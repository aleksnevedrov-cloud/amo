import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { cellText, FORMULA_NO_VALUE, readKbSheetRows } from '../src/extract.ts';
import { isPriceBook, parsePriceBook } from '../src/price-book.ts';

const real = (name: string) => readFile(fileURLToPath(new URL(`./fixtures/real/${name}`, import.meta.url)));

describe('формулы без сохранённого значения (KB-PRICE-SHEETS-FIX, п. 2)', () => {
  it('сумма ячеек, SUM по диапазону, IF(ISNUMBER…), ссылка на другой лист, скобки и деление; неизвестная функция — пометка «формула без значения»', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Прайс по ГОСТ');
    ws.getCell('A1').value = 8800;
    ws.getCell('B1').value = 3160;
    ws.getCell('C1').value = { formula: 'A1+B1' } as ExcelJS.CellValue;
    ws.getCell('D1').value = { formula: 'SUM(A1:B1)' } as ExcelJS.CellValue;
    ws.getCell('E1').value = { formula: 'IF(ISNUMBER(A1),"priced","not_priced")' } as ExcelJS.CellValue;
    ws.getCell('F1').value = { formula: 'IF(ISNUMBER(G1),"priced","not_priced")' } as ExcelJS.CellValue;
    ws.getCell('H1').value = { formula: '(A1-B1)/(2/1000)' } as ExcelJS.CellValue;
    ws.getCell('I1').value = { formula: '2*A1+2*B1+C1' } as ExcelJS.CellValue;
    ws.getCell('J1').value = { formula: 'VLOOKUP(A1,A1:B1,2)' } as ExcelJS.CellValue;
    ws.getCell('K1').value = { formula: 'A1+B1', result: 100 } as ExcelJS.CellValue;
    const other = wb.addWorksheet('Дополнения');
    other.getCell('A1').value = { formula: "'Прайс по ГОСТ'!A1*2" } as ExcelJS.CellValue;
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer());
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(bytes.buffer as ArrayBuffer);
    const p = wb2.getWorksheet('Прайс по ГОСТ')!;
    expect(['C1', 'D1', 'E1', 'F1', 'H1', 'I1', 'K1'].map((a) => cellText(p.getCell(a)))).toEqual(['11960', '11960', 'priced', 'not_priced', '2820000', '35880', '100']);
    expect(cellText(p.getCell('J1'))).toBe(`${FORMULA_NO_VALUE}Прайс по ГОСТ!J1`);
    expect(cellText(wb2.getWorksheet('Дополнения')!.getCell('A1'))).toBe('17600');
  });
});

describe('настоящие файлы заказчика (docs/opt, коммит 88e5282): «Межкомнатные двери.xlsx», «Металлические двери.xlsx»', () => {
  it('межкомнатные: 30 ID (INT-008 — смета 11 960 по формуле P12+Q12 и правилу из комментария), 147 размеров, 31 тариф (9 без цены), шапки «ID модели», словарь; ошибок нет', async () => {
    const rows = await readKbSheetRows(new Uint8Array(await real('Межкомнатные двери.xlsx')));
    expect(isPriceBook(rows)).toBe(true);
    const book = parsePriceBook(rows);
    expect(book.errors).toEqual([]);
    expect(book.products).toHaveLength(30);
    expect(book.products.filter((p) => !p.estimate)).toHaveLength(29);
    const est = book.products.find((p) => p.productId === 'INT-008')!;
    expect(est).toMatchObject({ price: 11_960, estimate: true, status: 'estimate_only', no: '8' });
    expect(est.card.estimateFormula).toContain('8 800 + коробка 3 160 = 11 960');
    const cpl = book.products.find((p) => p.productId === 'INT-013')!;
    expect(cpl).toMatchObject({ model: 'ДПГ CPL', price: 23_900, coating: 'CPL 0,2 мм', components: { коробка: { status: 'included' }, наличник: { status: 'priced', price: 2000 }, добор: { status: 'not_priced' }, порог: { status: 'not_priced' } } });
    expect(cpl.aliases).toEqual(['ДПГ CPL', 'ДПГ', 'CPL', 'ДВ CPL', 'ДВ 1Рп Г ПрБ', 'Дверной блок деревянный внутренний глухой однопольный']);
    expect(cpl.card.colors.length).toBeGreaterThan(0);
    expect(cpl.card.designation).toBeTruthy();
    expect(book.products.every((p) => p.card.comment)).toBe(true);
    expect(book.sizes).toHaveLength(147);
    expect(book.sizes.filter((z) => z.productId === 'INT-008')).toHaveLength(3);
    expect(book.rule).toMatchObject({ largeThresholdPercent: 30, regularSurchargePercent: 30, largeSurchargePercent: 100 });
    expect(book.hardware).toHaveLength(31);
    expect(book.hardware.filter((h) => h.price === null).map((h) => h.tariffId)).toEqual(['OPT-009', 'OPT-010', 'OPT-011', 'OPT-012', 'OPT-013', 'OPT-014', 'OPT-015', 'OPT-016', 'OPT-017']);
    // Цены-формулы без значения посчитаны: OPT-022 (м²), OPT-024 (м), OPT-025 = 2×OPT-029 + 2×OPT-030 + OPT-031.
    expect(book.hardware.find((h) => h.tariffId === 'OPT-025')).toMatchObject({ price: 2 * 4000 + 2 * 439.64 + 3550, unit: 'шт' });
    expect(book.hardware.find((h) => h.tariffId === 'OPT-022')).toMatchObject({ price: 6430, unit: 'м²' });
    expect(book.hardware.find((h) => h.tariffId === 'OPT-024')).toMatchObject({ price: 19_300, unit: 'м' });
    expect(new Set(book.dictionary.map((d) => d.sheet))).toEqual(new Set(['Сокращения', 'Типоразмеры', 'ГОСТы', 'Словарь']));
    expect(book.skipped.filter((x) => x.message.startsWith('неизвестная вкладка'))).toEqual([]);
    expect(book.skipped.filter((x) => x.sheet === 'Подбор' || x.sheet === 'Размеры')).toEqual([]);
  });

  it('металлические: 20 ID, № 9 = MET-012, ALU-007 только смета, 46 размеров, те же 31 тариф с теми же ценами', async () => {
    const book = parsePriceBook(await readKbSheetRows(new Uint8Array(await real('Металлические двери.xlsx'))));
    expect(book.errors).toEqual([]);
    expect(book.products).toHaveLength(20);
    expect(book.products.find((p) => p.no === '9')).toMatchObject({ productId: 'MET-012' });
    expect(book.products.filter((p) => p.status === 'estimate_only').map((p) => p.productId)).toEqual(['ALU-007']);
    expect(book.products.filter((p) => p.status === 'inactive')).toEqual([]);
    expect(book.products.every((p) => p.card.comment)).toBe(true);
    expect(book.sizes).toHaveLength(46);
    expect(book.hardware).toHaveLength(31);
    const inner = parsePriceBook(await readKbSheetRows(new Uint8Array(await real('Межкомнатные двери.xlsx'))));
    expect(book.hardware.map((h) => [h.tariffId, h.price])).toEqual(inner.hardware.map((h) => [h.tariffId, h.price]));
  });
});
