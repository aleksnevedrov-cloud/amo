// KB-ALIASES-UI: синонимы постранично — счётчики по прайсам, страница не больше 50 строк, поиск без регистра и ё/е по
// синониму, модели и ID; добавление и удаление вручную — как раньше; подбор по синониму не меняется.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookXlsx, interiorBook, onyxBook } from '../../../packages/opt/kb/test/fixtures/price-book.ts';
import { ACCOUNT_ID, setup, widgetToken } from './helpers.ts';

type Alias = { id: number; alias: string; canonical: string; productId: string | null; sourceId: number | null };
type Page = { aliases: Alias[]; total: number; offset: number; limit: number; groups: { sourceId: number; title: string; count: number }[]; all: number };

describe('синонимы постранично (KB-ALIASES-UI)', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let headers: Record<string, string>;
  let onyx = 0;
  let inner = 0;
  const get = async (qs: string) => (await ctx.app.inject({ url: `/widget/v1/kb/aliases?${qs}`, headers })).json() as Page;
  const upload = async (filename: string, sheets: Record<string, unknown[][]>) =>
    (await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/sources/file', headers, payload: { filename, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBase64: (await bookXlsx(sheets)).toString('base64') } })).json().source.id as number;

  beforeAll(async () => {
    ctx = await setup();
    headers = { 'x-auth-token': await widgetToken() };
    await ctx.app.inject({ method: 'GET', url: '/oauth/amo/callback', query: { code: 'c', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
    onyx = await upload('Оникс.xlsx', onyxBook());
    inner = await upload('Межкомнатные двери.xlsx', interiorBook());
    // Как у настоящего Оникса — тысячи синонимов у одного прайса: ещё 120 к той же модели.
    for (let i = 1; i <= 120; i += 1) await ctx.deps.kb.aliases.add(ACCOUNT_ID, `Оникс вариант ${String(i).padStart(3, '0')}`, 'Оникс Модель Классик', { sourceId: onyx });
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/aliases', headers, payload: { lines: 'Ёлочка = дверь ёлка' } });
  });
  afterAll(() => ctx.close());

  it('счётчики по прайсам без строк (limit=0): «Оникс.xlsx — N», «Межкомнатные двери.xlsx — N», «Добавлены вручную»; all — сумма', async () => {
    const r = await get('limit=0');
    expect(r.aliases).toEqual([]);
    const byId = new Map(r.groups.map((g) => [g.sourceId, g]));
    expect(byId.get(onyx)).toMatchObject({ title: 'Оникс.xlsx' });
    expect(byId.get(onyx)!.count).toBeGreaterThan(120);
    expect(byId.get(inner)).toMatchObject({ title: 'Межкомнатные двери.xlsx' });
    expect(byId.get(0)).toEqual({ sourceId: 0, title: 'Добавлены вручную', count: 1 });
    expect(r.all).toBe(r.groups.reduce((n, g) => n + g.count, 0));
  });

  it('страница группы — не больше 50 строк даже при limit=1000; «Ещё 50» — следующие без повторов', async () => {
    const total = (await get('limit=0')).groups.find((g) => g.sourceId === onyx)!.count;
    const p1 = await get(`source_id=${onyx}&offset=0&limit=1000`);
    expect(p1.aliases).toHaveLength(50);
    expect(p1).toMatchObject({ total, offset: 0, limit: 50 });
    expect(p1.aliases.every((a) => a.sourceId === onyx)).toBe(true);
    const p2 = await get(`source_id=${onyx}&offset=50&limit=50`);
    expect(p2.aliases).toHaveLength(50);
    expect(p2.aliases.some((a) => p1.aliases.some((b) => b.id === a.id))).toBe(false);
    const last = await get(`source_id=${onyx}&offset=${total - 3}&limit=50`);
    expect(last.aliases).toHaveLength(3);
  });

  it('поиск «авангард» — только синонимы ONX-0001 «Оникс Авангард наборный шпон», чужих нет; без регистра; по ID; ё = е', async () => {
    const r = await get('q=авангард&limit=50');
    expect(r.aliases.length).toBeGreaterThan(0);
    expect(r.groups.map((g) => g.sourceId)).toEqual([onyx]);
    for (const a of r.aliases) expect(`${a.alias} ${a.canonical} ${a.productId ?? ''}`.toLowerCase()).toContain('авангард');
    expect(r.aliases.some((a) => a.productId === 'ONX-0001')).toBe(true);
    expect((await get('q=АВАНГАРД')).total).toBe(r.total);
    const byId = await get('q=onx-0001');
    expect(byId.aliases.length).toBeGreaterThan(0);
    expect(byId.aliases.every((a) => a.productId === 'ONX-0001')).toBe(true);
    expect((await get('q=елоч')).aliases.map((a) => a.alias)).toEqual(['дверь ёлка']);
    expect((await get('q=%25')).total).toBe(0);
    expect((await get(`source_id=${inner}&q=авангард`)).total).toBe(0);
  });

  it('добавленные вручную — группа 0; удаление — как раньше; подбор по синониму не меняется', async () => {
    const manual = await get('source_id=0');
    expect(manual.aliases.map((a) => [a.alias, a.canonical])).toEqual([['дверь ёлка', 'Ёлочка']]);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/widget/v1/kb/aliases/${manual.aliases[0]!.id}`, headers })).json()).toEqual({ ok: true });
    expect((await get('source_id=0')).total).toBe(0);
    expect((await ctx.deps.kb.aliases.resolve(ACCOUNT_ID, 'оникс вариант 007'))?.canonical).toBe('Оникс Модель Классик');
  });
});
