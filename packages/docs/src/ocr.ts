/**
 * OCR сканов и фото. Основной провайдер — Yandex Vision (серверы в РФ, 152-ФЗ):
 * файл целиком уходит только сюда, в Claude — уже текст без контактов.
 *
 * Сверить с документацией Yandex Cloud Vision OCR API v1 (см. отчёт фазы 3):
 *  - POST https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText — синхронно, картинка или PDF на 1 страницу;
 *  - POST …/recognizeTextAsync + GET https://operation.api.cloud.yandex.net/operations/{id}
 *    + GET …/ocr/v1/getRecognition?operationId= — многостраничные PDF (ответ — JSON по странице на строку).
 */
export interface OcrPage {
  text: string;
  /** Таблицы, восстановленные из разметки (строки через табуляцию). */
  tables: string[];
}

export interface OcrResult {
  provider: string;
  pages: OcrPage[];
  /** Текст всех страниц: таблицы — табуляцией, остальное — строками по положению на странице. */
  text: string;
}

export interface OcrProvider {
  readonly name: string;
  recognize(bytes: Uint8Array, mime: string, opts?: { model?: 'page' | 'handwritten' | 'table' }): Promise<OcrResult>;
}

export class OcrError extends Error {
  override name = 'OcrError';
}

interface Vertex {
  x?: string | number;
  y?: string | number;
}
interface Box {
  vertices?: Vertex[];
}
interface Line {
  boundingBox?: Box;
  text?: string;
}
interface Block {
  boundingBox?: Box;
  lines?: Line[];
}
interface Cell {
  rowIndex?: string | number;
  columnIndex?: string | number;
  text?: string;
}
interface Table {
  rowCount?: string | number;
  columnCount?: string | number;
  cells?: Cell[];
}
/** Ответ Vision: { result: { textAnnotation: {...}, page } } или сам textAnnotation в async-потоке. */
export interface TextAnnotation {
  width?: string | number;
  height?: string | number;
  blocks?: Block[];
  tables?: Table[];
  fullText?: string;
}

const SYNC_MAX_BYTES = 10 * 1024 * 1024;

