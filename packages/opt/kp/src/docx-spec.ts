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
    // «Наименование приложения | Количество листов» — перечень приложений, не спецификация (ТЗ 90091, таблица 25).
    const titles = h.cols.titles.join(' | ').toLowerCase();
    if (/лист(?:ов|а)?(?![а-яё])/.test(h.cols.titles[h.cols.qty] ?? '') || /наименование приложени/.test(titles)) return;
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

/** Раздел ТЗ: заголовок, номер, текст до следующего заголовка и его части (абзацы, ячейки таблиц) с диапазонами позиций. */
export interface EquipmentSection {
  title: string;
  /** Номер раздела из заголовка («РАЗДЕЛ 15.», «15.», «15 »). */
  number: string | null;
  text: string;
  /** Части текста; positions — номера позиций спецификации, к которым часть относится («поз. 14-18 Приложения 1»). */
  parts: { text: string; positions: number[] | null }[];
}

/** Абзац-заголовок: стиль заголовка, нумерованный абзац верхнего уровня, «15. Текст» или «РАЗДЕЛ 15. …» — короткий. */
const isHeading = (p: DocxParagraph) =>
  p.text.length <= 160 && (/heading|заголов|^title$|^[1-3]$/i.test(p.style ?? '') || (p.numbered && (p.level ?? 0) === 0) || /^\d{1,2}\.?\s+[А-ЯЁA-Z]/.test(p.text) || /^раздел\s+\d{1,2}/i.test(p.text));

const MAX_SECTION = 1500;
const sectionNumber = (title: string) => /^(?:раздел\s+)?(\d{1,2})(?:[.\s)]|$)/i.exec(title.trim())?.[1] ?? null;

/** Номера позиций из текста: «поз. 14-18», «позиции 14–18, 20», «поз. 3». */
export function positionsOf(text: string): number[] | null {
  const m = /поз(?:иц[а-яё]*|\.)?\s*((?:\d{1,3}\s*(?:[-–—]\s*\d{1,3})?\s*(?:,|и)?\s*)+)/i.exec(text);
  if (!m) return null;
  const out: number[] = [];
  for (const part of (m[1] as string).split(/,|\sи\s/)) {
    const r = /(\d{1,3})\s*(?:[-–—]\s*(\d{1,3}))?/.exec(part);
    if (!r) continue;
    const from = Number(r[1]);
    const to = r[2] ? Number(r[2]) : from;
    for (let n = from; n <= to && n - from < 200; n += 1) out.push(n);
  }
  return out.length ? out : null;
}

