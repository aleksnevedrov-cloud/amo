import { describe, expect, it } from 'vitest';
import { chunkDocument, headingOf, MAX_CHUNK_CHARS, normalizeKey } from '../src/chunk.ts';

describe('разбиение текста на фрагменты базы знаний', () => {
  it('короткая заметка — один фрагмент, текст как есть', () => {
    const c = chunkDocument('Скидка опт от 50 полотен — 12 %');
    expect(c).toEqual([{ position: 0, text: 'Скидка опт от 50 полотен — 12 %', meta: {} }]);
  });

  it('страницы PDF и листы xlsx попадают в метаданные, строки таблиц не режутся', () => {
    const rows = Array.from({ length: 120 }, (_, i) => `ДПГ ${i}\t800×2000\t${1000 + i}`).join('\n');
    const text = `--- страница 1 ---\nУсловия поставки\nОплата по счёту.\n--- страница 2 ---\n=== Лист «Прайс» ===\n${rows}`;
    const c = chunkDocument(text);
    expect(c[0]).toMatchObject({ meta: { page: 1 } });
    expect(c[0]?.text).toContain('Оплата по счёту.');
    const sheet = c.filter((x) => x.meta.sheet === 'Прайс');
    expect(sheet.length).toBeGreaterThan(1);
    for (const ch of sheet) {
      expect(ch.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
      for (const line of ch.text.split('\n')) expect(line).toMatch(/^ДПГ \d+\t800×2000\t\d+$/);
    }
    expect(c.map((x) => x.position)).toEqual(c.map((_, i) => i));
  });

  it('заголовок раздела начинает фрагмент и остаётся в метаданных', () => {
    const c = chunkDocument('# Скидки\nОт 50 полотен — 12 %.\nОт 100 полотен — 15 %.\n\nУСЛОВИЯ ОПЛАТЫ\nПредоплата 50 %.');
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ meta: { heading: 'Скидки' } });
    expect(c[0]?.text.startsWith('# Скидки')).toBe(true);
    expect(c[1]).toMatchObject({ meta: { heading: 'УСЛОВИЯ ОПЛАТЫ' }, text: 'УСЛОВИЯ ОПЛАТЫ\nПредоплата 50 %.' });
  });

  it('длинный абзац без переносов режется по предложениям, затем по длине', () => {
    const sentence = 'Дверь глухая ламинированная с сотовым заполнением поставляется в срок до двух недель. ';
    const c = chunkDocument(sentence.repeat(60));
    expect(c.length).toBeGreaterThan(2);
    for (const ch of c) expect(ch.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    expect(c.map((x) => x.text).join(' ').replace(/\s+/g, ' ').trim()).toBe(sentence.repeat(60).replace(/\s+/g, ' ').trim());
    const noSpaces = chunkDocument('x'.repeat(3100));
    expect(noSpaces.map((x) => x.text.length)).toEqual([1500, 1500, 100]);
  });

  it('заголовком считается капс или нумерация перед текстом, но не обычная строка', () => {
    expect(headingOf('УСЛОВИЯ ОПЛАТЫ', 'Предоплата')).toBe('УСЛОВИЯ ОПЛАТЫ');
    expect(headingOf('1.2 Доставка', 'По Москве')).toBe('1.2 Доставка');
    expect(headingOf('Скидка опт от 50 полотен — 12 %', 'ещё')).toBeNull();
    expect(headingOf('УСЛОВИЯ', undefined)).toBeNull();
    expect(headingOf('ДПГ\t800', 'x')).toBeNull();
  });

  it('ключ нормализации: регистр, ё, кавычки, пробелы', () => {
    expect(normalizeKey('  ДПГ  «Сота»  Ёлка ')).toBe('дпг сота елка');
  });
});
