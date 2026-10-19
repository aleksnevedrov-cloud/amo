import PizZip from 'pizzip';
import { detectHeader, tableItems, type SheetRow } from './table-parse.ts';

/**
 * KP-DOCX-APPENDIX: спецификация в Word-файле ТЗ. Раньше весь документ (≈ 38 тыс. знаков, 26 таблиц) уходил в модель одним
 * запросом и возвращал 0 позиций — таблица «Приложение №1» стоит в самом конце, после текста ТЗ. Теперь документ читается кодом:
 * абзацы и таблицы тела по порядку; таблица спецификации — та, у которой распознана шапка «наименование / количество»
 * (как в xlsx, table-parse.ts) и есть строки с количеством; при нескольких — с заголовком «Приложение / Спецификация / Перечень»,
 * затем с бо́льшим числом позиций, затем последняя. Её строки разбираются по колонкам, модель только нормализует названия.
 * Разделы «… комплектация …» из текста ТЗ прикладываются к позициям, к которым относятся (раздел 15 — к дверям ДПС 01 EI60).
 */

/** Абзац тела документа (вне таблиц). */
export interface DocxParagraph {
  kind: 'p';
  text: string;
  /** Стиль абзаца (w:pStyle): Heading1, «Заголовок 1», «1» … */
  style: string | null;
  /** Абзац в нумерованном списке (w:numPr) и его уровень. */
  numbered: boolean;
  level: number | null;
}

/**
 * Таблица верхнего уровня: строки ячеек. Объединённые по горизонтали — пустыми ячейками справа, чтобы колонки не съезжали;
 * по вертикали — значением верхней ячейки в каждой строке («Дверь ДПС 01 EI60» на пять размеров).
 */
export interface DocxTable {
  kind: 'table';
  /** Номер таблицы в документе (с 1). */
  n: number;
  rows: string[][];
}

