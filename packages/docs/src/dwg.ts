import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { layoutPage, type TextAnnotation } from './ocr.ts';

/**
 * Чертежи (фаза 4, media.parse_dwg). Вместо растеризации и OCR берём текст прямо из чертежа:
 * DWG → DXF внешним конвертером LibreDWG (`dwg2dxf`), DXF разбирается здесь — надписи TEXT/MTEXT,
 * атрибуты блоков и размеры со своими координатами, дальше — общее восстановление строк (layoutPage).
 * Это точнее OCR: маркировки и размеры приходят как есть, без ошибок распознавания.
 */
export type DwgConverter = (dwg: Uint8Array) => Promise<string>;

export class DwgError extends Error {
  override name = 'DwgError';
}

const run = promisify(execFile);

/** Конвертер по умолчанию — LibreDWG `dwg2dxf` (путь — DWG2DXF_BIN). */
export const dwg2dxf: DwgConverter = async (dwg) => {
  const bin = process.env.DWG2DXF_BIN || 'dwg2dxf';
  const dir = await mkdtemp(join(tmpdir(), 'ai-door-dwg-'));
  try {
    const src = join(dir, 'in.dwg');
    const out = join(dir, 'out.dxf');
    await writeFile(src, dwg);
    try {
      await run(bin, ['-o', out, src], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      if (e.code === 'ENOENT') throw new DwgError('Конвертер DWG (LibreDWG dwg2dxf) не установлен на сервере — попросите у клиента PDF или картинку');
      throw new DwgError(`Конвертация DWG не удалась: ${(e.stderr || e.message || '').toString().trim().slice(0, 300)}`);
    }
    return readFile(out, 'latin1').then((s) => decodeDxf(s));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** DXF бывает в cp1251 (старые российские чертежи) — определяем по $DWGCODEPAGE. */
function decodeDxf(latin1: string): string {
  const bytes = Buffer.from(latin1, 'latin1');
  const cp = /\$DWGCODEPAGE\s*\n\s*3\s*\n\s*(\S+)/i.exec(latin1)?.[1]?.toUpperCase() ?? '';
  if (/ANSI_1251|CP1251|1251/.test(cp)) return new TextDecoder('windows-1251').decode(bytes);
  return bytes.toString('utf8');
}

interface DxfText {
  text: string;
  x: number;
  y: number;
  h: number;
}

/**
 * Текст из ASCII DXF: TEXT, MTEXT, ATTRIB (атрибуты блоков — марки дверей) и DIMENSION (размеры).
 * Координаты нужны, чтобы собрать таблицу спецификации построчно.
 */
export function parseDxfText(dxf: string): DxfText[] {
  const lines = dxf.replace(/\r\n/g, '\n').split('\n');
  const out: DxfText[] = [];
  let i = 0;
  // Пропускаем всё до секции ENTITIES (в BLOCKS — определения, они повторяются через INSERT/ATTRIB).
  let inEntities = false;
  let cur: { type: string; text: string[]; x: number; y: number; h: number; measurement: number | null } | null = null;
  const flush = () => {
    if (!cur) return;
    let text = cur.text.join('');
    if (cur.type === 'DIMENSION') {
      // Пустой текст или «<>» — берём измеренное значение.
      text = text.replace(/<>/g, cur.measurement !== null ? formatMm(cur.measurement) : '').trim() || (cur.measurement !== null ? formatMm(cur.measurement) : '');
    }
    text = cleanMtext(text);
    if (text.trim()) out.push({ text: text.trim(), x: cur.x, y: cur.y, h: cur.h || 2.5 });
    cur = null;
  };
  while (i + 1 < lines.length) {
    const code = Number((lines[i] ?? '').trim());
    // Текстовые группы не обрезаем: MTEXT режется на куски по 250 символов и пробел на стыке значим.
    const raw = lines[i + 1] ?? '';
    const value = code === 1 || code === 3 ? raw : raw.trim();
    i += 2;
    if (code === 0) {
      flush();
      if (value === 'SECTION') {
        // Следующая пара 2/<имя секции>.
        const name = (lines[i + 1] ?? '').trim();
        inEntities = name === 'ENTITIES';
        continue;
      }
      if (value === 'ENDSEC') {
        inEntities = false;
        continue;
      }
      if (inEntities && ['TEXT', 'MTEXT', 'ATTRIB', 'DIMENSION'].includes(value)) cur = { type: value, text: [], x: 0, y: 0, h: 0, measurement: null };
      continue;
    }
    if (!cur) continue;
    switch (code) {
      case 1:
        cur.text.push(value);
        break;
      case 3: // MTEXT: куски по 250 символов идут кодом 3, хвост — кодом 1, в порядке чтения
        cur.text.push(value);
        break;
      case 10:
        cur.x = Number(value) || 0;
        break;
      case 20:
        cur.y = Number(value) || 0;
        break;
      case 40:
        if (cur.type !== 'DIMENSION') cur.h = Number(value) || 0;
        break;
      case 42:
        if (cur.type === 'DIMENSION') cur.measurement = Number(value);
        break;
      default:
        break;
    }
  }
  flush();
  return out;
}

const formatMm = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v)));

/** Убирает форматирование MTEXT: {\fArial|b1;текст}, \P — перенос, \~ — пробел, %%d — градус и т. п. */
export function cleanMtext(s: string): string {
  return s
    .replace(/\\[Pp]/g, '\n')
    .replace(/\\~/g, ' ')
    .replace(/\\[fFhHcCwWqQaAtT][^;]*;/g, '')
    .replace(/\\[lLoOkK]/g, '')
    .replace(/\\S([^^]*)\^([^;]*);/g, '$1/$2')
    .replace(/[{}]/g, '')
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/%%[cC]/g, 'Ø')
    .replace(/%%%/g, '%')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Текст чертежа построчно (ось Y в DXF направлена вверх — переворачиваем). */
export function dxfToText(dxf: string): string {
  const items = parseDxfText(dxf);
  if (!items.length) return '';
  const maxY = Math.max(...items.map((t) => t.y));
  const a: TextAnnotation = {
    blocks: [
      {
        lines: items.flatMap((t) =>
          t.text.split('\n').map((line, k) => {
            const y = maxY - t.y + k * t.h * 1.6;
            return { text: line, boundingBox: { vertices: [{ x: t.x, y }, { x: t.x + line.length * t.h * 0.8, y }, { x: t.x + line.length * t.h * 0.8, y: y + t.h }, { x: t.x, y: y + t.h }] } };
          }),
        ),
      },
    ],
  };
  return layoutPage(a).text;
}
