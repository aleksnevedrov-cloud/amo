import { DialogRepo, JournalRepo, MemoryRepo, SettingsRepo, SuggestionsRepo, widgetSettingsSchema, type WidgetSettingsInput } from '@ai-door/db';
import { PricingRepo } from '@ai-door/pricing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seeded, type Seeded } from '../../tools/test/fixtures.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { DialogPipeline, type DocumentAnalyzer } from '../src/pipeline.ts';
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

  it('сбой разбора — агенту пометка, диалог продолжается', async () => {
    const t = await setup([text('Не удалось открыть файл. Напишите, пожалуйста, размеры проёмов текстом.')], {}, analyzer(true));
    await t.dialog.enqueue(ACC, lead, '', 'https://test.amocrm.ru/c/2', { url: 'https://drive.amocrm.ru/files/scan.pdf', type: 'file' });
    expect((await t.pipeline.processLead(ACC, lead)).status).toBe('replied');
    expect(JSON.stringify(t.llm.requests[0]!.messages)).toContain('разобрать не удалось');
    expect((await t.journal.list(ACC, { leadId: lead })).some((e) => e.kind === 'error' && e.summary.includes('OCR недоступен'))).toBe(true);
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
