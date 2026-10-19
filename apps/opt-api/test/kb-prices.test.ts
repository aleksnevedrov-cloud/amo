// RFD-AI-AGENT-OPT-KB, этап 3: цены из xlsx-прайса с предпросмотром, синонимы, приоритет «база → веб»,
// автопополнение из веб-поиска и правок менеджера, группировка веб-поиска по модели, дневной лимит, подпись источника.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import PizZip from 'pizzip';
import type { LlmGateway, RoutedRequest, RoutedResponse } from '@core/llm';
import type { OptAiProvider } from '@opt/kp';
import { KP_PRICE_RESEARCH_KIND, resolveKpPath } from '@opt/kp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookXlsx, interiorBook, metalBook } from '../../../packages/opt/kb/test/fixtures/price-book.ts';
import { ACCOUNT_ID, answerSurvey, LEAD_ID, setup, widgetToken } from './helpers.ts';

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

  it('«Собрать КП» + «Найти цены»: позиции из прайса — с подписью; нестандарт по правилу; синоним; Турина в прайсе нет — интернет, цена в КП не ставится, вопрос менеджеру (KP-AGENT-V2)', async () => {
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const d0 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    draftId = d0.id;
    expect(d0.items).toHaveLength(5);
    const r = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId } });
    expect(r.json()).toMatchObject({ queued: [0, 1, 2, 3, 4] });
    // Турин (два размера, одна модель — один поиск) — интернет; позиции прайса — без интернета.
    expect(g.searches()).toBe(1);
    const d = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    const lines = d.items as { request_index: number; price: number | null; priceSource: string; priceLabel: string; priceOutcome?: string; priceStale: boolean; kbPriceId: number | null; market: { median: number } | null }[];
    // KB-MATCH: ключ модели совпал и признаки (полотно, глухое) подошли → подпись «по прайсу: … (строка N)».
    expect(lines[0]).toMatchObject({ price: 3450, priceSource: 'price_file', priceStale: false, priceLabel: 'по прайсу: ДПГ сота (строка 4)' });
    expect(lines[0]?.kbPriceId).toBeGreaterThan(0);
    expect(lines[1]).toMatchObject({ price: 3650, priceSource: 'price_file' });
    // Синоним → ДПГ сота 700×2000: точного размера нет, правило нестандарта по высоте не сработало (высота та же) → пересчёт по площади от 800×2000.
    expect(lines[2]).toMatchObject({ priceSource: 'price_file' });
    expect(lines[2]?.price).toBeCloseTo(3450 * (700 / 800), 2);
    // Турин — в прайсе нет: цены интернета показаны, в КП не поставлены (выбирает менеджер); в базу ничего не пишется.
    for (const i of [3, 4]) expect(lines[i]).toMatchObject({ price: null, priceOutcome: 'not_priced', priceLabel: 'цены из интернета — выбор менеджера', kbPriceId: null });
    const reasons = (i: number) => (d.needsManager as { request_index: number; reason: string }[]).filter((n) => n.request_index === i).map((n) => n.reason);
    expect(reasons(2)).toEqual([expect.stringContaining('цена из базы: пересчёт по площади с 800×2000'), 'цена из базы: по синониму: ДПГ сота']);
    expect(reasons(3).map((x) => x.replace(/\u00a0/g, ' '))).toEqual(['уточнить у менеджера: цены из интернета: 7 800 – 8 200 ₽, медиана 8 000 ₽ (3 источн.); итоговую цену выберите в опроснике']);
    expect((d.survey as { type: string; requestIndexes: number[]; blocking: boolean }[]).filter((q) => q.type === 'web_price').map((q) => [q.requestIndexes, q.blocking])).toEqual([[[3], true], [[4], true]]);
    // Журнал: три позиции из прайса — без веб-вызовов и без расхода; Турин — «цены из интернета».
    const journal = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/journal?kind=${KP_PRICE_RESEARCH_KIND}`, headers })).json().items as { summary: string; costUsd: number; details: { source?: string; webSearchCalls?: number } }[];
    const fromPrice = journal.filter((j) => j.summary.includes(' ₽ из прайса ('));
    expect(fromPrice).toHaveLength(3);
    expect(fromPrice.every((j) => j.details.source === 'kb' && j.details.webSearchCalls === 0 && Number(j.costUsd) === 0)).toBe(true);
    expect(journal.filter((j) => j.summary.startsWith('Цены из интернета по позиции'))).toHaveLength(2);
    expect((await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/prices?q=турин', headers })).json().items).toEqual([]);
  });

  it('«Собрать заново» + «Найти цены»: прайс — те же цены, Турин — снова вопрос «цена из интернета» из кэша поиска; прежний флаг force поиск не повторяет', async () => {
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const d0 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(d0.id).not.toBe(draftId);
    draftId = d0.id;
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId } });
    const d = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(d.items.map((l: { price: number | null; priceOutcome?: string }) => [l.price === null ? null : Math.round(l.price), l.priceOutcome ?? null])).toEqual([[3450, 'priced'], [3650, 'priced'], [3019, 'priced'], [null, 'not_priced'], [null, 'not_priced']]);
    expect(g.searches()).toBe(1);
    expect((d.survey as { type: string }[]).filter((q) => q.type === 'web_price')).toHaveLength(2);
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId, requestIndexes: [3], force: true } });
    expect(g.searches()).toBe(1);
    expect((await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft.items[3]).toMatchObject({ price: null, priceOutcome: 'not_priced', priceLabel: 'цены из интернета — выбор менеджера' });
  });

  it('правка менеджера остаётся в своём черновике и в базу не пишется (KB-WEB-ROWS); удаление цены и файла прайса', async () => {
    const d = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    const items = d.items.map((l: { request_index: number; price: number }) => (l.request_index === 0 ? { ...l, price: 3300 } : l));
    const saved = (await ctx.app.inject({ method: 'PUT', url: `/widget/v1/kp/draft/${draftId}`, headers, payload: { items } })).json().draft;
    expect(saved.items[0]).toMatchObject({ price: 3300, priceSource: 'manager', priceLabel: 'изменено менеджером' });
    const prices = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/prices?q=дпг', headers })).json();
    expect(prices.items.filter((p: { origin: string }) => p.origin !== 'price_list')).toEqual([]);
    // Новый черновик: ДПГ 800×2000 — снова цена прайса.
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const d2 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: d2.id, requestIndexes: [0] } });
    const d3 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(d3.items[0]).toMatchObject({ price: 3450, priceSource: 'price_file', priceLabel: 'по прайсу: ДПГ сота (строка 4)' });
    // Удаление цены из базы руками; удаление файла прайса удаляет все его цены (KB-PRICELIST, а).
    expect((await ctx.app.inject({ method: 'DELETE', url: `/widget/v1/kb/prices/${prices.items.find((p: { origin: string }) => p.origin === 'price_list').id}`, headers })).json()).toEqual({ ok: true });
    expect((await ctx.app.inject({ method: 'DELETE', url: `/widget/v1/kb/sources/${priceSourceId}`, headers })).json()).toEqual({ ok: true });
    expect((await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/prices', headers })).json().items).toEqual([]);
  });

  it('приёмка KB-MATCH (#30022107): веб-записи «модель = текст письма» остаются, но прайс с колонками признаков даёт три позиции по 23 900 ₽ «по прайсу: ДВ CPL (строка N)», веб-вызовов 0; «ДПГ + УПД, сота» → 8 800; алюминиевая дверь и «Дверь CPL белая» в прайсе нет — интернет и вопрос менеджеру, веб-записи в подбор не идут', async () => {
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
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const d0 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(d0.items).toHaveLength(3);
    const before = g.searches();
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: d0.id } });
    expect(g.searches()).toBe(before);
    const d = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(d.items.map((l: { price: number; priceSource: string; priceLabel: string }) => [l.price, l.priceSource, l.priceLabel])).toEqual([
      [23900, 'price_file', 'по прайсу: ДВ CPL (строка 5)'],
      [23900, 'price_file', 'по прайсу: ДВ CPL (строка 5)'],
      [23900, 'price_file', 'по прайсу: ДВ CPL (строка 5)'],
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
    // Опросник: доставка и срок действия цены (KP-AGENT-V2) — до сборки.
    await answerSurvey(ctx.app, headers, LEAD_ID);
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
    expect(mine.every((j) => j.summary.includes('из прайса') && j.details.webSearchCalls === 0 && j.details.match === 'features')).toBe(true);
    // Ничего не удалено: старые веб-записи на месте, просто не используются.
    expect((await ctx.deps.kb.prices.byId(ACCOUNT_ID, webA))?.price).toBe(5683);
    expect((await ctx.deps.kb.prices.byId(ACCOUNT_ID, webB))?.price).toBe(5120);
    // Заявка «ДПГ + УПД, сота 2000×800» → строка прайса ДПГ 8 800 (в этом прайсе одна ДПГ); алюминиевая дверь и «Дверь CPL белая»
    // (по признакам к строкам прайса не подходит) — в прайсе нет: «уточнить у менеджера», веб-поиска нет.
    letter.request_items = [
      { raw: 'ДПГ + УПД, сота 2000×800 — 5 шт', name: 'ДПГ + УПД, сота', width_mm: 800, height_mm: 2000, qty: 5 },
      { raw: 'Дверь алюминиевая остеклённая 800×2000 — 1 шт', name: 'Дверь алюминиевая остеклённая', width_mm: 800, height_mm: 2000, qty: 1 },
      { raw: 'Дверь CPL белая 800×2000 — 1 шт', name: 'Дверь CPL белая', width_mm: 800, height_mm: 2000, qty: 1 },
    ];
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const e0 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: e0.id } });
    // KP-AGENT-V2: двух дверей в прайсе нет — интернет (по поиску на модель), цена в КП не ставится.
    expect(g.searches()).toBe(before + 2);
    const e = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(e.items[0]).toMatchObject({ price: 8800, priceSource: 'price_file', priceLabel: 'по прайсу: ДПГ сота (строка 3)' });
    expect(e.items.slice(1).map((l: { price: number | null; priceOutcome?: string }) => [l.price, l.priceOutcome])).toEqual([[null, 'not_priced'], [null, 'not_priced']]);
    expect((e.needsManager as { request_index: number; reason: string }[]).filter((n) => n.request_index === 1).map((n) => n.reason)).toEqual([expect.stringMatching(/^уточнить у менеджера: цены из интернета: .*итоговую цену выберите в опроснике$/)]);
    expect((await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/prices?q=алюмин', headers })).json().items).toEqual([]);
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
      [23900, 'price_file', 'по прайсу: Дверь внутренняя CPL (строка 3)'],
      [23900, 'price_file', 'по прайсу: Дверь внутренняя CPL (строка 3)'],
      [23900, 'price_file', 'по прайсу: Дверь внутренняя CPL (строка 3)'],
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
    // KB-COMPONENT-DOOR: «Добор телескопический, МДФ» подходит и к ДВ CPL, и к «Аква 01 ПГ» (обе деревянные) — вопрос менеджеру, без цены.
    const q0 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(q0.items[30]).toMatchObject({ category: 'component', price: null, priceOutcome: 'question', question: { kind: 'component_door', reason: 'many', text: 'К какой двери считать «Добор телескопический, МДФ 300×2150 мм, 4 шт»?' } });
    expect(q0.items[30].question.options.map((o: { requestIndex: number; model: string; qty: number }) => [o.requestIndex, o.model, o.qty])).toEqual([[0, 'ДВ CPL', 30], [34, 'Аква 01 ПГ', 1]]);
    // Ответ менеджера: к ДВ CPL — цена из колонки «Добор» этой двери.
    expect((await ctx.app.inject({ method: 'POST', url: `/widget/v1/kp/draft/${d0.id}/component-door`, headers, payload: { requestIndex: 30, doorRequestIndex: 0 } })).statusCode).toBe(200);
    const d = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    const items = d.items as { name: string; price: number | null; priceLabel: string | null; category: string; componentDoor?: number | null }[];
    expect(items.slice(0, 30).every((l) => l.price === 23_900 && l.priceLabel === 'по прайсу: ДВ CPL (строка 2)')).toBe(true);
    expect(items[30]).toMatchObject({ category: 'component', price: 900, priceLabel: 'по двери ДВ CPL', componentDoor: 0 });
    // «Коробка дверная CPL»: покрытие CPL исключает «Аква 01 ПГ» (ПВХ) — дверь одна, ДВ CPL, без вопроса.
    expect(items[31]).toMatchObject({ price: 3500, priceLabel: 'по двери ДВ CPL' });
    expect(items[32]).toMatchObject({ price: 1450, category: 'hardware' });
    expect(items[33]).toMatchObject({ price: 980, category: 'hardware' });
    // «Аква … /врезка замка …» — дверь, а не работа: цена из прайса межкомнатных.
    expect(items[34]).toMatchObject({ price: 7900, category: 'door' });
    expect(items[34]?.priceLabel).toMatch(/^по базе: Прайс_межкомнатные_двери_ГОСТ/);
    expect(items[35]).toMatchObject({ price: null, category: 'service' });
    // Документ собирается без цены у работы; работа вне таблицы и итога; под таблицей фраза о замере.
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/template', headers, payload: { filename: 'kp.docx', contentBase64: templateDocx() } });
    // Опросник: глазок — «оставить без цены», нестандарт — «как посчитано», доставка, срок цены.
    await answerSurvey(ctx.app, headers, LEAD_ID, { web_price: { option: 'no_price' } });
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
  it('KB-PRICE-SHEETS: два многолистовых прайса — счётчики карточки, 90025 по синониму INT-013 → 3 × 23 900, нестандарт по сетке (+30 % / +100 % / ровно 30 %), комплектующие и фурнитура по модели двери, INT-008 — смета, расхождение тарифа отменяет импорт, удаление и перезаливка', async () => {
    type Src = { id: number; prices: number; priceKey: string; priceTitle: string; counts: Record<string, number> | null; priceImport: { updated: boolean; was: number; imported: number; error?: string; book?: Record<string, unknown> } };
    const upload = async (filename: string, sheets: Record<string, unknown[][]>) =>
      (await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/sources/file', headers, payload: { filename, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBase64: (await bookXlsx(sheets)).toString('base64') } })).json().source as Src;
    // Межкомнатные: тот же ключ, что у прежнего файла межкомнатных (15 строк) — заменяет его целиком.
    const inner = await upload('Прайс_межкомнатные_двери_ГОСТ.xlsx', interiorBook());
    expect(inner).toMatchObject({ priceTitle: 'Межкомнатные', prices: 30 + 86 + 31, counts: { doors: 30, components: 86, hardware: 31, sizes: 150, comments: 30 }, priceImport: { updated: true, was: 15, imported: 147, book: { doors: 30, components: 86, hardware: 31, hardwareUnpriced: 9, estimates: 1, sizes: 150, comments: 30, dictionary: 12 } } });
    expect(inner.counts!.aliases).toBeGreaterThanOrEqual(60);
    const metal = await upload('Прайс_металлические_двери_ГОСТ.xlsx', metalBook());
    expect(metal).toMatchObject({ priceTitle: 'Металлические', prices: 20 + 31, counts: { doors: 20, components: 0, hardware: 31, sizes: 100, comments: 20 }, priceImport: { book: { doors: 20, hardware: 31, hardwareUnpriced: 9, estimates: 0 } } });
    const journal = async (kind: string) => (await ctx.app.inject({ method: 'GET', url: `/widget/v1/journal?kind=${kind}`, headers })).json().items as { summary: string; details: Record<string, unknown> }[];
    expect((await journal('kb_index')).some((j) => j.summary.startsWith('База знаний: прайс «Межкомнатные» (30 ID): цен дверей 30 (сметных 1), комплектующих 86, фурнитуры 31 (без цены 9), размеров 150, синонимов'))).toBe(true);
    // Расхождение цены тарифа между файлами: импорт отменяется целиком, прежние данные металлических на месте, в журнале лист / колонка.
    const bad = await upload('Прайс_металлические_двери_ГОСТ v2.xlsx', metalBook({ extrasShift: 100 }));
    expect(bad.priceImport.error).toContain('вкладка «Дополнения»: цена тарифа OPT-001 расходится с уже загруженным прайсом «Межкомнатные»');
    expect(bad.prices).toBe(0);
    const sources = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/sources', headers })).json().sources as Src[];
    expect(sources.find((x) => x.id === metal.id)?.prices).toBe(51);
    expect((await journal('kb_index')).some((j) => j.summary.includes('не импортирован — вкладка «Дополнения»: цена тарифа OPT-001') && j.summary.endsWith('прежние данные прайса сохранены'))).toBe(true);
    await ctx.app.inject({ method: 'DELETE', url: `/widget/v1/kb/sources/${bad.id}`, headers });
    // Один тариф в двух файлах — в базе две строки, при подборе берётся одна без пометки «найдено в двух прайсах».
    const kbAll = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/prices?limit=1000', headers })).json().items as { origin: string; category: string; tariffId: string | null; productId: string | null; status: string; price: number }[];
    expect(kbAll.filter((p) => p.tariffId === 'OPT-001')).toHaveLength(2);
    expect(kbAll.filter((p) => p.category === 'door' && p.origin === 'price_list')).toHaveLength(50);

    // Заявка 90025: три двери по синониму INT-013 (точный размер сетки — 0 %), нестандарт, комплектующие и фурнитура по модели двери.
    const DOOR = 'Дверной блок деревянный внутренний глухой однопольный без порога, покрытие CPL';
    letter.request_items = [
      { raw: 'ДВ CPL / ДВ 1Рп Г ПрБ 900×2000 — 3 шт', name: 'ДВ CPL / ДВ 1Рп Г ПрБ', width_mm: 900, height_mm: 2000, qty: 3 },
      { raw: 'Коробка — 3 шт', name: 'Коробка', width_mm: null, height_mm: null, qty: 3 },
      { raw: 'Добор 150 мм — 3 шт', name: 'Добор 150 мм', width_mm: null, height_mm: null, qty: 3 },
      { raw: 'Порог — 3 шт', name: 'Порог', width_mm: null, height_mm: null, qty: 3 },
      { raw: `${DOOR} 899×2000 — 1 шт`, name: DOOR, width_mm: 899, height_mm: 2000, qty: 1 },
      { raw: `${DOOR} 1171×2000 — 1 шт`, name: DOOR, width_mm: 1171, height_mm: 2000, qty: 1 },
      { raw: `${DOOR} 900×2601 — 1 шт`, name: DOOR, width_mm: 900, height_mm: 2601, qty: 1 },
      { raw: 'ДА Профиль с фрамугой 1950×2375 — 1 шт', name: 'ДА Профиль с фрамугой', width_mm: 1950, height_mm: 2375, qty: 1 },
      { raw: 'Фрамуга — 1 шт', name: 'Фрамуга', width_mm: null, height_mm: null, qty: 1 },
      { raw: 'Доводчик — 1 шт', name: 'Доводчик', width_mm: null, height_mm: null, qty: 1 },
      { raw: 'MET-012 960×2050 — 2 шт', name: 'MET-012', width_mm: 960, height_mm: 2050, qty: 2 },
      { raw: 'Вентиляционная решётка — 2 шт', name: 'Вентиляционная решётка', width_mm: null, height_mm: null, qty: 2 },
      { raw: 'Замок Punto — 2 шт', name: 'Замок Punto', width_mm: null, height_mm: null, qty: 2 },
      { raw: 'Комплект петель и крепежа — 2 шт', name: 'Комплект петель и крепежа', width_mm: null, height_mm: null, qty: 2 },
      { raw: 'Петля накладная — 4 шт', name: 'Петля накладная', width_mm: null, height_mm: null, qty: 4 },
      { raw: 'Глазок — 2 шт', name: 'Глазок', width_mm: null, height_mm: null, qty: 2 },
      { raw: 'ДПГ сота с коробкой 800×2000 — 1 шт', name: 'ДПГ сота с коробкой', width_mm: 800, height_mm: 2000, qty: 1 },
      { raw: 'Монтаж дверного блока — 10 шт', name: 'Монтаж дверного блока', width_mm: null, height_mm: null, qty: 10 },
    ] as unknown as typeof letter.request_items;
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const d0 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(d0.items).toHaveLength(18);
    const searches = g.searches();
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: d0.id } });
    // KB-COMPONENT-DOOR: «Коробка», «Добор 150 мм», «Порог» без признаков двери, а дверей в заявке четыре (INT-013, ALU-005, MET-012,
    // INT-008) — вопрос менеджеру у каждой строки; цены нет, документ не собирается.
    const q = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    for (const i of [1, 2, 3]) expect(q.items[i]).toMatchObject({ category: 'component', price: null, priceOutcome: 'question', question: { reason: 'many' } });
    expect(q.items[1].question.options.map((o: { productId: string; size: string; qty: number }) => [o.productId, o.size, o.qty])).toEqual([['INT-013', '900×2000 мм', 3], ['INT-013', '899×2000 мм', 1], ['INT-013', '1171×2000 мм', 1], ['INT-013', '900×2601 мм', 1], ['ALU-005', '1950×2375 мм', 1], ['MET-012', '960×2050 мм', 2], ['INT-008', '800×2000 мм', 1]]);
    expect(q.needsManager.filter((n: { request_index: number }) => n.request_index === 1).map((n: { reason: string }) => n.reason)).toEqual([expect.stringMatching(/^вопрос по комплектующему: группа «Коробка» — подходит несколько дверей заявки: INT-013 ДВ CPL 900×2000 мм × 3; .*; ответ — в блоке «Вопросы по комплектующим»$/)]);
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/template', headers, payload: { filename: 'kp.docx', contentBase64: templateDocx() } });
    const blocked = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/build', headers, payload: { draftId: d0.id } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: 'component_questions', message: 'ответьте на вопросы по комплектующим: 3 («Коробка», «Добор», «Порог»)' });
    // Менеджер относит все три к двери поз. 1 (INT-013): цены — из строки INT-013; «Найти цены» выбор не сбрасывает.
    for (const i of [1, 2, 3]) await ctx.app.inject({ method: 'POST', url: `/widget/v1/kp/draft/${d0.id}/component-door`, headers, payload: { requestIndex: i, doorRequestIndex: 0 } });
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: d0.id } });
    const d = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    const items = d.items as { name: string; price: number | null; priceLabel: string | null; category: string; priceOutcome?: string; productId?: string | null; quoteNotes?: string[]; priceModel?: string | null; priceSource?: string }[];
    // KP-AGENT-V2: глазок в прайсе без цены — интернет (фурнитура: Дополнения → интернет → вопрос); остальное — из прайса.
    expect(items.filter((l) => l.category !== 'service' && l.priceSource !== 'price_file' && l.priceOutcome !== 'included').map((l) => [l.name, l.category, l.price, l.priceLabel])).toEqual([['Глазок', 'hardware', null, 'цены из интернета — выбор менеджера']]);
    expect(g.searches()).toBe(searches + 1);
    const needs = (d.needsManager as { request_index: number; reason: string }[]).reduce<Record<number, string[]>>((m, n) => ({ ...m, [n.request_index]: [...(m[n.request_index] ?? []), n.reason] }), {});
    // 1. 90025: синоним INT-013, точный размер сетки — 23 900 без надбавки; примечание из «Подбора» под позицией.
    expect(items[0]).toMatchObject({ price: 23_900, category: 'door', productId: 'INT-013', priceOutcome: 'priced', priceModel: 'ДВ CPL 0,2 мм', quoteNotes: ['Цвет полотна по каталогу CPL.'] });
    expect(needs[0]).toEqual(['цена из базы: по прайсу: ДВ CPL (строка 16) — совпали: дверной блок, глухой, однопольный, без порога, распашной, CPL', 'цена из базы: по синониму: ДВ CPL']);
    expect(kbAll.find((p) => p.productId === 'INT-013' && p.category === 'door')).toBeTruthy();
    // 2. Комплектующие по модели двери заявки: коробка 3 160 (строка INT-013), добор — в прайсе без цены → «уточнить у менеджера», не 0; порог — входит в блок.
    expect(items[1]).toMatchObject({ price: 3160, category: 'component', priceLabel: 'по двери INT-013, ДВ CPL', priceOutcome: 'priced', componentDoor: 0 });
    expect((items[1] as { question?: unknown }).question ?? null).toBeNull();
    expect(needs[1]).toEqual(['цена из базы: по двери INT-013, ДВ CPL (поз. 1): выбор менеджера для этой строки', 'цена из базы: комплектующее по двери INT-013, ДВ CPL: Коробка (ДВ CPL) (строка 16)']);
    expect(items[2]).toMatchObject({ price: null, category: 'component', priceOutcome: 'not_priced', componentDoor: 0 });
    expect(needs[2]).toEqual(['цена из базы: по двери INT-013, ДВ CPL (поз. 1): выбор менеджера для этой строки', 'уточнить у менеджера: добор к двери INT-013, ДВ CPL в прайсе без цены']);
    expect(items[3]).toMatchObject({ price: null, priceOutcome: 'included', componentDoor: 0 });
    expect(needs[3]).toEqual(['цена из базы: по двери INT-013, ДВ CPL (поз. 1): выбор менеджера для этой строки', 'цена из базы: порог входит в цену блока INT-013, ДВ CPL (в базу входит: полотно, коробка)']);
    // 3. Нестандарт по сетке: 899 при эталоне 900 → +30 %; 1171 → +100 %; 2601 → +100 %; фраза о производстве — под позицией в КП.
    expect(items[4]).toMatchObject({ price: 31_070, productId: 'INT-013' });
    expect(needs[4]).toContain('цена из базы: нестандарт 899×2000 при эталоне 900×2000: +30 % к базе');
    expect(items[4]?.quoteNotes).toEqual(['Цвет полотна по каталогу CPL.', 'нестандарт 899×2000 при эталоне 900×2000: +30 % к базе', 'Нестандартные позиции подлежат уточнению на производстве.']);
    expect(items[5]).toMatchObject({ price: 47_800 });
    expect(needs[5]).toContain('цена из базы: нестандарт 1171×2000 при эталоне 900×2000: +100 % к базе (превышение больше 30 %)');
    expect(items[6]).toMatchObject({ price: 47_800 });
    // 4. ALU-005 1950×2375 при эталоне 1500×2700: ширина ровно +30 % — остаётся 30 % (54 000 → 70 200); фрамуга и доводчик по модели.
    expect(items[7]).toMatchObject({ price: 70_200, productId: 'ALU-005' });
    expect(needs[7]).toEqual(['цена из базы: нестандарт 1950×2375 при эталоне 1500×2700: +30 % к базе', 'цена из базы: Нестандартные позиции подлежат уточнению на производстве.']);
    expect(items[8]).toMatchObject({ price: null, priceOutcome: 'included', category: 'hardware' });
    expect(needs[8]?.[0]).toMatch(/^цена из базы: Фрамуга входит в цену блока ДА Профиль с фрамугой/);
    expect(items[9]).toMatchObject({ price: 3900, priceOutcome: 'priced', category: 'hardware' });
    // 5. MET-012 (№ 9 листа 1): точный размер; вентиляционная решётка входит в базу; замок Punto — для MET; комплект петель — петли внутри не удваиваются; глазок — без цены.
    expect(items[10]).toMatchObject({ price: 32_000 + 9 * 400, productId: 'MET-012', priceOutcome: 'priced' });
    expect(items[11]).toMatchObject({ price: null, priceOutcome: 'included' });
    expect(items[12]).toMatchObject({ price: 4200, priceOutcome: 'priced' });
    expect(items[13]).toMatchObject({ price: 4100, priceOutcome: 'priced' });
    expect(items[14]).toMatchObject({ price: null, priceOutcome: 'included' });
    expect(needs[14]).toContain('цена из базы: Петля накладная (OPT-029) входит в комплект «Комплект петель и крепежа» той же позиции — отдельно не считается');
    expect(items[15]).toMatchObject({ price: null, priceOutcome: 'not_priced' });
    expect(needs[15]).toEqual([expect.stringMatching(/^уточнить у менеджера: цены из интернета: .*итоговую цену выберите в опроснике$/)]);
    // 6. INT-008 — только смета: 11 960 по правилу из комментария, пометка «сметная цена».
    expect(items[16]).toMatchObject({ price: 11_960, productId: 'INT-008', priceOutcome: 'estimate' });
    expect(needs[16]).toEqual(['цена из базы: сметная цена: Сметная позиция: полотно INT-005 8 800 + коробка 3 160 = 11 960 — для сметы, уточнить у менеджера']);
    expect(items[17]).toMatchObject({ price: null, category: 'service' });
    // Документ: «входит в блок» — не строка таблицы, а примечание под дверью; «без цены» — строка с «уточнить у менеджера»; итог без них.
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/template', headers, payload: { filename: 'kp.docx', contentBase64: templateDocx() } });
    // Опросник: глазок — «оставить без цены», нестандарт — «как посчитано», доставка, срок цены.
    await answerSurvey(ctx.app, headers, LEAD_ID, { web_price: { option: 'no_price' } });
    const built = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/build', headers, payload: { draftId: d0.id } });
    expect(built.json()).toMatchObject({ draft: { status: 'built', hasDocx: true } });
    const doc = await ctx.deps.kp.byId(ACCOUNT_ID, d0.id);
    const text = new PizZip(readFileSync(resolveKpPath(ctx.deps.filesRoot, doc!.docxPath!))).file('word/document.xml')!.asText().replace(/\u00a0/g, ' ').replace(/<w:br\s*\/>/g, '\n').replace(/<[^>]+>/g, '');
    const total = 3 * 23_900 + 3 * 3160 + 31_070 + 47_800 + 47_800 + 70_200 + 3900 + 2 * 35_600 + 2 * 4200 + 2 * 4100 + 11_960;
    expect(text).toContain(`итого ${total.toLocaleString('ru-RU').replace(/\u00a0/g, ' ')} ₽`);
    expect(text).toContain('В цену блока входит: Порог');
    expect(text).toContain('В цену блока входит: Фрамуга');
    expect(text).toContain('Нестандартные позиции подлежат уточнению на производстве.');
    // Шаблон теста печатает только {{sum}}: у строки без цены сумма «—»; в шаблоне заказчика в колонке цены — «уточнить у менеджера».
    expect(text).toContain('3. Добор 150 мм — —;');
    expect(text).toContain('12. Глазок — —;');
    expect(text).toContain('В цену блока входит: Вентиляционная решётка');
    expect(text).toContain('В составе комплекта «Комплект петель и крепежа»: Петля накладная');
    expect(text).toContain('2. Коробка (ДВ CPL) CPL 0,2 мм');
    expect(text).toContain('10. Замок Punto');
    expect(text).not.toContain('Дверь Доводчик');
    expect((text.match(/71 700/g) ?? []).length).toBe(1);
    const log = await journal('kp_build');
    expect(log[0]?.summary).toContain('входит в цену блока (под дверью, не в таблице): 4');
    expect(log[0]?.summary).toContain('без цены в прайсе («уточнить у менеджера», не в итоге): 2');
    // Неактивные ALU-003/004 и сметная ALU-007 при подборе по признакам не берутся.
    expect(kbAll.filter((p) => p.status === 'inactive').map((p) => p.productId).sort()).toEqual(['ALU-003', 'ALU-004']);
    // Удаление файла межкомнатных уносит только его данные (двери, размеры, синонимы, словарь); металлические на месте; перезаливка восстанавливает всё.
    expect((await ctx.app.inject({ method: 'DELETE', url: `/widget/v1/kb/sources/${inner.id}`, headers })).json()).toEqual({ ok: true });
    const afterDel = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/prices?limit=1000', headers })).json().items as { category: string; origin: string; productId: string | null }[];
    expect(afterDel.filter((p) => p.origin === 'price_list' && p.category === 'door').map((p) => p.productId?.slice(0, 3))).not.toContain('INT');
    expect(afterDel.filter((p) => p.origin === 'price_list' && p.category === 'door')).toHaveLength(20);
    const again = await upload('Прайс_межкомнатные_двери_ГОСТ.xlsx', interiorBook());
    expect(again).toMatchObject({ prices: 147, counts: { doors: 30, sizes: 150 }, priceImport: { was: 0, imported: 147 } });
    letter.request_items = [{ raw: 'ДВ CPL / ДВ 1Рп Г ПрБ 900×2000 — 3 шт', name: 'ДВ CPL / ДВ 1Рп Г ПрБ', width_mm: 900, height_mm: 2000, qty: 3 }] as unknown as typeof letter.request_items;
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const d2 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: d2.id } });
    const d3 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(d3.items[0]).toMatchObject({ price: 23_900, productId: 'INT-013' });
  }, 30_000);
  it('KB-PRICE-SHEETS-FIX: настоящие файлы заказчика («Межкомнатные двери.xlsx», «Металлические двери.xlsx») грузятся без ошибок со счётчиками; предпросмотр книги вместо разметки колонок; «Найти цены» на старом черновике без категорий ставит категории заново; автопорога в прайсе нет — «уточнить у менеджера», без веб-поиска', async () => {
    type Src = { id: number; prices: number; priceTitle: string; counts: Record<string, number> | null; priceImport: { error?: string; book?: Record<string, unknown> } | null };
    // Синтетические прайсы предыдущего сценария уносят свои тарифы OPT-… (другие цены) — иначе сверка тарифов остановит импорт.
    const before = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/sources', headers })).json().sources as { id: number; priceKey: string | null }[];
    for (const s of before.filter((x) => x.priceKey && /прайс (межкомнатные|металлические) двери гост/.test(x.priceKey))) await ctx.app.inject({ method: 'DELETE', url: `/widget/v1/kb/sources/${s.id}`, headers });
    const real = (name: string) => readFileSync(fileURLToPath(new URL(`../../../packages/opt/kb/test/fixtures/real/${name}`, import.meta.url)));
    const upload = async (filename: string) =>
      (await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/sources/file', headers, payload: { filename, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBase64: real(filename).toString('base64') } })).json().source as Src;
    const inner = await upload('Межкомнатные двери.xlsx');
    expect(inner.priceImport?.error).toBeUndefined();
    expect(inner).toMatchObject({ priceTitle: 'Межкомнатные', counts: { doors: 30, hardware: 31, sizes: 147, comments: 30 }, priceImport: { book: { doors: 30, estimates: 1, hardware: 31, hardwareUnpriced: 9, sizes: 147, comments: 30 } } });
    const metal = await upload('Металлические двери.xlsx');
    expect(metal.priceImport?.error).toBeUndefined();
    expect(metal).toMatchObject({ priceTitle: 'Металлические', counts: { doors: 20, hardware: 31, sizes: 46, comments: 20 } });
    // Предпросмотр книги (п. 3): не разметка колонок, а счётчики файла и итог импорта.
    const pv = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kb/sources/${inner.id}/prices/preview`, headers })).json();
    expect(pv).toMatchObject({ isPriceBook: true, isPriceList: false, book: { doors: 30, estimates: 1, hardware: 31, hardwareUnpriced: 9, sizes: 147, errors: [] }, priceImport: { book: { doors: 30 } } });
    expect(pv.sheets).toContain('Подбор');
    // «Импортировать заново» без разметки — книга перечитана, счётчики те же.
    const re = (await ctx.app.inject({ method: 'POST', url: `/widget/v1/kb/sources/${inner.id}/prices/import`, headers, payload: { mapping: {} } })).json();
    expect(re).toMatchObject({ imported: inner.prices, book: { doors: 30 }, counts: { doors: 30, sizes: 147 } });
    // Старый черновик без категорий (до KB-COMPONENTS): дверь по синониму «Финская с четвертью ДПГ», автопорог (нет в прайсе), монтаж.
    letter.request_items = [
      { raw: 'Финская с четвертью ДПГ 600×1900 — 2 шт', name: 'Финская с четвертью ДПГ', width_mm: 600, height_mm: 1900, qty: 2 },
      { raw: 'Автопорог LDM-03 24×1020 — 2 шт', name: 'Автопорог LDM-03 24×1020', width_mm: null, height_mm: null, qty: 2 },
      { raw: 'Монтаж дверного блока — 2 шт', name: 'Монтаж дверного блока', width_mm: null, height_mm: null, qty: 2 },
    ] as unknown as typeof letter.request_items;
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const d0 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    const old = (await ctx.deps.kp.byId(ACCOUNT_ID, d0.id))!;
    const strip = ({ category: _c, kind: _k, ...rest }: Record<string, unknown>) => rest;
    const oldPayload = old.payload as unknown as { items: Record<string, unknown>[]; request_items: Record<string, unknown>[] };
    await ctx.deps.kp.setPayload(d0.id, { ...oldPayload, items: oldPayload.items.map(strip), request_items: oldPayload.request_items.map(strip) } as unknown as Record<string, unknown>);
    expect(((await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft.items as { category?: string }[]).map((l) => l.category)).toEqual([undefined, undefined, undefined]);
    const searches = g.searches();
    const run = (await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: d0.id } })).json();
    // Категории поставлены заново: монтаж — работы, в поиск не ушёл; автопорог — фурнитура.
    expect(run).toMatchObject({ total: 2, categoriesRefreshed: 3 });
    // Автопорога в прайсе нет — интернет (KP-AGENT-V2), один поиск.
    expect(g.searches()).toBe(searches + 1);
    const d1 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    const items = d1.items as { category: string; price: number | null; productId?: string | null; priceLabel?: string | null; priceOutcome?: string }[];
    expect(items.map((l) => l.category)).toEqual(['door', 'hardware', 'service']);
    expect(items[0]).toMatchObject({ price: 3100, productId: 'INT-001' });
    // Автопорога в прайсе нет — цены интернета в опросник, в КП сама не ставится; веб-строка базы (на проде — 27 295 ₽) не подставляется.
    expect(items[1]).toMatchObject({ price: null, priceOutcome: 'not_priced', priceLabel: 'цены из интернета — выбор менеджера' });
    expect((d1.needsManager as { request_index: number; reason: string }[]).filter((n) => n.request_index === 1).map((n) => n.reason)).toEqual([expect.stringMatching(/^уточнить у менеджера: цены из интернета: .*итоговую цену выберите в опроснике$/)]);
    expect(items[2]).toMatchObject({ price: null, category: 'service' });
    // П. 7: письмо 90025 (черновик 61, КП-2026-13) — три позиции длинным текстом; синоним «ДВ 1Рп Г ПрБ» / «Дверной блок деревянный
    // внутренний глухой однопольный» внутри названия → INT-013 «ДПГ CPL» 23 900, а не ALU-006 из металлического прайса (+30 %).
    const LONG = 'Дверной блок, деревянный, внутренний, глухой, однопольный, без порога, распашной с доводчиком ДВ 1Рп 2100-10 Г ПрБ М3 ГОСТ 475-2016, облицовка cpl светлосерый';
    letter.request_items = [
      { raw: `${LONG} 1010×2100 — 1 шт`, name: LONG, width_mm: 1010, height_mm: 2100, qty: 1 },
      { raw: `${LONG} 910×2100 — 1 шт`, name: LONG, width_mm: 910, height_mm: 2100, qty: 1 },
      { raw: `${LONG} 910×2100 — 1 шт (поз. 3)`, name: LONG, width_mm: 910, height_mm: 2100, qty: 1 },
      { raw: 'Дверной блок деревянный внутренний глухой однопольный без порога CPL 1010×2100 — 1 шт', name: 'Дверной блок деревянный внутренний глухой однопольный без порога CPL', width_mm: 1010, height_mm: 2100, qty: 1 },
    ] as unknown as typeof letter.request_items;
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const d3 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    const s3 = g.searches();
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: d3.id } });
    expect(g.searches()).toBe(s3);
    const d4 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    const lines = d4.items as { price: number | null; productId?: string | null; priceLabel?: string | null; priceModel?: string | null }[];
    expect(lines.map((l) => [l.price, l.productId, l.priceLabel])).toEqual([
      [23_900, 'INT-013', 'по прайсу: ДПГ CPL (строка 23)'],
      [23_900, 'INT-013', 'по прайсу: ДПГ CPL (строка 23)'],
      [23_900, 'INT-013', 'по прайсу: ДПГ CPL (строка 23)'],
      [23_900, 'INT-013', 'по прайсу: ДПГ CPL (строка 23)'],
    ]);
    const n4 = (d4.needsManager as { request_index: number; reason: string }[]).filter((n) => n.request_index === 0).map((n) => n.reason);
    expect(n4).toContain('цена из базы: по синониму: ДПГ CPL (слова синонима — в названии позиции, ID INT-013)');
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/template', headers, payload: { filename: 'kp.docx', contentBase64: templateDocx() } });
    await answerSurvey(ctx.app, headers, LEAD_ID);
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/build', headers, payload: { draftId: d3.id } })).json()).toMatchObject({ draft: { status: 'built' } });
    const doc4 = await ctx.deps.kp.byId(ACCOUNT_ID, d3.id);
    const text4 = new PizZip(readFileSync(resolveKpPath(ctx.deps.filesRoot, doc4!.docxPath!))).file('word/document.xml')!.asText().replace(/\u00a0/g, ' ').replace(/<[^>]+>/g, '');
    expect(text4).toContain('итого 95 600 ₽');
    expect(text4).not.toContain('ДА-1-Г-Т-V60');

    // KB-HW-NULL-2: перезапуск opt-api (пересчёт категорий по словам) не переводит тарифы «Дополнений» в двери; ID товара = ID тарифа.
    await ctx.deps.kb.prices.backfillCategories();
    const acc = (await ctx.deps.kb.db.query<{ source_id: string; category: string; n: number; with_id: number }>(
      `SELECT source_id, category, count(*)::int AS n, count(product_id)::int AS with_id FROM kb_prices WHERE source_id = ANY($1::bigint[]) AND product_id LIKE 'OPT%' GROUP BY source_id, category ORDER BY source_id, category`,
      [[inner.id, metal.id]],
    )).rows.map((r) => [Number(r.source_id), r.category, r.n, r.with_id]);
    expect(acc).toEqual([[inner.id, 'hardware', 31, 31], [metal.id, 'hardware', 31, 31]]);
    const doorsBy = (await ctx.deps.kb.db.query<{ source_id: string; n: number }>(`SELECT source_id, count(*)::int AS n FROM kb_prices WHERE source_id = ANY($1::bigint[]) AND category = 'door' GROUP BY source_id ORDER BY source_id`, [[inner.id, metal.id]])).rows.map((r) => [Number(r.source_id), r.n]);
    expect(doorsBy).toEqual([[inner.id, 30], [metal.id, 20]]);
    expect((await ctx.deps.kb.db.query(`SELECT 1 FROM kb_prices WHERE source_id = ANY($1::bigint[]) AND tariff_id IS NOT NULL AND (category <> 'hardware' OR product_id IS DISTINCT FROM tariff_id)`, [[inner.id, metal.id]])).rowCount).toBe(0);

    // KB-HW-NULL: 9 тарифов «Дополнений» без цены (OPT-009…017) в каждом файле — цена NULL, а не 0,00; нулевых цен прайса в базе нет.
    const all = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/prices?limit=1000', headers })).json().items as { origin: string; category: string; tariffId: string | null; price: number | null; sourceId: number }[];
    const unpriced = all.filter((p) => p.origin === 'price_list' && p.price === null);
    expect(unpriced.map((p) => p.tariffId).sort()).toEqual(['009', '010', '011', '012', '013', '014', '015', '016', '017'].flatMap((n) => [`OPT-${n}`, `OPT-${n}`]));
    expect(new Set(unpriced.map((p) => p.sourceId))).toEqual(new Set([inner.id, metal.id]));
    expect(all.filter((p) => p.origin === 'price_list' && p.price === 0)).toEqual([]);
    const db = (await ctx.deps.kb.prices.listByOrigin(ACCOUNT_ID, 'price_list')).filter((r) => r.tariffId === 'OPT-012');
    expect(db.map((r) => r.price)).toEqual([null, null]);
    // Заявка с позициями без цены у алюминиевой двери ALU-005 и у межкомнатной INT-018: «уточнить у менеджера», не 0 ₽, в итог не входят.
    letter.request_items = [
      { raw: 'ДПГ CPL 910×2100 — 1 шт', name: 'ДПГ CPL', width_mm: 910, height_mm: 2100, qty: 1 },
      { raw: 'СПД40 6М1зак-12-4М1-12-6Изак для алюминиевой двери — 1 шт', name: 'СПД40 6М1зак-12-4М1-12-6Изак для алюминиевой двери', width_mm: null, height_mm: null, qty: 1 },
      { raw: 'Санузловой МДФ: влагостойкое исполнение и порог — 2 шт', name: 'Санузловой МДФ: влагостойкое исполнение и порог', width_mm: null, height_mm: null, qty: 2 },
      { raw: 'Петля IN4000U SN 100×70×2 — 3 шт', name: 'Петля IN4000U SN 100×70×2', width_mm: null, height_mm: null, qty: 3 },
    ] as unknown as typeof letter.request_items;
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const d5 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    // По словам «СПД40 …» и «Санузловой МДФ …» — без ключевых слов фурнитуры (черновик считает их дверями); категорию даёт строка прайса при поиске цены.
    expect(d5.items.map((l: { category: string }) => l.category)).toEqual(['door', 'door', 'door', 'hardware']);
    const s5 = g.searches();
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: d5.id } });
    // Тарифы «Дополнений» без цены (OPT-012, OPT-017) — интернет (KP-AGENT-V2): фурнитура «Дополнения → интернет → вопрос».
    expect(g.searches()).toBe(s5 + 2);
    const d6 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    const l6 = d6.items as { price: number | null; priceOutcome?: string; priceSource?: string; category: string; priceLabel?: string }[];
    expect(l6.map((l) => [l.price, l.priceOutcome, l.priceSource ?? null, l.category])).toEqual([[23_900, 'priced', 'price_file', 'door'], [null, 'not_priced', null, 'hardware'], [null, 'not_priced', null, 'hardware'], [123.54, 'priced', 'price_file', 'hardware']]);
    expect([l6[1]?.priceLabel, l6[2]?.priceLabel]).toEqual(['цены из интернета — выбор менеджера', 'цены из интернета — выбор менеджера']);
    const n6 = (d6.needsManager as { request_index: number; reason: string }[]).filter((n) => n.request_index === 1 || n.request_index === 2).map((n) => n.reason);
    expect(n6).toEqual([expect.stringMatching(/^уточнить у менеджера: цены из интернета: /), expect.stringMatching(/^уточнить у менеджера: цены из интернета: /)]);
    expect(n6).not.toContain('цена не задана');
    // Петля IN4000U в прайсе — для INT-016/018/008, дверь заявки INT-013: цена из прайса с пометкой, без веб-поиска.
    expect((d6.needsManager as { request_index: number; reason: string }[]).filter((n) => n.request_index === 3).map((n) => n.reason)).toContain('уточнить у менеджера: Петля IN4000U SN 100×70×2 в прайсе для моделей INT-016, INT-018, INT-008, а дверь в заявке — INT-013');
    // Менеджер оставляет обе позиции без цены — в документе «уточнить у менеджера».
    await answerSurvey(ctx.app, headers, LEAD_ID, { web_price: { option: 'no_price' } });
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/build', headers, payload: { draftId: d5.id } })).json()).toMatchObject({ draft: { status: 'built' } });
    const doc6 = await ctx.deps.kp.byId(ACCOUNT_ID, d5.id);
    const text6 = new PizZip(readFileSync(resolveKpPath(ctx.deps.filesRoot, doc6!.docxPath!))).file('word/document.xml')!.asText().replace(/\u00a0/g, ' ').replace(/<[^>]+>/g, '');
    // В шаблоне теста — только {{sum}}: строки без цены — «—», не «0 ₽»; итог 23 900 + 3 × 123,54 = 24 270,62 → «24 271 ₽».
    expect(text6).toContain('СПД40 6М1зак-12-4М1-12-6Изак для алюминиевой двери — —;');
    expect(text6).toContain('Санузловой МДФ: влагостойкое исполнение и порог — —;');
    expect(text6).not.toMatch(/(^|[^\d ])0 ₽/);
    expect(text6).toContain('итого 24 271 ₽');
    // Черновик, где цена 0 записана из базы до миграции 011, в документе — тоже «уточнить», не 0 ₽.
    const legacy = (await ctx.deps.kp.byId(ACCOUNT_ID, d5.id))!;
    const lp = legacy.payload as unknown as { items: Record<string, unknown>[] };
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const d7 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    const p7 = (await ctx.deps.kp.byId(ACCOUNT_ID, d7.id))!.payload as unknown as { items: Record<string, unknown>[] };
    await ctx.deps.kp.setPayload(d7.id, { ...p7, items: lp.items.map((l, i) => (i === 1 ? { ...l, price: 0, priceOutcome: undefined } : l)) } as unknown as Record<string, unknown>);
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/build', headers, payload: { draftId: d7.id } })).json()).toMatchObject({ draft: { status: 'built' } });
    const text7 = new PizZip(readFileSync(resolveKpPath(ctx.deps.filesRoot, (await ctx.deps.kp.byId(ACCOUNT_ID, d7.id))!.docxPath!))).file('word/document.xml')!.asText().replace(/\u00a0/g, ' ').replace(/<[^>]+>/g, '');
    expect(text7).toContain('СПД40 6М1зак-12-4М1-12-6Изак для алюминиевой двери — —;');
    expect(text7).toContain('итого 24 271 ₽');
    // Два файла заказчика, четыре поиска и три сборки документа — дольше 5 с по умолчанию.
  }, 30_000);
  it('KB-COMPONENT-DOOR-GROUP (89813): вопросы — по одному на группу похожих комплектующих (вид + исполнение, без размера); ответ на группу ставит цену во все её строки из колонки выбранной двери; «изменить дверь» меняет только одну строку; однозначные строки вопросов не получают', async () => {
    // Файлы заказчика уже загружены сценарием KB-PRICE-SHEETS-FIX («Межкомнатные двери.xlsx», «Металлические двери.xlsx»).
    const r = (raw: string, qty: number) => ({ raw: `${raw} — ${qty} шт`, name: raw, width_mm: null, height_mm: null, qty });
    letter.request_items = [
      { raw: 'ДПГ усиленная ПВХ 800×2000 — 5 шт', name: 'ДПГ усиленная ПВХ', width_mm: 800, height_mm: 2000, qty: 5 },
      { raw: 'ДПГ CPL 910×2100 — 3 шт', name: 'ДПГ CPL', width_mm: 910, height_mm: 2100, qty: 3 },
      { raw: 'Дверь техническая ДМ-1 860×2050 — 2 шт', name: 'Дверь техническая ДМ-1', width_mm: 860, height_mm: 2050, qty: 2 },
      r('Коробка ТЕЛЕСКОП, сэндвич 74×2150', 20),
      r('Коробка ТЕЛЕСКОП, сэндвич 74×2400', 10),
      r('Коробка ТЕЛЕСКОП, сэндвич 92×2150', 7),
      r('Коробка ТЕЛЕСКОП, ДПК 74×2150', 5),
      r('Наличник телескопический, МДФ 70×2150', 40),
      r('Наличник телескопический, МДФ 70×2400', 10),
      r('Наличник телескопический, ДПК 70×2150', 10),
      r('Добор телескопический, МДФ 100 мм', 10),
      r('Добор телескопический, МДФ 150 мм', 6),
      r('Добор телескопический, ДПК 100 мм', 4),
      r('Наличник ПВХ 70 мм', 10),
      r('Коробка стальная', 2),
    ] as unknown as typeof letter.request_items;
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const d0 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(d0.items.filter((l: { category: string }) => l.category === 'component')).toHaveLength(12);
    const searches = g.searches();
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: d0.id } });
    expect(g.searches()).toBe(searches);
    type Line = { request_index: number; qty: number; price: number | null; priceLabel?: string | null; priceOutcome?: string; productId?: string | null; componentDoor?: number | null; componentDoorBy?: string | null; componentDoorGroup?: string | null; question?: { group: string; groupTitle: string; reason: string; options: { requestIndex: number; productId: string | null }[] } | null };
    const get = async () => (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft as { items: Line[]; needsManager: { request_index: number; reason: string }[] };
    const d1 = await get();
    expect(d1.items.slice(0, 3).map((l) => [l.productId, l.price])).toEqual([['INT-002', 6800], ['INT-013', 23_900], ['MET-001', 24_100]]);
    // 10 строк с вопросом → 6 групп; размер группу не делит.
    const asked = d1.items.filter((l) => l.priceOutcome === 'question');
    expect(asked).toHaveLength(10);
    const groups = [...new Map(asked.map((l) => [l.question!.group, l.question!.groupTitle])).entries()];
    expect(groups).toEqual([
      ['коробка|сэндвич|телескоп', 'Коробка ТЕЛЕСКОП, сэндвич'],
      ['коробка|дпк|телескоп', 'Коробка ТЕЛЕСКОП, ДПК'],
      ['наличник|мдф|телескоп', 'Наличник телескопический, МДФ'],
      ['наличник|дпк|телескоп', 'Наличник телескопический, ДПК'],
      ['добор|мдф|телескоп', 'Добор телескопический, МДФ'],
      ['добор|дпк|телескоп', 'Добор телескопический, ДПК'],
    ]);
    // МДФ — деревянное исполнение: стальная MET-001 в варианты не попадает; у сэндвича — все три двери.
    expect(asked.find((l) => l.question!.group === 'наличник|мдф|телескоп')!.question!.options.map((o) => o.productId)).toEqual(['INT-002', 'INT-013']);
    expect(asked.find((l) => l.question!.group === 'коробка|сэндвич|телескоп')!.question!.options.map((o) => o.productId)).toEqual(['INT-002', 'INT-013', 'MET-001']);
    // Однозначные строки — без вопроса и вне групп: «Наличник ПВХ» → INT-002, «Коробка стальная» → MET-001 (входит в цену блока).
    expect(d1.items[13]).toMatchObject({ price: 1430, priceOutcome: 'priced', priceLabel: 'по двери INT-002, ДПГ усиленная' });
    expect(d1.items[14]).toMatchObject({ price: null, priceOutcome: 'included' });
    expect(d1.items[13]?.componentDoorGroup ?? null).toBeNull();
    // Сборка до ответов — 409 со списком групп.
    const blocked = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/build', headers, payload: { draftId: d0.id } });
    expect(blocked.json()).toMatchObject({ error: 'component_questions', message: 'ответьте на вопросы по комплектующим: 6 («Коробка ТЕЛЕСКОП, сэндвич», «Коробка ТЕЛЕСКОП, ДПК», «Наличник телескопический, МДФ», «Наличник телескопический, ДПК», …)' });
    // Ответ на группу «Коробка ТЕЛЕСКОП, сэндвич» → INT-002: цена во все три строки из колонки «Коробка» INT-002 (1 910).
    const ans = async (groupKey: string, door: number) => (await ctx.app.inject({ method: 'POST', url: `/widget/v1/kp/draft/${d0.id}/component-door`, headers, payload: { groupKey, doorRequestIndex: door } })).json();
    expect(await ans('коробка|сэндвич|телескоп', 0)).toMatchObject({ applied: 3 });
    const d2 = await get();
    expect([3, 4, 5].map((i) => [d2.items[i]?.price, d2.items[i]?.priceLabel, d2.items[i]?.componentDoorBy, d2.items[i]?.componentDoor])).toEqual([[1910, 'по двери INT-002, ДПГ усиленная', 'group', 0], [1910, 'по двери INT-002, ДПГ усиленная', 'group', 0], [1910, 'по двери INT-002, ДПГ усиленная', 'group', 0]]);
    expect(d2.needsManager.filter((n) => n.request_index === 3).map((n) => n.reason)[0]).toBe('цена из базы: по двери INT-002, ДПГ усиленная (поз. 1): ответ менеджера по группе «Коробка ТЕЛЕСКОП, сэндвич»');
    // «Изменить дверь» у одной строки (74×2400 → INT-013): меняется только она, у INT-013 коробка входит в цену блока.
    expect((await ctx.app.inject({ method: 'POST', url: `/widget/v1/kp/draft/${d0.id}/component-door`, headers, payload: { requestIndex: 4, doorRequestIndex: 1 } })).statusCode).toBe(200);
    const d3 = await get();
    expect(d3.items[4]).toMatchObject({ price: null, priceOutcome: 'included', componentDoor: 1, componentDoorBy: 'line', priceLabel: 'по двери INT-013, ДПГ CPL' });
    expect([d3.items[3]?.price, d3.items[5]?.price]).toEqual([1910, 1910]);
    // Повторный ответ на группу строку с «изменить дверь» не трогает.
    expect(await ans('коробка|сэндвич|телескоп', 0)).toMatchObject({ applied: 2 });
    expect((await get()).items[4]).toMatchObject({ componentDoor: 1, componentDoorBy: 'line' });
    // Остальные группы.
    await ans('коробка|дпк|телескоп', 2);
    await ans('наличник|мдф|телескоп', 1);
    await ans('наличник|дпк|телескоп', 0);
    await ans('добор|мдф|телескоп', 0);
    await ans('добор|дпк|телескоп', 1);
    const d4 = await get();
    expect(d4.items.filter((l) => l.priceOutcome === 'question')).toEqual([]);
    expect(d4.items.slice(3, 13).map((l) => [l.request_index, l.price, l.priceOutcome])).toEqual([
      [3, 1910, 'priced'], [4, null, 'included'], [5, 1910, 'priced'],
      [6, null, 'included'],
      [7, 2000, 'priced'], [8, 2000, 'priced'],
      [9, 1430, 'priced'],
      [10, 1060, 'priced'], [11, 1060, 'priced'],
      [12, null, 'not_priced'],
    ]);
    // Ни одной цены не от дверей заявки: подписи — только INT-002 / INT-013 / MET-001.
    expect(d4.items.slice(3).every((l) => /по двери (INT-002|INT-013|MET-001),/.test(l.priceLabel ?? ''))).toBe(true);
    // «Найти цены» (по всем и с заменой) — ответы групп и строки остаются.
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: d0.id } });
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: d0.id, requestIndexes: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12] } });
    const d5 = await get();
    expect(d5.items.slice(3, 13).map((l) => [l.price, l.componentDoor, l.componentDoorBy])).toEqual([
      [1910, 0, 'group'], [null, 1, 'line'], [1910, 0, 'group'], [null, 2, 'group'], [2000, 1, 'group'], [2000, 1, 'group'], [1430, 0, 'group'], [1060, 0, 'group'], [1060, 0, 'group'], [null, 1, 'group'],
    ]);
    // Все группы отвечены — документ собирается (добор ДПК без цены — «оставить без цены» в опроснике).
    await answerSurvey(ctx.app, headers, LEAD_ID);
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/build', headers, payload: { draftId: d0.id } })).json()).toMatchObject({ draft: { status: 'built' } });
    const text = new PizZip(readFileSync(resolveKpPath(ctx.deps.filesRoot, (await ctx.deps.kp.byId(ACCOUNT_ID, d0.id))!.docxPath!))).file('word/document.xml')!.asText().replace(/\u00a0/g, ' ').replace(/<[^>]+>/g, '');
    const total = 5 * 6800 + 3 * 23_900 + 2 * 24_100 + (20 + 7) * 1910 + (40 + 10) * 2000 + 10 * 1430 + (10 + 6) * 1060 + 10 * 1430;
    expect(text).toContain(`итого ${total.toLocaleString('ru-RU').replace(/\u00a0/g, ' ')} ₽`);
  }, 30_000);
  it('KB-DOOR-MATCH-2 (89813): «кромка ПВХ» — не покрытие; ДПГ + УПД подходит к нескольким моделям прайса — «уточнить у менеджера» без ID; одинаковые строки — один исход; ДПГУЧ — интернет и вопрос, Аква — вопрос «аналог»; противопожарная и двустворчатая — только если названы; коробка «входит в цену блока» — не 0 ₽', async () => {
    // Файлы заказчика уже загружены сценарием KB-PRICE-SHEETS-FIX. KB-WEB-ROWS (черновик 69): в базе — веб-строки прежнего поиска
    // по ДПГУЧ (35), Акве (183) и автопорогу; в подбор они не идут.
    const webRows = [
      await ctx.deps.kb.prices.upsert({ accountId: ACCOUNT_ID, model: 'ДПГУЧ + УПД, 45S3K; кромка ПВХ', widthMm: 800, heightMm: 2000, price: 40_029.67, origin: 'web', category: 'door', note: 'медиана 1 источника' }),
      await ctx.deps.kb.prices.upsert({ accountId: ACCOUNT_ID, model: 'Аква 01 ПГ + УПД, окут ПВХ, Белый', widthMm: 600, heightMm: 2000, price: 14_453, origin: 'web', category: 'door', note: 'медиана 1 источника' }),
      await ctx.deps.kb.prices.upsert({ accountId: ACCOUNT_ID, model: 'Автопорог LDM-03', price: 27_296, origin: 'web', category: 'hardware' }),
    ];
    const DPG = 'ДПГ + УПД, сота; кромка ПВХ 1 мм с 2-х сторон';
    const AQUA = 'Аква 01 ПГ + УПД 600*2000*40 мм окут Белый ПВХ/врезка замка под цилиндр кл/зв/Правая (Дб-9)';
    const door = (name: string, w: number, h: number, qty: number) => ({ raw: `${name} ${w}×${h} — ${qty} шт`, name, width_mm: w, height_mm: h, qty });
    letter.request_items = [
      door(DPG, 800, 2000, 7),
      door(DPG, 800, 2100, 3),
      door(DPG, 800, 2000, 2),
      door('ДПГУЧ + УПД, сота; кромка ПВХ 1 мм с 2-х сторон', 800, 2000, 2),
      door(AQUA, 600, 2000, 1),
      door('ДПГ усиленная ПВХ', 800, 2000, 5),
      door('ДС 1 Рп Г влагостойкий санузловой', 700, 2000, 1),
      door('Дверь техническая ДМ-1', 860, 2050, 2),
      { raw: 'Коробка стальная — 2 шт', name: 'Коробка стальная', width_mm: null, height_mm: null, qty: 2 },
      { raw: 'Автопорог LDM-03 24×1020 — 2 шт', name: 'Автопорог LDM-03 24×1020', width_mm: null, height_mm: null, qty: 2 },
    ] as unknown as typeof letter.request_items;
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const d0 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    const searches = g.searches();
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: d0.id } });
    // KP-AGENT-V2: ДПГУЧ в прайсе нет — интернет (один поиск); Аква — бренд клиента: сначала вопрос «аналог по ГОСТ», без поиска;
    // автопорог — из кэша поиска прошлого сценария.
    expect(g.searches()).toBe(searches + 1);
    type Line = { request_index: number; price: number | null; priceLabel?: string | null; priceOutcome?: string; productId?: string | null; kbPriceId?: number | null };
    const d1 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft as { items: Line[]; needsManager: { request_index: number; reason: string }[] };
    const reason = (i: number) => d1.needsManager.filter((n) => n.request_index === i).map((n) => n.reason);
    // п. 1, 4: «ДПГ + УПД» (кромка ПВХ — не покрытие) подходит к нескольким моделям — без ID и цены, одинаково во всех трёх строках.
    for (const i of [0, 1, 2]) {
      expect(d1.items[i]).toMatchObject({ productId: null, price: null, priceOutcome: 'not_priced', priceLabel: 'несколько моделей в прайсе', kbPriceId: null });
      expect(reason(i)).toEqual([expect.stringMatching(/^уточнить у менеджера: «ДПГ \+ УПД, сота» подходит к нескольким моделям прайса: INT-001 «Финская с четвертью ДПГ», INT-002 «ДПГ усиленная», .* — нужен различающий признак/)]);
    }
    expect(reason(0)[0]).not.toMatch(/INT-017|INT-023/);
    // п. 2, 3: ДПГУЧ и Аква — не обычная ДПГ, не противопожарная двустворчатая INT-023: похожей моделью не заменяются.
    expect(d1.items[3]).toMatchObject({ productId: null, price: null, priceOutcome: 'not_priced', priceLabel: 'цены из интернета — выбор менеджера' });
    expect(reason(3)).toEqual([expect.stringMatching(/^уточнить у менеджера: цены из интернета: .*итоговую цену выберите в опроснике$/)]);
    expect(d1.items[4]).toMatchObject({ productId: null, price: null, priceOutcome: 'not_priced', priceLabel: 'бренд «Аква» вне прайса — вопрос «аналог»' });
    expect(reason(4)).toEqual([expect.stringMatching(/^уточнить у менеджера: «Аква» в прайсе нет — аналог по ГОСТ/)]);
    // Различающий признак есть — подбор как раньше; санузловой блок ДС — когда он назван.
    expect(d1.items[5]).toMatchObject({ productId: 'INT-002', price: 6800, priceOutcome: 'priced' });
    expect(d1.items[6]).toMatchObject({ productId: 'INT-017', priceOutcome: 'priced' });
    expect(d1.items[7]).toMatchObject({ productId: 'MET-001', price: 24_100, priceOutcome: 'priced' });
    expect(d1.items.filter((l) => ['INT-017', 'INT-023'].includes(l.productId ?? '')).map((l) => l.request_index)).toEqual([6]);
    // п. 5: коробка «входит в цену блока» — цена null, не 0.
    expect(d1.items[8]).toMatchObject({ price: null, priceOutcome: 'included' });
    expect(d1.items.some((l) => l.price === 0)).toBe(false);
    // KB-WEB-ROWS: веб-строки базы не подобраны — автопорог: цены интернета в опросник; сами строки базы на месте.
    expect(d1.items[9]).toMatchObject({ price: null, priceOutcome: 'not_priced', priceLabel: 'цены из интернета — выбор менеджера' });
    expect(d1.items.filter((l) => l.kbPriceId && webRows.includes(l.kbPriceId))).toEqual([]);
    for (const id of webRows) expect((await ctx.deps.kb.prices.byId(ACCOUNT_ID, id))?.origin).toBe('web');
    // Черновик 68: строки ДПГ уже стоят на INT-017 от прежнего подбора — «Найти цены» с заменой не тянет этот ID в одинаковые строки.
    const stored = (await ctx.deps.kp.byId(ACCOUNT_ID, d0.id))!.payload as unknown as { items: Record<string, unknown>[] };
    await ctx.deps.kp.setPayload(d0.id, { ...stored, items: stored.items.map((l, i) => (i < 3 ? { ...l, productId: 'INT-017', price: 23_426, priceOutcome: 'priced', priceLabel: 'по прайсу: ДС-1-Г-ВЛ-ПВХ' } : l)) } as unknown as Record<string, unknown>);
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: d0.id, requestIndexes: [0, 1, 2] } });
    const d2 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft as { items: Line[] };
    expect(d2.items.slice(0, 3).map((l) => [l.productId, l.price, l.priceOutcome])).toEqual([[null, null, 'not_priced'], [null, null, 'not_priced'], [null, null, 'not_priced']]);
    expect(g.searches()).toBe(searches + 1);
    // Опросник: модель и цены интернета — «оставить без цены», Акву — искать в интернете (тоже без цены), доставка, срок цены.
    await answerSurvey(ctx.app, headers, LEAD_ID, { web_price: { option: 'no_price' }, analog: { option: 'web' } });
    // Цена прежнего веб-поиска, оставшаяся в черновике (ДПГУЧ 40 029,67 ₽ «по рынку»), при сборке снимается — «уточнить у менеджера».
    const p2 = (await ctx.deps.kp.byId(ACCOUNT_ID, d0.id))!.payload as unknown as { items: Record<string, unknown>[] };
    await ctx.deps.kp.setPayload(d0.id, { ...p2, items: p2.items.map((l, i) => (i === 3 ? { ...l, price: 40_029.67, priceSource: 'research', priceLabel: 'по рынку (19.10.2026)', priceOutcome: undefined } : i === 7 ? { ...l, tzEquipment: 'раздел «15. Базовая комплектация»: коробка, 3 петли, доводчик' } : l)) } as unknown as Record<string, unknown>);
    // Документ: ДПГ/ДПГУЧ/Аква без цены, коробка — примечанием под своей дверью, ни одного «0 ₽».
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/build', headers, payload: { draftId: d0.id } })).json()).toMatchObject({ draft: { status: 'built' } });
    const text = new PizZip(readFileSync(resolveKpPath(ctx.deps.filesRoot, (await ctx.deps.kp.byId(ACCOUNT_ID, d0.id))!.docxPath!))).file('word/document.xml')!.asText().replace(/\u00a0/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(text).not.toMatch(/(?<![0-9 ])0 ₽/);
    // Строки без цены — сумма «—», в итог не входят (шаблон теста выводит сумму строки).
    expect(text.match(/(ДПГ|ДПГУЧ) \+ УПД, сота; кромка ПВХ 1 мм с 2-х сторон — —/g)).toHaveLength(4);
    expect(text).toContain('(Дб-9) — —');
    expect(text).toContain(`итого ${(5 * 6800 + 23_426 + 2 * 24_100).toLocaleString('ru-RU').replace(/\u00a0/g, ' ')} ₽`);
    expect(text).toMatch(/Дверь техническая ДМ-1.*В цену блока входит: Коробка стальная/);
    expect(text).not.toContain('40 029');
    // KP-DOCX-APPENDIX: комплектация из ТЗ — примечанием под позицией.
    expect(text).toMatch(/Дверь техническая ДМ-1.*Комплектация по ТЗ: раздел «15\. Базовая комплектация»: коробка, 3 петли, доводчик/);
    expect(((await ctx.deps.kp.byId(ACCOUNT_ID, d0.id))!.payload as unknown as { items: Record<string, unknown>[] }).items[3]).toMatchObject({ price: null, priceOutcome: 'not_priced', priceLabel: 'цена не из прайса' });
  }, 30_000);
});
