import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { layoutPage, OcrError, type OcrPage, type OcrProvider, type OcrResult, type TextAnnotation } from '@core/docs';
import { costOfUsage, modelTraits, type LlmGateway } from '@core/llm';
import { asGateway, resolveRoute, type LlmClient } from '@retail/agent';
import { ocrContext } from './context.ts';

/**
 * RFD-AI-AGENT-RETAIL-OCR: собственное распознавание «Агента розница» — без Yandex Vision, для всех вариантов файлов.
 *
 * | Вход | Шаг 1 | Шаг 2, если текста мало | Итог |
 * | PDF без текстового слоя | pdftoppm -r 200 -png (poppler), до 20 страниц | Tesseract rus+eng по странице; мало текста — страница картинкой в модель аккаунта (до 8 страниц) | «--- страница N ---» + текст |
 * | JPG / PNG / WEBP / BMP | Tesseract | (картинку модели показывает сам DocumentService при vision.photosToClaude) | текст |
 * | HEIC / HEIF / TIFF | ImageMagick → PNG (TIFF — постранично) | как картинка | текст |
 *
 * «Мало текста» — критерий isMeaningful из extract.ts (≥ 5 слов из 3+ букв и ≥ 15 % токенов). Таймауты: pdftoppm 60 с на файл,
 * Tesseract 60 с на страницу, модель 90 с на страницу. Временные файлы — в каталоге процесса, удаляются в finally.
 * Модель недоступна или выключено vision.photosToClaude — только текст Tesseract с пометкой «часть страниц — чертежи, текст
 * неполный», без ошибки. Ошибка — с этапом: «растеризация», «распознавание», «модель».
 */

export const MAX_PDF_PAGES = 20;
export const MAX_MODEL_PAGES = 8;
export const PDF_DPI = 200;
const RASTER_TIMEOUT_MS = 60_000;
const TESSERACT_TIMEOUT_MS = 60_000;
const MODEL_TIMEOUT_MS = 90_000;
const MODEL_MAX_TOKENS = 4000;

const MODEL_SYSTEM = `Ты распознаёшь страницу документа компании «РФ-Двери» (двери, проёмы, спецификации, чертежи, сметы, счета) по изображению. Перепиши весь текст и все размеры со страницы как есть, ничего не придумывай. Изделия на чертежах опиши словами (тип, размеры, количество, маркировка). Таблицы передай строками: ячейки через « | ». Если на странице нет текста и размеров — напиши «(на странице нет текста)».`;

/** Как isMeaningful в extract.ts (@core/docs, не трогаем): ≥ 5 слов из 3+ букв и ≥ 15 % токенов. */
export function isMeaningful(text: string): boolean {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 5) return false;
  const words = tokens.filter((t) => /^[\p{L}]{3,}$/u.test(t));
  return words.length >= 5 && words.length / tokens.length >= 0.15;
}

export interface ExecLike {
  (cmd: string, args: string[], opts: { timeoutMs: number; cwd?: string }): Promise<{ stdout: string }>;
}

/** Минимум от tesseract.js (подменяется в тестах). */
export interface TesseractWorkerLike {
  recognize(image: Buffer, options?: Record<string, unknown>, output?: Record<string, boolean>): Promise<{
    data: { text: string; blocks?: { paragraphs: { lines: { text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }[] }[] }[] | null };
  }>;
  terminate(): Promise<unknown>;
}

export interface RetailOcrDeps {
  /** Модель аккаунта (ключ с вкладки «Модель»); null — страницы-чертежи остаются с пометкой. */
  llmFor: (accountId: number) => Promise<LlmClient | LlmGateway | null>;
  exec?: ExecLike;
  tesseract?: () => Promise<TesseractWorkerLike>;
  tmpDir?: string;
}

interface PageText {
  n: number;
  text: string;
  tables: string[];
  byModel: boolean;
}

export class RetailOcr implements OcrProvider {
  readonly name = 'retail';
  private worker: Promise<TesseractWorkerLike> | null = null;
  private readonly exec: ExecLike;
  private readonly factory: () => Promise<TesseractWorkerLike>;

  constructor(private readonly d: RetailOcrDeps) {
    this.exec = d.exec ?? defaultExec;
    this.factory = d.tesseract ?? defaultTesseract;
  }

  async recognize(bytes: Uint8Array, mime: string): Promise<OcrResult> {
    const m = mime.toLowerCase().split(';')[0]?.trim() ?? '';
    if (m === 'application/pdf') return this.recognizePdf(bytes);
    if (/^image\/(jpe?g|png|webp|bmp)$/.test(m)) {
      const page = await this.recognizeImage(Buffer.from(bytes), 1);
      return this.result([page], []);
    }
    if (/^image\/(heic|heif|tiff?)$/.test(m)) {
      const pages = await this.withTmp(async (dir) => {
        const ext = m.includes('tif') ? 'tif' : 'heic';
        await writeFile(join(dir, `in.${ext}`), bytes);
        const pngs = await this.convertImage(dir, `in.${ext}`);
        const out: PageText[] = [];
        for (const [i, png] of pngs.entries()) out.push(await this.recognizeImage(png, i + 1));
        return out;
      });
      return this.result(pages, []);
    }
    throw new OcrError(`распознавание: формат ${mime || 'неизвестен'} не поддерживается`);
  }

