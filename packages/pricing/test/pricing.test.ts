import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calculate, exportRulesXlsx, importRulesXlsx, pricingRulesSchema, RulesImportError, type CalcInput } from '../src/index.ts';

interface Case {
  id: string;
  doors: { name: string; price: number; widthMm: number; heightMm: number; qty: number }[];
  extras: { code: string; qty: number }[];
  products: { name: string; price: number; qty: number }[];
  services: { code: string; floor?: number }[];
  managerTotal?: number;
  managerDiscount?: number;
  managerLines?: Record<string, number>;
}
const fx = JSON.parse(readFileSync(new URL('../../../evals/fixtures/invoices.json', import.meta.url), 'utf8')) as { rules: unknown; cases: Case[] };
const rules = pricingRulesSchema.parse(fx.rules);

const input = (c: Case): CalcInput => ({
  doors: c.doors.map((d, i) => ({ productId: `d${i}`, name: d.name, category: null, price: d.price, widthMm: d.widthMm, heightMm: d.heightMm, qty: d.qty })),
  kit: true,
  extras: c.extras,
  products: c.products.map((p, i) => ({ productId: `p${i}`, name: p.name, price: p.price, qty: p.qty })),
  services: c.services,
});
const byId = (id: string) => fx.cases.find((c) => c.id === id) as Case;

describe('расчёт совпадает с накладными менеджеров', () => {
  it('89222: Стэфани-22, нестандарт 75 см +30 %, книжка', () => {
    const r = calculate(rules, input(byId('89222')));
    expect(r.total).toBe(210873);
    expect(r.complete).toBe(true);
    const line = (name: string) => r.lines.filter((l) => l.name.startsWith(name));
    expect(line('Межкомнатная дверь').map((l) => [l.name.slice(-6), l.price])).toEqual([
      ['60*200', 11250],
      ['80*200', 11250],
      ['75*200', 14625],
    ]);
    expect(line('Коробка')[0]).toMatchObject({ qty: 13, price: 1224, total: 15912 });
    expect(line('Наличник')[0]).toMatchObject({ qty: 25, price: 1464, total: 36600 });
    expect(line('Добор 200')[0]).toMatchObject({ qty: 3, total: 4296 });
  });

  it('89190: Лаура, 4 двери', () => {
    expect(calculate(rules, input(byId('89190'))).total).toBe(138600);
  });

  it('87583: Б18, занос на этаж; итог до ручной скидки менеджера', () => {
    const c = byId('87583');
    const r = calculate(rules, input(c));
    expect(r.total - (c.managerDiscount ?? 0)).toBe(c.managerTotal);
    expect(r.lines.find((l) => l.name.startsWith('Занос'))).toMatchObject({ qty: 6, price: 500, total: 3000 });
  });

  it('88959: двустворчатая — правило «на дверь» расходится с ручным расчётом', () => {
    const c = byId('88959');
    const r = calculate(rules, input(c));
    const qty = (n: string) => r.lines.find((l) => l.name === n)?.qty;
    // Фиксируем расхождение: нужно отдельное правило для двустворчатых дверей (вопрос к обучению).
    expect(qty('Коробка телескоп')).toBe(5);
    expect(c.managerLines?.['Коробка телескоп']).toBe(6);
  });
});

describe('calculate: частные случаи', () => {
  const door = { productId: '1', name: 'Дверь Тест', category: null, price: 10000, widthMm: 800, heightMm: 2000, qty: 1 };
  const base: CalcInput = { doors: [door], kit: false, extras: [], products: [], services: [] };

  it('нестандарт без наценки в правилах — цену считает менеджер', () => {
    const r = calculate(pricingRulesSchema.parse({}), { ...base, doors: [{ ...door, widthMm: 750 }] });
    expect(r.complete).toBe(false);
    expect(r.lines[0]).toMatchObject({ price: null, basis: expect.stringMatching(/менеджер/) });
    expect(r.total).toBe(0);
  });

  it('компонент без цены для серии — неполный расчёт', () => {
    const r = calculate(rules, { ...base, kit: true, doors: [{ ...door, name: 'Неизвестная серия' }] });
    expect(r.complete).toBe(false);
    expect(r.missing).toContain('Коробка телескоп');
  });

  it('разные серии — отдельные строки комплектующих', () => {
    const r = calculate(rules, {
      ...base,
      kit: true,
      doors: [
        { ...door, name: 'Лаура дуб', qty: 1 },
        { ...door, name: 'Б18 ПВХ', qty: 1 },
      ],
    });
    expect(r.lines.filter((l) => l.name === 'Коробка телескоп').map((l) => l.price).sort()).toEqual([1170, 1700]);
  });

  it('услуги по км и неизвестные коды', () => {
    const rr = pricingRulesSchema.parse({ services: [{ code: 'km', name: 'Доставка за МКАД', unit: 'per_km', price: 40, basePrice: 1500 }] });
    const r = calculate(rr, { ...base, services: [{ code: 'km', km: 20 }, { code: 'nope' }] });
    expect(r.lines.find((l) => l.name.startsWith('Доставка'))).toMatchObject({ price: 2300 });
    expect(r.missing).toContain('неизвестная услуга «nope»');
  });

  it('повтор кода в правилах отклоняется', () => {
    expect(() =>
      pricingRulesSchema.parse({ components: [{ code: 'a', name: 'x', qtyPerDoor: 1 }], services: [{ code: 'a', name: 'y', unit: 'fixed', price: 1 }] }),
    ).toThrow(/повторяется/);
  });
});

describe('XLSX', () => {
  it('экспорт → импорт сохраняет правила', async () => {
    const buf = await exportRulesXlsx(rules);
    expect(await importRulesXlsx(buf)).toEqual(rules);
  });

  it('понятные ошибки импорта', async () => {
    await expect(importRulesXlsx(new TextEncoder().encode('not excel'))).rejects.toBeInstanceOf(RulesImportError);
    const empty = await exportRulesXlsx(pricingRulesSchema.parse({}));
    await expect(importRulesXlsx(empty)).rejects.toThrow(/Нет ни одной строки/);
  });
});
