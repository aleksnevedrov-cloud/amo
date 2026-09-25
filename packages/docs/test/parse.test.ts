import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  cleanPersonalData,
  decodeMarking,
  detectFormat,
  estimateKit,
  extensionWidthForWall,
  extract,
  ExtractError,
  findMarkings,
  flagsFor,
  htmlTablesToText,
  isMeaningful,
  isStandardLeaf,
  leafWidthForOpening,
  markingToText,
  searchQuery,
} from '../src/index.ts';

/** Минимальный PDF с текстовым слоем (без сжатия). */
function tinyPdf(text: string): Uint8Array {
  const content = `BT /F1 12 Tf 50 750 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

describe('extract', () => {
  it('определяет формат по MIME и расширению', () => {
    expect(detectFormat('application/pdf')).toBe('pdf');
    expect(detectFormat('application/octet-stream', 'Смета.XLSX')).toBe('xlsx');
    expect(detectFormat('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('docx');
    expect(detectFormat('image/jpeg', 'IMG_1.jpg')).toBe('image');
    expect(detectFormat('application/x-dwg', 'plan.dwg')).toBe('unsupported');
  });

  it('PDF: текстовый слой без OCR', async () => {
    const e = await extract(tinyPdf('Measurement sheet: bedroom door opening 800x2000 wall 100 qty 2 pieces'), 'application/pdf');
    expect(e.format).toBe('pdf');
    expect(e.pages).toBe(1);
    expect(e.text).toContain('800x2000');
    expect(e.needsOcr).toBe(false);
  });

  it('PDF без текста — нужен OCR; картинка — всегда OCR', async () => {
    const e = await extract(tinyPdf(''), 'application/pdf');
    expect(e.needsOcr).toBe(true);
    const img = await extract(new Uint8Array([0xff, 0xd8]), 'image/jpeg');
    expect(img).toMatchObject({ format: 'image', needsOcr: true, text: '' });
  });

  it('XLSX: строки через табуляцию, пустые строки и скрытые листы пропускаются', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Спецификация');
    ws.addRow(['№', 'Позиция', 'Кол-во']);
    ws.addRow([]);
    ws.addRow([1, 'ДВ 1 Рп 23,8х10 Г ПрБ', 2]);
    ws.getCell('B5').value = { richText: [{ text: 'Дверь ' }, { text: 'ПВХ' }] };
    const hidden = wb.addWorksheet('Служебный');
    hidden.state = 'hidden';
    hidden.addRow(['секрет']);
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer());
    const e = await extract(bytes, '', 'spec.xlsx');
    expect(e.text).toContain('=== Лист «Спецификация» ===');
    expect(e.text).toContain('1\tДВ 1 Рп 23,8х10 Г ПрБ\t2');
    expect(e.text).toContain('Дверь ПВХ');
    expect(e.text).not.toContain('секрет');
  });

  it('неподдерживаемый формат и слишком большой файл — ошибка', async () => {
    await expect(extract(new Uint8Array(3), 'application/x-dwg', 'a.dwg')).rejects.toBeInstanceOf(ExtractError);
    await expect(extract(new Uint8Array(21 * 1024 * 1024), 'application/pdf')).rejects.toThrow(/20 МБ/);
  });

  it('HTML таблиц → текст с табуляцией', () => {
    const t = htmlTablesToText('<p>Запрос</p><table><tr><td><p>№</p><p>п/п</p></td><td><p>Дверь&nbsp;ДГ 2100*900</p></td></tr><tr><td>1</td><td><img src="x">шт</td></tr></table>');
    expect(t).toBe('Запрос\n№ п/п\tДверь ДГ 2100*900\n1\tшт');
  });

  it('isMeaningful отсекает мусорный текстовый слой', () => {
    expect(isMeaningful('с:, 00 м N с:, 00 м N •• 1000 800')).toBe(false);
    expect(isMeaningful('Спецификация дверей Марка Обозначение Наименование Высота мм')).toBe(true);
  });
});

describe('cleanPersonalData', () => {
  it('убирает ФИО, телефоны, e-mail, реквизиты и адреса, оставляя размеры', () => {
    const src = [
      'Заказчик: Иванов Иван Иванович',
      'Тел. +7 (912) 345-67-89, ivan@mail.ru',
      'ООО «Плутон» ИНН 7709093255 КПП 770901001',
      'Адрес: г. Москва, ул. Ленина, д. 5, кв. 12',
      'Проём 1: 838×2050, стена 105, 2 шт',
      'Директор Петров П.П.',
      'ГОСТ 475-2016, срок поставки 2026-09-30',
    ].join('\n');
    const { text, removed } = cleanPersonalData(src);
    expect(text).not.toMatch(/Иванов|345-67|ivan@|7709093255|Ленина|Петров/);
    expect(text).toContain('Проём 1: 838×2050, стена 105, 2 шт');
    expect(text).toContain('ГОСТ 475-2016, срок поставки 2026-09-30');
    expect(text).toContain('ООО «Плутон» ИНН [номер] КПП [номер]');
    expect(removed).toBeGreaterThanOrEqual(6);
  });

  it('не принимает за телефон числа через табуляцию (ячейки) и не трогает артикулы', () => {
    const { text } = cleanPersonalData('ГОСТ 475-2016\t31\tшт\nАртикул 12345678');
    expect(text).toBe('ГОСТ 475-2016\t31\tшт\nАртикул 12345678');
  });
});

describe('decodeMarking', () => {
  it('ГОСТ 475: ДВ 1 Рп 23,8х10 Г ПрБ (в т. ч. с OCR-ошибкой З→3)', () => {
    const m = decodeMarking('ДВ 1 Рп 2З,8х10 Г ПрБ/ ГОСТ 475-2016');
    expect(m).toMatchObject({ material: 'wood', location: 'interior', opening: 'swing', glazing: 'solid', side: 'right', threshold: false, height_mm: 2380, width_mm: 1000 });
    expect(m.unknown).toEqual([]);
    expect(markingToText(m)).toBe('деревянная, внутренняя, глухая, распашная, 2380×1000 мм (В×Ш), правая, без порога');
  });

  it('противопожарные и стальные: ДПС 01 2340х960 Л EI30, ДСН Оп Прг', () => {
    expect(decodeMarking('ДПС 01 2340х960 Л EI30')).toMatchObject({ material: 'steel', fireproof: true, fireRating: 'EI30', side: 'left', height_mm: 2340, width_mm: 960 });
    expect(decodeMarking('ДСН Оп Прг Пр Н О 2340х1160')).toMatchObject({ material: 'steel', location: 'exterior', leaves: 1, threshold: true, side: 'right', glazing: 'glazed' });
  });

  it('размеры в мм и второй размер как проём; двупольная по ширине', () => {
    const m = decodeMarking('ДГ 2100*900мм Правая');
    expect(m).toMatchObject({ height_mm: 2100, width_mm: 900, side: 'right' });
    const two = decodeMarking('ДВ 1 Рл 23,8х10 Г ПрБ 1000×2380 ГОСТ 475-2016');
    expect(two).toMatchObject({ height_mm: 2380, width_mm: 1000, opening_height_mm: 2380, opening_width_mm: 1000 });
    expect(decodeMarking('ДПС 02 2340х1710 EI30').leaves).toBe(2);
    expect(decodeMarking('ДАН О Дп Р')).toMatchObject({ leaves: 2, glazing: 'glazed', unknown: ['Р'] });
  });

  it('findMarkings собирает уникальные маркировки из таблицы', () => {
    const text = '1\tДВ 1 Рп 23,8х10 Г ПрБ\t2\n2\tДВ 1 Рп 23,8х10 Г ПрБ\t1\n3\tДверь межкомнатная AquaDoor\t4';
    const found = findMarkings(text);
    expect(found).toHaveLength(1);
    expect(found[0]!.width_mm).toBe(1000);
  });
});

describe('kit', () => {
  it('полотно по проёму и добор по стене как у замерщика', () => {
    expect(leafWidthForOpening(838, null)).toEqual({ width: 700, nonstandard: false });
    expect(leafWidthForOpening(805, null)).toEqual({ width: 700, nonstandard: false });
    expect(leafWidthForOpening(697, null)).toEqual({ width: 600, nonstandard: false });
    expect(leafWidthForOpening(1050, null)).toEqual({ width: 900, nonstandard: false });
    expect(leafWidthForOpening(1300, null)).toEqual({ width: 1220, nonstandard: true });
    expect(extensionWidthForWall(105)).toBe(100);
    expect(extensionWidthForWall(235)).toBe(250);
  });

  it('одностворчатая — 2,5/5/2,5; двустворчатая — 3/6/3', () => {
    const k = estimateKit([
      { room: 'Спальня', label: null, width_mm: 838, height_mm: 2050, wall_mm: 105, leaf_width_mm: null, qty: 1, double: null, side: null, note: null },
      { room: 'Зал', label: null, width_mm: 1400, height_mm: 2060, wall_mm: 235, leaf_width_mm: null, qty: 1, double: true, side: null, note: null },
      { room: 'Кладовая', label: null, width_mm: 697, height_mm: 1985, wall_mm: null, leaf_width_mm: null, qty: 2, double: null, side: null, note: null },
    ]);
    expect(k.lines[0]).toMatchObject({ leaf_width_mm: 700, leaf_height_mm: 2000, boxes: 2.5, casings: 5, extensions: 2.5, extension_width_mm: 100 });
    expect(k.lines[1]).toMatchObject({ double: true, boxes: 3, casings: 6, extensions: 3, extension_width_mm: 250 });
    expect(k.lines[2]).toMatchObject({ leaf_width_mm: 600, leaf_height_mm: 1900, nonstandard: false, boxes: 5, casings: 10, extensions: 0 });
    expect(k.totals).toEqual({ doors: 4, boxes: 10.5, casings: 21, extensions: 5.5 });
  });
});

describe('match', () => {
  it('флаги: противопожарные, стальные, нестандарт', () => {
    const base = { name: 'Дверь', marking: null, width_mm: null, height_mm: null, qty: 1, unit: 'шт', price_rub: null, material: null, color: null, fireproof: null, note: null };
    expect(flagsFor({ ...base, marking: 'ДПС 01 EI30' })).toEqual(['fireproof', 'steel']);
    expect(flagsFor({ ...base, name: 'Дверной блок из алюминиевых профилей' })).toEqual(['steel']);
    expect(flagsFor({ ...base, width_mm: 1050, height_mm: 2100 })).toEqual(['nonstandard_size']);
    expect(flagsFor({ ...base, width_mm: 800, height_mm: 2000 })).toEqual([]);
    expect(isStandardLeaf(null, null)).toBeNull();
  });

  it('поисковый запрос без размеров и общих слов', () => {
    expect(
      searchQuery({ name: 'Дверь межкомнатная AquaDoor 700х2000 мм влагостойкая ПВХ белый глухая', marking: null, width_mm: 700, height_mm: 2000, qty: 1, unit: null, price_rub: null, material: 'ПВХ', color: 'белый', fireproof: null, note: null }),
    ).toBe('AquaDoor влагостойкая ПВХ белый глухая ПВХ белый');
  });
});
