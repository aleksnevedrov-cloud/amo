import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import { detectFormat, htmlTablesToText, isMeaningful, type OcrProvider } from '@core/docs';

/**
 * Текст источника базы знаний из файла. Отличие от @core/docs: лимиты под прайсы и каталоги
 * (до 50 000 строк xlsx и 2 млн символов), сканы и фото — через OCR аккаунта, если он включён.
 * Разметка та же, что у @core/docs, чтобы фрагменты получали страницу и лист: «--- страница N ---», «=== Лист «X» ===».
 */
export const KB_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const KB_MAX_TEXT_CHARS = 2_000_000;
const MAX_ROWS = 50_000;

export const KB_FILE_EXTENSIONS = ['pdf', 'docx', 'xlsx', 'xlsm', 'csv', 'txt', 'md', 'jpg', 'jpeg', 'png', 'webp'] as const;

export class KbExtractError extends Error {
  override name = 'KbExtractError';
}

export interface KbExtracted {
  format: 'pdf' | 'xlsx' | 'docx' | 'image' | 'text';
  text: string;
  pages: number;
  /** Текст получен распознаванием (имя провайдера OCR). */
  ocr: string | null;
}

export function kbFormatOf(mime: string, filename: string): KbExtracted['format'] {
  const f = detectFormat(mime, filename);
  if (f === 'pdf' || f === 'xlsx' || f === 'docx' || f === 'image' || f === 'text') return f;
  throw new KbExtractError(`Формат не поддерживается: ${filename || mime}. Принимаются pdf, docx, xlsx, csv, txt, md, jpg, png`);
}

export interface KbExtractOptions {
  /** OCR аккаунта для сканов и фото; null — распознавание выключено. */
  ocr?: OcrProvider | null;
}

export async function extractForKb(bytes: Uint8Array, mime: string, filename: string, opts: KbExtractOptions = {}): Promise<KbExtracted> {
  if (bytes.byteLength > KB_MAX_FILE_BYTES) throw new KbExtractError('Файл больше 50 МБ');
  const format = kbFormatOf(mime, filename);
  switch (format) {
    case 'text':
      return { format, text: cap(decodeText(bytes)), pages: 1, ocr: null };
    case 'docx':
      return { format, text: cap(await extractDocx(bytes)), pages: 1, ocr: null };
    case 'xlsx':
      return { format, text: cap(await extractXlsx(bytes)), pages: 1, ocr: null };
    case 'pdf': {
      const pdf = await extractPdf(bytes);
      if (pdf.meaningful || !opts.ocr) {
        if (!pdf.meaningful) throw new KbExtractError('В PDF нет текстового слоя, а распознавание сканов выключено (настройка «Разбор файлов»)');
        return { format, text: cap(pdf.text), pages: pdf.pages, ocr: null };
      }
      const r = await opts.ocr.recognize(bytes, 'application/pdf');
      return { format, text: cap(r.text), pages: Math.max(pdf.pages, r.pages.length), ocr: r.provider };
    }
    case 'image': {
      if (!opts.ocr) throw new KbExtractError('Распознавание фото и сканов выключено (настройка «Разбор файлов»)');
      const r = await opts.ocr.recognize(bytes, mime || 'image/jpeg');
      return { format, text: cap(r.text), pages: 1, ocr: r.provider };
    }
  }
}

/** UTF-8, а при явных признаках — cp1251 (старые прайсы в csv/txt из Excel). */
function decodeText(bytes: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  // Доля знаков замены велика — файл не в UTF-8.
  const bad = (utf8.match(/�/g) ?? []).length;
  if (bad > 0 && bad / Math.max(1, utf8.length) > 0.002) {
    try {
      return new TextDecoder('windows-1251').decode(bytes);
    } catch {
      return utf8;
    }
  }
  return utf8;
}

async function extractPdf(bytes: Uint8Array): Promise<{ text: string; pages: number; meaningful: boolean }> {
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch (err) {
    throw new KbExtractError(`PDF не читается: ${(err as Error).message}`);
  }
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = text.map((t) => t.replace(/[ \t]+\n/g, '\n').trim());
  const joined = pages.map((t, i) => (pages.length > 1 ? `--- страница ${i + 1} ---\n${t}` : t)).join('\n');
  return { text: joined, pages: totalPages, meaningful: isMeaningful(pages.join('\n')) };
}

async function extractDocx(bytes: Uint8Array): Promise<string> {
  try {
    const html = (await mammoth.convertToHtml({ buffer: Buffer.from(bytes) }, { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) })).value;
    return htmlTablesToText(html);
  } catch (err) {
    throw new KbExtractError(`DOCX не читается: ${(err as Error).message}`);
  }
}

export interface KbSheetRow {
  sheet: string;
  row: number;
  cells: string[];
}

