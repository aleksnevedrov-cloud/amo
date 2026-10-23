// RFD-AI-AGENT-FILES-PRIORITY, п. 2: вложения писем, отложенные по дневному лимиту, разбираются автоматически, когда лимит
// позволяет; текст дописывается в историю сделки вместо пометки (новой и прежнего формата «разобрать не удалось: … лимит»)
// и в открытую задачу сделки, поставленную из-за лимита; пока лимит исчерпан — остаются отложенными без ошибок.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsRepo, DialogRepo, JournalRepo, MailAttachmentsRepo, SettingsRepo, widgetSettingsSchema, type Db } from '@core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb } from '../../../core/db/test/setup.ts';
import { replaceDeferredMark, runDeferredMailFiles } from '../src/index.ts';

const log = { info: () => undefined, warn: () => undefined };
const TEXT = '[Документ «Запрос.docx»: Запрос КП] Три межкомнатные двери 800×2000, эмаль белая, с монтажом; срок — до 15.11.';

describe('отложенные по лимиту вложения писем', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let attachments: MailAttachmentsRepo;
  let dialog: DialogRepo;
  let journal: JournalRepo;
  const tasks: Record<number, { id: number; text: string }[]> = { 301: [{ id: 5, text: 'Клиент прислал письмо с файлом «Запрос.docx», файл разобрать не удалось из-за дневного лимита. Разобрать вручную и ответить.' }], 302: [] };
  const updated: { id: number; text: string }[] = [];
  let limited = true;
  const analyzed: { filename: string; priority: string; leadId: number | null; bytes: number }[] = [];
  const documents = {
    async analyze(input: { filename: string; priority: 'deferred'; leadId: number | null; bytes: Uint8Array }) {
      if (limited) throw Object.assign(new Error('Достигнут дневной лимит разбора файлов (100)'), { stage: 'limit' });
      analyzed.push({ filename: input.filename, priority: input.priority, leadId: input.leadId, bytes: input.bytes.byteLength });
      return { id: analyzed.length, kind: 'request', text: input.filename === 'Запрос.docx' ? TEXT : `[Файл «${input.filename}»] смета на 2 двери`, costUsd: 0.02, model: 'test-docs' };
    },
  };
  const deps = () => ({
    attachments,
    settings: new SettingsRepo(db),
    journal,
    dialog,
    documents,
    amo: async () => ({
      openLeadTasks: async (leadId: number) => tasks[leadId] ?? [],
      updateTaskText: async (id: number, text: string) => {
        updated.push({ id, text });
      },
    }),
  });

  beforeAll(async () => {
    ({ db, drop } = await freshDb());
    await new AccountsRepo(db).upsertInstalled({ id: 1, subdomain: 'a', accountDomain: 'a.amocrm.ru' });
    await new SettingsRepo(db).save(1, 1, widgetSettingsSchema.parse({}));
    attachments = new MailAttachmentsRepo(db);
    dialog = new DialogRepo(db);
    journal = new JournalRepo(db);
    const dir = mkdtempSync(join(tmpdir(), 'mail-deferred-'));
    const p1 = join(dir, 'zapros.docx');
    const p2 = join(dir, 'smeta.xlsx');
    writeFileSync(p1, 'docx-bytes');
    writeFileSync(p2, 'xlsx');
    // Новое письмо: пометка «разбор отложен…» (poller), строка — отложена.
    const a1 = await attachments.insert({ accountId: 1, leadId: 301, messageUid: 10, messageId: '<m1@client.ru>', filename: 'Запрос.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sizeBytes: 10, storagePath: p1 });
    await attachments.setExtract(a1.id, { error: 'Достигнут дневной лимит разбора файлов (100)', deferred: true });
    await dialog.addMessage(1, 301, 'client', 'Тема письма: Запрос КП\nДобрый день, прошу посчитать.\n(во вложении файл «Запрос.docx» — разбор отложен по дневному лимиту, будет разобран автоматически)');
    // Письмо прежнего кода (до доработки): пометка «разобрать не удалось: … лимит …», статус переведён миграцией 022 в deferred.
    const a2 = await attachments.insert({ accountId: 1, leadId: 302, messageUid: 11, messageId: '<m2@client.ru>', filename: 'Смета.xlsx', mime: 'application/vnd.ms-excel', sizeBytes: 4, storagePath: p2 });
    await attachments.setExtract(a2.id, { error: 'Достигнут дневной лимит разбора файлов (100)' });
    await db.query("UPDATE mail_attachments SET extract_status = 'deferred' WHERE extract_status = 'error' AND extract_error ILIKE '%дневной лимит%'");
    await dialog.addMessage(1, 302, 'client', 'Тема письма: Смета\nСмотрите вложение\n(во вложении файл «Смета.xlsx», разобрать не удалось: Достигнут дневной лимит разбора файлов (100))');
  });
  afterAll(() => drop());

  it('пока лимит исчерпан — остаются отложенными, без ошибок и записей', async () => {
    expect(await runDeferredMailFiles(deps(), log)).toMatchObject({ accounts: 1, picked: 2, done: 0, stillLimited: 2, failed: 0 });
    expect((await attachments.listDeferred(1)).map((a) => a.filename)).toEqual(['Запрос.docx', 'Смета.xlsx']);
    expect(await journal.list(1)).toHaveLength(0);
  });

  it('лимит позволяет (новые сутки или лимит повышен) → разобраны с приоритетом deferred, текст в истории сделки и в задаче из-за лимита', async () => {
    limited = false;
    expect(await runDeferredMailFiles(deps(), log)).toMatchObject({ picked: 2, done: 2, stillLimited: 0, failed: 0, tasksUpdated: 1 });
    expect(analyzed).toEqual([
      { filename: 'Запрос.docx', priority: 'deferred', leadId: 301, bytes: 10 },
      { filename: 'Смета.xlsx', priority: 'deferred', leadId: 302, bytes: 4 },
    ]);
    expect(await attachments.listDeferred(1)).toEqual([]);
    const rows = await attachments.listByLead(1, 301);
    expect(rows[0]).toMatchObject({ extractStatus: 'done', extractedText: TEXT });
    // Контекст агента: пометка заменена текстом разбора — и новая, и прежнего формата.
    expect((await dialog.history(1, 301)).map((m) => m.text)).toEqual([`Тема письма: Запрос КП\nДобрый день, прошу посчитать.\n${TEXT}`]);
    expect((await dialog.history(1, 302)).map((m) => m.text)).toEqual(['Тема письма: Смета\nСмотрите вложение\n[Файл «Смета.xlsx»] смета на 2 двери']);
    // Задача, поставленная из-за лимита, дополнена кратким содержимым; у сделки 302 задач нет.
    expect(updated).toEqual([{ id: 5, text: `Клиент прислал письмо с файлом «Запрос.docx», файл разобрать не удалось из-за дневного лимита. Разобрать вручную и ответить.\n\nСодержимое файла «Запрос.docx» (разобрано после дневного лимита): ${TEXT}` }]);
    const log1 = await journal.list(1, { kind: 'document' });
    expect(log1.map((e) => e.summary).sort()).toEqual(['Разобрано отложенное вложение «Запрос.docx» (request, отложенный): текст дописан в письмо в истории сделки; содержимое дописано в задачу 5', 'Разобрано отложенное вложение «Смета.xlsx» (request, отложенный): текст дописан в письмо в истории сделки']);
    expect(log1.every((e) => (e.details as { priority?: string }).priority === 'deferred')).toBe(true);
    // Повторный проход ничего не берёт.
    expect(await runDeferredMailFiles(deps(), log)).toMatchObject({ picked: 0 });
  });

  it('пометки нет в истории → текст отдельным сообщением; файл не прочитан → ошибка без падения', async () => {
    const a3 = await attachments.insert({ accountId: 1, leadId: 303, messageUid: 12, messageId: '<m3@client.ru>', filename: 'План.pdf', mime: 'application/pdf', sizeBytes: 1, storagePath: '/nonexistent/plan.pdf' });
    await attachments.setExtract(a3.id, { error: 'лимит', deferred: true });
    const a4 = await attachments.insert({ accountId: 1, leadId: 304, messageUid: 13, messageId: '<m4@client.ru>', filename: 'Фото.jpg', mime: 'image/jpeg', sizeBytes: 1, storagePath: join(tmpdir(), 'x') });
    await attachments.setExtract(a4.id, { error: 'лимит', deferred: true });
    const r = await runDeferredMailFiles({ ...deps(), readFile: async (p) => (p.endsWith('x') ? new Uint8Array([1]) : Promise.reject(new Error('ENOENT'))) }, log);
    expect(r).toMatchObject({ picked: 2, done: 1, failed: 1 });
    expect((await attachments.byId(a3.id))?.extractStatus).toBe('error');
    expect((await dialog.history(1, 304)).map((m) => m.text)).toEqual(['Содержимое вложения «Фото.jpg» из письма (разобрано после дневного лимита):\n[Файл «Фото.jpg»] смета на 2 двери']);
  });

  it('замена пометки в тексте письма', () => {
    expect(replaceDeferredMark('Текст\n(во вложении файл «a (1).pdf» — разбор отложен по дневному лимиту, будет разобран автоматически)', 'a (1).pdf', 'РАЗБОР')).toBe('Текст\nРАЗБОР');
    expect(replaceDeferredMark('(во вложении файл «b.pdf», разобрать не удалось: Формат не поддерживается)', 'b.pdf', 'x')).toBeNull();
    expect(replaceDeferredMark('(во вложении файл «c.pdf» — разбор отложен по дневному лимиту, будет разобран автоматически)', 'd.pdf', 'x')).toBeNull();
  });
});
