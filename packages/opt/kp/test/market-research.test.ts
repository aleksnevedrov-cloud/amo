import { LlmError, WebSearchUnavailableError, type ChatRoute, type LlmGateway, type RoutedRequest, type RoutedResponse, type WebSource } from '@core/llm';
import { describe, expect, it } from 'vitest';
import { buildQuery, cleanName, describeItem, dropOutliers, judgeOffer, leavesOf, median, notRfShop, orientSize, parseSizeMm, researchMarketPrice, scaleByArea, statsOf, urlConfirmed, type ItemCard, type MarketOffer, type MarketResearchInput } from '../src/market-research.ts';

const route: ChatRoute = { primary: { provider: 'openai', model: 'gpt-5' }, fallback: null };

const CARD = { kind: 'leaf', factory: 'Профиль Дорс', model: '2.47U', collection: 'U', finish: 'ПВХ', color: 'белый', glazing: 'сатинат', heightMm: 2000, widthMm: 800, leaves: null, equipment: null, fireRating: null, standards: [] };

/** Ответ модели: первый вызов — карточка, второй — предложения с источниками и счётчиком поиска. */
function fakeLlm(card: unknown, offers: unknown, sources: WebSource[], calls = 2): LlmGateway & { requests: RoutedRequest[] } {
  const requests: RoutedRequest[] = [];
  const reply = (text: string, web: boolean): RoutedResponse => ({
    text,
    toolCalls: [],
    stopReason: 'end',
    usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, cacheWriteTokens: 0, ...(web ? { webSearchCalls: calls } : {}) },
    provider: 'openai',
    model: 'gpt-5',
    assistantMessage: { role: 'assistant', content: text },
    latencyMs: 1,
    ...(web ? { sources } : {}),
    fallbackUsed: false,
    requested: route.primary,
    attempts: [],
  });
  return {
    requests,
    async chat(req) {
      requests.push(req);
      if (req.webSearch) {
        if (offers instanceof Error) throw offers;
        return reply(JSON.stringify(offers), true);
      }
      return reply(JSON.stringify(card), false);
    },
    providers: async () => ['openai'],
    provider: async () => null,
  };
}

const input: MarketResearchInput = {
  line: { name: 'Профиль Дорс 2.47U белый', size: '2000×800 мм', qty: 3, price: null },
  item: { raw: 'Дверь Профиль Дорс 2.47U белый сатинат 2000×800 — 3 шт', name: 'Профиль Дорс 2.47U белый', width_mm: 800, height_mm: 2000 },
  requirements: [],
};

const card: ItemCard = { ...CARD, kind: 'leaf', standards: [], lowConfidence: false };
const SRC: WebSource[] = [{ url: 'https://profildoors.ru/2-47u' }, { url: 'https://dveri-shop.ru/p/247u/' }, { url: 'https://market.ru/x' }, { url: 'https://agg.ru/y' }, { url: 'https://m2.ru/z' }];
const offer = (over: Partial<MarketOffer>): MarketOffer => ({
  url: 'https://dveri-shop.ru/p/247u',
  seller: 'dveri-shop',
  title: 'Профиль Дорс 2.47U белый',
  price: 10_000,
  currency: 'RUB',
  unit: 'piece',
  quantityInUnit: null,
  inStock: true,
  vatStated: 'included',
  vatRateStated: null,
  sourceKind: 'retail',
  includesDelivery: null,
  deliveryRub: null,
  factory: 'Профиль Дорс',
  model: '2.47U',
  design: ['ПВХ', 'белый'],
  standards: [],
  widthMm: 800,
  heightMm: 2000,
  kind: 'leaf',
  leaves: null,
  foundAt: '2026-10-13T10:00:00.000Z',
  ...over,
});

