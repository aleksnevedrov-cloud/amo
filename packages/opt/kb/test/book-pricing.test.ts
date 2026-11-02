import { describe, expect, it } from 'vitest';
import { nonstandardBySizes } from '../src/book-pricing.ts';
import type { BookRule } from '../src/price-book.ts';

const rule: BookRule = { largeThresholdPercent: 30, regularSurchargePercent: 30, largeSurchargePercent: 100, appliesTo: 'base', productionNote: null };

describe('нестандарт по сетке размеров (RFD-AI-AGENT-OPT-KB-PRICE-SHEETS)', () => {
  const sizes = [{ widthMm: 800, heightMm: 2000 }, { widthMm: 900, heightMm: 2000 }];
  it('точный размер — 0 %; любое отличие, в том числе меньше, — +30 %; больше порога строго — +100 %; ровно порог — 30 %', () => {
    expect(nonstandardBySizes(sizes, { widthMm: 900, heightMm: 2000 }, rule)).toMatchObject({ surchargePercent: 0, factor: 1, basis: 'exact', notes: [] });
    const less = nonstandardBySizes(sizes, { widthMm: 899, heightMm: 2000 }, rule);
    expect(less).toMatchObject({ surchargePercent: 30, factor: 1.3, basis: 'rules', reference: { widthMm: 900, heightMm: 2000 } });
    expect(less.notes).toEqual(['нестандарт 899×2000 при эталоне 900×2000: +30 % к базе', 'Нестандартные позиции подлежат уточнению на производстве.']);
    expect(nonstandardBySizes(sizes, { widthMm: 1171, heightMm: 2000 }, rule)).toMatchObject({ surchargePercent: 100, factor: 2, reference: { widthMm: 900 } });
    expect(nonstandardBySizes(sizes, { widthMm: 900, heightMm: 2601 }, rule)).toMatchObject({ surchargePercent: 100, factor: 2 });
    // Ровно +30 % по обоим измерениям (ALU-005: 1950×2375 при 1500×2700 → ширина +30 %, высота меньше) — остаётся 30 %.
    expect(nonstandardBySizes([{ widthMm: 1500, heightMm: 2700 }], { widthMm: 1950, heightMm: 2375 }, rule)).toMatchObject({ surchargePercent: 30, factor: 1.3 });
    expect(nonstandardBySizes([{ widthMm: 900, heightMm: 2000 }], { widthMm: 1170, heightMm: 2000 }, rule)).toMatchObject({ surchargePercent: 30 });
    // Противопожарная — дополнительная фраза; своё примечание прайса вместо стандартного.
    expect(nonstandardBySizes(sizes, { widthMm: 950, heightMm: 2000 }, { ...rule, productionNote: 'Уточнить на производстве.' }, null, true).notes).toEqual(['нестандарт 950×2000 при эталоне 900×2000: +30 % к базе', 'Уточнить на производстве.', 'размер и огнестойкость исполнения уточняются']);
    // Без размера или без сетки — базовая цена.
    expect(nonstandardBySizes(sizes, { widthMm: null, heightMm: 2000 }, rule)).toMatchObject({ basis: 'base', factor: 1 });
    expect(nonstandardBySizes([], { widthMm: 900, heightMm: 2000 }, rule)).toMatchObject({ basis: 'base', factor: 1, notes: ['у модели нет сетки размеров — базовая цена'] });
  });

  it('эталон — пара с минимальным превышением; геометрия пары: сумма створок, each_leaf — самая широкая', () => {
    const grid = [{ widthMm: 600, heightMm: 2000 }, { widthMm: 800, heightMm: 2000 }, { widthMm: 900, heightMm: 2100 }];
    // 850×2000: до 800×2000 — 6 %, до 900×2100 — 5,6 % (ближе) → эталон 900×2100, +30 %.
    expect(nonstandardBySizes(grid, { widthMm: 850, heightMm: 2000 }, rule)).toMatchObject({ surchargePercent: 30, reference: { widthMm: 900, heightMm: 2100 } });
    expect(nonstandardBySizes(grid, { widthMm: 1300, heightMm: 2000 }, rule)).toMatchObject({ surchargePercent: 100, reference: { widthMm: 900 } });
    // 899×2000 при 800 и 900 — ближе 900 (0,1 %), а не 800 с положительным превышением 12 %.
    expect(nonstandardBySizes([{ widthMm: 800, heightMm: 2000 }, { widthMm: 900, heightMm: 2000 }, { widthMm: 600, heightMm: 2100 }], { widthMm: 900, heightMm: 2601 }, rule)).toMatchObject({ surchargePercent: 100, reference: { widthMm: 900, heightMm: 2000 } });
    const pair = [{ widthMm: 1300, heightMm: 2000, leafWidthsMm: [600, 700] }];
    expect(nonstandardBySizes(pair, { widthMm: 1300, heightMm: 2000 }, rule, 'pair')).toMatchObject({ basis: 'exact' });
    expect(nonstandardBySizes(pair, { widthMm: 700, heightMm: 2000 }, rule, 'each_leaf')).toMatchObject({ basis: 'exact' });
    expect(nonstandardBySizes(pair, { widthMm: 1700, heightMm: 2000 }, rule, 'overall_pair')).toMatchObject({ surchargePercent: 100 });
  });
});
