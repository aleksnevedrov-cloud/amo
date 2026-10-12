/**
 * Разбор CSV для справочников: разделитель `;` или `,` (определяется по заголовку), кавычки по RFC 4180,
 * строки с `#` в начале — комментарии и примеры из шаблона, пустые строки пропускаются.
 * Возвращает заголовок и строки с номером исходной строки файла — для понятных ошибок валидации.
 */
export interface CsvTable {
  header: string[];
  rows: { line: number; cells: string[] }[];
  delimiter: ';' | ',';
}

export class CsvError extends Error {
  constructor(message: string, readonly line: number) {
    super(message);
  }
}

export function parseCsv(text: string): CsvTable {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  const meaningful = lines.map((l, i) => ({ line: i + 1, text: l })).filter((l) => l.text.trim() && !l.text.trimStart().startsWith('#'));
  const first = meaningful[0];
  if (!first) throw new CsvError('файл пустой: нет строки заголовка', 1);
  const delimiter: ';' | ',' = (first.text.match(/;/g)?.length ?? 0) >= (first.text.match(/,/g)?.length ?? 0) ? ';' : ',';
  const header = splitLine(first.text, delimiter, first.line).map((h) => h.trim().toLowerCase());
  const rows = meaningful.slice(1).map((l) => ({ line: l.line, cells: splitLine(l.text, delimiter, l.line).map((c) => c.trim()) }));
  return { header, rows, delimiter };
}

function splitLine(line: string, delimiter: string, lineNo: number): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') {
      if (cur) throw new CsvError('кавычка посреди значения', lineNo);
      quoted = true;
    } else if (ch === delimiter) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (quoted) throw new CsvError('незакрытая кавычка', lineNo);
  out.push(cur);
  return out;
}

/** Число из текста прайса: «1 500», «1500,50», «1500.50 ₽» → 1500.5; пусто → null. */
export function parseNumber(v: string): number | null {
  const s = v.replace(/[\s\u00a0₽руб.]/gi, '').replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
