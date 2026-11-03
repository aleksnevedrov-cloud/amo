import { AsyncLocalStorage } from 'node:async_hooks';
import type { WidgetSettings } from '@core/db';
import type { AnalyzeFileInput, DocumentResult, OcrProvider, OcrResult } from '@core/docs';
import type { ChatRoute } from '@core/llm';

/**
 * RFD-AI-AGENT-OPT-DEAL-FILES, часть А: контекст разбора для собственного распознавания опта. DocumentService (@core/docs,
 * не трогаем) вызывает OCR без аккаунта и настроек, а OptOcr для страниц-чертежей нужна модель аккаунта опта (маршрут
 * resolveOptRoute, ключ OpenAI с вкладки «Модель») и флаг vision.photosToClaude. Обёртка OptDocuments кладёт их в
 * AsyncLocalStorage на время analyze() и добавляет расход модели на распознавание к costUsd результата — он попадает в
 * журнал разбора опта, как сейчас. Для базы знаний (extractForKb зовёт OCR напрямую) — withOcrContext.
 */
export interface OcrContext {
  accountId: number;
  settings: WidgetSettings;
  /** Маршрут модели опта; null — страницы-чертежи в модель не уходят. */
  route: ChatRoute | null;
  /** Расход модели на распознавание страниц (суммируется OptOcr). */
  cost: { usd: number; inputTokens: number; outputTokens: number; pages: number };
  /** Пометки о распознавании (какие страницы ушли в модель, что не распознано). */
  notes: string[];
  /**
   * DEAL-FILES-2, 2.3: растры страниц (PNG, до MAX_MODEL_PAGES) — для второго прохода по чертежу без повторной растеризации;
   * OptDocuments отдаёт их в результате analyze как ocrPages.
   */
  pages?: Buffer[];
  /** DEAL-FILES-2, 2.5: ход распознавания по страницам (индикатор сборки). */
  onPage?: (p: { page: number; pages: number; byModel: boolean }) => void;
}

export const ocrContext = new AsyncLocalStorage<OcrContext>();

export const emptyOcrCost = (): OcrContext['cost'] => ({ usd: 0, inputTokens: 0, outputTokens: 0, pages: 0 });

/** DEAL-FILES-2, 2.5: хук хода распознавания на время сборки черновика (OptDocuments копирует его в контекст каждого файла). */
export const ocrProgress = new AsyncLocalStorage<{ onPage: NonNullable<OcrContext['onPage']> }>();

/** Результат analyze с растрами страниц скана (для второго прохода по чертежу). */
export type DocumentResultWithPages = DocumentResult & { ocrPages?: Buffer[] };

export interface DocumentsLike {
  analyze(input: AnalyzeFileInput): Promise<DocumentResult>;
}

/** DocumentService с контекстом аккаунта для OptOcr; наружу — тот же analyze(). */
export class OptDocuments implements DocumentsLike {
  constructor(private readonly inner: DocumentsLike) {}

  async analyze(input: AnalyzeFileInput): Promise<DocumentResultWithPages> {
    const progress = ocrProgress.getStore();
    const ctx: OcrContext = { accountId: input.accountId, settings: input.settings, route: input.route ?? null, cost: emptyOcrCost(), notes: [], pages: [], ...(progress ? { onPage: progress.onPage } : {}) };
    return ocrContext.run(ctx, async () => {
      const r = await this.inner.analyze(input);
      const out: DocumentResultWithPages = ctx.cost.usd || ctx.cost.pages ? { ...r, costUsd: r.costUsd + ctx.cost.usd } : { ...r };
      if (ctx.pages?.length) out.ocrPages = ctx.pages;
      return out;
    });
  }
}

/** OCR-провайдер, который распознаёт в заданном контексте аккаунта (база знаний опта: сканы прайсов). */
export function withOcrContext(provider: OcrProvider, ctx: () => OcrContext): OcrProvider {
  return {
    name: provider.name,
    recognize: (bytes: Uint8Array, mime: string): Promise<OcrResult> => ocrContext.run(ctx(), () => provider.recognize(bytes, mime)),
  };
}
