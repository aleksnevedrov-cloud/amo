// KB-MARKUP: вопрос «нестандарт» с наценкой источника — проценты к цене фабрики, наценка после; ответ вариантом прайса
// переносится на «Собрать заново» выбором (цену считает поиск по текущей наценке), своя цена — числом.
import { describe, expect, it } from 'vitest';
import { applyAnswer, buildQuestions, carryAnswers, nonstandardOption, type KpLine, type KpPayload } from '../src/index.ts';

const line = (over: Partial<KpLine> = {}): KpLine => ({
  request_index: 0, page_id: null, name: 'Оникс Авангард', size: '1000×2000 мм', qty: 1, price: 25_584, lead_time: '', discount: 0,
  priceSource: 'price_file', priceOutcome: 'priced', category: 'door',
  nonstandard: { basis: 'rules', basePrice: 16_400, note: 'нестандарт 1000×2000 при эталоне 900×2000: +30 % к базе' },
  markup: { factoryPrice: 21_320, pct: 20, price: 25_584, sourceId: 3, priceKey: 'оникс прайс' },
  ...over,
});
const payload = (l: KpLine): Partial<KpPayload> => ({ items: [l], request_items: [{ raw: 'Оникс Авангард 1000×2000', name: 'Оникс Авангард', width_mm: 1000, height_mm: 2000, qty: 1 }] as KpPayload['request_items'], answers: {} });

describe('нестандарт с наценкой (KB-MARKUP)', () => {
  it('варианты: +30 % / +100 % к цене фабрики, затем наценка; без наценки — как раньше', () => {
    expect(nonstandardOption('p30', 16_400, 20)).toEqual({ factoryPrice: 21_320, price: 25_584 });
    expect(nonstandardOption('p100', 16_400, 20)).toEqual({ factoryPrice: 32_800, price: 39_360 });
    expect(nonstandardOption('p30', 16_400, 0)).toEqual({ factoryPrice: 21_320, price: 21_320 });
    const q = buildQuestions(payload(line())).find((x) => x.type === 'nonstandard')!;
    expect(q.options.map((o) => [o.id, o.price, o.factoryPrice ?? null])).toEqual([['computed', 25_584, null], ['p30', 25_584, 21_320], ['p100', 39_360, 32_800]]);
    const plain = buildQuestions(payload(line({ price: 21_320, markup: null }))).find((x) => x.type === 'nonstandard')!;
    expect(plain.options.map((o) => o.price)).toEqual([21_320, 21_320, 32_800]);
  });

  it('ответ «+100 %»: цена с наценкой, у строки — цена фабрики варианта; «Собрать заново» переносит выбор, а не цену', () => {
    const p = payload(line());
    const q = buildQuestions(p).find((x) => x.type === 'nonstandard')!;
    const answered = applyAnswer(p, q.key, { option: 'p100', price: null, fields: {}, at: '2026-10-21T10:00:00Z', by: 1 }, q).payload;
    expect(answered.items?.[0]).toMatchObject({ price: 39_360, priceSource: 'price_file', nonstandardChoice: 'p100', markup: { factoryPrice: 32_800, pct: 20, price: 39_360 } });
    // Новый черновик той же сделки: цены ещё нет — переносится выбор, цену поставит поиск по текущей наценке.
    const fresh = payload(line({ price: null, markup: null, nonstandard: null, priceSource: undefined, priceOutcome: undefined }));
    const carried = carryAnswers(fresh, answered).items?.[0];
    expect(carried).toMatchObject({ price: null, nonstandardChoice: 'p100' });
    // Своя цена менеджера — переносится числом, без наценки и выбора.
    const own = applyAnswer(p, q.key, { option: 'custom', price: 30_000, fields: {}, at: '2026-10-21T10:00:00Z', by: 1 }, q).payload;
    expect(own.items?.[0]).toMatchObject({ price: 30_000, priceSource: 'manager', markup: null, nonstandardChoice: null });
    expect(carryAnswers(fresh, own).items?.[0]).toMatchObject({ price: 30_000, priceSource: 'manager' });
  });
});
