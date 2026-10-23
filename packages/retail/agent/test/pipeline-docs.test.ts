import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DialogRepo, JournalRepo, MailAttachmentsRepo, MemoryRepo, SettingsRepo, SuggestionsRepo, widgetSettingsSchema, type WidgetSettingsInput } from '@core/db';
import { PricingRepo } from '@retail/pricing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seeded, type Seeded } from '../../../core/tools/test/fixtures.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { DialogPipeline, type DocumentAnalyzer } from '../src/pipeline.ts';
import { deferFileToDisk, runDeferredMailFiles } from '../../mail/src/deferred.ts';
import { fakeAmo } from './fake-amo.ts';
import { ScriptedLlm, text } from './scripted-llm.ts';

let s: Seeded;
let lead = 7000;
const ACC = 1;

beforeAll(async () => {
  s = await seeded(ACC);
});
afterAll(async () => s.drop());
beforeEach(() => {
  lead += 1;
});

const withContact = { lead: { id: 0, name: 'x', price: 0, status_id: 10, pipeline_id: 1, responsible_user_id: 3, created_at: 0, custom_fields_values: null, _embedded: { contacts: [{ id: 88, is_main: true }] } } };

function analyzer(fail = false): DocumentAnalyzer & { inputs: unknown[] } {
  const inputs: unknown[] = [];
  return {
    inputs,
    async analyze(input) {
      inputs.push({ ...input, bytes: input.bytes.byteLength });
      if (fail) throw new Error('OCR недоступен');
      return {
        id: 1,
        kind: 'measurement',
        text: '[Файл «IMG_1.jpg»: Замерный лист] Два проёма.\nПроёмы:\n- Спальня: 838×2050 мм, стена 105',
        note: '[AI] Разбор файла «IMG_1.jpg» — Замерный лист',
        memoryOpenings: [{ room: 'Спальня', width_mm: 838, height_mm: 2050, wall_mm: 105, qty: 1 }],
        costUsd: 0.02,
        model: 'claude-opus-5',
      };
    },
  };
}

async function setup(steps: ConstructorParameters<typeof ScriptedLlm>[0], settings: WidgetSettingsInput = {}, docs: DocumentAnalyzer | null = analyzer()) {
  await new SettingsRepo(s.db).save(ACC, 1, widgetSettingsSchema.parse({ enabled: true, mode: 'auto', ...settings }));
  const llm = new ScriptedLlm(steps);
  const fake = fakeAmo(withContact);
  const deps = {
    settings: new SettingsRepo(s.db),
    dialog: new DialogRepo(s.db),
    journal: new JournalRepo(s.db),
    catalog: s.catalog,
    knowledge: s.knowledge,
    pricing: new PricingRepo(s.db),
    memory: new MemoryRepo(s.db),
    suggestions: new SuggestionsRepo(s.db),
    orchestrator: new Orchestrator(llm),
    llm,
    amo: async () => fake.access,
    send: fake.send,
    download: async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/jpeg' }),
    ...(docs ? { documents: docs } : {}),
  };
  return { fake, ...deps, pipeline: new DialogPipeline(deps) };
}