describe('карточка позиции и запрос', () => {
  it('фабрика и модель из ответа модели, размер из позиции важнее пересказа модели, ГОСТ заявки попадает в стандарты', async () => {
    const llm = fakeLlm({ ...CARD, heightMm: 2100, widthMm: 700 }, { offers: [] }, []);
    const { card: c } = await describeItem(llm, route, { ...input, requirements: ['ГОСТ 475-2016', 'срок 10 дней'] });
    expect(c).toMatchObject({ kind: 'leaf', factory: 'Профиль Дорс', model: '2.47U', heightMm: 2000, widthMm: 800, standards: ['ГОСТ 475-2016'], lowConfidence: false });
    // Карточка — без веб-поиска и по строгой схеме.
    expect(llm.requests[0]?.webSearch).toBeUndefined();
    expect(llm.requests[0]?.outputSchema?.name).toBe('item_card');
    expect(buildQuery(c, input.item, input.line)).toBe('Профиль Дорс 2.47U U дверное полотно ПВХ белый 800×2000 купить цена Москва');
  });

  it('без фабрики или модели — lowConfidence, запрос по наименованию и характеристикам', async () => {
    const llm = fakeLlm({ ...CARD, factory: null, model: null, collection: null }, { offers: [] }, []);
    const { card: c } = await describeItem(llm, route, { ...input, item: { ...input.item, name: 'Дверь межкомнатная ПВХ белая' } });
    expect(c.lowConfidence).toBe(true);
    expect(buildQuery(c, { ...input.item, name: 'Дверь межкомнатная ПВХ белая' }, input.line)).toBe('Дверь межкомнатная ПВХ белая дверное полотно белый сатинат 800×2000 купить цена Москва');
  });
});