export class YandexVision implements OcrProvider {
  readonly name = 'yandex';
  constructor(
    private readonly apiKey: string,
    private readonly folderId: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async recognize(bytes: Uint8Array, mime: string, opts: { model?: 'page' | 'handwritten' | 'table' } = {}): Promise<OcrResult> {
    const mimeType = normalizeMime(mime);
    if (bytes.byteLength > SYNC_MAX_BYTES) throw new OcrError('Vision: файл больше 10 МБ');
    const body = {
      mimeType,
      languageCodes: ['ru', 'en'],
      model: opts.model ?? (mimeType === 'application/pdf' ? 'page' : 'handwritten'),
      content: Buffer.from(bytes).toString('base64'),
    };
    const annotations =
      mimeType === 'application/pdf' && (await pdfPageCount(bytes)) > 1 ? await this.recognizeAsync(body) : [await this.recognizeSync(body)];
    const pages = annotations.map(layoutPage);
    return { provider: this.name, pages, text: pages.map((p, i) => (pages.length > 1 ? `--- страница ${i + 1} ---\n${p.text}` : p.text)).join('\n') };
  }

  private headers() {
    return { authorization: `Api-Key ${this.apiKey}`, 'x-folder-id': this.folderId, 'content-type': 'application/json' };
  }

  private async recognizeSync(body: unknown): Promise<TextAnnotation> {
    const res = await this.fetchImpl('https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const json = (await res.json().catch(() => null)) as { result?: { textAnnotation?: TextAnnotation }; message?: string } | null;
    if (!res.ok) throw new OcrError(`Vision: HTTP ${res.status} ${json?.message ?? ''}`.trim());
    return json?.result?.textAnnotation ?? {};
  }

  private async recognizeAsync(body: unknown): Promise<TextAnnotation[]> {
    const start = await this.fetchImpl('https://ocr.api.cloud.yandex.net/ocr/v1/recognizeTextAsync', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const op = (await start.json().catch(() => null)) as { id?: string; done?: boolean; message?: string } | null;
    if (!start.ok || !op?.id) throw new OcrError(`Vision async: HTTP ${start.status} ${op?.message ?? ''}`.trim());
    let done = op.done ?? false;
    for (let i = 0; !done && i < 60; i++) {
      await this.sleep(2000);
      const res = await this.fetchImpl(`https://operation.api.cloud.yandex.net/operations/${op.id}`, { headers: this.headers(), signal: AbortSignal.timeout(30_000) });
      const st = (await res.json().catch(() => null)) as { done?: boolean; error?: { message?: string } } | null;
      if (st?.error) throw new OcrError(`Vision async: ${st.error.message ?? 'ошибка'}`);
      done = st?.done ?? false;
    }
    if (!done) throw new OcrError('Vision async: распознавание не завершилось за 2 минуты');
    const res = await this.fetchImpl(`https://ocr.api.cloud.yandex.net/ocr/v1/getRecognition?operationId=${op.id}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new OcrError(`Vision getRecognition: HTTP ${res.status}`);
    return parseRecognitionStream(await res.text());
  }
}

/** Результат getRecognition: по одному JSON на строку (или один объект / массив). */
export function parseRecognitionStream(raw: string): TextAnnotation[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  const unwrap = (v: unknown): TextAnnotation | null => {
    if (!v || typeof v !== 'object') return null;
    const o = v as { result?: { textAnnotation?: TextAnnotation }; textAnnotation?: TextAnnotation };
    return o.result?.textAnnotation ?? o.textAnnotation ?? (('blocks' in o || 'fullText' in o) ? (o as TextAnnotation) : null);
  };
  const whole = tryParse(trimmed);
  if (Array.isArray(whole)) return whole.map(unwrap).filter((x): x is TextAnnotation => x !== null);
  if (whole) return [unwrap(whole)].filter((x): x is TextAnnotation => x !== null);
  return trimmed
    .split('\n')
    .map((l) => unwrap(tryParse(l)))
    .filter((x): x is TextAnnotation => x !== null);
}

const num = (v: string | number | undefined) => Number(v ?? 0);

/**
 * Собирает текст страницы по положению строк: строки с близкой высотой — в одну
 * строку через табуляцию (так столбцы замерного листа не перемешиваются).
 */
export function layoutPage(a: TextAnnotation): OcrPage {
  const tables = (a.tables ?? []).map(tableToText).filter(Boolean);
  const lines: { x: number; y: number; h: number; text: string }[] = [];
  for (const b of a.blocks ?? []) {
    for (const l of b.lines ?? []) {
      const text = (l.text ?? '').trim();
      if (!text) continue;
      const v = l.boundingBox?.vertices ?? [];
      const ys = v.map((p) => num(p.y));
      const xs = v.map((p) => num(p.x));
      const y0 = ys.length ? Math.min(...ys) : 0;
      const y1 = ys.length ? Math.max(...ys) : 0;
      lines.push({ x: xs.length ? Math.min(...xs) : 0, y: (y0 + y1) / 2, h: Math.max(y1 - y0, 1), text });
    }
  }
  if (!lines.length) return { text: tables.length ? tables.join('\n\n') : (a.fullText ?? '').trim(), tables };
  lines.sort((p, q) => p.y - q.y || p.x - q.x);
  const rows: (typeof lines)[] = [];
  for (const l of lines) {
    const row = rows.at(-1);
    const first = row?.[0];
    if (row && first && Math.abs(l.y - first.y) <= Math.min(first.h, l.h) * 0.6) row.push(l);
    else rows.push([l]);
  }
  const text = rows.map((r) => r.sort((p, q) => p.x - q.x).map((l) => l.text).join('\t')).join('\n');
  return { text: tables.length ? `${text}\n\n${tables.join('\n\n')}` : text, tables };
}

function tableToText(t: Table): string {
  const rowsN = num(t.rowCount);
  const colsN = num(t.columnCount);
  if (!rowsN || !colsN) return '';
  const grid: string[][] = Array.from({ length: rowsN }, () => Array.from({ length: colsN }, () => ''));
  for (const c of t.cells ?? []) {
    const r = num(c.rowIndex);
    const col = num(c.columnIndex);
    const row = grid[r];
    if (row && col < colsN) row[col] = (c.text ?? '').replace(/\s+/g, ' ').trim();
  }
  return grid
    .map((r) => r.join('\t').replace(/\t+$/, ''))
    .filter((r) => r.trim())
    .join('\n');
}

function normalizeMime(mime: string): string {
  const m = mime.toLowerCase().split(';')[0]?.trim() ?? '';
  if (m === 'image/jpg') return 'image/jpeg';
  if (['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(m)) return m;
  throw new OcrError(`Vision: формат ${mime || 'неизвестен'} не поддерживается (нужны JPEG, PNG, WebP или PDF)`);
}

/** Число страниц PDF по объектам /Type /Page — без разбора структуры, для выбора sync/async. */
export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  const head = Buffer.from(bytes).toString('latin1');
  const m = head.match(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/);
  if (m) return Number(m[1]);
  const n = (head.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
  return Math.max(n, 1);
}
