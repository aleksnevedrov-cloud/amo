// RFD-AI-AGENT-OPT-KB, этап 3: цены из xlsx-прайса с предпросмотром, синонимы, приоритет «база → веб»,
// автопополнение из веб-поиска и правок менеджера, группировка веб-поиска по модели, дневной лимит, подпись источника.
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import PizZip from 'pizzip';
import type { LlmGateway, RoutedRequest, RoutedResponse } from '@core/llm';
import type { OptAiProvider } from '@opt/kp';
import { KP_PRICE_ERROR_KIND, KP_PRICE_RESEARCH_KIND, resolveKpPath } from '@opt/kp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNT_ID, LEAD_ID, setup, widgetToken } from './helpers.ts';

/** Заявка #30008823 (упрощённо): две модели, у ДПГ два размера. */
const letter = {
  client: { org: 'ООО Стройоптпоставка', fio: '', email: 'stoptpostavka@yandex.ru', phone: '' },
  request_items: [
    { raw: 'Дверь ДПГ сота 800×2000 — 10 шт', name: 'ДПГ сота', width_mm: 800, height_mm: 2000, qty: 10 },
    { raw: 'Дверь ДПГ сота 900×2000 — 4 шт', name: 'ДПГ сота', width_mm: 900, height_mm: 2000, qty: 4 },
    { raw: 'Дверь глухая ламинированная сотовое заполнение 700×2000 — 2 шт', name: 'дверь глухая ламинированная сотовое заполнение', width_mm: 700, height_mm: 2000, qty: 2 },
    { raw: 'Дверь Турин 800×2000 — 3 шт', name: 'Турин', width_mm: 800, height_mm: 2000, qty: 3 },
    { raw: 'Дверь Турин 900×2100 — 1 шт', name: 'Турин', width_mm: 900, height_mm: 2100, qty: 1 },
  ],
  required_blocks: ['price'],
  questions: [] as string[],
};
const card = (model: string, w: number, h: number) => ({ kind: 'leaf', factory: 'Браво', model, collection: null, finish: 'экошпон', color: 'белый', glazing: null, heightMm: h, widthMm: w, leaves: 1, equipment: null, fireRating: null, standards: [] });
const SRC = [{ url: 'https://dveri-a.ru/turin' }, { url: 'https://dveri-b.ru/turin' }, { url: 'https://bravo.ru/turin' }];
const offer = (url: string, price: number) => ({ url, seller: new URL(url).host, title: 'Дверь Турин', price, currency: 'RUB', unit: 'piece', quantityInUnit: null, inStock: true, vatStated: 'included', vatRateStated: null, sourceKind: 'retail', includesDelivery: null, deliveryRub: null, factory: 'Браво', model: 'Турин', design: ['экошпон', 'белый'], standards: [], widthMm: 800, heightMm: 2000, kind: 'leaf', leaves: 1 });

