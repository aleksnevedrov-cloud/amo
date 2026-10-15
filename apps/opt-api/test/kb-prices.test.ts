// RFD-AI-AGENT-OPT-KB, этап 3: цены из xlsx-прайса с предпросмотром, синонимы, приоритет «база → веб»,
// автопополнение из веб-поиска и правок менеджера, группировка веб-поиска по модели, дневной лимит, подпись источника.
import ExcelJS from 'exceljs';
import type { LlmGateway, RoutedRequest, RoutedResponse } from '@core/llm';
import type { OptAiProvider } from '@opt/kp';
import { KP_PRICE_ERROR_KIND, KP_PRICE_RESEARCH_KIND } from '@opt/kp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEAD_ID, setup, widgetToken } from './helpers.ts';

/** Заявка #30008823 (упрощённо): две модели, у ДПГ два размера. */
const letterAnswer = JSON.stringify({
  client: { org: 'ООО Стройоптпоставка', fio: '', email: 'stoptpostavka@yandex.ru', phone: '' },
  request_items: [
    { raw: 'Дверь ДПГ сота 800×2000 — 10 шт', name: 'ДПГ сота', width_mm: 800, height_mm: 2000, qty: 10 },
    { raw: 'Дверь ДПГ сота 900×2000 — 4 шт', name: 'ДПГ сота', width_mm: 900, height_mm: 2000, qty: 4 },
    { raw: 'Дверь глухая ламинированная сотовое заполнение 700×2000 — 2 шт', name: 'дверь глухая ламинированная сотовое заполнение', width_mm: 700, height_mm: 2000, qty: 2 },
    { raw: 'Дверь Турин 800×2000 — 3 шт', name: 'Турин', width_mm: 800, height_mm: 2000, qty: 3 },
    { raw: 'Дверь Турин 900×2100 — 1 шт', name: 'Турин', width_mm: 900, height_mm: 2100, qty: 1 },
  ],
  required_blocks: ['price'],
  questions: [],
});
const card = (model: string, w: number, h: number) => ({ kind: 'leaf', factory: 'Браво', model, collection: null, finish: 'экошпон', color: 'белый', glazing: null, heightMm: h, widthMm: w, leaves: 1, equipment: null, fireRating: null, standards: [] });
const SRC = [{ url: 'https://dveri-a.ru/turin' }, { url: 'https://dveri-b.ru/turin' }, { url: 'https://bravo.ru/turin' }];
const offer = (url: string, price: number) => ({ url, seller: new URL(url).host, title: 'Дверь Турин', price, currency: 'RUB', unit: 'piece', quantityInUnit: null, inStock: true, vatStated: 'included', vatRateStated: null, sourceKind: 'retail', includesDelivery: null, deliveryRub: null, factory: 'Браво', model: 'Турин', design: ['экошпон', 'белый'], standards: [], widthMm: 800, heightMm: 2000, kind: 'leaf', leaves: 1 });

function gateway() {
  const requests: RoutedRequest[] = [];
  let searches = 0;
  const llm: LlmGateway = {
    async chat(req, route) {
      requests.push(req);
      let text: string;
      if (req.webSearch) {
        searches += 1;
        text = JSON.stringify({ offers: [offer('https://dveri-a.ru/turin', 7800), offer('https://dveri-b.ru/turin', 8200), offer('https://bravo.ru/turin', 8000)] });
      } else if (req.outputSchema?.name === 'item_card') {
        const m = /Позиция: (.+)/.exec(String(req.messages[0]?.content ?? ''));
        const size = /(\d{3,4})×(\d{3,4})/.exec(String(req.messages[0]?.content ?? ''));
        text = JSON.stringify(card(m?.[1]?.trim() ?? 'x', Number(size?.[1] ?? 800), Number(size?.[2] ?? 2000)));
      } else text = letterAnswer;
      const res: RoutedResponse = {
        text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 500, outputTokens: 50, cachedInputTokens: 0, cacheWriteTokens: 0, ...(req.webSearch ? { webSearchCalls: 3 } : {}) },
        provider: route.primary.provider, model: route.primary.model, assistantMessage: { role: 'assistant', content: text }, latencyMs: 1, fallbackUsed: false, requested: route.primary, attempts: [], ...(req.webSearch ? { sources: SRC } : {}),
      };
      return res;
    },
    providers: async () => ['openai'],
    provider: async () => null,
  };
  const ai: OptAiProvider = async () => ({ llm, source: 'account', providers: ['openai'], keySources: { openai: 'account' } });
  return { ai, requests, searches: () => searches };
}

