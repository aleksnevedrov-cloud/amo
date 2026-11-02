import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db, JournalEntry } from '@core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKbCore, KB_INDEX_KIND, KB_SEARCH_KIND, type KbCore } from '../src/core.ts';
import type { Embedder } from '../src/embeddings.ts';
import { sourceLabel } from '../src/search.ts';
import { fakeEmbedder, freshKbDb } from './setup.ts';

const XLSX = join(import.meta.dirname, '../../kp/test/fixtures/zayavka-30008823.xlsx');
const ACCOUNT = 31337;

describe('база знаний опта: индексация текста и файла, поиск, лимиты (БД с pgvector)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: KbCore;
  const journal: JournalEntry[] = [];
  let embedder: Embedder | null = null;
  const fake = fakeEmbedder();

  beforeAll(async () => {
    ({ db, drop } = await freshKbDb());
    core = createKbCore({
      db,
      filesRoot: mkdtempSync(join(tmpdir(), 'kb-files-')),
      embedderFor: async () => embedder,
      ocrFor: async () => null,
      journal: { add: async (e) => void journal.push(e) },
      usdRubRate: async () => 90,
    });
  });
  afterAll(() => drop());

  it('текст менеджера: статус new → indexed, фрагмент виден, полнотекстовый поиск находит без эмбеддингов', async () => {
    const id = await core.addText(ACCOUNT, { title: '', content: 'Скидка опт от 50 полотен — 12 %', userId: 7 });
    let s = await core.repo.get(ACCOUNT, id);
    expect(s).toMatchObject({ kind: 'text', status: 'new', title: 'Скидка опт от 50 полотен — 12 %', original: null, sizeBytes: 51 });
    expect(s?.filePath).toMatch(/\/31337\/\d+-text\.txt$/);
    const r = await core.index({ accountId: ACCOUNT, sourceId: id, userId: 7 });
    expect(r).toMatchObject({ status: 'indexed', chunks: 1, embeddedChunks: 0, tokens: 0, usd: 0 });
    s = await core.repo.get(ACCOUNT, id);
    expect(s).toMatchObject({ status: 'indexed', chunks: 1, embeddedChunks: 0, error: null });
    expect(s?.indexedAt).toBeInstanceOf(Date);
    expect(await core.repo.listChunks(ACCOUNT, id)).toMatchObject([{ position: 0, text: 'Скидка опт от 50 полотен — 12 %', hasEmbedding: false }]);
    const found = await core.search(ACCOUNT, 'скидка опт', { userId: 7 });
    expect(found.hits).toHaveLength(1);
    expect(found.hits[0]).toMatchObject({ sourceId: id, matched: ['text'], source: { kind: 'text', title: 'Скидка опт от 50 полотен — 12 %' } });
    expect(found.model).toBeNull();
    expect(journal.map((e) => e.kind)).toEqual([KB_INDEX_KIND, KB_SEARCH_KIND]);
    expect(journal[0]?.summary).toContain('без эмбеддингов');
    // Чужой аккаунт ничего не видит.
    expect((await core.search(1, 'скидка опт', { silent: true })).hits).toEqual([]);
  });

  it('xlsx-заявка из сделки #30008823: лист в метаданных, фрагменты по строкам, поиск по позиции', async () => {
    const bytes = new Uint8Array(readFileSync(XLSX));
    const id = await core.addFile(ACCOUNT, { filename: 'zayavka-30008823.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes, userId: 7 });
    const r = await core.index({ accountId: ACCOUNT, sourceId: id, userId: 7 });
    expect(r.status).toBe('indexed');
    expect(r.chunks).toBeGreaterThan(0);
    const chunks = await core.repo.listChunks(ACCOUNT, id);
    expect(chunks[0]?.meta.sheet).toBeTruthy();
    const s = await core.repo.get(ACCOUNT, id);
    expect(s).toMatchObject({ kind: 'file', status: 'indexed', original: 'zayavka-30008823.xlsx', chunks: r.chunks, sizeBytes: bytes.byteLength });
    const word = chunks[0]?.text.split(/[\s\t]+/).find((w) => /^[А-Яа-я]{5,}$/.test(w));
    expect(word).toBeTruthy();
    const found = await core.search(ACCOUNT, word as string, { silent: true });
    expect(found.hits.some((h) => h.sourceId === id)).toBe(true);
  });

  it('с ключом OpenAI: эмбеддинги пишутся в pgvector, векторный и текстовый поиск объединяются, стоимость в журнале', async () => {
    embedder = fake.embedder;
    const id = await core.addText(ACCOUNT, { title: 'Сроки', content: 'Срок поставки полотен ДПГ — 10 рабочих дней.\n\nДвери с остеклением — 14 рабочих дней.', userId: 7 });
    const r = await core.index({ accountId: ACCOUNT, sourceId: id, userId: 7 });
    expect(r).toMatchObject({ status: 'indexed', chunks: 1, embeddedChunks: 1 });
    expect(r.tokens).toBeGreaterThan(0);
    expect(fake.calls.at(-1)).toHaveLength(1);
    const found = await core.search(ACCOUNT, 'срок поставки полотен', { userId: 7 });
    expect(found.hits[0]).toMatchObject({ sourceId: id, matched: ['vector', 'text'] });
    expect(found.model).toBe('fake-embedding');
    const last = journal.at(-1);
    expect(last?.kind).toBe(KB_SEARCH_KIND);
    expect(last?.costUsd).toBeGreaterThan(0);
    expect(last?.costRub).toBeCloseTo((last?.costUsd ?? 0) * 90, 8);
    // Переиндексация: статус new, затем снова indexed тем же числом фрагментов.
    expect((await core.reindex(ACCOUNT, id)).status).toBe('new');
    expect((await core.repo.get(ACCOUNT, id))?.status).toBe('new');
    expect((await core.index({ accountId: ACCOUNT, sourceId: id, userId: 7 })).chunks).toBe(1);
    embedder = null;
  });

  it('ошибки: неподдерживаемый формат, пустой текст, лимит фрагментов; удаление убирает фрагменты и файл', async () => {
    await expect(core.addFile(ACCOUNT, { filename: 'archive.zip', mime: 'application/zip', bytes: new Uint8Array([1]), userId: null })).rejects.toThrow(/Формат не поддерживается/);
    await expect(core.addText(ACCOUNT, { title: 'x', content: '   ', userId: null })).rejects.toThrow('Пустой текст');
    const before = await core.repo.usage(ACCOUNT);
    expect(before.limits).toEqual({ bytes: 500 * 1024 * 1024, chunks: 20_000 });
    const id = await core.addText(ACCOUNT, { title: 'Удалить', content: 'временная заметка про монтаж', userId: null });
    await core.index({ accountId: ACCOUNT, sourceId: id, userId: null });
    const path = (await core.repo.get(ACCOUNT, id))?.filePath as string;
    expect(readFileSync(path, 'utf8')).toBe('временная заметка про монтаж');
    const removed = await core.remove(ACCOUNT, id);
    expect(removed?.id).toBe(id);
    expect(await core.repo.get(ACCOUNT, id)).toBeNull();
    expect(await core.repo.listChunks(ACCOUNT, id)).toEqual([]);
    expect(() => readFileSync(path)).toThrow();
    expect((await core.repo.usage(ACCOUNT)).sources).toBe(before.sources);
    // Источник с ошибкой: битый xlsx → status error с текстом, событие в журнале.
    const bad = await core.addFile(ACCOUNT, { filename: 'bad.xlsx', mime: '', bytes: new Uint8Array([1, 2, 3, 4]), userId: null });
    const r = await core.index({ accountId: ACCOUNT, sourceId: bad, userId: null });
    expect(r.status).toBe('error');
    expect((await core.repo.get(ACCOUNT, bad))).toMatchObject({ status: 'error', error: expect.stringContaining('XLSX не читается') });
    expect(journal.at(-1)?.summary).toContain('не проиндексирован');
  });

  it('подпись источника', () => {
    const d = new Date('2026-10-01T10:00:00Z');
    expect(sourceLabel({ kind: 'file', title: 'прайс Текона.xlsx', original: 'прайс Текона.xlsx', indexedAt: d })).toBe(`прайс Текона.xlsx (${d.toLocaleDateString('ru-RU')})`);
    expect(sourceLabel({ kind: 'url', title: 'Цены', original: 'https://rf-dveri.ru/ceny/', indexedAt: null })).toBe('https://rf-dveri.ru/ceny/');
    expect(sourceLabel({ kind: 'text', title: 'Скидки', original: null, indexedAt: null })).toBe('заметка «Скидки»');
    expect(sourceLabel(null)).toBe('источник удалён');
  });
});