function gateway() {
  const requests: RoutedRequest[] = [];
  let searches = 0;
  // Веб-предложения — по модели последней карточки позиции (чтобы не отвергались как «другая модель»), медиана web.price.
  const web = { model: 'Турин', price: 8000 };
  const llm: LlmGateway = {
    async chat(req, route) {
      requests.push(req);
      let text: string;
      if (req.webSearch) {
        searches += 1;
        text = JSON.stringify({ offers: [{ ...offer('https://dveri-a.ru/turin', web.price - 200), model: web.model }, { ...offer('https://dveri-b.ru/turin', web.price + 200), model: web.model }, { ...offer('https://bravo.ru/turin', web.price), model: web.model }] });
      } else if (req.outputSchema?.name === 'item_card') {
        const m = /Позиция: (.+)/.exec(String(req.messages[0]?.content ?? ''));
        const size = /(\d{3,4})×(\d{3,4})/.exec(String(req.messages[0]?.content ?? ''));
        web.model = m?.[1]?.trim() ?? 'x';
        text = JSON.stringify(card(web.model, Number(size?.[1] ?? 800), Number(size?.[2] ?? 2000)));
      } else text = JSON.stringify(letter);
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
  return { ai, requests, searches: () => searches, web };
}

/** Минимальный DOCX-шаблон: строки позиций и итог (как в opt-api.test.ts). */
function templateDocx(): string {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{{#items}}{{n}}. {{name}} — {{sum}}; {{/items}}итого {{grand_total}}</w:t></w:r></w:p></w:body></w:document>');
  return zip.generate({ type: 'base64' });
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
    // Файл распознан как прайс (шапка с моделью и ценой) — цены импортированы сразу при индексации (KB-PRICELIST, б): НДС по заголовку «с НДС».
    expect(add.json().source).toMatchObject({ status: 'indexed', prices: 3 });
    const auto = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/prices', headers })).json();
    expect(auto.total).toBe(3);
    expect(auto.items[0]).toMatchObject({ model: 'ДПГ сота', vat: 'included', origin: 'price_list', factory: null });
    const idx = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/journal?kind=kb_index', headers })).json().items as { summary: string }[];
    expect(idx.some((j) => j.summary === 'База знаний: из прайса «прайс Текона.xlsx» импортировано цен 3 автоматически')).toBe(true);
    const pv = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kb/sources/${priceSourceId}/prices/preview`, headers })).json();
    expect(pv).toMatchObject({ headerFound: true, isPriceList: true, vatHint: 'included', mapping: { sheet: 'Прайс', model: 0, size: 1, price: 2, abbr: null, description: null, headerRow: 2 }, total: 3, skipped: 0 });
    expect(pv.columns.map((c: { header: string }) => c.header)).toEqual(['Наименование', 'Размер', 'Цена с НДС, руб.']);
    expect(pv.sample[0]).toMatchObject({ model: 'ДПГ сота', widthMm: 800, heightMm: 2000, price: 3450, section: 'Ламинированные' });
    // Переимпорт с фабрикой, датой и правилом нестандарта из панели «Цены из прайса»: прежний прайс (автоимпорт) заменён.
    const imp = await ctx.app.inject({ method: 'POST', url: `/widget/v1/kb/sources/${priceSourceId}/prices/import`, headers, payload: { mapping: pv.mapping, factory: 'Текона', validAt: '2026-10-01', vat: 'included', nonstandard: { heightPct: 15 } } });
    expect(imp.json()).toEqual({ imported: 3, skipped: 0, replaced: 3 });
    expect((await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/sources', headers })).json().sources.find((x: { id: number }) => x.id === priceSourceId).prices).toBe(3);
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
    // KB-MATCH: ключ модели совпал и признаки (полотно, глухое) подошли → подпись «по прайсу: … (строка N)».
    expect(lines[0]).toMatchObject({ price: 3450, priceSource: 'kb', priceStale: false, priceLabel: 'по прайсу: ДПГ сота (строка 4)' });
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
    expect(prices.items.map((p: { model: string; factory: string; baseSize: string; price: number; confidence: number; origin: string }) => [p.model, p.factory, p.baseSize, p.price, p.confidence, p.origin])).toEqual([['Дверь Турин', 'Браво', '800×2000', 8000, 40, 'web']]);
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
    // KP-NAME: название позиции — как в письме («Дверь ДПГ сота»), ключ модели тот же.
    expect(prices.items.find((p: { origin: string }) => p.origin === 'manager')).toMatchObject({ model: 'Дверь ДПГ сота', baseSize: '800×2000', price: 3300, confidence: 90 });
    // Новый черновик: ДПГ 800×2000 — строка прайса выше правки менеджера при том же размере (KB-PRICELIST, д: прайс › менеджер › веб).
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const d2 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: d2.id, requestIndexes: [0] } });
    const d3 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(d3.items[0]).toMatchObject({ price: 3450, priceSource: 'kb', priceLabel: 'по прайсу: ДПГ сота (строка 4)' });
    // Дневной лимит $0,001: уже потрачено больше — веб-поиск не запускается, пометка в блок, запись kp_price_error.
    await ctx.app.inject({ method: 'PUT', url: '/widget/v1/kp/settings', headers, payload: { constants: { webSearchDailyUsd: 0.001 } } });
    const before = g.searches();
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: d2.id, requestIndexes: [3], force: true } });
    expect(g.searches()).toBe(before);
    const d4 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(d4.needsManager.filter((n: { request_index: number }) => n.request_index === 3).map((n: { reason: string }) => n.reason)).toEqual(['цена не задана', expect.stringContaining('поиск цены: дневной лимит веб-поиска $0.001 исчерпан')]);
    const errors = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/journal?kind=${KP_PRICE_ERROR_KIND}`, headers })).json().items;
    expect(errors[0].summary).toContain('дневной лимит веб-поиска $0.001 исчерпан');
    // Удаление цены из базы руками; удаление файла прайса удаляет все его цены (KB-PRICELIST, а), правки менеджера и веб-цены остаются.
    expect((await ctx.app.inject({ method: 'DELETE', url: `/widget/v1/kb/prices/${prices.items.find((p: { origin: string }) => p.origin === 'price_list').id}`, headers })).json()).toEqual({ ok: true });
    expect((await ctx.app.inject({ method: 'DELETE', url: `/widget/v1/kb/sources/${priceSourceId}`, headers })).json()).toEqual({ ok: true });
    const left = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/prices', headers })).json();
    expect(left.items.map((p: { origin: string }) => p.origin).sort()).toEqual(['manager', 'web']);
    expect(left.items.every((p: { sourceTitle: string | null; sourceId: number | null }) => p.sourceTitle === null)).toBe(true);
  });

  it('приёмка KB-MATCH (#30022107): веб-записи «модель = текст письма» остаются, но прайс с колонками признаков даёт три позиции по 23 900 ₽ «по прайсу: ДВ CPL (строка N)», веб-вызовов 0; «ДПГ + УПД, сота» → 8 800; алюминиевая дверь → веб; веб-цена вне диапазона прайса отброшена', async () => {
    const LETTER = 'Дверной блок деревянный внутренний глухой однопольный без порога распашной с доводчиком, внутренним механическим замком, облицовка CPL светлосерый';
    // Старые веб-цены по тем же позициям (как на проде до KB-MATCH): модель — текст письма, ключ совпадает дословно.
    const webA = await ctx.deps.kb.prices.upsert({ accountId: ACCOUNT_ID, model: `${LETTER} 1010×2100`, widthMm: 1010, heightMm: 2100, price: 5683, origin: 'web' });
    const webB = await ctx.deps.kb.prices.upsert({ accountId: ACCOUNT_ID, model: `${LETTER} 910×2100`, widthMm: 910, heightMm: 2100, price: 5120, origin: 'web' });
    // Прайс с колонками признаков: «Модель», «Сокращение», «Г/О», «Покрытие», «Материал», «Конструкция», «Назначение», «Огнестойкость».
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Прайс');
    for (const r of [
      ['Прайс ООО «Двери» от 10.10.2026'],
      ['№', 'Модель', 'Сокращение', 'Г/О', 'Покрытие', 'Материал', 'Конструкция', 'Назначение', 'Огнестойкость', 'Комплектация', 'Размер блока', 'Цена без НДС, руб.'],
      [3, 'ДПГ сота', 'ДПГ', 'Г', 'ламинат', 'МДФ', 'полотно однопольное', 'внутренняя', 'нет', '', '800×2000', 8800],
      [4, 'ДПО сота', 'ДПО', 'О', 'ламинат', 'МДФ', 'полотно однопольное', 'внутренняя', 'нет', '', '800×2000', 9900],
      [17, 'ДВ CPL', 'ДВ 1Рп Г ПрБ', 'Г', 'CPL 0,2 мм', 'дерево', 'полнозаполненная, однопольная, распашная, без порога', 'внутренняя, общественные помещения', 'нет', 'коробка, 3 петли, уплотнитель, замок, ручки, доводчик', 'Блок Ш×В: 1010×2100; 910×2100', '23 900'],
      [18, 'ДВ ПВХ', 'ДВ 1Рп О', 'О', 'ПВХ', 'дерево', 'однопольная, распашная, с порогом', 'внутренняя', 'нет', '', '910×2100', 19900],
    ]) ws.addRow(r);
    const add = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/sources/file', headers, payload: { filename: 'прайс 475.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBase64: Buffer.from(await wb.xlsx.writeBuffer()).toString('base64') } });
    expect(add.json().source).toMatchObject({ status: 'indexed', prices: 5 });
    const list = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/prices?limit=100', headers })).json();
    expect(list.items.filter((p: { origin: string }) => p.origin === 'price_list').map((p: { model: string; baseSize: string; featureKey: string; sourceRow: number }) => [p.model, p.baseSize, p.featureKey, p.sourceRow])).toEqual([
      ['ДВ CPL', '1010×2100', 'block|wood|solid|cpl|*', 5],
      ['ДВ CPL', '910×2100', 'block|wood|solid|cpl|*', 5],
      ['ДВ ПВХ', '910×2100', 'block|wood|glazed|pvc|*', 6],
      ['ДПГ сота', '800×2000', 'leaf|wood|solid|laminate|*', 3],
      ['ДПО сота', '800×2000', 'leaf|wood|glazed|laminate|*', 4],
    ]);
    // «Собрать заново» → «Найти цены»: три позиции письма (как в сделке #30022107), модель разбора называет признаки явно.
    const features = { type: 'block', material: 'wood', glazing: 'solid', leaves: 1, threshold: 'without', opening: 'swing', coating: 'cpl', fire: null, closer: true, lock: true };
    letter.request_items = [
      { raw: `${LETTER} 1010×2100 — 1 шт`, name: LETTER, width_mm: 1010, height_mm: 2100, qty: 1, features } as (typeof letter.request_items)[number],
      { raw: `${LETTER} 910×2100 — 1 шт`, name: LETTER, width_mm: 910, height_mm: 2100, qty: 1, features } as (typeof letter.request_items)[number],
      { raw: `${LETTER} 910×2100 — 1 шт`, name: LETTER, width_mm: 910, height_mm: 2100, qty: 1 },
    ];
    await ctx.app.inject({ method: 'PUT', url: '/widget/v1/kp/settings', headers, payload: { constants: { webSearchDailyUsd: 5 } } });
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const d0 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(d0.items).toHaveLength(3);
    const before = g.searches();
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: d0.id } });
    expect(g.searches()).toBe(before);
    const d = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(d.items.map((l: { price: number; priceSource: string; priceLabel: string }) => [l.price, l.priceSource, l.priceLabel])).toEqual([
      [23900, 'kb', 'по прайсу: ДВ CPL (строка 5)'],
      [23900, 'kb', 'по прайсу: ДВ CPL (строка 5)'],
      [23900, 'kb', 'по прайсу: ДВ CPL (строка 5)'],
    ]);
    const notes = (d.needsManager as { request_index: number; reason: string }[]).map((n) => `${n.request_index}: ${n.reason}`);
    for (const i of [0, 1, 2]) expect(notes).toContain(`${i}: цена из базы: по прайсу: ДВ CPL (строка 5) — совпали: дверной блок, деревянный, глухой, однопольный, без порога, распашной, CPL`);
    // KP-NAME: полное название клиента, модель и покрытие из прайса, комплектация, «цвет уточнить» (в строке прайса цвета нет).
    expect(d.items.map((l: { name: string; priceModel: string; equipment: string | null }) => [l.name, l.priceModel, l.equipment])).toEqual([
      [LETTER, 'ДВ CPL 0,2 мм', 'коробка, 3 петли, уплотнитель, замок, ручки, доводчик'],
      [LETTER, 'ДВ CPL 0,2 мм', 'коробка, 3 петли, уплотнитель, замок, ручки, доводчик'],
      [LETTER, 'ДВ CPL 0,2 мм', 'коробка, 3 петли, уплотнитель, замок, ручки, доводчик'],
    ]);
    for (const i of [0, 1, 2]) expect(notes).toContain(`${i}: цвет уточнить: в письме «светло-серый», в строке прайса ДВ CPL (строка 5) цвет не указан`);
    // «Собрать документ»: в DOCX три строки с полным названием, «по прайсу: ДВ CPL 0,2 мм», комплектация под первой, итог 71 700 ₽.
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/template', headers, payload: { filename: 'kp.docx', contentBase64: templateDocx() } });
    const built = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/build', headers, payload: { draftId: d0.id } });
    expect(built.json()).toMatchObject({ draft: { status: 'built', hasDocx: true } });
    const doc = await ctx.deps.kp.byId(ACCOUNT_ID, d0.id);
    const xml = new PizZip(readFileSync(resolveKpPath(ctx.deps.filesRoot, doc!.docxPath!))).file('word/document.xml')!.asText().replace(/\u00a0/g, ' ');
    const text = xml.replace(/<w:br\s*\/>/g, '\n').replace(/<[^>]+>/g, '');
    const row = `${LETTER} — по прайсу: ДВ CPL 0,2 мм\nКомплектация: коробка, 3 петли, уплотнитель, замок, ручки, доводчик — 23 900 ₽`;
    expect(text).toContain(`1. ${row}; 2. ${row}; 3. ${row}; итого 71 700 ₽`);
    expect(xml).toContain('<w:br/>');
    const journal = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/journal?kind=${KP_PRICE_RESEARCH_KIND}`, headers })).json().items as { summary: string; details: { draftId: number; match?: string; webSearchCalls?: number } }[];
    const mine = journal.filter((j) => j.details.draftId === d0.id);
    expect(mine).toHaveLength(3);
    expect(mine.every((j) => j.summary.includes('веб-поиск не вызывался') && j.details.webSearchCalls === 0 && j.details.match === 'features')).toBe(true);
    // Ничего не удалено: старые веб-записи на месте, просто не используются.
    expect((await ctx.deps.kb.prices.byId(ACCOUNT_ID, webA))?.price).toBe(5683);
    expect((await ctx.deps.kb.prices.byId(ACCOUNT_ID, webB))?.price).toBe(5120);
    // Заявка «ДПГ + УПД, сота 2000×800» → строка прайса ДПГ 8 800; алюминиевая дверь → в прайсе нет → веб (один вызов).
    g.web.price = 15_000;
    letter.request_items = [
      { raw: 'ДПГ + УПД, сота 2000×800 — 5 шт', name: 'ДПГ + УПД, сота', width_mm: 800, height_mm: 2000, qty: 5 },
      { raw: 'Дверь алюминиевая остеклённая 800×2000 — 1 шт', name: 'Дверь алюминиевая остеклённая', width_mm: 800, height_mm: 2000, qty: 1 },
    ];
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const e0 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: e0.id } });
    expect(g.searches()).toBe(before + 1);
    const e = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(e.items[0]).toMatchObject({ price: 8800, priceSource: 'kb', priceLabel: 'по прайсу: ДПГ сота (строка 3)' });
    expect(e.items[1]).toMatchObject({ price: 15_000, priceSource: 'research' });
    expect(e.items[1].priceLabel).toMatch(/^по рынку \(/);
    // Веб-результат записан с признаками (алюминиевая, остеклённая), а не просто текстом письма.
    const alu = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/prices?q=алюмин', headers })).json().items as { origin: string; features: { material: string; glazing: string }; featureKey: string }[];
    expect(alu.filter((p) => p.origin === 'web')).toMatchObject([{ features: { material: 'aluminium', glazing: 'glazed' }, featureKey: '*|aluminium|glazed|*|*' }]);
    // Реалистичность: «Дверь CPL белая» — по признакам к строке прайса не подходит (только покрытие), но группа CPL в прайсе есть
    // (медиана 23 900); веб даёт 8 000 (< 40 %) → цена отброшена, в базу не записана, в журнале kp_price_error.
    g.web.price = 8000;
    letter.request_items = [{ raw: 'Дверь CPL белая 800×2000 — 1 шт', name: 'Дверь CPL белая', width_mm: 800, height_mm: 2000, qty: 1 }];
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const f0 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: f0.id } });
    expect(g.searches()).toBe(before + 2);
    const f = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(f.items[0]).toMatchObject({ price: null });
    expect((f.needsManager as { reason: string }[]).map((n) => n.reason)).toContain('поиск цены: веб-цена 8\u00a0000 ₽ отброшена: вне диапазона прайса (медиана прайса по группе 23\u00a0900 ₽, допустимо 40–300 %); добавьте цену в базу знаний или введите руками');
    const errors = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/journal?kind=${KP_PRICE_ERROR_KIND}`, headers })).json().items as { summary: string; details: { reason?: string; webMedian?: number; priceListMedian?: number } }[];
    expect(errors[0]).toMatchObject({ summary: 'Цена не найдена: Дверь CPL белая, 800×2000 мм — веб-цена 8\u00a0000 ₽ отброшена: вне диапазона прайса (медиана по группе 23\u00a0900 ₽)', details: { reason: 'web_price_unrealistic', webMedian: 8000, priceListMedian: 23900 } });
    expect((await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/prices?q=белая', headers })).json().items).toEqual([]);
  });

  it('приёмка #30022107: прайс с «ДВ CPL», «Сокращение в названии», «Назначение/Конструкция» и двумя размерами в ячейке → три позиции по 23 900 ₽ «по базе: прайс», веб-вызовов 0; второй прайс заменяет первый', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Прайс');
    for (const r of [
      ['Прайс ООО «Двери» от 10.10.2026'],
      ['№', 'Сокращение в названии', 'Наименование', 'Назначение/Конструкция', 'Размер блока', 'Цена без НДС, руб.'],
      [17, 'ДВ CPL', 'Дверь внутренняя CPL', 'Дверной блок деревянный внутренний глухой однопольный без порога, покрытие CPL', 'Блок Ш×В: 1010×2100; 910×2100. Проход ≥800 мм — подтвердить чертежом.', '23 900'],
      [18, 'ДВ ПВХ', 'Дверь внутренняя ПВХ', 'Дверной блок деревянный внутренний остеклённый однопольный с порогом, покрытие ПВХ', '910×2100', 19900],
    ]) ws.addRow(r);
    const bytes = Buffer.from(await wb.xlsx.writeBuffer());
    const add = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/sources/file', headers, payload: { filename: 'прайс ДВ.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBase64: bytes.toString('base64') } });
    expect(add.json().source).toMatchObject({ status: 'indexed', prices: 3 });
    const list = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/prices?q=cpl', headers })).json();
    expect(list.items.filter((p: { origin: string }) => p.origin === 'price_list').map((p: { baseSize: string; price: number; vat: string; abbr: string; sourceRow: number }) => [p.baseSize, p.price, p.vat, p.abbr, p.sourceRow])).toEqual([['1010×2100', 23900, 'no_vat', 'ДВ CPL', 3], ['910×2100', 23900, 'no_vat', 'ДВ CPL', 3]]);
    // Письмо клиента: названия из «Назначения», три позиции.
    letter.request_items = [
      { raw: 'Дверной блок деревянный внутренний глухой однопольный без порога, покрытие CPL 1010×2100 — 1 шт', name: 'Дверной блок деревянный внутренний глухой однопольный без порога, покрытие CPL', width_mm: 1010, height_mm: 2100, qty: 1 },
      { raw: 'Дверной блок деревянный внутренний глухой однопольный без порога, покрытие CPL 910×2100 — 2 шт', name: 'Дверной блок деревянный внутренний глухой однопольный без порога, покрытие CPL', width_mm: 910, height_mm: 2100, qty: 2 },
      { raw: 'Дверной блок деревянный глухой однопольный CPL без порога 910×2100 — 1 шт', name: 'Дверной блок деревянный глухой однопольный CPL без порога', width_mm: 910, height_mm: 2100, qty: 1 },
    ];
    await ctx.app.inject({ method: 'PUT', url: '/widget/v1/kp/settings', headers, payload: { constants: { webSearchDailyUsd: 5 } } });
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const d0 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(d0.items).toHaveLength(3);
    const before = g.searches();
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: d0.id } });
    expect(g.searches()).toBe(before);
    const d = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(d.items.map((l: { price: number; priceSource: string; priceLabel: string }) => [l.price, l.priceSource, l.priceLabel])).toEqual([
      [23900, 'kb', 'по прайсу: Дверь внутренняя CPL (строка 3)'],
      [23900, 'kb', 'по прайсу: Дверь внутренняя CPL (строка 3)'],
      [23900, 'kb', 'по прайсу: Дверь внутренняя CPL (строка 3)'],
    ]);
    const notes = (d.needsManager as { request_index: number; reason: string }[]).map((n) => `${n.request_index}: ${n.reason}`);
    for (const i of [0, 1, 2]) expect(notes).toContain(`${i}: цена из базы: по прайсу: Дверь внутренняя CPL (строка 3) — совпали: дверной блок, деревянный, глухой, однопольный, без порога, CPL`);
    // Новый прайс заменяет прежний: загружаем файл с другой ценой — в базе только он.
    const wb2 = new ExcelJS.Workbook();
    const ws2 = wb2.addWorksheet('Прайс');
    for (const r of [['Наименование', 'Размер', 'Цена с НДС'], ['ДВ CPL', '1010×2100', 24900]]) ws2.addRow(r);
    const add2 = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/sources/file', headers, payload: { filename: 'прайс ДВ v2.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBase64: Buffer.from(await wb2.xlsx.writeBuffer()).toString('base64') } });
    expect(add2.json().source).toMatchObject({ status: 'indexed', prices: 1 });
    const after = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/prices', headers })).json();
    expect(after.items.filter((p: { origin: string }) => p.origin === 'price_list').map((p: { model: string; price: number; sourceTitle: string }) => [p.model, p.price, p.sourceTitle])).toEqual([['ДВ CPL', 24900, 'прайс ДВ v2.xlsx']]);
    const sources = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/sources', headers })).json().sources as { title: string; prices: number }[];
    expect(sources.find((x) => x.title === 'прайс ДВ.xlsx')?.prices).toBe(0);
    expect(sources.find((x) => x.title === 'прайс ДВ v2.xlsx')?.prices).toBe(1);
    // Удаление файла прайса не падает и уносит его цены.
    const src2 = (sources as unknown as { id: number; title: string }[]).find((x) => x.title === 'прайс ДВ v2.xlsx')!.id;
    expect((await ctx.app.inject({ method: 'DELETE', url: `/widget/v1/kb/sources/${src2}`, headers })).json()).toEqual({ ok: true });
    expect((await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/prices', headers })).json().items.some((p: { origin: string }) => p.origin === 'price_list')).toBe(false);
  });
});