describe('фильтр предложений', () => {
  it('ссылка не из источников поиска отклоняется — цены «по памяти модели» в расчёт не попадают', () => {
    expect(urlConfirmed('https://dveri-shop.ru/p/247u', SRC)).toBe(true);
    expect(urlConfirmed('https://DVERI-SHOP.ru/p/247u/', SRC)).toBe(true);
    expect(urlConfirmed('https://dveri-shop.ru/p/other', SRC)).toBe(false);
    expect(judgeOffer(offer({ url: 'https://dveri-shop.ru/p/other' }), card, SRC)).toMatchObject({ accepted: false, reason: 'ссылка не подтверждена поиском', unitPrice: null });
    expect(judgeOffer(offer({ currency: 'USD' }), card, SRC)).toMatchObject({ accepted: false, reason: 'не рубли' });
  });

  it('тип товара: дверь, полотно и блок совместимы (пометка, не отказ); фурнитура и комплект — другой товар; неизвестный тип (other) не мешает', () => {
    expect(judgeOffer(offer({ kind: 'block' }), card, SRC)).toMatchObject({ accepted: true, notes: ['тип: дверной блок вместо «дверное полотно»'] });
    expect(judgeOffer(offer({ kind: 'leaf' }), { ...card, kind: 'door' }, SRC)).toMatchObject({ accepted: true, notes: ['тип: дверное полотно вместо «дверь»'] });
    expect(judgeOffer(offer({ kind: 'hardware' }), card, SRC)).toMatchObject({ accepted: false, reason: 'другой тип товара' });
    expect(judgeOffer(offer({ kind: 'set' }), { ...card, kind: 'door' }, SRC)).toMatchObject({ accepted: false, reason: 'другой тип товара' });
    expect(judgeOffer(offer({ kind: 'other' }), card, SRC)).toMatchObject({ accepted: true, notes: [] });
  });

  it('число створок: двухпольная позиция и однопольное предложение — отказ; неизвестное число створок не проверяется', () => {
    expect(leavesOf('Дверь межкомнатная двухпольная из массива')).toBe(2);
    expect(leavesOf('дверь двустворчатая')).toBe(2);
    expect(leavesOf('Полотно однопольное')).toBe(1);
    expect(leavesOf('Дверь Турин')).toBeNull();
    expect(judgeOffer(offer({ leaves: 1 }), { ...card, leaves: 2 }, SRC)).toMatchObject({ accepted: false, reason: 'другое число створок' });
    expect(judgeOffer(offer({ leaves: 2 }), { ...card, leaves: 2 }, SRC)).toMatchObject({ accepted: true });
    expect(judgeOffer(offer({ leaves: null }), { ...card, leaves: 2 }, SRC)).toMatchObject({ accepted: true });
  });

  it('только магазины РФ: reddit, зарубежный домен, PDF и госдокументы отбрасываются до разбора с причиной; .com с рублями проходит', () => {
    expect(notRfShop('https://www.reddit.com/r/doors/x')).toBe('не магазин (reddit.com)');
    expect(notRfShop('https://www.tueren.de/produkt')).toBe('домен .de');
    expect(notRfShop('https://fabrika.ru/catalog/price.pdf?v=2')).toBe('PDF-документ');
    expect(notRfShop('https://docs.cntd.ru/document/1200')).toBe('не магазин (docs.cntd.ru)');
    expect(notRfShop('https://zakupki.gov.ru/epz/order')).toBe('госдокумент');
    expect(notRfShop('https://dveri-shop.ru/p/247u')).toBeNull();
    expect(notRfShop('https://xn--80aaaf.xn--p1ai/p')).toBeNull();
    expect(notRfShop('https://doors.com/p')).toBeNull();
    const src = [{ url: 'https://www.reddit.com/r/doors/x' }, { url: 'https://doors.com/p' }];
    expect(judgeOffer(offer({ url: 'https://www.reddit.com/r/doors/x' }), card, src)).toMatchObject({ accepted: false, reason: 'не магазин РФ', notes: ['не магазин (reddit.com)'] });
    expect(judgeOffer(offer({ url: 'https://doors.com/p', currency: 'USD' }), card, src)).toMatchObject({ accepted: false, reason: 'не рубли' });
    expect(judgeOffer(offer({ url: 'https://doors.com/p' }), card, src)).toMatchObject({ accepted: true });
  });

  it('единицы: комплект делится на количество, м² умножается на площадь полотна, без данных — «единица не приводится»', () => {
    const set = judgeOffer(offer({ unit: 'set', quantityInUnit: 4, price: 40_000 }), card, SRC);
    expect(set).toMatchObject({ accepted: true, unitPrice: 10_000 });
    expect(set.formula?.replace(/\u00a0/g, ' ')).toBe('комплект 4 шт → за штуку 10 000 ₽');
    expect(judgeOffer(offer({ unit: 'set', quantityInUnit: null }), card, SRC)).toMatchObject({ accepted: false, reason: 'единица не приводится' });
    const m2 = judgeOffer(offer({ url: 'https://m2.ru/z', unit: 'm2', price: 5_000, widthMm: null, heightMm: null }), card, SRC);
    expect(m2).toMatchObject({ accepted: true, unitPrice: 8_000 });
    expect(m2.formula?.replace(/\u00a0/g, ' ')).toBe('5 000 ₽/м² × (800 × 2000 мм = 1.600 м²) = 8 000 ₽');
    expect(judgeOffer(offer({ unit: 'm2' }), { ...card, heightMm: null, widthMm: null }, SRC)).toMatchObject({ accepted: false, reason: 'цена за м² без размера позиции' });
  });

  it('размер: меньшее значение — ширина; «1400x2700», «1,4х2,7м» и «2000×800» разбираются одинаково; у предложения размер тоже ориентируется', async () => {
    expect(orientSize(2700, 1400)).toEqual({ widthMm: 1400, heightMm: 2700 });
    expect(orientSize(800, 2000)).toEqual({ widthMm: 800, heightMm: 2000 });
    expect(orientSize(null, 2000)).toEqual({ widthMm: null, heightMm: 2000 });
    expect(parseSizeMm('Дверь двухпольная из массива лиственницы 1400x2700 мм, окраска L429')).toEqual({ widthMm: 1400, heightMm: 2700 });
    expect(parseSizeMm('дверь 1,4х2,7м, 2 шт')).toEqual({ widthMm: 1400, heightMm: 2700 });
    expect(parseSizeMm('Турин 2000×800')).toEqual({ widthMm: 800, heightMm: 2000 });
    expect(parseSizeMm('полотно 2000*800 мм')).toEqual({ widthMm: 800, heightMm: 2000 });
    expect(parseSizeMm('Дверь без размера')).toBeNull();
    // Модель перепутала стороны (heightMm 1400, widthMm 2700) — карточка исправляет по правилу.
    const text = 'Дверь межкомнатная двухпольная из массива лиственницы 1400x2700 мм, окраска L429 Indigo, 2 шт';
    const llm = fakeLlm({ ...CARD, kind: 'block', factory: null, model: null, heightMm: 1400, widthMm: 2700, leaves: null, finish: 'окраска', color: 'L429 Indigo', glazing: null }, { offers: [] }, []);
    const { card: c } = await describeItem(llm, route, { line: { name: text, size: '', qty: 2, price: null }, item: { raw: text, name: text, width_mm: null, height_mm: null }, requirements: [] });
    expect(c).toMatchObject({ widthMm: 1400, heightMm: 2700, leaves: 2 });
    // Предложение с размером «2700×1400» — тот же размер.
    expect(judgeOffer(offer({ widthMm: 2700, heightMm: 1400 }), { ...c, kind: 'leaf', lowConfidence: true }, SRC)).toMatchObject({ accepted: true });
  });

  it('запрос: без количества и без дублей признаков, размер один раз', () => {
    const text = 'Дверь межкомнатная двухпольная из массива лиственницы 1400x2700 мм, окраска L429 Indigo, 2 шт';
    expect(cleanName(text)).toBe('Дверь межкомнатная двухпольная из массива лиственницы, окраска L429 Indigo');
    expect(cleanName('Полотно Турин 2000×800 — 3 штуки')).toBe('Полотно Турин');
    const c: ItemCard = { kind: 'door', factory: null, model: null, collection: null, finish: 'окраска', color: 'L429 Indigo', glazing: null, heightMm: 2700, widthMm: 1400, leaves: 2, equipment: null, fireRating: null, standards: [], lowConfidence: true };
    expect(buildQuery(c, { raw: text, name: text, width_mm: null, height_mm: null }, { name: text, size: '', qty: 2, price: null })).toBe('Дверь межкомнатная двухпольная из массива лиственницы, окраска L429 Indigo 1400×2700 купить цена Москва');
  });

  it('размер: отклонение больше допуска отклоняется, в допуске принимается, неизвестный размер не проверяется', () => {
    expect(judgeOffer(offer({ widthMm: 700 }), card, SRC)).toMatchObject({ accepted: false, reason: 'другой размер', unitPrice: 10_000 });
    expect(judgeOffer(offer({ widthMm: 790 }), card, SRC, { sizeToleranceMm: 10 })).toMatchObject({ accepted: true });
    expect(judgeOffer(offer({ widthMm: 789 }), card, SRC, { sizeToleranceMm: 10 })).toMatchObject({ accepted: false, reason: 'другой размер' });
    expect(judgeOffer(offer({ widthMm: null, heightMm: null }), card, SRC)).toMatchObject({ accepted: true });
  });

  it('доставка в цене: без суммы отклоняется, с суммой вычитается и попадает в формулу', () => {
    expect(judgeOffer(offer({ includesDelivery: true }), card, SRC)).toMatchObject({ accepted: false, reason: 'доставка в цене без суммы' });
    const j = judgeOffer(offer({ includesDelivery: true, deliveryRub: 1_500, price: 11_500 }), card, SRC);
    expect(j).toMatchObject({ accepted: true, unitPrice: 10_000 });
    expect(j.formula?.replace(/\u00a0/g, ' ')).toBe('11 500 ₽ − доставка 1 500 ₽ = 10 000 ₽');
  });

  it('НДС источника: не указан — конечная цена с НДС и пометка (5.1); pre_net без ставки — не определён; pre_net со ставкой доначисляется; no_vat — конечная цена', () => {
    expect(judgeOffer(offer({ vatStated: 'unknown' }), card, SRC)).toMatchObject({ accepted: true, unitPrice: 10_000, vatAssumed: true, notes: ['НДС по умолчанию (не указан на сайте)'] });
    expect(judgeOffer(offer({ vatStated: 'included' }), card, SRC).vatAssumed).toBe(false);
    expect(judgeOffer(offer({ vatStated: 'pre_net', vatRateStated: null }), card, SRC)).toMatchObject({ accepted: false, reason: 'НДС не определён' });
    const j = judgeOffer(offer({ vatStated: 'pre_net', vatRateStated: 22 }), card, SRC);
    expect(j).toMatchObject({ accepted: true, unitPrice: 12_200 });
    expect(j.formula?.replace(/\u00a0/g, ' ')).toBe('+ НДС 22 % = 12 200 ₽');
    expect(judgeOffer(offer({ vatStated: 'no_vat' }), card, SRC)).toMatchObject({ accepted: true, unitPrice: 10_000, formula: null });
  });

  it('другая модель или фабрика — отклонение «другая модель» (кандидат в аналоги); у позиции без модели сравнения нет; домен производителя из настроек', () => {
    expect(judgeOffer(offer({ model: '2.48U' }), card, SRC)).toMatchObject({ accepted: false, reason: 'другая модель', unitPrice: 10_000 });
    expect(judgeOffer(offer({ factory: 'Браво' }), card, SRC)).toMatchObject({ accepted: false, reason: 'другая модель' });
    expect(judgeOffer(offer({ model: 'ПД 2.47U белый' }), card, SRC)).toMatchObject({ accepted: true });
    expect(judgeOffer(offer({ model: '2.48U' }), { ...card, factory: null, model: null, lowConfidence: true }, SRC)).toMatchObject({ accepted: true });
    expect(judgeOffer(offer({}), card, SRC).manufacturer).toBe(false);
    expect(judgeOffer(offer({}), card, SRC, { manufacturerDomains: ['dveri-shop.ru'] }).manufacturer).toBe(true);
    expect(judgeOffer(offer({ sourceKind: 'manufacturer' }), card, SRC).manufacturer).toBe(true);
  });
});

