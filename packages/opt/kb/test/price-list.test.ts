import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { readKbSheetRows } from '../src/extract.ts';
import { detectMapping, draftsToPrices, extractPrices, parsePrice, previewPriceList } from '../src/price-list.ts';

async function xlsx(sheets: Record<string, unknown[][]>): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const r of rows) ws.addRow(r);
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

describe('цены из xlsx-прайса', () => {
  it('разбор цены', () => {
    expect(parsePrice('3 450,00 ₽')).toBe(3450);
    expect(parsePrice('3450')).toBe(3450);
    expect(parsePrice('3.450')).toBe(3450);
    expect(parsePrice('12 500 руб.')).toBe(12500);
    expect(parsePrice('7900.5')).toBe(7900.5);
    expect(parsePrice('800×2000')).toBeNull();
    expect(parsePrice('2')).toBeNull();
    expect(parsePrice('ДПГ')).toBeNull();
  });

  it('шапка найдена: колонки по названиям, разделы без цены — в примечание, строки без цены пропускаются', async () => {
    const bytes = await xlsx({
      Прайс: [
        ['Прайс-лист Текона от 01.10.2026'],
        [],
        ['№', 'Наименование', 'Размер, мм', 'Ед.', 'Цена, руб. с НДС'],
        ['Ламинированные'],
        [1, 'ДПГ сота', '800×2000', 'шт', '3 450,00'],
        [2, 'ДПО сота', '800*2000', 'шт', 4100],
        [3, 'Нестандарт по высоте', '', '', 'договорная'],
        ['Экошпон'],
        [4, 'Турин', '700х2000', 'шт', '7 900'],
      ],
      Условия: [['Скидка опт от 50 полотен — 12 %']],
    });
    const p = await previewPriceList(bytes);
    expect(p.sheets).toEqual(['Прайс', 'Условия']);
    expect(p.headerFound).toBe(true);
    expect(p.mapping).toMatchObject({ sheet: 'Прайс', model: 1, size: 2, unit: 3, price: 4, width: null, height: null, factory: null, headerRow: 3 });
    expect(p.columns.map((c) => c.header)).toEqual(['№', 'Наименование', 'Размер, мм', 'Ед.', 'Цена, руб. с НДС']);
    expect(p.total).toBe(3);
    expect(p.skipped).toBe(1);
    expect(p.sample).toEqual([
      { sheet: 'Прайс', row: 5, model: 'ДПГ сота', factory: null, unit: 'шт', widthMm: 800, heightMm: 2000, price: 3450, section: 'Ламинированные', abbr: null, description: null },
      { sheet: 'Прайс', row: 6, model: 'ДПО сота', factory: null, unit: 'шт', widthMm: 800, heightMm: 2000, price: 4100, section: 'Ламинированные', abbr: null, description: null },
      { sheet: 'Прайс', row: 9, model: 'Турин', factory: null, unit: 'шт', widthMm: 700, heightMm: 2000, price: 7900, section: 'Экошпон', abbr: null, description: null },
    ]);
    // Менеджер переназначил колонку модели на «№» — предпросмотр пересчитан по его сопоставлению.
    const manual = await previewPriceList(bytes, { model: 0 });
    expect(manual.total).toBe(0);
    expect(manual.skipped).toBe(4);
    const rows = draftsToPrices(p.sample, { factory: 'Текона', validAt: new Date('2026-10-01'), vat: 'included', nonstandard: { heightPct: 15 } });
    expect(rows[0]).toMatchObject({ model: 'ДПГ сота', factory: 'Текона', widthMm: 800, heightMm: 2000, price: 3450, vat: 'included', origin: 'price_list', nonstandard: { heightPct: 15 }, note: 'раздел: Ламинированные; лист «Прайс», строка 5' });
  });

  it('ширина и высота отдельными колонками, фабрика в колонке', async () => {
    const bytes = await xlsx({ Лист1: [['Фабрика', 'Модель', 'Ширина', 'Высота', 'Стоимость'], ['Браво', 'Турин', 800, 2000, 7900], ['Браво', 'Милан', 0.9, 2.1, '8 300']] });
    const rows = await readKbSheetRows(bytes);
    const { mapping, headerFound } = detectMapping(rows);
    expect(headerFound).toBe(true);
    expect(mapping).toMatchObject({ factory: 0, model: 1, width: 2, height: 3, price: 4, size: null });
    const { drafts } = extractPrices(rows, mapping);
    expect(drafts.map((d) => [d.factory, d.model, d.widthMm, d.heightMm, d.price])).toEqual([['Браво', 'Турин', 800, 2000, 7900], ['Браво', 'Милан', 900, 2100, 8300]]);
  });

  it('без шапки: цена — колонка с числами, модель — самая текстовая, размер — где он похож на размер', async () => {
    const bytes = await xlsx({ Лист1: [['ДПГ сота', '800×2000', 3450], ['ДПО сота', '800×2000', 4100], ['Турин', '700×2000', 7900]] });
    const p = await previewPriceList(bytes);
    expect(p.headerFound).toBe(false);
    expect(p.mapping).toMatchObject({ model: 0, size: 1, price: 2, headerRow: null });
    expect(p.total).toBe(3);
    expect(p.sample[2]).toMatchObject({ model: 'Турин', widthMm: 700, heightMm: 2000, price: 7900 });
  });

  it('KB-PRICELIST: несколько размеров в одной ячейке → отдельные строки; колонки «Сокращение в названии» и «Назначение/Конструкция»; НДС по заголовку; признак прайса', async () => {
    const bytes = await xlsx({
      Прайс: [
        ['Прайс ООО «Двери» от 10.10.2026'],
        ['№', 'Сокращение в названии', 'Наименование', 'Назначение/Конструкция', 'Размер блока', 'Цена без НДС, руб.'],
        [17, 'ДВ CPL', 'Дверь внутренняя CPL', 'Дверной блок деревянный внутренний глухой однопольный без порога', 'Блок Ш×В: 1010×2100; 910×2100. Проход ≥800 мм — подтвердить чертежом.', '23 900'],
        [18, 'ДВ ПВХ', 'Дверь внутренняя ПВХ', 'Дверной блок деревянный внутренний остеклённый однопольный', '910×2100', 19900],
        [19, 'ДН', 'Дверь наружная', 'Стальной блок', 'по чертежу', 45000],
      ],
    });
    const p = await previewPriceList(bytes);
    expect(p.headerFound).toBe(true);
    expect(p.isPriceList).toBe(true);
    expect(p.vatHint).toBe('no_vat');
    expect(p.mapping).toMatchObject({ abbr: 1, model: 2, description: 3, size: 4, price: 5, headerRow: 2 });
    expect(p.total).toBe(4);
    expect(p.sample.map((x) => [x.row, x.model, x.widthMm, x.heightMm, x.price, x.abbr])).toEqual([
      [3, 'Дверь внутренняя CPL', 1010, 2100, 23900, 'ДВ CPL'],
      [3, 'Дверь внутренняя CPL', 910, 2100, 23900, 'ДВ CPL'],
      [4, 'Дверь внутренняя ПВХ', 910, 2100, 19900, 'ДВ ПВХ'],
      [5, 'Дверь наружная', null, null, 45000, 'ДН'],
    ]);
    expect(p.sample[0]?.description).toBe('Дверной блок деревянный внутренний глухой однопольный без порога');
    const rows = draftsToPrices(p.sample, { vat: p.vatHint });
    expect(rows[0]).toMatchObject({ abbr: 'ДВ CPL', description: 'Дверной блок деревянный внутренний глухой однопольный без порога', sourceRow: 3, vat: 'no_vat', note: 'лист «Прайс», строка 3' });
    // Заявка клиента (без колонки цены) прайсом не считается — автоимпорта не будет.
    const request = await previewPriceList(await xlsx({ Лист1: [['1 ЭТАЖ'], ['ДПГ сота 800×2000', 12], ['Добор', 3]] }));
    expect(request.isPriceList).toBe(false);
  });
});
