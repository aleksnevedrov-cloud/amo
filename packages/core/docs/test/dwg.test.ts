import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanMtext, dwg2dxf, dxfToText, extract, parseDxfText } from '../src/index.ts';

/** Минимальный ASCII DXF: спецификация дверей надписями и размер. */
const pairs = (arr: (string | number)[]) => arr.map((x) => `${x}`).join('\n');
const DXF = pairs([
  0, 'SECTION', 2, 'HEADER', 9, '$DWGCODEPAGE', 3, 'ANSI_1251', 0, 'ENDSEC',
  0, 'SECTION', 2, 'BLOCKS', 0, 'TEXT', 1, 'в блоке — не берём', 10, 0, 20, 0, 0, 'ENDSEC',
  0, 'SECTION', 2, 'ENTITIES',
  0, 'TEXT', 8, 'Спецификация', 10, 10, 20, 100, 40, 3, 1, 'Марка',
  0, 'TEXT', 10, 60, 20, 100.5, 40, 3, 1, 'Обозначение',
  0, 'TEXT', 10, 150, 20, 99.8, 40, 3, 1, 'Кол-во',
  0, 'TEXT', 10, 10, 20, 90, 40, 3, 1, 'Д-1',
  0, 'MTEXT', 10, 60, 20, 90, 40, 3, 3, '{\\fArial|b1;ДВ 1 Рп 23,8х10 ', 1, 'Г ПрБ}\\PГОСТ 475-2016',
  0, 'TEXT', 10, 150, 20, 90, 40, 3, 1, '4',
  0, 'DIMENSION', 10, 10, 20, 70, 42, 2050.0, 1, '',
  0, 'DIMENSION', 10, 60, 20, 70, 42, 838.4, 1, '<> мм',
  0, 'ENDSEC', 0, 'EOF',
]);

describe('DXF', () => {
  it('берёт TEXT/MTEXT/DIMENSION только из ENTITIES, чистит форматирование MTEXT', () => {
    const items = parseDxfText(DXF);
    expect(items.map((t) => t.text)).toEqual(['Марка', 'Обозначение', 'Кол-во', 'Д-1', 'ДВ 1 Рп 23,8х10 Г ПрБ\nГОСТ 475-2016', '4', '2050', '838 мм']);
    expect(items.some((t) => t.text.includes('в блоке'))).toBe(false);
  });

  it('собирает строки таблицы по координатам (Y вверх)', () => {
    const text = dxfToText(DXF);
    expect(text.split('\n')[0]).toBe('Марка\tОбозначение\tКол-во');
    expect(text).toContain('Д-1\tДВ 1 Рп 23,8х10 Г ПрБ\t4');
    expect(text).toContain('2050\t838 мм');
  });

  it('cleanMtext: шрифты, переносы, спецсимволы', () => {
    expect(cleanMtext('{\\fISOCPEUR|b0|i1;Проём}\\P900%%d\\~%%c20 \\S1^2;')).toBe('Проём\n900° Ø20 1/2');
  });

  it('extract: .dxf напрямую, .dwg через конвертер', async () => {
    const dxf = await extract(new TextEncoder().encode(DXF), '', 'plan.dxf');
    expect(dxf).toMatchObject({ format: 'dxf', needsOcr: false });
    expect(dxf.text).toContain('ДВ 1 Рп 23,8х10 Г ПрБ');
    let got: number | null = null;
    const dwg = await extract(new Uint8Array([65, 67, 49, 48]), 'application/acad', 'plan.dwg', { dwg: async (b) => ((got = b.byteLength), DXF) });
    expect(got).toBe(4);
    expect(dwg.format).toBe('dwg');
    expect(dwg.text).toContain('Д-1\tДВ 1 Рп 23,8х10 Г ПрБ\t4');
  });

  it('dwg2dxf: нет конвертера — понятная ошибка; подменённый бинарник — работает и читает cp1251', async () => {
    process.env.DWG2DXF_BIN = '/nonexistent/dwg2dxf';
    await expect(extract(new Uint8Array([1]), '', 'a.dwg')).rejects.toThrow(/LibreDWG.*не установлен/);
    // Скрипт вместо dwg2dxf: пишет DXF в cp1251 в указанный -o файл.
    const dir = mkdtempSync(join(tmpdir(), 'fake-dwg-'));
    const fixture = join(dir, 'fixture.dxf');
    // DXF в cp1251, как из старых российских САПР.
    writeFileSync(fixture, Buffer.from([...DXF].map((ch) => cp1251Byte(ch))));
    const bin = join(dir, 'dwg2dxf');
    writeFileSync(bin, `#!/bin/sh\ncp "${fixture}" "$2"\n`);
    chmodSync(bin, 0o755);
    process.env.DWG2DXF_BIN = bin;
    const dxf = await dwg2dxf(new Uint8Array([1, 2]));
    expect(dxf).toContain('ДВ 1 Рп 23,8х10');
    delete process.env.DWG2DXF_BIN;
  });
});

/** Кодировка cp1251 для кириллицы и ASCII (достаточно для теста). */
function cp1251Byte(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  if (c < 128) return c;
  if (c === 0x0401) return 0xa8;
  if (c === 0x0451) return 0xb8;
  if (c >= 0x0410 && c <= 0x044f) return c - 0x0410 + 0xc0;
  if (c === 0x2116) return 0xb9;
  return 0x3f;
}
