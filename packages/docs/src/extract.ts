import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';

/** Что удалось вытащить из файла без внешних сервисов. */
export interface Extracted {
  format: 'pdf' | 'xlsx' | 'docx' | 'image' | 'text' | 'unsupported';
  /** Текст (таблицы — строками через табуляцию). */
  text: string;
  pages: number;
  /** Текстового слоя нет или он бессмысленный — нужен OCR. */
  needsOcr: boolean;
}

export class ExtractError extends Error {
  override name = 'ExtractError';
}

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Сколько текста отдаём дальше (в LLM уходит ещё меньше). */
export const MAX_TEXT_CHARS = 60_000;
const MAX_ROWS = 2000;

export function detectFormat(mime: string, filename = ''): Extracted['format'] {
  const m = mime.toLowerCase().split(';')[0]?.trim() ?? '';
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (m.includes('spreadsheetml') || ext === 'xlsx' || ext === 'xlsm') return 'xlsx';
  if (m.includes('wordprocessingml') || ext === 'docx') return 'docx';
  if (/^image\/(jpeg|png|webp|heic|heif)$/.test(m) || /^(jpe?g|png|webp|heic|heif)$/.test(ext)) return 'image';
  if (m.startsWith('text/') || ['txt', 'csv', 'md'].includes(ext)) return 'text';
  return 'unsupported';
}

export async function extract(bytes: Uint8Array, mime: string, filename = ''): Promise<Extracted> {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new ExtractError('Файл больше 20 МБ');
  const format = detectFormat(mime, filename);
  switch (format) {
    case 'pdf':
      return extractPdf(bytes);
    case 'xlsx':
      return { format, text: await extractXlsx(bytes), pages: 1, needsOcr: false };
    case 'docx':
      return { format, text: await extractDocx(bytes), pages: 1, needsOcr: false };
    case 'image':
      return { format, text: '', pages: 1, needsOcr: true };
    case 'text':
      return { format, text: cap(new TextDecoder('utf-8').decode(bytes)), pages: 1, needsOcr: false };
    default:
      throw new ExtractError(`Формат не поддерживается: ${filename || mime}`);
  }
}

async function extractPdf(bytes: Uint8Array): Promise<Extracted> {
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch (err) {
    throw new ExtractError(`PDF не читается: ${(err as Error).message}`);
  }
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = text.map((t) => t.replace(/[ \t]+\n/g, '\n').trim());
  const joined = pages.map((t, i) => (pages.length > 1 ? `--- страница ${i + 1} ---\n${t}` : t)).join('\n');
  return { format: 'pdf', text: cap(joined), pages: totalPages, needsOcr: !isMeaningful(pages.join('\n')) };
}

/**
 * Текстовый слой бывает мусорным (чертежи с повёрнутым текстом): считаем осмысленным,
 * если есть хотя бы несколько слов из 3+ букв и они составляют заметную долю.
 */
export function isMeaningful(text: string): boolean {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 5) return false;
  const words = tokens.filter((t) => /^[\p{L}]{3,}$/u.test(t));
  return words.length >= 5 && words.length / tokens.length >= 0.15;
}

async function extractXlsx(bytes: Uint8Array): Promise<string> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  } catch (err) {
    throw new ExtractError(`XLSX не читается: ${(err as Error).message}`);
  }
  const out: string[] = [];
  let rows = 0;
  wb.eachSheet((ws) => {
    if (ws.state === 'hidden' || ws.state === 'veryHidden') return;
    const lines: string[] = [];
    ws.eachRow((row) => {
      if (rows >= MAX_ROWS) return;
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (c) => cells.push(cellText(c)));
      const line = cells.join('\t').replace(/\t+$/, '');
      if (line.trim()) {
        lines.push(line);
        rows += 1;
      }
    });
    if (lines.length) out.push(`=== Лист «${ws.name}» ===\n${lines.join('\n')}`);
  });
  return cap(out.join('\n'));
}

function cellText(c: ExcelJS.Cell): string {
  const v = c.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('result' in v) return v.result === undefined || v.result === null ? '' : String(v.result);
    if ('text' in v) return String(v.text);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if ('error' in v) return '';
  }
  return String(v).replace(/\s+/g, ' ').trim();
}

async function extractDocx(bytes: Uint8Array): Promise<string> {
  let html: string;
  try {
    html = (await mammoth.convertToHtml({ buffer: Buffer.from(bytes) }, { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) })).value;
  } catch (err) {
    throw new ExtractError(`DOCX не читается: ${(err as Error).message}`);
  }
  return cap(htmlTablesToText(html));
}

/** HTML mammoth → текст, где ячейки таблиц разделены табуляцией, строки — переносом. */
export function htmlTablesToText(html: string): string {
  return html
    .replace(/<img[^>]*>/gi, '')
    // Внутри ячеек абзацы — через пробел, чтобы строка таблицы осталась одной строкой.
    .replace(/<table[\s\S]*?<\/table>/gi, (t) => t.replace(/<\/p>\s*(?=<\/t[dh]>)/gi, '').replace(/<\/p>\s*(?=<p>)/gi, ' '))
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<\/(tr|p|li|h\d|table|div)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, '').replace(/\t{2,}/g, '\t'))
    .filter((l, i, a) => l.trim() || (i > 0 && (a[i - 1] ?? '').trim()))
    .join('\n')
    .trim();
}

const cap = (t: string) => (t.length > MAX_TEXT_CHARS ? `${t.slice(0, MAX_TEXT_CHARS)}\n…(текст обрезан)` : t);