/** Непустые строки видимых листов — для текста базы и для извлечения цен (этап 3). */
export async function readKbSheetRows(bytes: Uint8Array): Promise<KbSheetRow[]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  } catch (err) {
    throw new KbExtractError(`XLSX не читается: ${(err as Error).message}`);
  }
  const out: KbSheetRow[] = [];
  wb.eachSheet((ws) => {
    if (ws.state === 'hidden' || ws.state === 'veryHidden') return;
    ws.eachRow((row, rowNumber) => {
      if (out.length >= MAX_ROWS) return;
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (c) => cells.push(cellText(c)));
      while (cells.length && !cells[cells.length - 1]?.trim()) cells.pop();
      if (cells.some((c) => c.trim())) out.push({ sheet: ws.name, row: rowNumber, cells });
    });
  });
  return out;
}

async function extractXlsx(bytes: Uint8Array): Promise<string> {
  const rows = await readKbSheetRows(bytes);
  const bySheet = new Map<string, string[]>();
  for (const r of rows) {
    const list = bySheet.get(r.sheet) ?? [];
    list.push(r.cells.join('\t').replace(/\t+$/, ''));
    bySheet.set(r.sheet, list);
  }
  return [...bySheet.entries()].map(([name, lines]) => `=== Лист «${name}» ===\n${lines.join('\n')}`).join('\n');
}

/** Префикс текста ячейки-формулы без значения, которую не удалось посчитать: «#FORMULA!Прайс по ГОСТ!P15». */
export const FORMULA_NO_VALUE = '#FORMULA!';

export function cellText(c: ExcelJS.Cell): string {
  const v = c.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('formula' in v || 'sharedFormula' in v) {
      // KB-PRICE-SHEETS-FIX, п. 2: у формулы есть сохранённое значение — берём его; нет (файл писала не Excel) — считаем простые
      // формулы сами (A+B, SUM, IF(ISNUMBER…)); не вышло — пометка, по которой разбор прайса даёт понятную ошибку.
      const r = (v as { result?: unknown }).result;
      if (r !== undefined && r !== null && !(typeof r === 'object' && 'error' in (r as object))) return String(r).replace(/\s+/g, ' ').trim();
      const computed = evaluateFormulaCell(c);
      return computed === null ? `${FORMULA_NO_VALUE}${c.worksheet.name}!${c.address}` : computed;
    }
    if ('result' in v) return v.result === undefined || v.result === null ? '' : String(v.result);
    if ('text' in v) return String(v.text);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if ('error' in v) return '';
  }
  return String(v).replace(/\s+/g, ' ').trim();
}

type Fv = number | string | null;

/** Значение ячейки для формулы: число, текст или null; вложенные формулы считаются рекурсивно (глубина ограничена). */
function formulaValue(c: ExcelJS.Cell, depth: number): Fv | undefined {
  const v = c.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') {
    if ('formula' in v || 'sharedFormula' in v) {
      const r = (v as { result?: unknown }).result;
      if (typeof r === 'number' || typeof r === 'string') return r;
      if (depth > 8) return undefined;
      const text = evaluateFormulaCell(c, depth + 1);
      if (text === null) return undefined;
      const n = Number(text.replace(',', '.'));
      return text !== '' && Number.isFinite(n) ? n : text;
    }
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('result' in v) return typeof v.result === 'number' || typeof v.result === 'string' ? v.result : null;
    if ('text' in v) return String(v.text);
  }
  return null;
}

/**
 * Счёт простой формулы без сохранённого значения: числа, ссылки на ячейки (в т. ч. другого листа), + − × ÷, скобки,
 * SUM(диапазон), IF(условие, a, b), ISNUMBER(x), строки в кавычках. Что-то другое — null (ошибка «пересохраните файл в Excel»).
 */
