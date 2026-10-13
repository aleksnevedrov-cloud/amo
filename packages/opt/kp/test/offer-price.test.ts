// Цена предложения и НДС (RFD-AI-AGENT-OPT-PRICE, этап 4): копейки, коэффициенты, пометки, НДС источников и НДС КП.
import { describe, expect, it } from 'vitest';
import { templateData } from '../src/build.ts';
import type { MarketResearchResult, OfferJudgement } from '../src/market-research.ts';
import { formatKopecks, lineSumKopecks, manufacturerCoefficient, offerPrice, pickCoefficient, splitVat, toKopecks } from '../src/offer-price.ts';

const plain = (s: string) => s.replace(/\u00a0/g, ' ');
const judged = (price: number, reason: OfferJudgement['reason'] = null): OfferJudgement => ({
  offer: { url: `https://shop.ru/${price}`, seller: 'shop', title: 'Дверь', price, currency: 'RUB', unit: 'piece', quantityInUnit: null, inStock: true, vatStated: reason === 'НДС не определён' ? 'unknown' : 'included', vatRateStated: null, sourceKind: 'retail', includesDelivery: null, deliveryRub: null, factory: null, model: null, design: [], standards: [], widthMm: null, heightMm: null, kind: 'door', leaves: null, foundAt: '2026-10-13T10:00:00.000Z' },
  accepted: reason === null,
  reason,
  unitPrice: price,
  formula: null,
  manufacturer: false,
  notes: [],
});
const research = (over: Partial<MarketResearchResult>): MarketResearchResult => ({ query: 'дверь', card: null, status: 'ok', offers: [], stats: null, analog: null, error: null, provider: 'openai', model: 'gpt-5', webSearchCalls: 2, cost: { inputTokens: 0, outputTokens: 0, usd: 0 }, sources: [], ...over });
const stats = (prices: number[]) => {
  const xs = [...prices].sort((a, b) => a - b);
  const n = xs.length;
  const median = n % 2 ? xs[(n - 1) / 2]! : (xs[n / 2 - 1]! + xs[n / 2]!) / 2;
  return { min: xs[0]!, max: xs[n - 1]!, median, count: n, unit: 'piece' as const };
};

describe('коэффициент', () => {
  it('приоритет: позиция → производитель → общий → 1,00; ноль, отрицательное и NaN не принимаются', () => {
    expect(pickCoefficient({ line: 0.95, manufacturer: 1.1, general: 1.05 })).toEqual({ value: 0.95, source: 'line' });
    expect(pickCoefficient({ line: null, manufacturer: 1.1, general: 1.05 })).toEqual({ value: 1.1, source: 'manufacturer' });
    expect(pickCoefficient({ general: 1.05 })).toEqual({ value: 1.05, source: 'general' });
    expect(pickCoefficient({ line: 0, manufacturer: -1, general: Number.NaN })).toEqual({ value: 1, source: 'default' });
    expect(pickCoefficient()).toEqual({ value: 1, source: 'default' });
    expect(manufacturerCoefficient('Профиль Дорс', { 'профиль дорс': 0.9, Браво: 1.1 })).toBe(0.9);
    expect(manufacturerCoefficient('Браво', { 'профиль дорс': 0.9, Браво: 1.1 })).toBe(1.1);
    expect(manufacturerCoefficient('Другая', { Браво: 1.1 })).toBeNull();
    expect(manufacturerCoefficient(null, { Браво: 1.1 })).toBeNull();
  });
});