export type DocxBlock = DocxParagraph | DocxTable;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? _));
const clean = (s: string) => s.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const attr = (tag: string, name: string) => new RegExp(`w:${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

/** Абзацы и таблицы тела документа по порядку. Вложенные таблицы — текстом своей ячейки. */
export function readDocxBlocks(bytes: Uint8Array): DocxBlock[] {
  let xml: string;
  try {
    const zip = new PizZip(bytes);
    const f = zip.file('word/document.xml');
    if (!f) throw new Error('нет word/document.xml');
    xml = f.asText();
  } catch (err) {
    throw new Error(`DOCX не читается: ${(err as Error).message}`);
  }
  const blocks: DocxBlock[] = [];
  const tagRx = /<(\/?)w:(tbl|tr|tc|p|t|tab|br|cr|pStyle|numPr|ilvl|gridSpan|vMerge)\b([^>]*?)(\/?)>/g;
  let depth = 0;
  let tables = 0;
  let para: DocxParagraph | null = null;
  let paraText: string[] = [];
  let table: DocxTable | null = null;
  let row: string[] | null = null;
  let cell: string[] | null = null;
  let span = 1;
  // Объединение по вертикали (w:vMerge без val / continue): ячейка берёт значение той же колонки строкой выше.
  let vCont = false;
  let col = 0;
  let inText = false;
  let textStart = 0;
  for (let m = tagRx.exec(xml); m; m = tagRx.exec(xml)) {
    const [whole, close, name, attrs, selfClose] = m as unknown as [string, string, string, string, string];
    const push = (s: string) => {
      if (depth > 0 && cell) cell.push(s);
      else if (para) paraText.push(s);
    };
    if (name === 't') {
      if (!close && !selfClose) {
        inText = true;
        textStart = m.index + whole.length;
      } else if (close && inText) {
        push(decode(xml.slice(textStart, m.index)));
        inText = false;
      }
      continue;
    }
    if (name === 'tab' || name === 'br' || name === 'cr') {
      push(' ');
      continue;
    }
    if (name === 'tbl') {
      if (!close) {
        depth += 1;
        if (depth === 1) table = { kind: 'table', n: ++tables, rows: [] };
      } else {
        depth -= 1;
        if (depth === 0 && table) {
          blocks.push(table);
          table = null;
        }
      }
      continue;
    }
    if (depth === 1 && name === 'tr') {
      if (!close) row = [];
      else if (row && table) {
        while (row.length && !row[row.length - 1]) row.pop();
        if (row.some(Boolean)) table.rows.push(row);
        row = null;
      }
      continue;
    }
    if (depth === 1 && name === 'tc') {
      if (!close) {
        cell = [];
        span = 1;
        vCont = false;
        col = row?.length ?? 0;
      } else if (cell && row) {
        const text = clean(cell.join(''));
        row.push(!text && vCont ? table?.rows[table.rows.length - 1]?.[col] ?? '' : text);
        for (let i = 1; i < span; i += 1) row.push('');
        cell = null;
      }
      continue;
    }
    if (depth === 1 && cell && name === 'gridSpan') {
      span = Math.max(1, Number(attr(attrs, 'val') ?? 1) || 1);
      continue;
    }
    if (depth === 1 && cell && name === 'vMerge') {
      vCont = attr(attrs, 'val') !== 'restart';
      continue;
    }
    if (name === 'p') {
      if (depth > 0) {
        // Абзацы внутри ячейки — через пробел.
        if (close && cell) cell.push(' ');
        continue;
      }
      if (!close && !selfClose) {
        para = { kind: 'p', text: '', style: null, numbered: false, level: null };
        paraText = [];
      } else if (close && para) {
        para.text = clean(paraText.join(''));
        if (para.text) blocks.push(para);
        para = null;
      }
      continue;
    }
    if (depth === 0 && para) {
      if (name === 'pStyle') para.style = attr(attrs, 'val');
      else if (name === 'numPr' && !close) para.numbered = true;
      else if (name === 'ilvl') para.level = Number(attr(attrs, 'val') ?? 0);
    }
  }
  return blocks;
}

/** Таблица → строки для разбора по колонкам (table-parse.ts): «лист» — «таблица N». */
export const tableRows = (t: DocxTable): SheetRow[] => t.rows.map((cells, i) => ({ sheet: `таблица ${t.n}`, row: i + 1, cells }));

/**
 * Заголовок таблицы: короткие абзацы прямо перед ней вверх до абзаца «Приложение / Спецификация / Перечень …» включительно
 * («Приложение №1», «к техническому заданию»); такого абзаца нет в трёх ближайших — только абзац над таблицей.
 */
function titleOf(blocks: DocxBlock[], index: number): string {
  const out: string[] = [];
  for (let i = index - 1; i >= 0 && out.length < 3; i -= 1) {
    const b = blocks[i] as DocxBlock;
    if (b.kind === 'table' || b.text.length > 120) break;
    out.unshift(b.text);
    if (SPEC_TITLE.test(b.text)) return out.join(' ').slice(0, 300);
  }
  return (out[out.length - 1] ?? '').slice(0, 300);
}

const SPEC_TITLE = /приложени|спецификац|перечень|ведомост|потребност/i;

export interface SpecTable {
  table: DocxTable;
  title: string;
  /** Строк с наименованием и количеством. */
  items: number;
}

/** Кандидаты в спецификацию: шапка «наименование / количество» распознана, есть строки с количеством. */
export function specCandidates(blocks: DocxBlock[]): SpecTable[] {
  const out: SpecTable[] = [];
  blocks.forEach((b, i) => {
    if (b.kind !== 'table') return;
    const rows = tableRows(b);
    const h = detectHeader(rows);
    if (!h || h.cols.qty === null) return;
    const items = tableItems(rows, h.index + 1, h.cols).items.filter((it) => it.qty !== null).length;
    if (items) out.push({ table: b, title: titleOf(blocks, i), items });
  });
  return out;
}

/** Таблица спецификации: с заголовком «Приложение / Спецификация / Перечень», затем больше позиций, затем последняя. */
export function pickSpecTable(cands: SpecTable[]): SpecTable | null {
  return (
    [...cands].sort((a, b) => Number(SPEC_TITLE.test(b.title)) - Number(SPEC_TITLE.test(a.title)) || b.items - a.items || b.table.n - a.table.n)[0] ?? null
  );
}

/** Раздел ТЗ о комплектации: заголовок и текст до следующего заголовка (таблицы внутри — строками «ячейка — ячейка»). */
export interface EquipmentSection {
  title: string;
  /** Номер раздела, если написан в тексте заголовка («15.», «15 »). */
  number: string | null;
  text: string;
}

/** Абзац-заголовок: стиль заголовка, нумерованный абзац верхнего уровня или «15. Текст» — короткий. */
const isHeading = (p: DocxParagraph) =>
  p.text.length <= 160 && (/heading|заголов|^title$|^[1-3]$/i.test(p.style ?? '') || (p.numbered && (p.level ?? 0) === 0) || /^\d{1,2}\.?\s+[А-ЯЁA-Z]/.test(p.text));

const MAX_SECTION = 1500;

/** Разделы с «комплектац» в заголовке. */
export function equipmentSections(blocks: DocxBlock[]): EquipmentSection[] {
  const out: EquipmentSection[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i] as DocxBlock;
    if (b.kind !== 'p' || !isHeading(b) || !/комплектац/i.test(b.text)) continue;
    const body: string[] = [];
    for (let j = i + 1; j < blocks.length; j += 1) {
      const n = blocks[j] as DocxBlock;
      if (n.kind === 'p' && isHeading(n) && !/^\d{1,2}\.\d/.test(n.text)) break;
      body.push(n.kind === 'p' ? n.text : n.rows.map((r) => r.filter(Boolean).join(' — ')).join('; '));
      if (body.join(' ').length > MAX_SECTION) break;
    }
    const text = clean(body.join(' ')).slice(0, MAX_SECTION);
    if (text) out.push({ title: b.text, number: /^(\d{1,2})(?:\.|\s)/.exec(b.text)?.[1] ?? null, text });
  }
  return out;
}

/** Слова-материалы и общие сокращения: по ним раздел комплектации к позиции не относим. */
const COMMON = new Set(['гост', 'ral', 'пвх', 'мдф', 'хдф', 'дпк', 'cpl', 'мм', 'шт', 'ту', 'снип', 'сп', 'рф']);

/** Отличительные обозначения позиции: «ДПС», «EI60», «ДСН», номер ГОСТ «57327-2016». */
export function markersOf(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![А-ЯЁA-Za-zа-яё0-9])([А-ЯЁA-Z]{2,5}\d{0,3})(?![А-ЯЁA-Za-zа-яё])/g)) {
    const w = (m[1] as string).toLowerCase();
    if (!COMMON.has(w)) out.add(w);
  }
  for (const m of text.matchAll(/(?<!\d)(\d{4,5}-\d{2,4})(?!\d)/g)) out.add(m[1] as string);
  return [...out];
}

/**
 * Раздел комплектации для позиции: строка ссылается на раздел («см. раздел 15», «п. 15») — он; иначе раздел, в заголовке или
 * тексте которого есть отличительное обозначение позиции (ДПС, EI60, номер ГОСТ). Несколько — первый по документу.
 */
export function equipmentFor(rowText: string, sections: EquipmentSection[]): EquipmentSection | null {
  const ref = /(?:раздел[а-я]*|пункт[а-я]*|п\.)\s*(\d{1,2})(?![\d.])/i.exec(rowText)?.[1];
  if (ref) {
    const s = sections.find((x) => x.number === ref);
    if (s) return s;
  }
  const markers = markersOf(rowText);
  if (!markers.length) return null;
  return sections.find((s) => {
    const t = ` ${s.title} ${s.text} `.toLowerCase();
    return markers.some((k) => new RegExp(`(?<![а-яёa-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![а-яёa-z])`).test(t));
  }) ?? null;
}
