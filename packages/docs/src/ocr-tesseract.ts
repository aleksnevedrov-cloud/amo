import { layoutPage, OcrError, type OcrProvider, type OcrResult, type TextAnnotation } from './ocr.ts';

/** Минимум от tesseract.js, который нам нужен (чтобы подменять в тестах). */
export interface TesseractWorkerLike {
  recognize(image: Buffer, options?: Record<string, unknown>, output?: Record<string, boolean>): Promise<{
    data: { text: string; blocks?: { paragraphs: { lines: { text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }[] }[] }[] | null };
  }>;
  terminate(): Promise<unknown>;
}

export type TesseractWorkerFactory = () => Promise<TesseractWorkerLike>;

/**
 * Запасной OCR — Tesseract (tesseract.js, WASM), работает на нашем сервере без внешних сервисов и ключей.
 * Хуже Yandex Vision на рукописном тексте и фото, но бесплатен и данные не покидают сервер.
 * Только картинки: сканы PDF без текстового слоя требуют растеризации, которой здесь нет.
 */
export class TesseractOcr implements OcrProvider {
  readonly name = 'tesseract';
  private worker: Promise<TesseractWorkerLike> | null = null;

  constructor(private readonly factory: TesseractWorkerFactory = defaultFactory) {}

  async recognize(bytes: Uint8Array, mime: string): Promise<OcrResult> {
    const m = mime.toLowerCase().split(';')[0]?.trim() ?? '';
    if (m === 'application/pdf') throw new OcrError('Tesseract: скан PDF без текста распознаётся только через Yandex Vision');
    if (!/^image\/(jpe?g|png|webp|bmp)$/.test(m)) throw new OcrError(`Tesseract: формат ${mime || 'неизвестен'} не поддерживается`);
    const worker = await this.getWorker();
    const { data } = await worker.recognize(Buffer.from(bytes), {}, { text: true, blocks: true });
    const annotation: TextAnnotation = {
      fullText: data.text,
      blocks: (data.blocks ?? []).map((b) => ({
        lines: b.paragraphs.flatMap((p) =>
          p.lines.map((l) => ({
            text: l.text,
            boundingBox: { vertices: [{ x: l.bbox.x0, y: l.bbox.y0 }, { x: l.bbox.x1, y: l.bbox.y0 }, { x: l.bbox.x1, y: l.bbox.y1 }, { x: l.bbox.x0, y: l.bbox.y1 }] },
          })),
        ),
      })),
    };
    const page = layoutPage(annotation);
    return { provider: this.name, pages: [page], text: page.text };
  }

  /** Один воркер на процесс — загрузка языковых данных (rus+eng) занимает секунды. */
  private getWorker(): Promise<TesseractWorkerLike> {
    this.worker ??= this.factory().catch((err: unknown) => {
      this.worker = null;
      throw new OcrError(`Tesseract не запустился: ${(err as Error).message}`);
    });
    return this.worker;
  }

  async close(): Promise<void> {
    const w = await this.worker?.catch(() => null);
    await w?.terminate();
    this.worker = null;
  }
}

async function defaultFactory(): Promise<TesseractWorkerLike> {
  const { createWorker } = await import('tesseract.js');
  // Языковые данные скачиваются один раз в TESSERACT_CACHE_PATH (по умолчанию — рабочий каталог процесса).
  const cachePath = process.env.TESSERACT_CACHE_PATH;
  const worker = await createWorker(['rus', 'eng'], undefined, cachePath ? { cachePath } : {});
  return worker as unknown as TesseractWorkerLike;
}
