import { describe, expect, it } from 'vitest';
import { readKbSheetRows } from '../src/extract.ts';
import { estimateFromComment, isPriceBook, parsePriceBook } from '../src/price-book.ts';
import { bookXlsx, interiorBook, metalBook } from './fixtures/price-book.ts';

describe('многолистовой прайс (RFD-AI-AGENT-OPT-KB-PRICE-SHEETS): разбор вкладок', () => {
  it('сметная цена из комментария: «= 11 960» или сумма слагаемых', () => {
    expect(estimateFromComment('полотно INT-005 8 800 + коробка 3 160 = 11 960')).toMatchObject({ price: 11_960 });
    expect(estimateFromComment('полотно INT-005 8 800 + коробка 3 160')).toMatchObject({ price: 11_960 });
    expect(estimateFromComment('обычный комментарий')).toBeNull();
    expect(estimateFromComment('')).toBeNull();
  });

  it('межкомнатные: 30 ID, INT-008 — сметная 11 960 по комментарию, 150 размеров, синонимы, статусы компонентов, 31 тариф (9 без цены), словарь, «Задача_Клауду» не читается', async () => {
    const rows = await readKbSheetRows(new Uint8Array(await bookXlsx(interiorBook())));
    expect(isPriceBook(rows)).toBe(true);
    const book = parsePriceBook(rows);
    expect(book.errors).toEqual([]);
    expect(book.products).toHaveLength(30);
    expect(book.products.map((p) => p.productId)).toEqual(Array.from({ length: 30 }, (_, i) => `INT-${String(i + 1).padStart(3, '0')}`));
    const cpl = book.products.find((p) => p.productId === 'INT-013')!;
    expect(cpl).toMatchObject({ model: 'ДВ CPL', abbr: 'ДВ 1Рп Г ПрБ', price: 23_900, status: 'active', estimate: false, family: 'interior', components: { коробка: { status: 'priced', price: 3160 }, наличник: { status: 'priced', price: 1200 }, добор: { status: 'not_priced', price: null }, порог: { status: 'included', price: null } } });
    expect(cpl.card).toMatchObject({ unit: 'block', sizeBasis: 'opening', geometry: 'single', fill: 'solid', gosts: ['ГОСТ 475-2016'], leafCount: 1, colors: ['белый', 'дуб'], quoteNotes: ['Цвет полотна по каталогу CPL.'], technical: { thickness_mm: 40 } });
    expect(cpl.aliases).toEqual(['ДВ CPL / ДВ 1Рп Г ПрБ', 'дверь внутренняя CPL', 'ДВ CPL']);
    // INT-008: на листе 1 цены нет — сметная по правилу из комментария, статус estimate_only.
    const est = book.products.find((p) => p.productId === 'INT-008')!;
    expect(est).toMatchObject({ price: 11_960, estimate: true, status: 'estimate_only' });
    expect(est.card.estimateFormula).toContain('= 11 960');
    expect(book.products.filter((p) => !p.estimate)).toHaveLength(29);
    // Размеры: 5 на модель; у пары INT-025 — ширины створок.
    expect(book.sizes).toHaveLength(150);
    expect(book.sizes.filter((s) => s.productId === 'INT-025')[0]).toMatchObject({ widthMm: 1300, heightMm: 2000, basis: 'opening', leafWidthsMm: [600, 700] });
    expect(book.rule).toEqual({ largeThresholdPercent: 30, regularSurchargePercent: 30, largeSurchargePercent: 100, appliesTo: 'base', productionNote: 'Нестандартные позиции подлежат уточнению на производстве.' });
    // Дополнения: 31 тариф, без цены 9 (OPT-009…OPT-017), единицы, «Для моделей», «Включено».
    expect(book.hardware).toHaveLength(31);
    expect(book.hardware.filter((h) => h.price === null).map((h) => h.tariffId)).toEqual(Array.from({ length: 9 }, (_, i) => `OPT-${String(i + 9).padStart(3, '0')}`));
    expect(book.hardware.find((h) => h.tariffId === 'OPT-007')).toMatchObject({ unit: 'м²', price: 5400, forModels: '*' });
    expect(book.hardware.find((h) => h.tariffId === 'OPT-024')).toMatchObject({ unit: 'шт', forModels: ['ALU-001', 'ALU-002', 'ALU-003', 'ALU-004', 'ALU-005', 'ALU-006', 'ALU-007'] });
    expect(book.hardware.find((h) => h.tariffId === 'OPT-025')?.includes).toBe('2×OPT-029, 2×OPT-030, OPT-031');
    expect(book.hardware.find((h) => h.tariffId === 'OPT-008')?.clarify).toBe('нужен стеклопакет OPT-009');
    // Словарь: четыре вкладки; «Задача_Клауду» — не импортируется и не считается неизвестной.
    expect(new Set(book.dictionary.map((d) => d.sheet))).toEqual(new Set(['Сокращения', 'ГОСТы', 'Типоразмеры', 'Словарь']));
    expect(book.dictionary).toHaveLength(5 + 3 + 2 + 2);
    expect(book.skipped.filter((x) => x.message.startsWith('неизвестная вкладка'))).toEqual([]);
    expect(book.products.every((p) => p.card.comment)).toBe(true);
  });

  it('металл: 20 ID, на листе 1 № 9 = MET-012; ALU-003/004 неактивны, ALU-007 только смета; та же фурнитура', async () => {
    const book = parsePriceBook(await readKbSheetRows(new Uint8Array(await bookXlsx(metalBook()))));
    expect(book.errors).toEqual([]);
    expect(book.products).toHaveLength(20);
    expect(book.products.find((p) => p.no === '9')).toMatchObject({ productId: 'MET-012', model: 'ДС Техно с вентиляцией' });
    expect(book.products.find((p) => p.productId === 'MET-012')?.card.baseIncludes).toBe('блок, вентиляционная решётка OPT-018');
    expect(book.products.filter((p) => p.status === 'inactive').map((p) => p.productId)).toEqual(['ALU-003', 'ALU-004']);
    expect(book.products.filter((p) => p.status === 'estimate_only').map((p) => p.productId)).toEqual(['ALU-007']);
    expect(book.products.find((p) => p.productId === 'MET-005')?.fire).toBe('EI 60');
    expect(book.products.find((p) => p.productId === 'ALU-005')?.family).toBe('aluminium');
    expect(book.sizes).toHaveLength(100);
    expect(book.hardware).toHaveLength(31);
  });

  it('ошибки отменяют импорт: ID без строки на листе 1, размер не число; неизвестные колонки и вкладки — в пропущенное', async () => {
    const sheets = interiorBook();
    (sheets.ID as unknown[][]).push([99, 'INT-099', 'leaf', 'opening', 'single', 'interior', 'solid', '', '', '', '', 'нет такой строки']);
    (sheets.Размеры as unknown[][]).push(['X', 'INT-001', 'широкая', 2000, 'opening', '']);
    (sheets['Прайс по ГОСТ'] as unknown[][])[1] = [...((sheets['Прайс по ГОСТ'] as unknown[][])[1] as unknown[]), 'Непонятная колонка'];
    sheets.Прочее = [['что-то'], ['ещё']];
    const book = parsePriceBook(await readKbSheetRows(new Uint8Array(await bookXlsx(sheets))));
    expect(book.errors).toEqual([
      { sheet: 'ID', row: 32, column: '№', message: 'ID INT-099: на листе прайса нет строки с № «99»' },
      { sheet: 'Размеры', row: 152, column: 'width_mm/height_mm', message: 'INT-001: размер не число («широкая» × «2000»)' },
    ]);
    expect(book.skipped).toEqual(expect.arrayContaining([{ sheet: 'Прочее', row: null, column: null, message: 'неизвестная вкладка — пропущена' }, { sheet: 'Прайс по ГОСТ', row: null, column: 'Непонятная колонка', message: 'неизвестные колонки — пропущены' }]));
  });

  it('старый одностраничный прайс — не книга', async () => {
    const rows = await readKbSheetRows(new Uint8Array(await bookXlsx({ Прайс: [['Наименование', 'Размер', 'Цена'], ['ДВ CPL', '910×2100', 23_900]] })));
    expect(isPriceBook(rows)).toBe(false);
  });
});
