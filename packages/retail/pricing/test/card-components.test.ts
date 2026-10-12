import { describe, expect, it } from 'vitest';
import { calculate, type CalcInput, type PricingRules } from '../src/index.ts';

/** Минимальные правила: одна коробка в комплекте по 999 руб. */
const rules = {
  sizes: { standardWidths: [600, 700, 800, 900], standardHeights: [2000], nonStandardMarkupPct: 0 },
  components: [
    { code: 'korobka', name: 'Коробка (Правила цен)', qtyPerDoor: 1, inKit: true, roundUp: false, prices: [], defaultPrice: 999 },
  ],
  services: [],
  disclaimer: '',
} as unknown as PricingRules;

const doors: CalcInput['doors'] = [
  { productId: '99415', name: 'Честер ПО', category: 'Эмаль', price: 10000, widthMm: 800, heightMm: 2000, qty: 1 },
];
const base: CalcInput = { doors, kit: true, extras: [], products: [], services: [] };

describe('комплектующие из карточки двери', () => {
  it('цена сайта вытесняет комплектующие из Правил цен', () => {
    const r = calculate(rules, {
      ...base,
      cardComponents: [{ name: 'Коробка Стандартная 2080x70x26', price: 1156 }],
    });
    const korobka = r.lines.filter((l) => l.name.includes('Коробка'));
    expect(korobka).toHaveLength(1);
    expect(korobka[0]?.price).toBe(1156);
    expect(korobka[0]?.basis).toBe('цена из карточки двери');
    expect(r.total).toBe(11156);
  });
});

describe('без карточки — старое поведение', () => {
  it('комплектующие берутся из Правил цен', () => {
    const r = calculate(rules, base);
    const korobka = r.lines.filter((l) => l.name.includes('Коробка'));
    expect(korobka).toHaveLength(1);
    expect(korobka[0]?.price).toBe(999);
    expect(r.total).toBe(10999);
  });

  it('пустой список карточки не отключает правила', () => {
    const r = calculate(rules, { ...base, cardComponents: [] });
    expect(r.total).toBe(10999);
  });

  it('количество по умолчанию равно числу дверей', () => {
    const two = [{ ...doors[0]!, qty: 2 }];
    const r = calculate(rules, { ...base, doors: two, cardComponents: [{ name: 'Коробка Стандартная', price: 1156 }] });
    const korobka = r.lines.find((l) => l.name.includes('Коробка'));
    expect(korobka?.qty).toBe(2);
    expect(korobka?.total).toBe(2312);
  });
});
