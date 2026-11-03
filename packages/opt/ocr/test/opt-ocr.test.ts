// RFD-AI-AGENT-OPT-DEAL-FILES, часть А: собственное распознавание опта без сети и бинарников — pdftoppm / pdfinfo / magick и Tesseract
// подменяются: «растеризация» кладёт PNG-заглушки с текстом страницы, «Tesseract» читает его из байтов, модель — заглушка.
import { readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { widgetSettingsSchema } from '@core/db';
import type { LlmGateway, RoutedResponse } from '@core/llm';
import { describe, expect, it, vi } from 'vitest';
import { isMeaningful, MAX_PDF_PAGES, ocrContext, OptDocuments, OptOcr, withOcrContext, type ExecLike, type OcrContext, type TesseractWorkerLike } from '../src/index.ts';

/** Фикстура «PDF»: страницы — строки; «скан» — текст, который якобы увидит Tesseract на растре. */
const pdfOf = (pages: string[]) => new TextEncoder().encode(`%PDF-FAKE\n${JSON.stringify(pages)}`);
const pagesOf = (bytes: Uint8Array): string[] => JSON.parse(new TextDecoder().decode(bytes).split('\n')[1] ?? '[]') as string[];
const MEANINGFUL = 'Дверь входная стальная Торэкс Дельта 900 на 2050 правая открывание наружу';
const GARBAGE = '| __ -- 12 ._ \\\\ 900 2100 ~~ |';

function fakes() {
  const calls: { cmd: string; args: string[] }[] = [];
  const exec: ExecLike = async (cmd, args, opts) => {
    calls.push({ cmd, args });
    const dir = opts.cwd ?? tmpdir();
    if (cmd === 'pdfinfo') {
      const bytes = new Uint8Array(await import('node:fs/promises').then((fs) => fs.readFile(join(dir, 'in.pdf'))));
      return { stdout: `Title: x\nPages: ${pagesOf(bytes).length}\n` };
    }
    if (cmd === 'pdftoppm') {
      const last = Number(args[args.indexOf('-l') + 1]);
      const bytes = new Uint8Array(await import('node:fs/promises').then((fs) => fs.readFile(join(dir, 'in.pdf'))));
      pagesOf(bytes).slice(0, last).forEach((text, i) => writeFileSync(join(dir, `page-${i + 1}.png`), `PNG:${text}`));
      return { stdout: '' };
    }
    if (cmd === 'magick') {
      const src = new TextDecoder().decode(await import('node:fs/promises').then((fs) => fs.readFile(join(dir, args[0] ?? ''))));
      const pages = src.startsWith('HEIC:') ? [src.slice(5)] : src.startsWith('TIFF:') ? src.slice(5).split('|') : [src];
      pages.forEach((text, i) => writeFileSync(join(dir, `conv-${String(i).padStart(3, '0')}.png`), `PNG:${text}`));
      return { stdout: '' };
    }
    throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });
  };
  const tess = { calls: 0, terminated: false };
  const worker: TesseractWorkerLike = {
    async recognize(image) {
      tess.calls++;
      const text = image.toString().replace(/^PNG:/, '');
      return { data: { text, blocks: text ? [{ paragraphs: [{ lines: [{ text, bbox: { x0: 10, y0: 10, x1: 500, y1: 30 } }] }] }] : [] } };
    },
    async terminate() {
      tess.terminated = true;
    },
  };
  const llm = { calls: [] as { pages: number; images: number }[] };
  const gateway: LlmGateway = {
    async chat(req, r) {
      const content = req.messages[0]?.content;
      const images = Array.isArray(content) ? content.filter((p) => p.type === 'image').length : 0;
      llm.calls.push({ pages: 1, images });
      const text = 'Чертёж: дверь ДПС 01 2100×900 левая — 2 шт; дверь ДПС 02 2100×1200 двупольная — 1 шт';
      return { text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 1800, outputTokens: 120, cachedInputTokens: 0, cacheWriteTokens: 0 }, provider: r.primary.provider, model: r.primary.model, assistantMessage: { role: 'assistant', content: text }, latencyMs: 1, fallbackUsed: false, requested: r.primary, attempts: [] } as unknown as RoutedResponse;
    },
    providers: async () => ['anthropic'],
    provider: async () => null,
  };
  const ocr = new OptOcr({ llmFor: async () => gateway, exec, tesseract: async () => worker, tmpDir: tmpdir() });
  return { ocr, calls, tess, llm, gateway };
}

/** Контекст опта: маршрут модели — как resolveOptRoute (модель с поддержкой изображений из настроек по умолчанию). */
const ctxOf = (photosToClaude = true, withRoute = true): OcrContext => {
  const settings = widgetSettingsSchema.parse({ vision: { photosToClaude } });
  return { accountId: 1, settings, route: withRoute ? { primary: { provider: settings.model.provider, model: settings.model.model }, fallback: null } : null, cost: { usd: 0, inputTokens: 0, outputTokens: 0, pages: 0 }, notes: [] };
};
const inCtx = <T,>(ctx: OcrContext, fn: () => Promise<T>) => ocrContext.run(ctx, fn);

