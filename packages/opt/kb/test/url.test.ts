import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db, JournalEntry } from '@core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKbCore, type KbCore, type KbIndexJob } from '../src/core.ts';
import type { FetchedUrl } from '../src/fetch-url.ts';
import { fakeEmbedder, freshKbDb } from './setup.ts';

const XLSX = join(import.meta.dirname, '../../kp/test/fixtures/zayavka-30008823.xlsx');
const ACCOUNT = 777;
const html = (title: string, body: string) => `<html><head><title>${title}</title></head><body><header><ul class="menu"><li><a href="/">Главная</a></li></ul></header><main><h1>${title}</h1>${body}</main><footer>подвал</footer></body></html>`;

describe('база знаний: источники-ссылки (этап 2)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: KbCore;
  const journal: JournalEntry[] = [];
  const fake = fakeEmbedder();
  const pages = new Map<string, FetchedUrl | Error>();
  const fetched: string[] = [];
  const page = (url: string, body: string, mime = 'text/html') => pages.set(url, { bytes: new TextEncoder().encode(body), mime, finalUrl: url, status: 200 });
  const enqueued: KbIndexJob[] = [];
  const enqueue = async (j: KbIndexJob) => {
    enqueued.push(j);
  };

  beforeAll(async () => {
    ({ db, drop } = await freshKbDb());
    core = createKbCore({
      db,
      filesRoot: mkdtempSync(join(tmpdir(), 'kb-url-')),
      embedderFor: async () => fake.embedder,
      ocrFor: async () => null,
      journal: { add: async (e) => void journal.push(e) },
      usdRubRate: async () => 90,
      fetchUrl: async (url) => {
        fetched.push(url);
        const p = pages.get(url);
        if (!p) throw new Error('HTTP 404');
        if (p instanceof Error) throw p;
        return p;
      },
    });
  });
  afterAll(() => drop());

  it('страница с ценами: заголовок из h1, текст без меню и подвала, статус indexed, period 30 дней', async () => {
    page('https://rf-dveri.ru/ceny/', html('Цены на двери', '<p>ДПГ сота 800×2000 — 3 450 ₽ за полотно.</p><p>Доплата за нестандарт по высоте 15 %.</p>'));
    const { id, existed } = await core.addUrl(ACCOUNT, { url: 'https://rf-dveri.ru/ceny/', userId: 7 });
    expect(existed).toBe(false);
    let s = await core.repo.get(ACCOUNT, id);
    expect(s).toMatchObject({ kind: 'url', status: 'new', title: 'https://rf-dveri.ru/ceny/', original: 'https://rf-dveri.ru/ceny/', refreshDays: 30, crawl: false });
    expect(s?.nextRefreshAt).toBeInstanceOf(Date);
    const r = await core.index({ accountId: ACCOUNT, sourceId: id, userId: 7 });
    expect(r).toMatchObject({ status: 'indexed', chunks: 1, embeddedChunks: 1 });
    s = await core.repo.get(ACCOUNT, id);
    expect(s).toMatchObject({ status: 'indexed', title: 'Цены на двери', mime: 'text/html', httpStatus: 200 });
    expect(s?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const chunk = (await core.repo.listChunks(ACCOUNT, id))[0];
    expect(chunk?.text).toContain('# Цены на двери');
    expect(chunk?.text).toContain('ДПГ сота 800×2000 — 3 450 ₽');
    expect(chunk?.text).not.toContain('Главная');
    expect(chunk?.meta.heading).toBe('Цены на двери');
    expect(readFileSync(s?.filePath as string, 'utf8')).toContain('Доплата за нестандарт');
    const found = await core.search(ACCOUNT, 'доплата за нестандарт по высоте', { silent: true });
    expect(found.hits[0]).toMatchObject({ sourceId: id, source: { kind: 'url', original: 'https://rf-dveri.ru/ceny/' } });
  });

  it('повторная индексация: страница не изменилась — скачана, но эмбеддинги не пересчитаны; изменилась — фрагменты заново', async () => {
    const s0 = (await core.repo.findUrl(ACCOUNT, 'https://rf-dveri.ru/ceny/'))!;
    const calls = fake.calls.length;
    await core.reindex(ACCOUNT, s0.id);
    const same = await core.index({ accountId: ACCOUNT, sourceId: s0.id, userId: 7 });
    expect(same).toMatchObject({ status: 'indexed', chunks: 1, tokens: 0, usd: 0 });
    expect(fake.calls.length).toBe(calls);
    expect(journal.at(-1)?.summary).toContain('без изменений');
    expect(fetched.filter((u) => u === 'https://rf-dveri.ru/ceny/')).toHaveLength(2);
    // Содержимое поменялось: новые фрагменты, новый хэш, эмбеддинги посчитаны.
    page('https://rf-dveri.ru/ceny/', html('Цены на двери', '<p>ДПГ сота 800×2000 — 3 650 ₽ за полотно.</p><h2>Экошпон</h2><p>Турин — 7 900 ₽.</p>'));
    await core.reindex(ACCOUNT, s0.id);
    const changed = await core.index({ accountId: ACCOUNT, sourceId: s0.id, userId: 7 });
    expect(changed.status).toBe('indexed');
    expect(changed.embeddedChunks).toBeGreaterThan(0);
    expect(fake.calls.length).toBe(calls + 1);
    expect((await core.repo.get(ACCOUNT, s0.id))?.contentHash).not.toBe(s0.contentHash);
    expect((await core.repo.listChunks(ACCOUNT, s0.id)).map((c) => c.text).join('\n')).toContain('3 650 ₽');
    // Тот же адрес повторно — не дубль, а переиндексация существующего.
    const again = await core.addUrl(ACCOUNT, { url: 'https://rf-dveri.ru/ceny/', refreshDays: 7, userId: 7 });
    expect(again).toEqual({ id: s0.id, existed: true });
    expect(await core.repo.get(ACCOUNT, s0.id)).toMatchObject({ status: 'new', refreshDays: 7 });
    await core.index({ accountId: ACCOUNT, sourceId: s0.id, userId: 7 });
  });

  it('обход раздела: страницы раздела становятся источниками-детьми и ставятся в очередь, чужие и уже добавленные пропускаются', async () => {
    page('https://rf-dveri.ru/catalog/', html('Каталог', '<a href="/catalog/dpg/">ДПГ</a><a href="/catalog/dpo/">ДПО</a><a href="/catalog/?p=2">2</a><a href="/ceny/">Цены</a><a href="https://vk.com/x">VK</a><p>Все модели.</p>'));
    page('https://rf-dveri.ru/catalog/dpg/', html('ДПГ', '<p>Глухое полотно, сотовое заполнение.</p>'));
    page('https://rf-dveri.ru/catalog/dpo/', html('ДПО', '<p>Остеклённое полотно.</p>'));
    const { id } = await core.addUrl(ACCOUNT, { url: 'https://rf-dveri.ru/catalog/', crawl: true, userId: 7 });
    const r = await core.index({ accountId: ACCOUNT, sourceId: id, userId: 7 }, { enqueue });
    expect(r.status).toBe('indexed');
    expect(enqueued.map((j) => j.sourceId)).toHaveLength(3);
    const children = (await core.repo.list(ACCOUNT)).filter((s) => s.parentId === id);
    expect(children.map((c) => c.original).sort()).toEqual(['https://rf-dveri.ru/catalog/?p=2', 'https://rf-dveri.ru/catalog/dpg/', 'https://rf-dveri.ru/catalog/dpo/']);
    expect(children.every((c) => c.status === 'new' && c.refreshDays === 30 && c.createdBy === 7)).toBe(true);
    expect(journal.at(-1)?.summary).toContain('обход раздела https://rf-dveri.ru/catalog/ — добавлено страниц 3');
    for (const j of enqueued) await core.index(j);
    const dpg = children.find((c) => c.original?.endsWith('/dpg/'))!;
    expect(await core.repo.get(ACCOUNT, dpg.id)).toMatchObject({ status: 'indexed', title: 'ДПГ' });
    expect(await core.repo.get(ACCOUNT, children.find((c) => c.original?.includes('?p=2'))!.id)).toMatchObject({ status: 'error', error: 'HTTP 404' });
    // Повторный обход не плодит дубли.
    enqueued.length = 0;
    await core.reindex(ACCOUNT, id);
    await core.index({ accountId: ACCOUNT, sourceId: id, userId: 7 }, { enqueue });
    expect(enqueued).toEqual([]);
    expect((await core.repo.list(ACCOUNT)).filter((s) => s.parentId === id)).toHaveLength(3);
  });

  it('плановое обновление: ссылки с подошедшим сроком переводятся в new и ставятся в очередь один раз', async () => {
    const all = await core.repo.list(ACCOUNT);
    const due = all.filter((s) => s.kind === 'url' && s.status === 'indexed').slice(0, 2);
    await db.query("UPDATE kb_sources SET next_refresh_at = now() - interval '1 hour' WHERE id = ANY($1::bigint[])", [due.map((s) => s.id)]);
    enqueued.length = 0;
    expect(await core.refreshDue(enqueue)).toBe(2);
    expect(enqueued.map((j) => j.sourceId).sort()).toEqual(due.map((s) => s.id).sort());
    expect(await core.refreshDue(enqueue)).toBe(0);
    for (const j of enqueued) await core.index(j);
    const after = await core.repo.get(ACCOUNT, due[0]!.id);
    expect(after?.status).toBe('indexed');
    expect(after!.nextRefreshAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('файл по ссылке (xlsx) разбирается как файл; ошибка скачивания — статус error с текстом', async () => {
    pages.set('https://rf-dveri.ru/files/zayavka.xlsx', { bytes: new Uint8Array(readFileSync(XLSX)), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', finalUrl: 'https://rf-dveri.ru/files/zayavka.xlsx', status: 200 });
    const { id } = await core.addUrl(ACCOUNT, { url: 'https://rf-dveri.ru/files/zayavka.xlsx', refreshDays: null, userId: 7 });
    const r = await core.index({ accountId: ACCOUNT, sourceId: id, userId: 7 });
    expect(r.status).toBe('indexed');
    expect(r.chunks).toBeGreaterThan(0);
    const s = await core.repo.get(ACCOUNT, id);
    expect(s).toMatchObject({ title: 'zayavka.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', refreshDays: null, nextRefreshAt: null });
    expect((await core.repo.listChunks(ACCOUNT, id))[0]?.meta.sheet).toBeTruthy();
    const bad = await core.addUrl(ACCOUNT, { url: 'https://rf-dveri.ru/net-takoy/', userId: 7 });
    expect(await core.index({ accountId: ACCOUNT, sourceId: bad.id, userId: 7 })).toMatchObject({ status: 'error', error: 'HTTP 404' });
    await expect(core.addUrl(ACCOUNT, { url: 'http://127.0.0.1/', userId: 7 })).rejects.toThrow('внутреннюю сеть');
  });
});