/** Разделы ТЗ: с номером в заголовке (по ссылке «см. раздел 15») и разделы о комплектации без номера. */
export function equipmentSections(blocks: DocxBlock[]): EquipmentSection[] {
  const out: EquipmentSection[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i] as DocxBlock;
    if (b.kind !== 'p' || !isHeading(b)) continue;
    const number = sectionNumber(b.text);
    if (!number && !/комплектац/i.test(b.text)) continue;
    const parts: EquipmentSection['parts'] = [];
    let size = 0;
    for (let j = i + 1; j < blocks.length && size <= MAX_SECTION; j += 1) {
      const n = blocks[j] as DocxBlock;
      if (n.kind === 'p' && isHeading(n) && !/^\d{1,2}\.\d/.test(n.text)) break;
      // «Приложение № 1» — начало приложения, не текст раздела.
      if (n.kind === 'p' && /^приложени[ея]\s*№?\s*\d/i.test(n.text)) break;
      // Таблица раздела: каждая непустая ячейка — своя часть (ТЗ 90091: таблица 1×1 «ДЛЯ ПРОТИВОПОЖАРНЫХ ДВЕРЕЙ поз. 14-18 …»);
      // строка из нескольких ячеек — одной частью «ячейка — ячейка».
      const texts = n.kind === 'p' ? [n.text] : n.rows.map((r) => r.filter(Boolean)).map((r) => (r.length === 1 ? (r[0] as string) : r.join(' — ')));
      for (const t of texts) {
        if (!t.trim()) continue;
        parts.push({ text: clean(t), positions: positionsOf(t) });
        size += t.length;
      }
    }
    const text = clean(parts.map((p) => p.text).join(' ')).slice(0, MAX_SECTION);
    if (text) out.push({ title: b.text, number, text, parts });
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

/** Комплектация из ТЗ для позиции: раздел и часть его текста. */
export interface EquipmentHit {
  section: EquipmentSection;
  text: string;
  /** Как найдено: ссылка «см. раздел N», диапазон «поз. 14-18» в разделе, обозначение позиции в разделе о комплектации. */
  by: 'ref' | 'positions' | 'marker';
}

/** Часть раздела для позиции с номером n: части с её номером в диапазоне; диапазонов нет — весь раздел. */
function partFor(s: EquipmentSection, n: number | null): string | null {
  const ranged = s.parts.filter((p) => p.positions);
  if (!ranged.length) return s.text;
  const mine = n === null ? [] : ranged.filter((p) => p.positions?.includes(n));
  return mine.length ? clean(mine.map((p) => p.text).join(' ')).slice(0, MAX_SECTION) : null;
}

/**
 * Комплектация для строки спецификации (rowNo — её № п/п): 1) строка ссылается на раздел («СМ. РАЗДЕЛ 15») — этот раздел,
 * его часть с номером строки в «поз. 14-18»; 2) в каком-либо разделе есть часть «поз. 14-18 Приложения …» с номером строки;
 * 3) раздел о комплектации, где есть обозначение позиции (ДПС, EI60, номер ГОСТ). Слово «комплектац» в заголовке не обязательно.
 */
export function equipmentFor(rowText: string, sections: EquipmentSection[], rowNo: number | null = null): EquipmentHit | null {
  const ref = /(?:раздел[а-яё]*|пункт[а-яё]*|п\.)\s*(\d{1,2})(?![\d.])/i.exec(rowText)?.[1];
  if (ref) {
    const s = sections.find((x) => x.number === ref);
    const text = s ? partFor(s, rowNo) : null;
    if (s && text) return { section: s, text, by: 'ref' };
  }
  if (rowNo !== null) {
    for (const s of sections) {
      const mine = s.parts.filter((p) => p.positions?.includes(rowNo) && /приложени/i.test(p.text));
      if (mine.length) return { section: s, text: clean(mine.map((p) => p.text).join(' ')).slice(0, MAX_SECTION), by: 'positions' };
    }
  }
  const markers = markersOf(rowText);
  if (!markers.length) return null;
  for (const s of sections.filter((x) => /комплектац/i.test(`${x.title} ${x.text}`))) {
    const t = ` ${s.title} ${s.text} `.toLowerCase();
    if (markers.some((k) => new RegExp(`(?<![а-яёa-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![а-яёa-z])`).test(t))) {
      const text = partFor(s, rowNo) ?? s.text;
      return { section: s, text, by: 'marker' };
    }
  }
  return null;
}

/** Условия закупки (п. 2.7): адрес и срок поставки, аванс, НДС, сертификаты, вес / габариты — из абзацев ТЗ и колонок спецификации. */
const CONDITION = /адрес[а-яё]* (?:поставки|доставки)|место поставки|срок[а-яё]* поставки|аванс|предоплат|ндс|сертификат|паспорт[а-яё]* качества|вес[а-яё]*\s|габарит|разгрузк|доставк/i;

export function requirementsOf(blocks: DocxBlock[], spec: DocxTable | null): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const t = clean(s).slice(0, 300);
    if (t && !out.includes(t)) out.push(t);
  };
  if (spec) {
    const rows = tableRows(spec);
    const h = detectHeader(rows);
    if (h) {
      for (const e of h.cols.extra.filter((x) => /срок[а-яё]* постав|место постав|адрес/i.test(x.title))) {
        const values = [...new Set(rows.slice(h.index + 1).map((r) => (r.cells[e.col] ?? '').trim()).filter(Boolean))];
        if (values.length && values.length <= 3) push(`${e.title}: ${values.join('; ')}`);
      }
    }
  }
  for (const b of blocks) {
    if (out.length >= 15) break;
    if (b.kind === 'p' && b.text.length <= 300 && CONDITION.test(b.text)) push(b.text);
  }
  return out;
}

/** Реквизиты предприятия (карточка): ИНН, КПП, ОГРН, БИК, р/с, к/с — и ни слова о дверях. Не заявка (п. 2.1). */
export function looksLikeRequisites(text: string): boolean {
  const t = text.toLowerCase();
  const hits = [/инн/, /кпп/, /огрн/, /бик/, /р\/с|расч[её]тн[а-яё]* сч[её]т/, /к\/с|корр[а-яё.]* сч[её]т/, /окпо|оквэд/].filter((rx) => rx.test(t)).length;
  return hits >= 3 && !/двер|полотн|короб|налични|фурнитур/.test(t);
}