describe('аналог по площади (5.1)', () => {
  // Пример заказчика: сделка 30013995, позиция 1400×2700, пять предложений — все отброшены до 5.1.
  const door: ItemCard = { kind: 'door', factory: null, model: null, collection: null, finish: 'окраска', color: 'L429 Indigo', glazing: null, heightMm: 2700, widthMm: 1400, leaves: 2, equipment: null, fireRating: null, standards: [], lowConfidence: true };
  const src = [{ url: 'https://woodwindows.ru/1' }, { url: 'https://woodwindows.ru/2' }, { url: 'https://woodwindows.ru/3' }, { url: 'https://dverka.moscow/4' }, { url: 'https://otis-group.ru/5' }];
  const wood = (url: string, price: number, widthMm: number | null, heightMm: number | null, leaves: number | null = 2) => offer({ url, seller: 'Альянс', title: 'Дверь двупольная из лиственницы', price, vatStated: 'unknown', factory: null, model: null, widthMm, heightMm, kind: 'door', leaves });

  it('три предложения Альянса пересчитываются по площади (1000×2700 и 2000×2700 → 1400×2700), НДС по умолчанию; другое число створок и без размера — не берутся', () => {
    const judged = [
      wood('https://woodwindows.ru/1', 77_000, 1000, 2700),
      wood('https://woodwindows.ru/2', 148_000, 2000, 2700),
      wood('https://woodwindows.ru/3', 162_000, 2000, 2700),
      wood('https://dverka.moscow/4', 30_045, null, null, 1),
      wood('https://otis-group.ru/5', 12_441, 550, 1900, 1),
    ].map((o) => judgeOffer(o, door, src));
    expect(judged.map((j) => j.reason)).toEqual(['другой размер', 'другой размер', 'другой размер', 'другое число створок', 'другое число створок']);
    const { judged: scaled, scaled: flag } = scaleByArea(judged, door);
    expect(flag).toBe(true);
    // 77 000 × (3,78 / 2,70) = 107 800; 148 000 × (3,78 / 5,40) = 103 600; 162 000 × 0,7 = 113 400.
    expect(scaled.filter((j) => j.accepted).map((j) => [j.sourceSize, j.unitPrice, j.vatAssumed])).toEqual([['1000×2700', 107_800, true], ['2000×2700', 103_600, true], ['2000×2700', 113_400, true]]);
    expect(scaled[0]?.notes).toEqual(['НДС по умолчанию (не указан на сайте)', 'аналог, пересчёт по площади с 1000×2700']);
    expect(scaled[0]?.formula?.replace(/\u00a0/g, ' ')).toBe('пересчёт по площади: 77 000 ₽ × (3.780 / 2.700 м²) = 107 800 ₽');
    expect(scaled.filter((j) => !j.accepted).map((j) => j.reason)).toEqual(['другое число створок', 'другое число створок']);
    expect(statsOf(dropOutliers(scaled))).toEqual({ min: 103_600, max: 113_400, median: 107_800, count: 3, unit: 'piece' });
  });

  it('ближайшие по площади — не больше трёх; точное совпадение есть — пересчёта нет; без размера позиции — нет', () => {
    // Ширины 1100…1600 без точного 1400: ближайшие по площади — 1300 и 1500 (по 100 мм), затем 1200.
    const widths = [1100, 1200, 1300, 1500, 1600];
    const manySrc = widths.map((w) => ({ url: `https://woodwindows.ru/w${w}` }));
    const many = widths.map((w) => judgeOffer(wood(`https://woodwindows.ru/w${w}`, 100_000, w, 2700), door, manySrc));
    const r = scaleByArea(many, door);
    // Выбраны три ближайших (1300 и 1500 по 100 мм, затем 1200); порядок в списке — исходный.
    expect(r.judged.filter((j) => j.accepted).map((j) => j.sourceSize)).toEqual(['1200×2700', '1300×2700', '1500×2700']);
    const exact = [judgeOffer(wood('https://woodwindows.ru/1', 90_000, 1400, 2700), door, src), judgeOffer(wood('https://woodwindows.ru/2', 148_000, 2000, 2700), door, src)];
    expect(scaleByArea(exact, door)).toMatchObject({ scaled: false });
    expect(scaleByArea(exact, door).judged[1]?.accepted).toBe(false);
    expect(scaleByArea(judged1(), { ...door, heightMm: null, widthMm: null }).scaled).toBe(false);
    function judged1() {
      return [judgeOffer(wood('https://woodwindows.ru/1', 77_000, 1000, 2700), door, src)];
    }
  });

  it('полный прогон по примеру: status ok, медиана 107 800 по трём пересчитанным, areaScaled', async () => {
    const llm = fakeLlm({ ...CARD, kind: 'door', factory: null, model: null, leaves: 2, heightMm: 2700, widthMm: 1400 }, { offers: [
      wood('https://woodwindows.ru/1', 77_000, 1000, 2700), wood('https://woodwindows.ru/2', 148_000, 2000, 2700), wood('https://woodwindows.ru/3', 162_000, 2000, 2700), wood('https://dverka.moscow/4', 30_045, null, null, 1), wood('https://otis-group.ru/5', 12_441, 550, 1900, 1),
    ] }, src);
    const text = 'Дверь межкомнатная двухпольная из массива лиственницы 1400x2700 мм, окраска L429 Indigo, 2 шт';
    const r = await researchMarketPrice(llm, route, { line: { name: text, size: '1400×2700 мм', qty: 2, price: null }, item: { raw: text, name: text, width_mm: 1400, height_mm: 2700 }, requirements: [] });
    expect(r).toMatchObject({ status: 'ok', areaScaled: true, stats: { min: 103_600, max: 113_400, median: 107_800, count: 3 } });
    expect(r.offers.filter((j) => j.accepted)).toHaveLength(3);
  });
});

