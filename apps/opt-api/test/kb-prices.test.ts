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
  // Как у заказчика (KP-LAYOUT): строки в таблице, после неё разрыв страницы, «{{grand_total}} ₽» со своим знаком рубля.
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>{{#items}}{{n}}. {{name}} — {{sum}}; {{/items}}</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:br w:type="page"/></w:r></w:p><w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>{{total_qty}}; итого {{grand_total}} ₽</w:t></w:r></w:p></w:body></w:document>');
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
    expect(idx.some((j) => j.summary === 'База знаний: из прайса «прайс Текона.xlsx» импортировано цен 3 автоматически (прайс «Текона»)')).toBe(true);
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
    expect(r.json()).toMatchObject({ queued: [0, 1, 2, 3, 4] });
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
    // KP-LAYOUT: ячейка в три уровня — короткое название по прайсу (без «по прайсу»), комплектация, обозначение заказчика (его строка);
    // в шаблоне без {{equipment}} / {{designation}} — строками под названием. Итог один раз с ₽, разрыв страницы перед плашкой убран.
    const row = (w: number) => `Дверной блок ДВ CPL 0,2 мм, глухой, светло-серый\nКомплектация: коробка, 3 петли, уплотнитель, замок, ручки, доводчик\nОбозначение заказчика: ${LETTER} ${w}×2100 — 1 шт — 23 900 ₽`;
    expect(text).toContain(`1. ${row(1010)}; 2. ${row(910)}; 3. ${row(910)}; `);
    expect(text).toContain('3 позиции; итого 71 700 ₽');
    expect(text).not.toContain('₽ ₽');
    expect(text).not.toContain('по прайсу');
    expect(xml).toContain('<w:br/>');
    expect(xml).not.toContain('w:type="page"');
    expect(xml).not.toContain('pageBreakBefore');
    const log = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/journal?kind=kp_build', headers })).json().items as { summary: string; details: { currencyStripped: string[]; pageBreaksRemoved: number } }[];
    expect(log[0]?.summary).toContain('в шаблоне нет {{equipment}} / {{designation}} — комплектация и обозначение заказчика добавлены строками под названием');
    expect(log[0]?.summary).toContain('в шаблоне знак ₽ стоит после {{grand_total}} — из значений убран');
    expect(log[0]?.summary).toContain('разрывов страницы после таблицы убрано: 2');
    expect(log[0]?.details).toMatchObject({ currencyStripped: ['grand_total'], pageBreaksRemoved: 2 });
    expect(d.items.map((l: { priceAbbr: string | null }) => l.priceAbbr)).toEqual(['ДВ 1Рп Г ПрБ', 'ДВ 1Рп Г ПрБ', 'ДВ 1Рп Г ПрБ']);
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
    expect((f.needsManager as { reason: string }[]).map((n) => n.reason)).toContain('поиск цены: веб-цена 8\u00a0000 ₽ отброшена: вне диапазона прайса (медиана прайса по группе «двери» 23\u00a0900 ₽, допустимо 40–300 %); добавьте цену в базу знаний или введите руками');
    const errors = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/journal?kind=${KP_PRICE_ERROR_KIND}`, headers })).json().items as { summary: string; details: { reason?: string; webMedian?: number; priceListMedian?: number } }[];
    expect(errors[0]).toMatchObject({ summary: 'Цена не найдена: Дверь CPL белая, 800×2000 мм — веб-цена 8\u00a0000 ₽ отброшена: вне диапазона прайса (медиана по группе 23\u00a0900 ₽)', details: { reason: 'web_price_unrealistic', webMedian: 8000, priceListMedian: 23900 } });
    expect((await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/prices?q=белая', headers })).json().items).toEqual([]);
  });

  it('приёмка #30022107: прайс с «ДВ CPL», «Сокращение в названии», «Назначение/Конструкция» и двумя размерами в ячейке → три позиции по 23 900 ₽ «по базе: прайс», веб-вызовов 0; второй прайс заменяет первый', async () => {
    // KB-MULTIPRICE: прайс «475» из прошлого теста — другой ключ, сам не затирается; убираем его, чтобы остался один прайс.
    const prev = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/sources', headers })).json().sources as { id: number; title: string }[];
    for (const sId of prev.filter((x) => x.title === 'прайс 475.xlsx').map((x) => x.id)) expect((await ctx.app.inject({ method: 'DELETE', url: `/widget/v1/kb/sources/${sId}`, headers })).json()).toEqual({ ok: true });
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

  it('приёмка KB-MULTIPRICE: два прайса рядом (54 + 21), ДВ CPL из межкомнатных → 23 900; перезаливка металлических с тем же ключом не трогает межкомнатные («обновлён: было, стало; удалено, добавлено»); удаление металлических — межкомнатные на месте', async () => {
    // Чистая база прайсов: файл «прайс 475» из прошлого теста убираем.
    const before = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/sources', headers })).json().sources as { id: number; title: string }[];
    for (const sId of before.filter((x) => x.title === 'прайс 475.xlsx').map((x) => x.id)) await ctx.app.inject({ method: 'DELETE', url: `/widget/v1/kb/sources/${sId}`, headers });
    const header = ['Модель', 'Сокращение', 'Г/О', 'Покрытие', 'Материал', 'Конструкция', 'Размер блока', 'Цена без НДС, руб.'];
    const innerRows = (price: number) => [
      header,
      ['ДВ CPL', 'ДВ 1Рп Г ПрБ', 'Г', 'CPL 0,2 мм', 'дерево', 'однопольная, распашная, без порога', 'Блок Ш×В: 1010×2100; 910×2100', price],
      ...Array.from({ length: 52 }, (_, i) => [`ДВ ПВХ ${i + 1}`, 'ДВ 1Рп О', 'О', 'ПВХ', 'дерево', 'однопольная, распашная, с порогом', `${700 + i}×2100`, 19_900 + i]),
    ];
    const metalRows = (n: number, price: number) => [header, ...Array.from({ length: n }, (_, i) => [`ДМ EI60 ${i + 1}`, 'ДМ', 'Г', 'порошковая окраска', 'сталь', 'однопольная, распашная, с порогом', `${800 + i}×2100`, price + i])];
    const upload = async (filename: string, rows: unknown[][]) => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Прайс');
      for (const r of rows) ws.addRow(r);
      return (await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/sources/file', headers, payload: { filename, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBase64: Buffer.from(await wb.xlsx.writeBuffer()).toString('base64') } })).json().source as { id: number; prices: number; priceKey: string; priceTitle: string; priceImport: { title: string; updated: boolean; was: number; imported: number; removed: number; added: number } };
    };
    const inner = await upload('Прайс_межкомнатные_двери_ГОСТ.xlsx', innerRows(23_900));
    expect(inner).toMatchObject({ prices: 54, priceKey: 'прайс межкомнатные двери гост', priceTitle: 'Межкомнатные', priceImport: { title: 'Межкомнатные', updated: false, was: 0, imported: 54, removed: 0, added: 54 } });
    const metal = await upload('Прайс_металлические_двери_ГОСТ.xlsx', metalRows(21, 40_000));
    expect(metal).toMatchObject({ prices: 21, priceTitle: 'Металлические', priceImport: { updated: false, imported: 21 } });
    // Оба прайса рядом: 54 + 21.
    const sources = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/sources', headers })).json().sources as { id: number; prices: number; priceTitle: string | null }[];
    expect(sources.filter((x) => x.prices > 0).map((x) => [x.priceTitle, x.prices])).toEqual(expect.arrayContaining([['Межкомнатные', 54], ['Металлические', 21]]));
    const all = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/prices?limit=1000', headers })).json().items as { origin: string; priceTitle: string | null }[];
    const byList = (rows: typeof all) => rows.filter((p) => p.origin === 'price_list').reduce<Record<string, number>>((m, p) => ({ ...m, [p.priceTitle ?? '?']: (m[p.priceTitle ?? '?'] ?? 0) + 1 }), {});
    expect(byList(all)).toEqual({ Межкомнатные: 54, Металлические: 21 });
    // #30022107: «Собрать заново» → «Найти цены» → три позиции по 23 900 «по прайсу: ДВ CPL».
    const LETTER = 'Дверной блок деревянный внутренний глухой однопольный без порога распашной с доводчиком, внутренним механическим замком, облицовка CPL светлосерый';
    letter.request_items = [
      { raw: `${LETTER} 1010×2100 — 1 шт`, name: LETTER, width_mm: 1010, height_mm: 2100, qty: 1 },
      { raw: `${LETTER} 910×2100 — 1 шт`, name: LETTER, width_mm: 910, height_mm: 2100, qty: 1 },
      { raw: `${LETTER} 910×2100 — 1 шт`, name: LETTER, width_mm: 910, height_mm: 2100, qty: 1 },
    ];
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const d0 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    const searches = g.searches();
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: d0.id } });
    expect(g.searches()).toBe(searches);
    const d = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(d.items.map((l: { price: number; priceLabel: string }) => [l.price, l.priceLabel])).toEqual([[23_900, 'по прайсу: ДВ CPL (строка 2)'], [23_900, 'по прайсу: ДВ CPL (строка 2)'], [23_900, 'по прайсу: ДВ CPL (строка 2)']]);
    // Перезаливка металлических файлом с тем же ключом (другое имя): 21 → 23, одна модель ушла, три добавились; межкомнатные не тронуты.
    const metal2 = await upload('Прайс_металлические_двери_ГОСТ — обновил 16102026.xlsx', [header, ...metalRows(20, 41_000).slice(1), ['ДМ EI30', 'ДМ', 'Г', 'порошковая окраска', 'сталь', 'однопольная', '900×2000', 35_000], ['ДМ EI90', 'ДМ', 'Г', 'порошковая окраска', 'сталь', 'однопольная', '900×2000', 55_000], ['ДМ EI90 2Рп', 'ДМ', 'Г', 'порошковая окраска', 'сталь', 'двупольная', '1300×2000', 75_000]]);
    expect(metal2).toMatchObject({ prices: 23, priceKey: 'прайс металлические двери гост', priceTitle: 'Металлические', priceImport: { title: 'Металлические', updated: true, was: 21, imported: 23, removed: 1, added: 3 } });
    const after = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/prices?limit=1000', headers })).json().items as typeof all;
    expect(byList(after)).toEqual({ Межкомнатные: 54, Металлические: 23 });
    expect(after.filter((p) => p.origin === 'price_list' && p.priceTitle === 'Металлические').every((p) => (p as unknown as { sourceId: number }).sourceId === metal2.id)).toBe(true);
    const sources2 = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/sources', headers })).json().sources as { id: number; prices: number }[];
    expect(sources2.find((x) => x.id === metal.id)?.prices).toBe(0);
    expect(sources2.find((x) => x.id === inner.id)?.prices).toBe(54);
    const journal = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/journal?kind=kb_index', headers })).json().items as { summary: string }[];
    expect(journal.some((j) => j.summary.includes('прайс «Металлические» обновлён: было 21, стало 23; удалено 1, добавлено 3'))).toBe(true);
    // Удаление металлических (нового и старого файла) — межкомнатные на месте.
    expect((await ctx.app.inject({ method: 'DELETE', url: `/widget/v1/kb/sources/${metal2.id}`, headers })).json()).toEqual({ ok: true });
    expect((await ctx.app.inject({ method: 'DELETE', url: `/widget/v1/kb/sources/${metal.id}`, headers })).json()).toEqual({ ok: true });
    const left = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/prices?limit=1000', headers })).json().items as typeof all;
    expect(byList(left)).toEqual({ Межкомнатные: 54 });
  });

  it('KP-REBUILD-MAIL, п. 2: пересборка без единой позиции не затирает рабочий черновик — прежний остаётся с пометкой, причина в журнале; пересборка с позициями создаёт новый', async () => {
    const before = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(before.items.length).toBeGreaterThan(0);
    // Письмо разобралось в ноль позиций (как при таймауте IMAP и пустой карточке).
    letter.request_items = [];
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const kept = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(kept.id).toBe(before.id);
    expect(kept.items.map((l: { name: string }) => l.name)).toEqual(before.items.map((l: { name: string }) => l.name));
    const notes = (kept.needsManager as { request_index: number; reason: string }[]).filter((n) => n.request_index === -1).map((n) => n.reason);
    expect(notes.some((n) => /^пересборка \d{2}\.\d{2}, \d{2}:\d{2} без позиций \(позиции не найдены ни в файлах, ни в письме\) — черновик сохранён$/.test(n))).toBe(true);
    const errors = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/journal?kind=kp_error', headers })).json().items as { summary: string; details: { keptDraft?: boolean; draftId?: number } }[];
    expect(errors[0]).toMatchObject({ summary: `Черновик ${before.id} сохранён: пересборка не дала ни одной позиции (позиции не найдены ни в файлах, ни в письме); прежний черновик с позициями (${before.items.length}) не заменён`, details: { keptDraft: true, draftId: before.id } });
    // Повторная пустая пересборка не плодит пометки: одна строка «пересборка …».
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const again = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(again.id).toBe(before.id);
    expect((again.needsManager as { reason: string }[]).filter((n) => n.reason.startsWith('пересборка ')).length).toBe(1);
    // С позициями — новый черновик, как и раньше.
    letter.request_items = [{ raw: 'Дверь ДПГ сота 800×2000 — 1 шт', name: 'Дверь ДПГ сота', width_mm: 800, height_mm: 2000, qty: 1 }];
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const fresh = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(fresh.id).toBeGreaterThan(before.id);
    expect(fresh.items).toHaveLength(1);
  });

  it('KB-COMPONENTS: колонки комплектующих → строки комплектующих; прайс фурнитуры; категории позиций; одно нажатие «Найти цены» ставит все позиции без цены порциями по 20; работы без цены, вне таблицы и итога, с фразой под таблицей', async () => {
    const upload = async (filename: string, rows: unknown[][]) => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Прайс');
      for (const r of rows) ws.addRow(r);
      return (await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/sources/file', headers, payload: { filename, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBase64: Buffer.from(await wb.xlsx.writeBuffer()).toString('base64') } })).json().source as { id: number; prices: number; priceTitle: string; priceImport: { updated: boolean; was: number; imported: number } };
    };
    // Прайс межкомнатных с колонками комплектующих — тот же ключ, что у прежнего файла межкомнатных: заменяет только его.
    const inner = await upload('Прайс_межкомнатные_двери_ГОСТ — обновил 17102026.xlsx', [
      ['Модель', 'Сокращение', 'Г/О', 'Покрытие', 'Материал', 'Размер блока', 'Цена, руб.', 'Коробка, руб.', 'Наличник, руб.', 'Добор, руб.', 'Порог, руб.'],
      ['ДВ CPL', 'ДВ 1Рп Г ПрБ', 'Г', 'CPL 0,2 мм', 'дерево', '1010×2100; 910×2100', 23_900, 3500, 1200, 900, 700],
      ['ДПГ сота', 'ДПГ', 'Г', 'ламинат', 'МДФ', '800×2000', 8800, 2100, 600, 500, 400],
      ['Аква 01 ПГ', 'ПГ', 'Г', 'ПВХ', 'МДФ', '600×2000', 7900, 1900, 550, 450, ''],
    ]);
    // 4 двери (ДВ CPL двумя размерами) + 4 + 4 + 3 комплектующих = 15 строк; прайс «Межкомнатные» обновлён (было 54).
    expect(inner).toMatchObject({ prices: 15, priceTitle: 'Межкомнатные', priceImport: { updated: true, was: 54, imported: 15 } });
    const hw = await upload('Прайс_фурнитура.xlsx', [['Наименование', 'Артикул/размер', 'Цена'], ['Ручка Palladium Luna', 'A-1', 1450], ['Замок врезной межкомнатный', 'ЗВ-4', 980], ['Петля универсальная', '100×70', 190]]);
    expect(hw).toMatchObject({ prices: 3, priceTitle: 'Фурнитура' });
    const kb = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/prices?limit=1000', headers })).json().items as { model: string; origin: string; category: string; componentKind: string | null; price: number }[];
    const byCat = (c: string) => kb.filter((p) => p.origin === 'price_list' && p.category === c).map((p) => p.model).sort();
    expect(byCat('door')).toEqual(['Аква 01 ПГ', 'ДВ CPL', 'ДВ CPL', 'ДПГ сота']);
    expect(byCat('component')).toEqual(['Добор (Аква 01 ПГ)', 'Добор (ДВ CPL)', 'Добор (ДПГ сота)', 'Коробка (Аква 01 ПГ)', 'Коробка (ДВ CPL)', 'Коробка (ДПГ сота)', 'Наличник (Аква 01 ПГ)', 'Наличник (ДВ CPL)', 'Наличник (ДПГ сота)', 'Порог (ДВ CPL)', 'Порог (ДПГ сота)']);
    expect(byCat('hardware')).toEqual(['Замок врезной межкомнатный', 'Петля универсальная', 'Ручка Palladium Luna']);
    // Заявка на 36 позиций (больше прежнего лимита 30): 30 дверей, добор, коробка, ручка, замок, дверь «Аква … /врезка замка…», монтаж.
    const DOOR = 'Дверной блок деревянный внутренний глухой однопольный без порога CPL светло-серый';
    letter.request_items = [
      ...Array.from({ length: 30 }, (_, i) => ({ raw: `${DOOR} 910×2100 — 1 шт (поз. ${i + 1})`, name: DOOR, width_mm: 910, height_mm: 2100, qty: 1 })),
      { raw: 'Добор телескопический, МДФ, 300×2150 — 4 шт', name: 'Добор телескопический, МДФ', width_mm: 300, height_mm: 2150, qty: 4 },
      { raw: 'Коробка дверная CPL — 2 шт', name: 'Коробка дверная CPL', width_mm: null, height_mm: null, qty: 2 },
      { raw: 'Ручка Palladium Luna — 2 шт', name: 'Ручка Palladium Luna', width_mm: null, height_mm: null, qty: 2 },
      { raw: 'Замок врезной межкомнатный — 2 шт', name: 'Замок врезной межкомнатный', width_mm: null, height_mm: null, qty: 2 },
      { raw: 'Аква 01 ПГ + УПД 600*2000*40 мм окут Белый ПВХ/врезка замка под цилиндр кл/зв/Правая (Дб-9) — 1 шт', name: 'Аква 01 ПГ + УПД окут Белый ПВХ/врезка замка под цилиндр кл/зв/Правая (Дб-9)', width_mm: 600, height_mm: 2000, qty: 1 },
      { raw: 'Монтаж дверного блока — 36 шт', name: 'Монтаж дверного блока', width_mm: null, height_mm: null, qty: 36 },
    ] as unknown as typeof letter.request_items;
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const d0 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(d0.items).toHaveLength(36);
    expect(d0.items.map((l: { category: string }) => l.category).filter((c: string) => c !== 'door')).toEqual(['component', 'component', 'hardware', 'hardware', 'service']);
    expect(d0.items.at(-1)).toMatchObject({ name: 'Монтаж дверного блока', kind: 'service', category: 'service', size: '' });
    // Одно нажатие: все 35 позиций без цены (кроме работы) поставлены порциями по 20, веб не вызывался.
    const searches = g.searches();
    const run = (await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: d0.id } })).json();
    expect(run).toMatchObject({ total: 35, batches: 2 });
    expect(run.queued).toHaveLength(35);
    expect(g.searches()).toBe(searches);
    const notes = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/journal?kind=note', headers })).json().items as { summary: string }[];
    expect(notes.some((n) => n.summary === 'Поиск цен: поставлено позиций 35 порциями по 20 (2)')).toBe(true);
    const d = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    const items = d.items as { name: string; price: number | null; priceLabel: string | null; category: string }[];
    expect(items.slice(0, 30).every((l) => l.price === 23_900 && l.priceLabel === 'по прайсу: ДВ CPL (строка 2)')).toBe(true);
    // Добор без указания двери: строка комплектующего своего вида из прайса (не веб), коробка CPL — к ДВ CPL.
    expect(items[30]).toMatchObject({ category: 'component' });
    expect(items[30]?.priceLabel).toMatch(/^по прайсу: Добор \(/);
    expect([500, 900, 450]).toContain(items[30]?.price);
    expect(items[31]).toMatchObject({ price: 3500, priceLabel: 'по прайсу: Коробка (ДВ CPL) (строка 2)' });
    expect(items[32]).toMatchObject({ price: 1450, category: 'hardware' });
    expect(items[33]).toMatchObject({ price: 980, category: 'hardware' });
    // «Аква … /врезка замка …» — дверь, а не работа: цена из прайса межкомнатных.
    expect(items[34]).toMatchObject({ price: 7900, category: 'door' });
    expect(items[34]?.priceLabel).toMatch(/^по базе: Прайс_межкомнатные_двери_ГОСТ/);
    expect(items[35]).toMatchObject({ price: null, category: 'service' });
    // Документ собирается без цены у работы; работа вне таблицы и итога; под таблицей фраза о замере.
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/template', headers, payload: { filename: 'kp.docx', contentBase64: templateDocx() } });
    const built = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/build', headers, payload: { draftId: d0.id } });
    expect(built.json()).toMatchObject({ draft: { status: 'built', hasDocx: true } });
    const doc = await ctx.deps.kp.byId(ACCOUNT_ID, d0.id);
    const text = new PizZip(readFileSync(resolveKpPath(ctx.deps.filesRoot, doc!.docxPath!))).file('word/document.xml')!.asText().replace(/\u00a0/g, ' ').replace(/<w:br\s*\/>/g, '\n').replace(/<[^>]+>/g, '');
    expect(text).not.toContain('Монтаж дверного блока');
    expect(text).toContain('41 позиция');
    const expectedTotal = 30 * 23_900 + (items[30]!.price as number) * 4 + 3500 * 2 + 1450 * 2 + 980 * 2 + 7900;
    expect(text).toContain(`итого ${expectedTotal.toLocaleString('ru-RU').replace(/\u00a0/g, ' ')} ₽`);
    expect(text).toContain('Стоимость монтажных работ рассчитывается после замера дверных проёмов.');
    const log = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/journal?kind=kp_build', headers })).json().items as { summary: string; details: { services: number } }[];
    expect(log[0]?.summary).toContain('работ вне таблицы: 1');
    expect(log[0]?.details.services).toBe(1);
  });
});
