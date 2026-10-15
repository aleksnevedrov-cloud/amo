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

export function cellText(c: ExcelJS.Cell): string {
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

const cap = (t: string) => (t.length > KB_MAX_TEXT_CHARS ? `${t.slice(0, KB_MAX_TEXT_CHARS)}\n…(текст обрезан)` : t);