describe('статистика', () => {
  it('медиана: нечётное — средний, чётное — среднее двух средних; выброс ×3 от медианы остальных исключается', () => {
    expect(median([30, 10, 20])).toBe(20);
    expect(median([10, 20, 30, 40])).toBe(25);
    expect(median([])).toBe(0);
    const judged = [9_000, 10_000, 11_000, 40_000].map((price, i) => judgeOffer(offer({ price, url: SRC[i]!.url }), card, SRC));
    const after = dropOutliers(judged);
    expect(after.map((j) => [j.unitPrice, j.accepted, j.reason])).toEqual([[9_000, true, null], [10_000, true, null], [11_000, true, null], [40_000, false, 'выброс']]);
    expect(statsOf(after)).toEqual({ min: 9_000, max: 11_000, median: 10_000, count: 3, unit: 'piece' });
    // Меньше трёх принятых — выбросы не считаются.
    expect(dropOutliers(judged.slice(2)).every((j) => j.accepted)).toBe(true);
    expect(statsOf([])).toBeNull();
  });
});

describe('полный прогон', () => {
  it('status ok: статистика по принятым, производители первыми, стоимость с веб-поиском, источники сохранены', async () => {
    const offers = [
      offer({ url: 'https://market.ru/x', price: 9_500, sourceKind: 'marketplace' }),
      offer({ url: 'https://profildoors.ru/2-47u', price: 10_500, sourceKind: 'manufacturer' }),
      offer({ url: 'https://dveri-shop.ru/p/247u', price: 10_000, vatStated: 'unknown' }),
      offer({ url: 'https://nowhere.ru/p', price: 1 }),
    ];
    const llm = fakeLlm(CARD, { offers }, SRC);
    const r = await researchMarketPrice(llm, route, input, { pricing: { 'openai:gpt-5': { input: 1, output: 2, cachedInput: 0.5 } } });
    expect(r.status).toBe('ok');
    // НДС не указан у dveri-shop — цена принята как конечная (5.1): три источника в медиане.
    expect(r.stats).toEqual({ min: 9_500, max: 10_500, median: 10_000, count: 3, unit: 'piece' });
    expect(r.offers.map((j) => [j.offer.url, j.accepted, j.reason, j.vatAssumed])).toEqual([
      ['https://profildoors.ru/2-47u', true, null, false],
      ['https://market.ru/x', true, null, false],
      ['https://dveri-shop.ru/p/247u', true, null, true],
      ['https://nowhere.ru/p', false, 'ссылка не подтверждена поиском', undefined],
    ]);
    expect(r.areaScaled).toBe(false);
    expect(r.offers.every((j) => j.offer.foundAt && !Number.isNaN(Date.parse(j.offer.foundAt)))).toBe(true);
    expect(r.webSearchCalls).toBe(2);
    expect(r.sources).toEqual(SRC);
    // Два вызова по 100/50 токенов плюс два вызова поиска по $0,01.
    expect(r.cost).toEqual({ inputTokens: 200, outputTokens: 100, usd: expect.closeTo(0.0004 + 0.02, 6) });
    expect(llm.requests[1]).toMatchObject({ webSearch: { region: { country: 'RU', city: 'Moscow', region: 'Moscow' } }, toolChoice: 'required', outputSchema: { name: 'market_offers' } });
    expect(r.analog).toBeNull();
  });

  it('status none: ничего не принято — цены нет; аналог из отклонённых «другая модель» по цене менеджера', async () => {
    const offers = [offer({ url: 'https://profildoors.ru/2-47u', model: '2.48U', price: 10_300, sourceKind: 'manufacturer' }), offer({ url: 'https://market.ru/x', model: '2.50U', price: 15_000 })];
    const llm = fakeLlm(CARD, { offers }, SRC);
    const r = await researchMarketPrice(llm, route, { ...input, managerPrice: 10_000 });
    expect(r.status).toBe('none');
    expect(r.stats).toBeNull();
    expect(r.analog).toMatchObject({ url: 'https://profildoors.ru/2-47u', unitPrice: 10_300, suggestion: { criterion: 'design', matched: ['design', 'price'], candidate: { id: 'https://profildoors.ru/2-47u' } } });
    expect(r.analog?.suggestion.reason.replace(/\u00a0/g, ' ')).toContain('по аналогу: Профиль Дорс 2.48U Профиль Дорс 2.47U белый, dveri-shop, https://profildoors.ru/2-47u; 10 300 ₽');
    // Без опорной цены и без общих признаков с заявкой аналога нет.
    const plain = offer({ url: 'https://market.ru/x', model: '2.50U', title: 'Полотно 2.50U', design: [], price: 15_000 });
    const r2 = await researchMarketPrice(fakeLlm(CARD, { offers: [plain] }, SRC), route, input);
    expect(r2.status).toBe('none');
    expect(r2.analog).toBeNull();
  });

  it('status failed: веб-поиск недоступен — текст провайдера, цены нет, карточка и запрос сохранены', async () => {
    const llm = fakeLlm(CARD, new WebSearchUnavailableError('openai', 'OpenAI отверг запрос с веб-поиском: tool web_search is not supported'), []);
    const r = await researchMarketPrice(llm, route, input);
    expect(r).toMatchObject({ status: 'failed', stats: null, offers: [], analog: null, error: 'веб-поиск недоступен: OpenAI отверг запрос с веб-поиском: tool web_search is not supported', card: { factory: 'Профиль Дорс' }, provider: 'openai' });
    expect(r.query).toContain('купить цена Москва');
    const quota = await researchMarketPrice(fakeLlm(CARD, new LlmError('quota', 'openai', 'insufficient_quota'), []), route, input);
    expect(quota).toMatchObject({ status: 'failed', error: 'insufficient_quota' });
    // Прочие ошибки не глотаются.
    await expect(researchMarketPrice(fakeLlm(CARD, new TypeError('boom'), []), route, input)).rejects.toThrow('boom');
  });

  it('мусор в ответе поиска: невалидные предложения пропускаются, валидные остаются', async () => {
    const llm = fakeLlm(CARD, { offers: [{ url: 'https://market.ru/x', price: -5 }, 'строка', offer({ url: 'https://market.ru/x', price: 9_900 })] }, SRC);
    const r = await researchMarketPrice(llm, route, input);
    expect(r.status).toBe('ok');
    expect(r.offers).toHaveLength(1);
    expect(r.stats?.median).toBe(9_900);
  });
});