describe('цена предложения', () => {
  it('3 и больше источников: медиана × 1,00, копейки без потерь, пометок нет; НДС не определён — отдельно, не в медиане', () => {
    const offers = [judged(10_000), judged(10_333.33), judged(12_000), judged(9_000, 'НДС не определён')];
    const r = research({ offers, stats: stats([10_000, 10_333.33, 12_000]) });
    const p = offerPrice(r);
    expect(p).toMatchObject({ status: 'ok', basis: 'median', sources: 3, priceKopecks: 1_033_333, price: 10_333.33, medianKopecks: 1_033_333, coefficient: { value: 1, source: 'default' }, notes: [] });
    expect(p.vatUnknown.map((o) => o.offer.price)).toEqual([9_000]);
    expect(plain(p.formula!)).toBe('медиана 10 333,33 ₽ (3 источника) = 10 333,33 ₽');
  });

  it('медиана на чётном числе — среднее двух средних; коэффициент применяется к копейкам с одним округлением', () => {
    const r = research({ stats: stats([10_000, 10_001, 12_000, 20_000]) });
    expect(r.stats?.median).toBe(11_000.5);
    const p = offerPrice(r, { line: 0.97 });
    // 1 100 050 коп × 0,97 = 1 067 048,5 → 1 067 049 коп (округление один раз, на последнем шаге).
    expect(p.priceKopecks).toBe(1_067_049);
    expect(p.price).toBe(10_670.49);
    expect(plain(p.formula!)).toBe('медиана 11 000,50 ₽ (4 источника) × 0.97 = 10 670,49 ₽');
    expect(toKopecks(0.1 + 0.2)).toBe(30);
  });

  it('1–2 источника: цена ставится с пометкой «ограничение расчёта»', () => {
    expect(offerPrice(research({ stats: stats([15_000]) }))).toMatchObject({ status: 'ok', price: 15_000, notes: ['ограничение расчёта: 1 источник'] });
    expect(offerPrice(research({ stats: stats([15_000, 16_000]) }))).toMatchObject({ status: 'ok', price: 15_500, notes: ['ограничение расчёта: 2 источника'] });
  });

  it('только аналог: цена ставится с пометкой аналога; аналог без опорной цены — с «цена не сравнивалась»', () => {
    const analog = (reason: string) => ({ suggestion: { candidate: { id: 'https://f.ru/a', name: 'Турин', vendor: 'Фабрика', price: 12_000, design: [], standards: [] }, criterion: 'design' as const, matched: ['design' as const], detail: 'общие признаки «шпон»', comparablePrice: 12_000, score: 10, reason }, unitPrice: 12_000, url: 'https://f.ru/a', foundAt: '2026-10-13' });
    const withRef = offerPrice(research({ status: 'none', analog: analog('предварительно, по аналогу: Фабрика Турин, f.ru, https://f.ru/a; 12 000 ₽; совпадение по дизайну (общие признаки «шпон»)') }), { general: 1.05 });
    expect(withRef).toMatchObject({ status: 'ok', basis: 'analog', sources: 0, priceKopecks: 1_260_000, price: 12_600 });
    expect(withRef.notes).toEqual(['предварительно, по аналогу: Фабрика Турин, f.ru, https://f.ru/a; 12 000 ₽; совпадение по дизайну (общие признаки «шпон»)']);
    const noRef = offerPrice(research({ status: 'none', analog: analog('предварительно, по аналогу: Фабрика Турин, f.ru, https://f.ru/a; 12 000 ₽; совпадение по дизайну (общие признаки «шпон»); цена не сравнивалась') }));
    expect(noRef.price).toBe(12_000);
    expect(noRef.notes[0]).toContain('цена не сравнивалась');
  });

  it('none и failed: цена не ставится, пометка «цены не найдены» или текст ошибки провайдера', () => {
    expect(offerPrice(research({ status: 'none' }))).toMatchObject({ status: 'none', price: null, priceKopecks: null, basis: null, notes: ['цены не найдены'] });
    expect(offerPrice(research({ status: 'failed', error: 'веб-поиск недоступен: OpenAI отверг запрос' }))).toMatchObject({ status: 'failed', price: null, notes: ['веб-поиск недоступен: OpenAI отверг запрос'] });
  });
});

describe('НДС КП', () => {
  it('пример ТЗ: 10 000 ₽ → без НДС 8 196,72 ₽, НДС 1 803,28 ₽, итого 10 000 ₽; ставка 0 — НДС 0', () => {
    expect(splitVat(toKopecks(10_000), 22)).toEqual({ grossKopecks: 1_000_000, netKopecks: 819_672, vatKopecks: 180_328, vatRate: 22 });
    expect(plain(formatKopecks(819_672))).toBe('8 196,72 ₽');
    expect(plain(formatKopecks(180_328))).toBe('1 803,28 ₽');
    expect(splitVat(1_000_000, 0)).toEqual({ grossKopecks: 1_000_000, netKopecks: 1_000_000, vatKopecks: 0, vatRate: 0 });
    // Сумма без НДС и НДС всегда даёт конечную цену копейка в копейку.
    for (const k of [1, 99, 1_234_567, 999_999_999]) {
      const v = splitVat(k, 22);
      expect(v.netKopecks + v.vatKopecks).toBe(k);
    }
  });

  it('двойной НДС запрещён: цена из медианы конечная, 22 % сверху не добавляются; НДС в документе выделяется из той же суммы', () => {
    const p = offerPrice(research({ stats: stats([10_000, 10_000, 10_000]) }));
    expect(p.price).toBe(10_000);
    expect(p.priceKopecks).not.toBe(1_220_000);
    const data = templateData({ kpNo: 'КП-2026-1', date: new Date(2026, 9, 13), basis: '', clientName: '', clientPhone: '', lines: [{ name: 'Дверь', size: '', qty: 1, price: p.price, discount: 0 }], vatRate: 22, priceNote: '' });
    expect(plain(data.grand_total)).toBe('10 000 ₽');
    expect(plain(data.vat_phrase)).toBe('в том числе НДС 22% — 1 803,28 ₽');
    expect(data.total_in_words).toBe('Десять тысяч рублей 00 копеек');
  });

  it('строка КП и итог считаются в копейках: 0,1 × 3 = 0,30, скидка 33 % от 10 000 × 3 = 20 100,00, НДС из итога', () => {
    expect(lineSumKopecks({ price: 0.1, qty: 3, discount: 0 })).toBe(30);
    expect(lineSumKopecks({ price: 10_000, qty: 3, discount: 33 })).toBe(2_010_000);
    expect(lineSumKopecks({ price: null, qty: 3, discount: 0 })).toBe(0);
    const data = templateData({ kpNo: '1', date: new Date(), basis: '', clientName: '', clientPhone: '', lines: [{ name: 'a', size: '', qty: 3, price: 0.1, discount: 0 }, { name: 'b', size: '', qty: 3, price: 10_000, discount: 33 }], vatRate: 22, priceNote: '' });
    expect(plain(data.grand_total)).toBe('20 100 ₽');
    // 2 010 030 коп / 1,22 = 1 647 566 коп без НДС → НДС 362 464 коп.
    expect(plain(data.vat_phrase)).toBe('в том числе НДС 22% — 3 624,64 ₽');
  });
});
