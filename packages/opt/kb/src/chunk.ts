/**
 * Разбиение текста источника на фрагменты базы знаний: не длиннее MAX_CHUNK_CHARS символов,
 * с метаданными — страница PDF («--- страница N ---» из извлечения), лист xlsx («=== Лист «X» ===»),
 * заголовок раздела (строка Markdown «# …» или короткая строка-заголовок без точки в конце).
 * Строки таблиц (ячейки через табуляцию) не режутся посередине: прайс остаётся читаемым построчно.
 */
export const MAX_CHUNK_CHARS = 1500;

export interface ChunkMeta {
  page?: number;
  sheet?: string;
  heading?: string;
}

export interface KbChunkDraft {
  position: number;
  text: string;
  meta: ChunkMeta;
}

const PAGE_RX = /^---\s*страница\s+(\d+)\s*---$/i;
const SHEET_RX = /^===\s*Лист\s+«(.+?)»\s*===$/i;
const MD_HEADING_RX = /^#{1,6}\s+(.+?)\s*#*$/;

/** Заголовок раздела: строка Markdown «# …» либо короткая строка капсом или с нумерацией («1.2 Условия») перед текстом. */
export function headingOf(line: string, next: string | undefined): string | null {
  const md = MD_HEADING_RX.exec(line);
  if (md) return (md[1] ?? '').trim() || null;
  if (line.length < 3 || line.length > 80 || line.includes('\t')) return null;
  if (/[.;:,!?]$/.test(line) || !/\p{L}/u.test(line) || !next?.trim()) return null;
  return /^[\p{Lu}\d][^\p{Ll}]*$/u.test(line) || /^\d+(\.\d+)*\.?\s+\S/.test(line) ? line : null;
}

export function chunkDocument(text: string, maxLen = MAX_CHUNK_CHARS): KbChunkDraft[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: KbChunkDraft[] = [];
  let meta: ChunkMeta = {};
  let cur = '';
  let curMeta: ChunkMeta = {};
  const push = () => {
    const t = cur.trim();
    if (t) out.push({ position: out.length, text: t, meta: { ...curMeta } });
    cur = '';
  };
  const add = (piece: string) => {
    if (!cur) curMeta = { ...meta };
    if (cur && (cur + '\n' + piece).length > maxLen) {
      push();
      curMeta = { ...meta };
    }
    cur = cur ? `${cur}\n${piece}` : piece;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const page = PAGE_RX.exec(line.trim());
    if (page) {
      push();
      meta = { ...meta, page: Number(page[1]) };
      continue;
    }
    const sheet = SHEET_RX.exec(line.trim());
    if (sheet) {
      push();
      meta = { sheet: sheet[1] ?? '' };
      continue;
    }
    const headingText = headingOf(line.trim(), lines[i + 1]);
    if (headingText) {
      // Заголовок начинает новый фрагмент и попадает в его текст — так поиск находит раздел по названию.
      push();
      meta = { ...meta, heading: headingText.slice(0, 200) };
      add(line.trim());
      continue;
    }
    if (line.length <= maxLen) {
      add(line);
      continue;
    }
    // Длинная строка (абзац без переносов) — по предложениям, затем жёстко по длине.
    push();
    let acc = '';
    for (const s of line.split(/(?<=[.!?…;])\s+/)) {
      if (acc && (acc + ' ' + s).length > maxLen) {
        add(acc);
        push();
        acc = '';
      }
      let rest = acc ? `${acc} ${s}` : s;
      while (rest.length > maxLen) {
        add(rest.slice(0, maxLen));
        push();
        rest = rest.slice(maxLen);
      }
      acc = rest;
    }
    if (acc) add(acc);
  }
  push();
  return out;
}

/** Нормализация для ключей поиска: нижний регистр, ё→е, одиночные пробелы, без кавычек. */
export function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[«»"'`]/g, '').replace(/\s+/g, ' ').trim();
}