async function priceListXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Прайс');
  for (const r of [['Прайс Текона от 01.10.2026'], ['Наименование', 'Размер', 'Цена с НДС, руб.'], ['Ламинированные'], ['ДПГ сота', '800×2000', '3 450'], ['ДПГ сота', '900×2000', 3650], ['ДПО сота', '800×2000', 4100]]) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('база знаний опта: цены и синонимы → поиск цен в черновике', () => {
  const g = gateway();
  let ctx: Awaited<ReturnType<typeof setup>>;
  let headers: Record<string, string>;
  let draftId = 0;
  let priceSourceId = 0;

  beforeAll(async () => {
    ctx = await setup({ ai: g.ai });
    headers = { 'x-auth-token': await widgetToken() };
    await ctx.app.inject({ method: 'GET', url: '/oauth/amo/callback', query: { code: 'c', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
    ctx.amo.mail = { id: 5, created_at: 1_760_000_000, params: { income: true, subject: 'Заявка', text: 'Нужны двери', from: 'stoptpostavka@yandex.ru', attachments: [] } };
  });
  afterAll(() => ctx.close());

  it('прайс xlsx: предпросмотр с авто-колонками, импорт с фабрикой, датой и правилом нестандарта; список цен', async () => {
    const bytes = await priceListXlsx();
    const add = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/sources/file', headers, payload: { filename: 'прайс Текона.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBase64: bytes.toString('base64') } });
    priceSourceId = add.json().source.id;
    expect(add.json().source.status).toBe('indexed');
    const pv = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kb/sources/${priceSourceId}/prices/preview`, headers })).json();
    expect(pv).toMatchObject({ headerFound: true, mapping: { sheet: 'Прайс', model: 0, size: 1, price: 2, headerRow: 2 }, total: 3, skipped: 0 });
    expect(pv.columns.map((c: { header: string }) => c.header)).toEqual(['Наименование', 'Размер', 'Цена с НДС, руб.']);
    expect(pv.sample[0]).toMatchObject({ model: 'ДПГ сота', widthMm: 800, heightMm: 2000, price: 3450, section: 'Ламинированные' });
    const imp = await ctx.app.inject({ method: 'POST', url: `/widget/v1/kb/sources/${priceSourceId}/prices/import`, headers, payload: { mapping: pv.mapping, factory: 'Текона', validAt: '2026-10-01', vat: 'included', nonstandard: { heightPct: 15 } } });
    expect(imp.json()).toEqual({ imported: 3, skipped: 0 });
    const list = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/prices', headers })).json();
    expect(list.total).toBe(3);
    expect(list.items.map((p: { model: string; baseSize: string; price: number; factory: string; confidence: number; origin: string; sourceTitle: string }) => [p.model, p.baseSize, p.price, p.factory, p.confidence, p.origin, p.sourceTitle])).toEqual([
      ['ДПГ сота', '800×2000', 3450, 'Текона', 70, 'price_list', 'прайс Текона.xlsx'],
      ['ДПГ сота', '900×2000', 3650, 'Текона', 70, 'price_list', 'прайс Текона.xlsx'],
      ['ДПО сота', '800×2000', 4100, 'Текона', 70, 'price_list', 'прайс Текона.xlsx'],
    ]);
    // Не xlsx — предпросмотра нет.
    const txt = (await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/sources/text', headers, payload: { content: 'Скидка опт от 50 полотен — 12 %' } })).json().source.id;
    expect((await ctx.app.inject({ method: 'GET', url: `/widget/v1/kb/sources/${txt}/prices/preview`, headers })).statusCode).toBe(404);
  });

  it('синонимы: строка «каноническое = синоним = синоним», список, удаление', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/aliases', headers, payload: { lines: 'ДПГ сота = ДПГ + УПД (сота) = дверь глухая ламинированная сотовое заполнение\nмусор без знака равно' } });
    expect(r.statusCode).toBe(400);
    const ok = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/aliases', headers, payload: { lines: 'ДПГ сота = ДПГ + УПД (сота) = дверь глухая ламинированная сотовое заполнение' } });
    expect(ok.json().added).toBe(2);
    expect(ok.json().aliases.map((a: { alias: string; canonical: string }) => [a.alias, a.canonical])).toEqual([['дверь глухая ламинированная сотовое заполнение', 'ДПГ сота'], ['ДПГ + УПД (сота)', 'ДПГ сота']]);
    const one = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/aliases', headers, payload: { alias: 'ДПГ сотовое', canonical: 'ДПГ сота' } });
    expect(one.json().added).toBe(1);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/widget/v1/kb/aliases/${one.json().aliases.find((a: { alias: string }) => a.alias === 'ДПГ сотовое').id}`, headers })).json()).toEqual({ ok: true });
    expect((await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/aliases', headers })).json().aliases).toHaveLength(2);
  });

  it('«Собрать КП» + «Найти цены»: позиции из базы — без веб-вызовов, с подписью; нестандарт по правилу; синоним; Турин — один веб-поиск на модель, второй размер по площади; результат веб-поиска попал в базу с доверием 40', async () => {
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const d0 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    draftId = d0.id;
    expect(d0.items).toHaveLength(5);
    expect(g.searches()).toBe(0);
    const r = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId } });
    expect(r.json()).toEqual({ queued: [0, 1, 2, 3, 4] });
    // Веб-поиск — только по «Турин», и только один раз: вторая позиция той же модели — из кэша по модели с пересчётом по площади.
    expect(g.searches()).toBe(1);
    const d = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    const lines = d.items as { request_index: number; price: number | null; priceSource: string; priceLabel: string; priceStale: boolean; kbPriceId: number | null; market: { median: number } | null }[];
    expect(lines[0]).toMatchObject({ price: 3450, priceSource: 'kb', priceStale: false, priceLabel: `по базе: прайс Текона.xlsx (${new Date('2026-10-01T00:00:00Z').toLocaleDateString('ru-RU')})` });
    expect(lines[0]?.kbPriceId).toBeGreaterThan(0);
    expect(lines[1]).toMatchObject({ price: 3650, priceSource: 'kb' });
    // Синоним → ДПГ сота 700×2000: точного размера нет, правило нестандарта по высоте не сработало (высота та же) → пересчёт по площади от 800×2000.
    expect(lines[2]).toMatchObject({ priceSource: 'kb' });
    expect(lines[2]?.price).toBeCloseTo(3450 * (700 / 800), 2);
    // Турин 800×2000 — по рынку (медиана 8000); результат сразу записан в базу, поэтому Турин 900×2100 берётся уже из базы
    // (запись веб-поиска, доверие 40) с пересчётом по площади — без второго веб-поиска.
    expect(lines[3]).toMatchObject({ price: 8000, priceSource: 'research', market: { median: 8000 } });
    expect(lines[3]?.priceLabel).toMatch(/^по рынку \(/);
    expect(lines[4]?.price).toBeCloseTo(8000 * ((900 * 2100) / (800 * 2000)), 2);
    expect(lines[4]).toMatchObject({ priceSource: 'kb' });
    expect(lines[4]?.priceLabel).toMatch(/^по рынку \(/);
    const notes = (d.needsManager as { request_index: number; reason: string }[]).filter((n) => n.request_index === 2).map((n) => n.reason);
    expect(notes).toEqual([expect.stringContaining('цена из базы: пересчёт по площади с 800×2000'), 'цена из базы: по синониму: ДПГ сота']);
    // Журнал: три позиции из базы без веб-вызовов, расход только за веб-поиск по Турину.
    const journal = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/journal?kind=${KP_PRICE_RESEARCH_KIND}`, headers })).json().items as { summary: string; costUsd: number; details: { source?: string; cached?: boolean } }[];
    expect(journal.filter((j) => j.details.source === 'kb')).toHaveLength(4);
    expect(journal.filter((j) => j.details.source === 'kb').every((j) => j.summary.includes('из базы знаний') && j.summary.includes('веб-поиск не вызывался') && Number(j.costUsd) === 0)).toBe(true);
    expect(journal.filter((j) => j.details.source !== 'kb')).toHaveLength(1);
    const spent = journal.reduce((s, j) => s + Number(j.costUsd), 0);
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeLessThan(5);
    // Веб-результат — в kb_prices: Браво Турин 800×2000, медиана 8000, доверие 40.
    const prices = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/prices?q=турин', headers })).json();
    expect(prices.items.map((p: { model: string; factory: string; baseSize: string; price: number; confidence: number; origin: string }) => [p.model, p.factory, p.baseSize, p.price, p.confidence, p.origin])).toEqual([['Турин', 'Браво', '800×2000', 8000, 40, 'web']]);
    expect(SRC.map((x) => x.url)).toContain(prices.items[0].url);
  });

  it('«Собрать заново» + «Найти цены»: теперь и Турин из базы (запись веб-поиска), веб-вызовов нет; «искать заново» (force) идёт в интернет мимо базы', async () => {
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const d0 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(d0.id).not.toBe(draftId);
    draftId = d0.id;
    const before = g.searches();
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId } });
    expect(g.searches()).toBe(before);
    const d = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(d.items.every((l: { price: number | null; priceSource: string }) => l.price !== null && l.priceSource === 'kb')).toBe(true);
    expect(d.items[3]).toMatchObject({ price: 8000 });
    expect(d.items[3].priceLabel).toMatch(/^по рынку \(/);
    expect(d.items[4].price).toBeCloseTo(8000 * ((900 * 2100) / (800 * 2000)), 2);
    // Плитка «Искать в интернете»: force — веб-поиск несмотря на базу.
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId, requestIndexes: [3], force: true } });
    expect(g.searches()).toBe(before + 1);
  });

  it('правка менеджера попадает в базу с доверием 90 и перекрывает прайс; дневной лимит веб-поиска останавливает поиск с пометкой', async () => {
    const d = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    const items = d.items.map((l: { request_index: number; price: number }) => (l.request_index === 0 ? { ...l, price: 3300 } : l));
    const saved = (await ctx.app.inject({ method: 'PUT', url: `/widget/v1/kp/draft/${draftId}`, headers, payload: { items } })).json().draft;
    expect(saved.items[0]).toMatchObject({ price: 3300, priceSource: 'manager', priceLabel: 'изменено менеджером' });
    const prices = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/prices?q=дпг', headers })).json();
    expect(prices.items.find((p: { origin: string }) => p.origin === 'manager')).toMatchObject({ model: 'ДПГ сота', baseSize: '800×2000', price: 3300, confidence: 90 });
    // Новый черновик: ДПГ 800×2000 берёт цену менеджера (90 > 70).
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const d2 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: d2.id, requestIndexes: [0] } });
    const d3 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(d3.items[0]).toMatchObject({ price: 3300, priceSource: 'kb', priceLabel: 'изменено менеджером' });
    // Дневной лимит $0,001: уже потрачено больше — веб-поиск не запускается, пометка в блок, запись kp_price_error.
    await ctx.app.inject({ method: 'PUT', url: '/widget/v1/kp/settings', headers, payload: { constants: { webSearchDailyUsd: 0.001 } } });
    const before = g.searches();
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: d2.id, requestIndexes: [3], force: true } });
    expect(g.searches()).toBe(before);
    const d4 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(d4.needsManager.filter((n: { request_index: number }) => n.request_index === 3).map((n: { reason: string }) => n.reason)).toEqual(['цена не задана', expect.stringContaining('поиск цены: дневной лимит веб-поиска $0.001 исчерпан')]);
    const errors = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/journal?kind=${KP_PRICE_ERROR_KIND}`, headers })).json().items;
    expect(errors[0].summary).toContain('дневной лимит веб-поиска $0.001 исчерпан');
    // Удаление цены из базы и записи прайса целиком при удалении источника.
    expect((await ctx.app.inject({ method: 'DELETE', url: `/widget/v1/kb/prices/${prices.items[0].id}`, headers })).json()).toEqual({ ok: true });
    await ctx.app.inject({ method: 'DELETE', url: `/widget/v1/kb/sources/${priceSourceId}`, headers });
    const left = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/prices', headers })).json();
    // Цены прайса удалённого источника остаются (source_id → NULL), кроме удалённой руками; плюс web и manager.
    expect(left.items.every((p: { sourceTitle: string | null }) => p.sourceTitle === null)).toBe(true);
  });
});