describe('OptOcr (RFD-AI-AGENT-OPT-DEAL-FILES, часть А)', () => {
  it('критерий «мало текста» — как isMeaningful в extract.ts', () => {
    expect(isMeaningful(MEANINGFUL)).toBe(true);
    expect(isMeaningful(GARBAGE)).toBe(false);
    expect(isMeaningful('')).toBe(false);
  });

  it('PDF-скан из 2 страниц: pdftoppm вызван один раз с -r 200, Tesseract — 2 раза, текст по страницам; модель не нужна', async () => {
    const f = fakes();
    const r = await inCtx(ctxOf(), () => f.ocr.recognize(pdfOf([MEANINGFUL, `${MEANINGFUL} страница два`]), 'application/pdf'));
    expect(r.provider).toBe('opt');
    expect(r.pages).toHaveLength(2);
    expect(r.text).toBe(`--- страница 1 ---\n${MEANINGFUL}\n--- страница 2 ---\n${MEANINGFUL} страница два`);
    expect(f.calls.filter((c) => c.cmd === 'pdftoppm')).toHaveLength(1);
    expect(f.calls.find((c) => c.cmd === 'pdftoppm')?.args).toEqual(['-r', '200', '-png', '-f', '1', '-l', '2', 'in.pdf', 'page']);
    expect(f.tess.calls).toBe(2);
    expect(f.llm.calls).toHaveLength(0);
  });

  it('скан чертежа: Tesseract дал мусор → страница ушла в модель картинкой, текст модели в результате, расход — в контекст', async () => {
    const f = fakes();
    const ctx = ctxOf();
    const r = await inCtx(ctx, () => f.ocr.recognize(pdfOf([MEANINGFUL, GARBAGE]), 'application/pdf'));
    expect(f.llm.calls).toEqual([{ pages: 1, images: 1 }]);
    expect(r.text).toContain('--- страница 2 (распознано моделью по изображению) ---');
    expect(r.text).toContain('дверь ДПС 01 2100×900 левая — 2 шт');
    expect(r.text).toContain(GARBAGE.trim()); // подсказка Tesseract остаётся над текстом модели
    expect(r.text).toContain('(страницы 2 распознаны моделью по изображению)');
    expect(ctx.cost).toMatchObject({ pages: 1, inputTokens: 1800, outputTokens: 120 });
    expect(ctx.cost.usd).toBeGreaterThan(0);
    expect(ctx.notes).toEqual(['страницы 2 распознаны моделью по изображению']);
  });

  it('PDF на 30 страниц: распознаны 20, пометка про 21–30; в модель — не больше 8 страниц', async () => {
    const f = fakes();
    const r = await inCtx(ctxOf(), () => f.ocr.recognize(pdfOf(Array.from({ length: 30 }, () => GARBAGE)), 'application/pdf'));
    expect(r.pages).toHaveLength(MAX_PDF_PAGES);
    expect(f.tess.calls).toBe(20);
    expect(f.llm.calls).toHaveLength(8);
    expect(r.text).toContain('(страницы 21–30 не распознаны (лимит 20 страниц на файл))');
    expect(r.text).toContain('(часть страниц — чертежи, текст неполный)');
  });

  it('JPG с текстом — только Tesseract, модель не вызвана, pdftoppm не нужен', async () => {
    const f = fakes();
    const r = await inCtx(ctxOf(), () => f.ocr.recognize(new TextEncoder().encode(`PNG:${MEANINGFUL}`), 'image/jpeg'));
    expect(r.text).toBe(MEANINGFUL);
    expect(f.tess.calls).toBe(1);
    expect(f.llm.calls).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  });

  it('HEIC → PNG через ImageMagick и распознан; TIFF многостраничный — по странице', async () => {
    const f = fakes();
    const heic = await f.ocr.recognize(new TextEncoder().encode(`HEIC:${MEANINGFUL}`), 'image/heic');
    expect(heic.text).toBe(MEANINGFUL);
    expect(f.calls.map((c) => [c.cmd, c.args[0]])).toEqual([['magick', 'in.heic']]);
    const tiff = await f.ocr.recognize(new TextEncoder().encode(`TIFF:${MEANINGFUL}|${MEANINGFUL} лист два`), 'image/tiff');
    expect(tiff.pages).toHaveLength(2);
    expect(tiff.text).toContain('--- страница 2 ---');
    expect(f.tess.calls).toBe(3);
  });

  it('photosToClaude = false, нет маршрута или модели → модель не вызвана, текст Tesseract с пометкой «текст неполный», без ошибки; вне контекста — то же', async () => {
    const f = fakes();
    const r = await inCtx(ctxOf(false), () => f.ocr.recognize(pdfOf([MEANINGFUL, GARBAGE]), 'application/pdf'));
    expect(f.llm.calls).toHaveLength(0);
    expect(r.text).toContain('(часть страниц — чертежи, текст неполный)');
    expect(r.text).toContain(`--- страница 1 ---\n${MEANINGFUL}`);
    const noRoute = await inCtx(ctxOf(true, false), () => f.ocr.recognize(pdfOf([GARBAGE]), 'application/pdf'));
    expect(f.llm.calls).toHaveLength(0);
    expect(noRoute.text).toContain('(часть страниц — чертежи, текст неполный)');
    const noLlm = new OptOcr({ llmFor: async () => null, exec: fakes().ocr['exec' as never] as unknown as ExecLike, tesseract: async () => fakes().ocr['factory' as never] as never });
    expect(noLlm.name).toBe('opt');
    const outside = await f.ocr.recognize(pdfOf([GARBAGE]), 'application/pdf');
    expect(outside.text).toContain('(часть страниц — чертежи, текст неполный)');
  });

  it('DEAL-FILES-2: растры страниц копятся в контексте (до 8) для второго прохода по чертежу, ход по страницам — через onPage; картинка — одна страница', async () => {
    const f = fakes();
    const ctx = { ...ctxOf(false), pages: [] as Buffer[], onPage: vi.fn() };
    await inCtx(ctx, () => f.ocr.recognize(pdfOf(Array.from({ length: 10 }, (_, i) => `${MEANINGFUL} ${i}`)), 'application/pdf'));
    expect(ctx.pages).toHaveLength(8);
    expect(ctx.pages[0]?.toString()).toBe(`PNG:${MEANINGFUL} 0`);
    expect(ctx.onPage).toHaveBeenCalledTimes(10);
    expect(ctx.onPage).toHaveBeenNthCalledWith(1, { page: 1, pages: 10, byModel: false });
    const img = { ...ctxOf(false), pages: [] as Buffer[] };
    await inCtx(img, () => f.ocr.recognize(new TextEncoder().encode(`PNG:${MEANINGFUL}`), 'image/jpeg'));
    expect(img.pages).toHaveLength(1);
  });

  it('ошибки с этапом: pdftoppm не установлен → «растеризация: …»; временный каталог убран', async () => {
    const f = fakes();
    const dir = tmpdir();
    const before = readdirSync(dir).filter((x) => x.startsWith('opt-ocr-')).length;
    const broken = new OptOcr({ llmFor: async () => null, exec: async (cmd) => (cmd === 'pdfinfo' ? { stdout: 'Pages: 1\n' } : Promise.reject(Object.assign(new Error('spawn pdftoppm ENOENT'), { code: 'ENOENT' }))), tesseract: async () => ({ recognize: async () => ({ data: { text: '' } }), terminate: async () => undefined }), tmpDir: dir });
    await expect(broken.recognize(pdfOf([MEANINGFUL]), 'application/pdf')).rejects.toThrow('растеризация: pdftoppm не установлен в образе');
    expect(readdirSync(dir).filter((x) => x.startsWith('opt-ocr-')).length).toBe(before);
    await expect(f.ocr.recognize(new Uint8Array([1]), 'application/zip')).rejects.toThrow('распознавание: формат application/zip не поддерживается');
  });

  it('OptDocuments: контекст аккаунта на время analyze, расход модели на распознавание добавлен к costUsd результата; withOcrContext — то же для базы знаний', async () => {
    const f = fakes();
    const seen: unknown[] = [];
    const inner = {
      async analyze(input: { accountId: number; bytes: Uint8Array; mime: string }) {
        const r = await f.ocr.recognize(input.bytes, input.mime);
        seen.push(ocrContext.getStore()?.accountId);
        return { id: 1, kind: 'request', text: r.text, note: '', memoryOpenings: [], costUsd: 0.01, model: 'm', provider: 'anthropic' } as never;
      },
    };
    const docs = new OptDocuments(inner as never);
    const settings = widgetSettingsSchema.parse({});
    const route = { primary: { provider: settings.model.provider, model: settings.model.model }, fallback: null };
    const r = await docs.analyze({ accountId: 42, leadId: null, source: 'widget', filename: 'чертёж.pdf', mime: 'application/pdf', bytes: pdfOf([GARBAGE]), settings, route } as never);
    expect(seen).toEqual([42]);
    expect(f.llm.calls).toHaveLength(1);
    expect(r.costUsd).toBeGreaterThan(0.01);
    expect(r.text).toContain('дверь ДПС 01');
    expect(ocrContext.getStore()).toBeUndefined();
    // База знаний: провайдер с контекстом аккаунта — скан прайса с чертежом тоже уходит в модель.
    const kb = withOcrContext(f.ocr, () => ({ accountId: 7, settings, route, cost: { usd: 0, inputTokens: 0, outputTokens: 0, pages: 0 }, notes: [] }));
    expect(kb.name).toBe('opt');
    const scan = await kb.recognize(pdfOf([MEANINGFUL, GARBAGE]), 'application/pdf');
    expect(f.llm.calls).toHaveLength(2);
    expect(scan.text).toContain('(распознано моделью по изображению)');
  });
});