export function evaluateFormulaCell(c: ExcelJS.Cell, depth = 0): string | null {
  const v = c.value as { formula?: string; sharedFormula?: string } | null;
  const src = (v?.formula ?? v?.sharedFormula ?? '').trim();
  if (!src || depth > 8) return null;
  const wb = c.worksheet.workbook;
  const cellOf = (ref: string): ExcelJS.Cell | null => {
    const m = /^(?:'([^']+)'|([^!]+))!(\$?[A-Z]{1,3}\$?\d+)$/.exec(ref) ?? [null, null, null, ref];
    const sheetName = (m[1] ?? m[2]) || null;
    const ws = sheetName ? wb.getWorksheet(sheetName) : c.worksheet;
    if (!ws) return null;
    return ws.getCell((m[3] as string).replace(/\$/g, ''));
  };
  const toNum = (x: Fv | undefined): number | undefined => {
    if (x === undefined) return undefined;
    if (x === null || x === '') return 0;
    if (typeof x === 'number') return x;
    const n = Number(x.replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : undefined;
  };
  // Разбор рекурсивным спуском.
  const tokens = src.match(/'[^']+'![A-Z$]+\d+|[A-Za-zА-Яа-я_][\w.]*![A-Z$]+\d+|"[^"]*"|\d+(?:[.,]\d+)?|[A-Z]+\(|\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?|[-+*/(),]|<>|<=|>=|[<>=]/g) ?? [];
  if (tokens.join('').replace(/\s+/g, '') !== src.replace(/\s+/g, '')) return null;
  let i = 0;
  let failed = false;
  const peek = () => tokens[i];
  const next = () => tokens[i++] as string;
  const rangeCells = (a: string, b: string): ExcelJS.Cell[] => {
    const pa = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(a);
    const pb = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(b);
    if (!pa || !pb) return [];
    const col = (s: string) => s.split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
    const out: ExcelJS.Cell[] = [];
    for (let r = Number(pa[2]); r <= Number(pb[2]); r += 1) for (let k = col(pa[1] as string); k <= col(pb[1] as string); k += 1) out.push(c.worksheet.getCell(r, k));
    return out.slice(0, 2000);
  };
  const parseExpr = (): Fv | undefined => {
    let left = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const right = parseTerm();
      const a = toNum(left);
      const b = toNum(right);
      if (a === undefined || b === undefined) return (failed = true), undefined;
      left = op === '+' ? a + b : a - b;
    }
    return left;
  };
  const parseTerm = (): Fv | undefined => {
    let left = parseUnary();
    while (peek() === '*' || peek() === '/') {
      const op = next();
      const right = parseUnary();
      const a = toNum(left);
      const b = toNum(right);
      if (a === undefined || b === undefined || (op === '/' && b === 0)) return (failed = true), undefined;
      left = op === '*' ? a * b : a / b;
    }
    return left;
  };
  const parseUnary = (): Fv | undefined => {
    if (peek() === '-') {
      next();
      const x = toNum(parseUnary());
      return x === undefined ? ((failed = true), undefined) : -x;
    }
    if (peek() === '+') next();
    return parseAtom();
  };
  const parseCompare = (): Fv | undefined => {
    const left = parseExpr();
    const op = peek();
    if (op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=') {
      next();
      const right = parseExpr();
      if (left === undefined || right === undefined) return undefined;
      const a = toNum(left);
      const b = toNum(right);
      const cmp = a !== undefined && b !== undefined ? a - b : String(left ?? '').localeCompare(String(right ?? ''));
      const ok = op === '=' ? cmp === 0 : op === '<>' ? cmp !== 0 : op === '<' ? cmp < 0 : op === '>' ? cmp > 0 : op === '<=' ? cmp <= 0 : cmp >= 0;
      return ok ? 1 : 0;
    }
    return left;
  };
  const parseAtom = (): Fv | undefined => {
    const t = next();
    if (t === undefined) return (failed = true), undefined;
    if (t === '(') {
      const x = parseCompare();
      if (next() !== ')') return (failed = true), undefined;
      return x;
    }
    if (/^"/.test(t)) return t.slice(1, -1);
    if (/^\d/.test(t)) return Number(t.replace(',', '.'));
    if (/\($/.test(t)) {
      const fn = t.slice(0, -1).toUpperCase();
      const args: (Fv | undefined)[] = [];
      const ranges: ExcelJS.Cell[][] = [];
      while (peek() !== ')') {
        const a = peek();
        if (a && /^\$?[A-Z]{1,3}\$?\d+:\$?[A-Z]{1,3}\$?\d+$/.test(a)) {
          next();
          const [from, to] = a.split(':') as [string, string];
          ranges.push(rangeCells(from, to));
          args.push(null);
        } else args.push(parseCompare());
        if (peek() === ',') next();
        else if (peek() !== ')') return (failed = true), undefined;
      }
      next();
      if (fn === 'SUM') {
        let total = 0;
        for (const cells of ranges) for (const x of cells) {
          const n = toNum(formulaValue(x, depth + 1));
          if (n === undefined) return (failed = true), undefined;
          total += n;
        }
        for (const a of args) {
          if (a === null) continue;
          const n = toNum(a);
          if (n === undefined) return (failed = true), undefined;
          total += n;
        }
        return total;
      }
      if (fn === 'ISNUMBER') return typeof args[0] === 'number' ? 1 : 0;
      if (fn === 'IF') {
        const cond = toNum(args[0]);
        if (cond === undefined) return (failed = true), undefined;
        return cond !== 0 ? (args[1] ?? null) : (args[2] ?? null);
      }
      if (fn === 'ROUND') {
        const n = toNum(args[0]);
        const d = toNum(args[1] ?? 0) ?? 0;
        return n === undefined ? ((failed = true), undefined) : Math.round(n * 10 ** d) / 10 ** d;
      }
      return (failed = true), undefined;
    }
    const cell = cellOf(t);
    if (!cell) return (failed = true), undefined;
    const value = formulaValue(cell, depth + 1);
    if (value === undefined) return (failed = true), undefined;
    return value;
  };
  const result = parseCompare();
  if (failed || result === undefined || i !== tokens.length) return null;
  if (result === null) return '';
  return typeof result === 'number' ? String(Math.round(result * 100) / 100) : result;
}

const cap = (t: string) => (t.length > KB_MAX_TEXT_CHARS ? `${t.slice(0, KB_MAX_TEXT_CHARS)}\n…(текст обрезан)` : t);