  private async recognizePdf(bytes: Uint8Array): Promise<OcrResult> {
    return this.withTmp(async (dir) => {
      await writeFile(join(dir, 'in.pdf'), bytes);
      const total = await this.pageCount(dir);
      const pngs = await this.rasterize(dir, Math.min(total ?? MAX_PDF_PAGES, MAX_PDF_PAGES));
      const notes: string[] = [];
      if (total && total > MAX_PDF_PAGES) notes.push(`страницы ${MAX_PDF_PAGES + 1}–${total} не распознаны (лимит ${MAX_PDF_PAGES} страниц на файл)`);
      const pages: PageText[] = [];
      let modelPages = 0;
      let modelSkipped = 0;
      for (const [i, png] of pngs.entries()) {
        const n = i + 1;
        const page = await this.recognizeImage(png, n);
        if (isMeaningful(page.text)) {
          pages.push(page);
          continue;
        }
        // Чертёж, схема, таблица с рамками: Tesseract дал мало текста — страница картинкой в модель (не больше 8 на файл).
        if (modelPages < MAX_MODEL_PAGES) {
          const byModel = await this.recognizeByModel(png, n);
          if (byModel) {
            modelPages++;
            pages.push({ ...byModel, text: byModel.text ? `${page.text.trim() ? `${page.text.trim()}\n` : ''}${byModel.text}` : page.text });
            continue;
          }
        }
        modelSkipped++;
        pages.push(page);
      }
      if (modelPages) notes.push(`страницы ${pages.filter((p) => p.byModel).map((p) => p.n).join(', ')} распознаны моделью по изображению`);
      if (modelSkipped) notes.push('часть страниц — чертежи, текст неполный');
      return this.result(pages, notes);
    });
  }

  /** Tesseract по картинке → строки по положению (layoutPage из @core/docs). */
  private async recognizeImage(png: Buffer, n: number): Promise<PageText> {
    const worker = await this.getWorker();
    let data: Awaited<ReturnType<TesseractWorkerLike['recognize']>>['data'];
    try {
      ({ data } = await withTimeout(worker.recognize(png, {}, { text: true, blocks: true }), TESSERACT_TIMEOUT_MS, `Tesseract: страница ${n} не распозналась за ${TESSERACT_TIMEOUT_MS / 1000} с`));
    } catch (err) {
      throw err instanceof OcrError ? err : new OcrError(`распознавание: ${(err as Error).message}`);
    }
    const annotation: TextAnnotation = {
      fullText: data.text,
      blocks: (data.blocks ?? []).map((b) => ({
        lines: b.paragraphs.flatMap((p) => p.lines.map((l) => ({ text: l.text, boundingBox: { vertices: [{ x: l.bbox.x0, y: l.bbox.y0 }, { x: l.bbox.x1, y: l.bbox.y0 }, { x: l.bbox.x1, y: l.bbox.y1 }, { x: l.bbox.x0, y: l.bbox.y1 }] } }))),
      })),
    };
    const page: OcrPage = layoutPage(annotation);
    return { n, text: page.text, tables: page.tables, byModel: false };
  }

  /** Страница картинкой в модель аккаунта: нужен контекст (RetailDocuments), vision.photosToClaude и модель с поддержкой изображений. */
  private async recognizeByModel(png: Buffer, n: number): Promise<PageText | null> {
    const ctx = ocrContext.getStore();
    if (!ctx || !ctx.settings.vision.photosToClaude) return null;
    const llm = await this.d.llmFor(ctx.accountId).catch(() => null);
    if (!llm) return null;
    const base = ctx.route ?? resolveRoute(ctx.settings);
    const route = modelTraits(base.primary.provider, base.primary.model).vision ? base : base.fallback && modelTraits(base.fallback.provider, base.fallback.model).vision ? { primary: base.fallback, fallback: null } : null;
    if (!route) return null;
    try {
      const res = await withTimeout(
        asGateway(llm).chat(
          {
            system: [{ text: MODEL_SYSTEM, cache: true }],
            messages: [{ role: 'user', content: [{ type: 'image', image: { mime: 'image/png', data: png.toString('base64') } }, { type: 'text', text: `Страница ${n}. Перепиши весь текст и размеры, опиши изделия, таблицы — строками.` }] }],
            maxTokens: MODEL_MAX_TOKENS,
            effort: 'low',
          },
          route,
        ),
        MODEL_TIMEOUT_MS,
        `модель: страница ${n} не распознана за ${MODEL_TIMEOUT_MS / 1000} с`,
      );
      const u = costOfUsage({ provider: res.provider, model: res.model }, res.usage, ctx.settings.billing.pricing);
      ctx.cost.usd += u.usd;
      ctx.cost.inputTokens += u.inputTokens;
      ctx.cost.outputTokens += u.outputTokens;
      ctx.cost.pages++;
      const text = (res.text ?? '').trim();
      return { n, text: text && text !== '(на странице нет текста)' ? text : '', tables: [], byModel: true };
    } catch (err) {
      throw new OcrError(`модель: ${(err as Error).message}`);
    }
  }