describe('вложения из чата (фаза 3)', () => {
  it('фото замерного листа: факты — агенту, проёмы — в память, примечание — в сделку, расход — в журнал', async () => {
    const docs = analyzer();
    const t = await setup([text('Спасибо, замер получил: спальня 838×2050. Подберём полотно 700.')], {}, docs);
    await t.dialog.enqueue(ACC, lead, 'Вот замер', 'https://test.amocrm.ru/c/1', { url: 'https://drive.amocrm.ru/files/IMG_1.jpg', type: 'picture' });
    const out = await t.pipeline.processLead(ACC, lead);
    expect(out.status).toBe('replied');
    expect(docs.inputs[0]).toMatchObject({ accountId: ACC, leadId: lead, source: 'chat', filename: 'IMG_1.jpg', mime: 'image/jpeg', bytes: 3 });
    // Агент видит факты из файла, но не сам файл.
    const userMsg = JSON.stringify(t.llm.requests[0]!.messages);
    expect(userMsg).toContain('Вот замер');
    expect(userMsg).toContain('Спальня: 838×2050 мм, стена 105');
    expect((await t.memory.get(ACC, 'contact:88')).data.openings).toEqual([{ room: 'Спальня', width_mm: 838, height_mm: 2050, wall_mm: 105, qty: 1 }]);
    const note = t.fake.state.calls.find((c) => c.method === 'POST' && c.path.endsWith('/notes'));
    expect(JSON.stringify(note?.body)).toContain('Разбор файла «IMG_1.jpg»');
    const log = await t.journal.list(ACC, { leadId: lead });
    const doc = log.find((e) => e.kind === 'document');
    expect(doc).toMatchObject({ summary: 'Разобран файл «IMG_1.jpg» (measurement)' });
    expect(doc!.costRub).toBeGreaterThan(0);
  });

  it('сбой разбора — агенту пометка, диалог продолжается; в журнале и логе — этап, текст ошибки, размер файла (RFD-AI-AGENT-WA-PHOTO, п. 1)', async () => {
    const logged: Record<string, unknown>[] = [];
    const t = await setup([text('Не удалось открыть файл. Напишите, пожалуйста, размеры проёмов текстом.')], {}, analyzer(true));
    const pipeline = new DialogPipeline({ ...t, log: (f) => logged.push(f) });
    await t.dialog.enqueue(ACC, lead, '', 'https://test.amocrm.ru/c/2', { url: 'https://drive.amocrm.ru/files/scan.pdf?sig=secret', type: 'file' });
    expect((await pipeline.processLead(ACC, lead)).status).toBe('replied');
    expect(JSON.stringify(t.llm.requests[0]!.messages)).toContain('разобрать не удалось');
    const err = (await t.journal.list(ACC, { leadId: lead })).find((e) => e.kind === 'error');
    expect(err?.summary).toBe('Разбор файла «scan.pdf» — разбор: OCR недоступен');
    expect(err?.details).toMatchObject({ stage: 'analyze', stageTitle: 'разбор', error: 'OCR недоступен', errorName: 'Error', url: 'https://drive.amocrm.ru/files/scan.pdf', mime: 'image/jpeg', bytes: 3, ms: expect.any(Number) });
    expect(logged[0]).toMatchObject({ accountId: ACC, leadId: lead, filename: 'scan.pdf', stage: 'analyze', error: 'OCR недоступен' });
  });

  it('файл не скачался (HTTP 404 из хранилища) — в журнале этап «скачивание», код ответа и признак повтора; ошибка без текста не теряется', async () => {
    const t = await setup([text('Файл не открылся, напишите размеры текстом.'), text('Файл не открылся, напишите размеры текстом.')], {}, analyzer());
    const notFound = Object.assign(new Error('Вложение недоступно: HTTP 404 (повтор через 2 с не помог, первая попытка: Вложение недоступно: HTTP 404)'), { name: 'AttachmentError', status: 404, retried: true });
    const pipeline = new DialogPipeline({ ...t, download: async () => { throw notFound; } });
    await t.dialog.enqueue(ACC, lead, '', 'https://test.amocrm.ru/c/4', { url: 'https://store.wazzup24.com/cd1574bb.jpeg', type: 'picture' });
    expect((await pipeline.processLead(ACC, lead)).status).toBe('replied');
    const err = (await t.journal.list(ACC, { leadId: lead })).find((e) => e.kind === 'error');
    expect(err?.summary).toContain('Разбор файла «cd1574bb.jpeg» — скачивание: Вложение недоступно: HTTP 404');
    expect(err?.details).toMatchObject({ stage: 'download', status: 404, retried: true, type: 'picture', url: 'https://store.wazzup24.com/cd1574bb.jpeg' });
    // Исключение без сообщения (так выглядела запись 14.10 по сделке 89955) — в журнале «без текста» и имя класса.
    const silent = new DialogPipeline({ ...t, download: async () => { throw new TypeError(''); } });
    lead += 1;
    await t.dialog.enqueue(ACC, lead, '', 'https://test.amocrm.ru/c/5', { url: 'https://store.wazzup24.com/x.jpeg', type: 'picture' });
    await silent.processLead(ACC, lead);
    const e2 = (await t.journal.list(ACC, { leadId: lead })).find((e) => e.kind === 'error');
    expect(e2?.summary).toBe('Разбор файла «x.jpeg» — скачивание: TypeError без текста');
    expect(e2?.details).toMatchObject({ stage: 'download', error: 'TypeError без текста', errorName: 'TypeError', status: null });
  });

  it('вложение письма из карточки amo при исчерпанном лимите → отложено (файл на томе, очередь deferred) → разобрано после повышения лимита → текст в истории сделки и в задаче «из-за дневного лимита» (RFD-AI-AGENT-FILES-PRIORITY)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'defer-'));
    const attachments = new MailAttachmentsRepo(s.db);
    let limited = true;
    const docs: DocumentAnalyzer & { analyze(input: { filename: string; priority?: string; bytes: Uint8Array }): Promise<never> } = {
      async analyze() {
        throw Object.assign(new Error('Достигнут дневной лимит разбора файлов (100)'), { stage: 'limit' });
      },
    } as never;
    const t = await setup([text('Файл получил, разберу чуть позже и отвечу по запросу.')], {}, docs);
    const deferred: string[] = [];
    const pipeline = new DialogPipeline({
      ...t,
      download: async () => ({ bytes: new Uint8Array([0x50, 0x4b, 3, 4]), mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
      deferFile: async (f) => {
        deferred.push(f.filename);
        await deferFileToDisk({ attachments, root }, { accountId: f.accountId, leadId: f.leadId, filename: f.filename, mime: f.mime, bytes: f.bytes, key: f.url, error: f.error });
      },
    });
    // Salesbot передал письмо из карточки amo: текст и ссылку на вложение из «Файлов» amo.
    await t.dialog.enqueue(ACC, lead, 'Тема письма: Запрос КП\nПрошу посчитать по вложению', 'https://test.amocrm.ru/c/3', { url: 'https://drive-b.amocrm.ru/download/abc/Запрос.docx', type: 'file' });
    expect((await pipeline.processLead(ACC, lead)).status).toBe('replied');
    expect(deferred).toEqual(['Запрос.docx']);
    expect(JSON.stringify(t.llm.requests[0]!.messages)).toContain('(клиент отправил файл «Запрос.docx» — разбор отложен по дневному лимиту, будет разобран автоматически)');
    const log = await t.journal.list(ACC, { leadId: lead });
    expect(log.find((e) => e.kind === 'skipped')?.summary).toBe('Файл «Запрос.docx» отложен по дневному лимиту — разберётся автоматически');
    expect(log.some((e) => e.kind === 'error')).toBe(false);
    const queued = await attachments.listDeferred(ACC);
    expect(queued.map((a) => [a.leadId, a.filename, a.extractStatus, a.sizeBytes])).toEqual([[lead, 'Запрос.docx', 'deferred', 4]]);
    expect(readFileSync(queued[0]!.storagePath)).toEqual(Buffer.from([0x50, 0x4b, 3, 4]));
    // Повтор того же файла не дублирует очередь.
    expect((await deferFileToDisk({ attachments, root }, { accountId: ACC, leadId: lead, filename: 'Запрос.docx', mime: 'x', bytes: new Uint8Array([0x50, 0x4b, 3, 4]), key: 'https://drive-b.amocrm.ru/download/abc/Запрос.docx', error: 'e' })).created).toBe(false);

    // Менеджеру из-за лимита поставлена задача; лимит повышен (или новые сутки) → проход отложенных: текст в историю и в задачу.
    limited = false;
    const tasks = [{ id: 44, text: 'Клиент прислал письмо с файлом «Запрос.docx», файл разобрать не удалось из-за дневного лимита. Разобрать вручную.' }];
    const updated: { id: number; text: string }[] = [];
    const r = await runDeferredMailFiles(
      {
        attachments,
        settings: t.settings,
        journal: t.journal,
        dialog: t.dialog,
        amo: async () => ({ openLeadTasks: async () => tasks, updateTaskText: async (id: number, txt: string) => void updated.push({ id, text: txt }) }),
        documents: { analyze: async (input) => (limited ? Promise.reject(Object.assign(new Error('лимит'), { stage: 'limit' })) : { id: 1, kind: 'request', text: `[Документ «${input.filename}»: Запрос КП] Три двери 800×2000, эмаль белая, монтаж; срок до 15.11.`, costUsd: 0.02, model: 'test-docs' }) },
      },
      { info: () => undefined, warn: () => undefined },
    );
    expect(r).toMatchObject({ picked: 1, done: 1, tasksUpdated: 1 });
    expect((await t.dialog.history(ACC, lead)).filter((m) => m.role === 'client').map((m) => m.text)).toEqual(['Тема письма: Запрос КП\nПрошу посчитать по вложению\n[Документ «Запрос.docx»: Запрос КП] Три двери 800×2000, эмаль белая, монтаж; срок до 15.11.']);
    expect(updated).toEqual([{ id: 44, text: 'Клиент прислал письмо с файлом «Запрос.docx», файл разобрать не удалось из-за дневного лимита. Разобрать вручную.\n\nСодержимое файла «Запрос.docx» (разобрано после дневного лимита): [Документ «Запрос.docx»: Запрос КП] Три двери 800×2000, эмаль белая, монтаж; срок до 15.11.' }]);
    expect(await attachments.listDeferred(ACC)).toEqual([]);
  });

  it('автоматический разбор выключен — файл не скачивается', async () => {
    const docs = analyzer();
    const t = await setup([text('Опишите, пожалуйста, словами.')], { vision: { autoParse: false } }, docs);
    await t.dialog.enqueue(ACC, lead, 'смотрите', 'https://test.amocrm.ru/c/3', { url: 'https://drive.amocrm.ru/files/a.xlsx', type: 'file' });
    await t.pipeline.processLead(ACC, lead);
    expect(docs.inputs).toEqual([]);
    expect(JSON.stringify(t.llm.requests[0]!.messages)).toContain('разбор вложений выключен');
  });

  it('проёмы из письма (meta.openings) попадают в память', async () => {
    const t = await setup([text('Спасибо за замер.')], {}, null);
    await t.dialog.enqueue(ACC, lead, 'Тема письма: замер\n[Файл «замер.pdf»: Замерный лист]', null, null, {
      channel: 'email',
      meta: { from: 'ivan@client.ru', openings: [{ room: 'Кухня', width_mm: 805, height_mm: 2060 }] },
    });
    await t.pipeline.processLead(ACC, lead);
    expect((await t.memory.get(ACC, 'contact:88')).data.openings).toEqual([{ room: 'Кухня', width_mm: 805, height_mm: 2060 }]);
  });
});

describe('аналитика: стартовый этап', () => {
  it('при первом контакте AI запоминается воронка и этап сделки', async () => {
    const starts: unknown[] = [];
    const t = await setup([text('Здравствуйте!')], {}, null);
    const pipeline = new DialogPipeline({ ...t, outcomes: { start: async (...a: unknown[]) => void starts.push(a) } } as unknown as ConstructorParameters<typeof DialogPipeline>[0]);
    await t.dialog.enqueue(ACC, lead, 'Привет', 'https://test.amocrm.ru/c/9');
    await pipeline.processLead(ACC, lead);
    expect(starts).toEqual([[ACC, lead, 1, 10]]);
  });
});

describe('ключ Anthropic по аккаунту', () => {
  it('нет ключа ни у аккаунта, ни на сервере — передача менеджеру с ошибкой в журнале', async () => {
    const t = await setup([], {}, null);
    const pipeline = new DialogPipeline({ ...t, llm: null, orchestrator: null, ai: async () => null } as unknown as ConstructorParameters<typeof DialogPipeline>[0]);
    await t.dialog.enqueue(ACC, lead, 'Привет', 'https://test.amocrm.ru/c/10');
    const out = await pipeline.processLead(ACC, lead);
    expect(out).toEqual({ status: 'handoff', reason: 'no_answer' });
    const log = await t.journal.list(ACC, { leadId: lead });
    expect(log.some((e) => e.kind === 'error' && e.summary.includes('Ключ Anthropic не задан'))).toBe(true);
  });

  it('LLM аккаунта используется вместо общей', async () => {
    const t = await setup([text('общая')], {}, null);
    const own = new ScriptedLlm([text('Ответ по ключу аккаунта')]);
    const pipeline = new DialogPipeline({ ...t, ai: async () => ({ llm: own, orchestrator: new Orchestrator(own), source: 'account' }) } as unknown as ConstructorParameters<typeof DialogPipeline>[0]);
    await t.dialog.enqueue(ACC, lead, 'Привет', 'https://test.amocrm.ru/c/11');
    const out = await pipeline.processLead(ACC, lead);
    expect(out).toEqual({ status: 'replied', text: 'Ответ по ключу аккаунта' });
    expect(own.requests).toHaveLength(1);
  });
});