/** Матрица характеристик (п. 2.3, сделка 89835 «Двери.docx»): позиция — колонка или блок строк, строка — характеристика. */
export interface MatrixPosition {
  name: string;
  qty: number | null;
  widthMm: number | null;
  heightMm: number | null;
  /** «характеристика: значение» через «; ». */
  note: string | null;
}

const NAME_KEY = /^(наименовани[ея]|тип|марка|модель|изделие|позиция|обозначение)(?![а-яё])/i;
const QTY_KEY = /^(кол-?во|количество)(?![а-яё])/i;
const CHAR_KEY = /размер|ширин|высот|материал|покрыт|цвет|фурнитур|замок|петл|открыван|порог|короб|наличник|заполнен|остекл|толщин|кол-?во|количеств|отделк|огнестойк|класс/i;
const mm = (s: string) => {
  const n = Number(/\d{3,4}/.exec(s)?.[0] ?? NaN);
  return Number.isFinite(n) ? n : null;
};

function positionFrom(pairs: [string, string][]): MatrixPosition | null {
  const name = pairs.find(([k]) => NAME_KEY.test(k))?.[1]?.trim();
  if (!name) return null;
  const qtyText = pairs.find(([k]) => QTY_KEY.test(k))?.[1] ?? '';
  const qty = /\d/.test(qtyText) ? Number(/\d+(?:[.,]\d+)?/.exec(qtyText)?.[0].replace(',', '.')) : null;
  const sizeText = pairs.find(([k]) => /размер|габарит/i.test(k))?.[1] ?? '';
  const pair = /(\d{3,4})\s*[×xх*]\s*(\d{3,4})/i.exec(sizeText);
  let widthMm = pair ? Math.min(Number(pair[1]), Number(pair[2])) : null;
  let heightMm = pair ? Math.max(Number(pair[1]), Number(pair[2])) : null;
  if (!pair) {
    widthMm = mm(pairs.find(([k]) => /ширин/i.test(k))?.[1] ?? '');
    heightMm = mm(pairs.find(([k]) => /высот/i.test(k))?.[1] ?? '');
  }
  const note = pairs.filter(([k, v]) => v && !NAME_KEY.test(k) && !QTY_KEY.test(k)).map(([k, v]) => `${k}: ${v}`).join('; ').slice(0, 1000) || null;
  return { name: name.slice(0, 300), qty: qty && qty > 0 ? qty : null, widthMm, heightMm, note };
}

/**
 * Позиции матрицы: а) по колонкам — первая колонка подписи характеристик, первая строка (или строка «Наименование / Тип / Марка»)
 * — названия позиций; б) блоками строк — таблица «характеристика | значение», где «Наименование / Тип / Марка» повторяется.
 */
export function matrixPositions(t: DocxTable): MatrixPosition[] {
  const rows = t.rows.filter((r) => r.some(Boolean));
  if (rows.length < 3) return [];
  const labels = rows.map((r) => (r[0] ?? '').trim());
  const charRows = labels.filter((l) => CHAR_KEY.test(l) || NAME_KEY.test(l)).length;
  const width = Math.max(...rows.map((r) => r.length));
  // а) По колонкам.
  if (width >= 3 && charRows >= Math.max(3, Math.ceil(labels.length * 0.5))) {
    const nameRow = rows.findIndex((r) => NAME_KEY.test((r[0] ?? '').trim()));
    const head = nameRow >= 0 ? rows[nameRow] as string[] : rows[0] as string[];
    const out: MatrixPosition[] = [];
    for (let c = 1; c < width; c += 1) {
      const name = (head[c] ?? '').trim();
      if (!name) continue;
      const pairs: [string, string][] = rows.map((r) => [(r[0] ?? '').trim() || 'Наименование', (r[c] ?? '').trim()]);
      if (nameRow < 0) pairs.unshift(['Наименование', name]);
      const p = positionFrom(pairs);
      if (p) out.push(p);
    }
    if (out.length >= 2) return out;
  }
  // б) Блоками строк.
  const starts = labels.map((l, i) => (NAME_KEY.test(l) ? i : -1)).filter((i) => i >= 0);
  if (starts.length >= 2 && width >= 2) {
    const out: MatrixPosition[] = [];
    starts.forEach((s, k) => {
      const end = starts[k + 1] ?? rows.length;
      const p = positionFrom(rows.slice(s, end).map((r) => [(r[0] ?? '').trim(), r.slice(1).filter(Boolean).join(' ').trim()]));
      if (p) out.push(p);
    });
    return out;
  }
  return [];
}
