import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeEmbedder } from '../../../packages/opt/kb/test/setup.ts';
import { ACCOUNT_ID, setup, widgetToken } from './helpers.ts';

const XLSX = join(import.meta.dirname, '../../../packages/opt/kp/test/fixtures/zayavka-30008823.xlsx');

/** Приёмка этапа 1 RFD-AI-AGENT-OPT-KB: текст и xlsx-заявка из сделки #30008823 в статусе indexed, фрагменты видны, поиск «скидка опт» находит текст. */
describe('opt-api: база знаний — источники, индексация, поиск, здоровье', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let headers: Record<string, string>;
  let textId = 0;
  let fileId = 0;
  const fake = fakeEmbedder();

  let pageVersion = 1;
  const fetched: string[] = [];
  const PRICE_PAGE = () => `<html><head><title>Цены | РФ-Двери</title></head><body><header><ul class="menu"><li><a href="/">Главная</a></li></ul></header><main><h1>Цены на двери</h1><table><tr><td>ДПГ сота</td><td>800×2000</td><td>${pageVersion === 1 ? '3 450' : '3 650'} ₽</td></tr></table></main><footer>© РФ-Двери</footer></body></html>`;

  beforeAll(async () => {
    ctx = await setup({
      embedder: fake.embedder,
      fetchUrl: async (url) => {
        fetched.push(url);
        if (url !== 'https://rf-dveri.ru/ceny/') throw new Error('HTTP 404');
        return { bytes: new TextEncoder().encode(PRICE_PAGE()), mime: 'text/html', finalUrl: url, status: 200 };
      },
    });
    headers = { 'x-auth-token': await widgetToken() };
    // Аккаунт появляется в БД опта после OAuth; здесь — напрямую, как в остальных тестах.
    await ctx.deps.accounts.upsertInstalled({ id: ACCOUNT_ID, subdomain: 'aleksnevedrov', accountDomain: 'aleksnevedrov.amocrm.ru' });
  });
  afterAll(() => ctx.close());

  it('/health проверяет отдельную БД базы знаний (kb_db)', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ok', checks: { db: 'ok', redis: 'ok', kb_db: 'ok' } });
  });

  it('пустая база: список и лимиты', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/sources', headers });
    expect(r.json()).toEqual({ sources: [], usage: { sources: 0, bytes: 0, chunks: 0, limits: { bytes: 500 * 1024 * 1024, chunks: 20_000 } } });
  });

  it('текст «Скидка опт от 50 полотен — 12 %» → indexed, фрагмент виден, поиск «скидка опт» находит', async () => {
    const add = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/sources/text', headers, payload: { title: '', content: 'Скидка опт от 50 полотен — 12 %' } });
    expect(add.statusCode).toBe(202);
    // Очередь в тестах отработала сразу: источник уже проиндексирован.
    expect(add.json().source).toMatchObject({ kind: 'text', title: 'Скидка опт от 50 полотен — 12 %', original: null, status: 'indexed', chunks: 1, embeddedChunks: 1 });
    textId = add.json().source.id;
    const chunks = await ctx.app.inject({ method: 'GET', url: `/widget/v1/kb/sources/${textId}/chunks`, headers });
    expect(chunks.json().chunks).toEqual([{ id: expect.any(Number), sourceId: textId, position: 0, text: 'Скидка опт от 50 полотен — 12 %', meta: {}, hasEmbedding: true }]);
    const found = await ctx.app.inject({ method: 'GET', url: `/widget/v1/kb/search?q=${encodeURIComponent('скидка опт')}`, headers });
    expect(found.statusCode).toBe(200);
    expect(found.json().hits).toHaveLength(1);
    expect(found.json().hits[0]).toMatchObject({ sourceId: textId, text: 'Скидка опт от 50 полотен — 12 %', matched: ['vector', 'text'], source: { kind: 'text', title: 'Скидка опт от 50 полотен — 12 %' } });
    expect(found.json().model).toBe('fake-embedding');
    // Стоимость индексации и поиска — в журнале опта.
    const journal = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/journal', headers })).json().items as { kind: string; summary: string; costRub: number }[];
    expect(journal.map((j) => j.kind)).toEqual(['kb_search', 'note', 'kb_index']);
    expect(journal[2]?.summary).toBe('База знаний: «Скидка опт от 50 полотен — 12 %» проиндексирован — фрагментов 1, эмбеддингов 1, 0.0 с');
    expect(journal[0]?.summary).toBe('Поиск по базе знаний «скидка опт»: найдено 1');
  });

  it('xlsx-заявка из сделки #30008823 → indexed, фрагменты с листом, список показывает оба источника и объём', async () => {
    const bytes = readFileSync(XLSX);
    const add = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/sources/file', headers, payload: { filename: 'zayavka-30008823.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBase64: bytes.toString('base64') } });
    expect(add.statusCode).toBe(202);
    expect(add.json().source).toMatchObject({ kind: 'file', title: 'zayavka-30008823.xlsx', original: 'zayavka-30008823.xlsx', status: 'indexed', sizeBytes: bytes.byteLength });
    expect(add.json().source.chunks).toBeGreaterThan(0);
    fileId = add.json().source.id;
    const chunks = await ctx.app.inject({ method: 'GET', url: `/widget/v1/kb/sources/${fileId}/chunks?limit=2`, headers });
    expect(chunks.json().chunks).toHaveLength(Math.min(2, add.json().source.chunks));
    expect(chunks.json().chunks[0].meta.sheet).toBeTruthy();
    const list = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/sources', headers })).json();
    expect(list.sources.map((s: { id: number; status: string }) => [s.id, s.status])).toEqual([[fileId, 'indexed'], [textId, 'indexed']]);
    expect(list.usage).toMatchObject({ sources: 2, bytes: bytes.byteLength + 51, chunks: add.json().source.chunks + 1 });
  });

  it('ссылка на страницу rf-dveri.ru с ценами → indexed без меню и подвала; повторная индексация по кнопке скачивает заново (этап 2)', async () => {
    const add = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/sources/url', headers, payload: { url: 'https://rf-dveri.ru/ceny/', refreshDays: 30, crawl: false } });
    expect(add.statusCode).toBe(202);
    expect(add.json()).toMatchObject({ existed: false, source: { kind: 'url', title: 'Цены на двери', original: 'https://rf-dveri.ru/ceny/', status: 'indexed', chunks: 1, refreshDays: 30, crawl: false, httpStatus: 200 } });
    expect(add.json().source.nextRefreshAt).toBeTruthy();
    const urlId = add.json().source.id as number;
    const chunks = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kb/sources/${urlId}/chunks`, headers })).json().chunks as { text: string }[];
    expect(chunks[0]?.text).toContain('ДПГ сота\t800×2000\t3 450 ₽');
    expect(chunks[0]?.text).not.toContain('Главная');
    expect(fetched).toEqual(['https://rf-dveri.ru/ceny/']);
    // Кнопка «Переиндексировать»: страница скачивается снова; содержимое поменялось — фрагменты обновлены.
    pageVersion = 2;
    const re = await ctx.app.inject({ method: 'POST', url: `/widget/v1/kb/sources/${urlId}/reindex`, headers });
    expect(re.statusCode).toBe(202);
    expect(re.json().source).toMatchObject({ id: urlId, status: 'indexed', chunks: 1 });
    expect(fetched).toHaveLength(2);
    expect((await ctx.app.inject({ method: 'GET', url: `/widget/v1/kb/sources/${urlId}/chunks`, headers })).json().chunks[0].text).toContain('3 650 ₽');
    // Недоступный адрес — источник со статусом error и текстом; внутренний адрес отклоняется сразу.
    const bad = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/sources/url', headers, payload: { url: 'https://rf-dveri.ru/net/' } });
    expect(bad.statusCode).toBe(202);
    expect(bad.json().source).toMatchObject({ status: 'error', error: 'HTTP 404' });
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/sources/url', headers, payload: { url: 'http://127.0.0.1:3001/health' } })).json()).toMatchObject({ error: 'rejected', message: expect.stringContaining('внутреннюю сеть') });
    await ctx.app.inject({ method: 'DELETE', url: `/widget/v1/kb/sources/${bad.json().source.id}`, headers });
    await ctx.app.inject({ method: 'DELETE', url: `/widget/v1/kb/sources/${urlId}`, headers });
  });

  it('KP-AGENT-V2, п. 4а: ссылка с комментарием и «фабрикой» — сохраняются вместе со ссылкой; повторная ссылка их меняет; больше 2000 знаков — 400', async () => {
    const add = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/sources/url', headers, payload: { url: 'https://rf-dveri.ru/ceny/', refreshDays: 30, crawl: false, comment: '  ДПК Аква, межкомнатные. Стальных нет  ', isFactory: true } });
    expect(add.statusCode).toBe(202);
    expect(add.json().source).toMatchObject({ kind: 'url', status: 'indexed', comment: 'ДПК Аква, межкомнатные. Стальных нет', isFactory: true });
    const id = add.json().source.id as number;
    const listed = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/sources', headers })).json().sources.find((x: { id: number }) => x.id === id);
    expect(listed).toMatchObject({ comment: 'ДПК Аква, межкомнатные. Стальных нет', isFactory: true });
    // Та же ссылка ещё раз — комментарий и «фабрика» обновлены, источник тот же.
    const again = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/sources/url', headers, payload: { url: 'https://rf-dveri.ru/ceny/', comment: 'Только межкомнатные', isFactory: false } });
    expect(again.json()).toMatchObject({ existed: true, source: { id, comment: 'Только межкомнатные', isFactory: false } });
    // Без полей — прежние значения не трогаются.
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/sources/url', headers, payload: { url: 'https://rf-dveri.ru/ceny/' } })).json().source).toMatchObject({ comment: 'Только межкомнатные', isFactory: false });
    const long = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/sources/url', headers, payload: { url: 'https://rf-dveri.ru/ceny/', comment: 'x'.repeat(2001) } });
    expect(long.statusCode).toBe(400);
    expect(long.json()).toMatchObject({ error: 'bad_body', message: 'комментарий — не длиннее 2000 знаков' });
    await ctx.app.inject({ method: 'DELETE', url: `/widget/v1/kb/sources/${id}`, headers });
  });

  it('переиндексация возвращает тот же результат; удаление убирает источник; чужой формат и не-админ отклоняются', async () => {
    const re = await ctx.app.inject({ method: 'POST', url: `/widget/v1/kb/sources/${textId}/reindex`, headers });
    expect(re.statusCode).toBe(202);
    expect(re.json().source).toMatchObject({ id: textId, status: 'indexed', chunks: 1 });
    const bad = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/sources/file', headers, payload: { filename: 'arch.zip', contentBase64: Buffer.from('zip').toString('base64') } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'rejected', message: expect.stringContaining('Формат не поддерживается') });
    const user = { 'x-auth-token': await widgetToken({ is_admin: false }) };
    expect((await ctx.app.inject({ method: 'DELETE', url: `/widget/v1/kb/sources/${fileId}`, headers: user })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/sources', headers: user })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/widget/v1/kb/sources/${fileId}`, headers })).json()).toEqual({ ok: true });
    expect((await ctx.app.inject({ method: 'DELETE', url: `/widget/v1/kb/sources/${fileId}`, headers })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: `/widget/v1/kb/sources/${fileId}/chunks`, headers })).statusCode).toBe(404);
    const list = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/sources', headers })).json();
    expect(list.sources.map((s: { id: number }) => s.id)).toEqual([textId]);
  });
});