  private result(pages: PageText[], notes: string[]): OcrResult {
    const ctx = ocrContext.getStore();
    if (ctx) ctx.notes.push(...notes);
    const multi = pages.length > 1;
    const text = [...pages.map((p) => (multi ? `--- страница ${p.n}${p.byModel ? ' (распознано моделью по изображению)' : ''} ---\n${p.text}` : p.text)), ...notes.map((x) => `(${x})`)].filter((x) => x.trim()).join('\n');
    return { provider: this.name, pages: pages.map((p) => ({ text: p.text, tables: p.tables })), text };
  }

  private async pageCount(dir: string): Promise<number | null> {
    try {
      const { stdout } = await this.exec('pdfinfo', ['in.pdf'], { timeoutMs: 15_000, cwd: dir });
      const m = /^Pages:\s+(\d+)/m.exec(stdout);
      return m ? Number(m[1]) : null;
    } catch {
      return null;
    }
  }

  /** pdftoppm -r 200 -png -f 1 -l N in.pdf page → page-1.png … (poppler-utils). */
  private async rasterize(dir: string, last: number): Promise<Buffer[]> {
    try {
      await this.exec('pdftoppm', ['-r', String(PDF_DPI), '-png', '-f', '1', '-l', String(last), 'in.pdf', 'page'], { timeoutMs: RASTER_TIMEOUT_MS, cwd: dir });
    } catch (err) {
      throw new OcrError(`растеризация: ${describeExecError(err, 'pdftoppm')}`);
    }
    const files = (await readdir(dir)).filter((f) => /^page-\d+\.png$/.test(f)).sort((a, b) => pageNo(a) - pageNo(b));
    if (!files.length) throw new OcrError('растеризация: pdftoppm не дал ни одной страницы');
    return Promise.all(files.map((f) => readFile(join(dir, f))));
  }

  /** HEIC / HEIF / TIFF → PNG через ImageMagick (imagemagick, imagemagick-heic); TIFF многостраничный — по файлу на страницу. */
  private async convertImage(dir: string, name: string): Promise<Buffer[]> {
    try {
      await this.exec('magick', [name, 'conv-%03d.png'], { timeoutMs: RASTER_TIMEOUT_MS, cwd: dir });
    } catch (err) {
      throw new OcrError(`растеризация: ${describeExecError(err, 'magick')}`);
    }
    const files = (await readdir(dir)).filter((f) => /^conv-\d+\.png$/.test(f)).sort();
    if (!files.length) throw new OcrError('растеризация: ImageMagick не дал ни одной страницы');
    return Promise.all(files.map((f) => readFile(join(dir, f))));
  }

  private async withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(this.d.tmpDir ?? tmpdir(), 'retail-ocr-'));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Один воркер на процесс — языковые данные rus+eng грузятся секунды. */
  private getWorker(): Promise<TesseractWorkerLike> {
    this.worker ??= this.factory().catch((err: unknown) => {
      this.worker = null;
      throw new OcrError(`распознавание: Tesseract не запустился: ${(err as Error).message}`);
    });
    return this.worker;
  }

  async close(): Promise<void> {
    const w = await this.worker?.catch(() => null);
    await w?.terminate();
    this.worker = null;
  }
}

const pageNo = (f: string) => Number(/(\d+)\.png$/.exec(f)?.[1] ?? 0);

function describeExecError(err: unknown, cmd: string): string {
  const e = err as { code?: string; killed?: boolean; signal?: string; message?: string; stderr?: string };
  if (e.code === 'ENOENT') return `${cmd} не установлен в образе`;
  if (e.killed || e.signal === 'SIGTERM') return `${cmd} не уложился в ${RASTER_TIMEOUT_MS / 1000} с`;
  return `${cmd}: ${(e.stderr ?? '').trim() || e.message || 'ошибка'}`.slice(0, 300);
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new OcrError(message)), ms);
    p.then((v) => (clearTimeout(t), resolve(v)), (e: unknown) => (clearTimeout(t), reject(e as Error)));
  });
}

const defaultExec: ExecLike = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeoutMs, cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve({ stdout: String(stdout) });
    });
  });

async function defaultTesseract(): Promise<TesseractWorkerLike> {
  const { createWorker } = await import('tesseract.js');
  // Языковые данные скачиваются один раз в TESSERACT_CACHE_PATH (по умолчанию — рабочий каталог процесса).
  const cachePath = process.env.TESSERACT_CACHE_PATH;
  const worker = await createWorker(['rus', 'eng'], undefined, cachePath ? { cachePath } : {});
  return worker as unknown as TesseractWorkerLike;
}
