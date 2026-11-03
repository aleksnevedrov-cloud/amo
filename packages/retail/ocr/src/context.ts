import { AsyncLocalStorage } from 'node:async_hooks';
import type { WidgetSettings } from '@core/db';
import type { AnalyzeFileInput, DocumentResult } from '@core/docs';
import type { ChatRoute } from '@core/llm';

/**
 * RFD-AI-AGENT-RETAIL-OCR: контекст разбора для собственного распознавания розницы. DocumentService (@core/docs, не трогаем)
 * вызывает OCR без аккаунта и настроек, а RetailOcr для страниц-чертежей нужна модель аккаунта (ключ с вкладки «Модель») и
 * флаг vision.photosToClaude. Обёртка RetailDocuments кладёт их в AsyncLocalStorage на время analyze() и добавляет расход
 * модели на распознавание к costUsd результата — он попадает в журнал разбора, как сейчас.
 */
export interface OcrContext {
  accountId: number;
  settings: WidgetSettings;
  route: ChatRoute | null;
  /** Расход модели на распознавание страниц (суммируется RetailOcr). */
  cost: { usd: number; inputTokens: number; outputTokens: number; pages: number };
  /** Пометки о распознавании (какие страницы ушли в модель, что не распознано) — в журнал. */
  notes: string[];
}

export const ocrContext = new AsyncLocalStorage<OcrContext>();

export interface DocumentsLike {
  analyze(input: AnalyzeFileInput): Promise<DocumentResult>;
}

/** DocumentService с контекстом аккаунта для RetailOcr; наружу — тот же analyze(). */
export class RetailDocuments implements DocumentsLike {
  constructor(private readonly inner: DocumentsLike) {}

  async analyze(input: AnalyzeFileInput): Promise<DocumentResult> {
    const ctx: OcrContext = { accountId: input.accountId, settings: input.settings, route: input.route ?? null, cost: { usd: 0, inputTokens: 0, outputTokens: 0, pages: 0 }, notes: [] };
    return ocrContext.run(ctx, async () => {
      const r = await this.inner.analyze(input);
      return ctx.cost.usd || ctx.cost.pages ? { ...r, costUsd: r.costUsd + ctx.cost.usd } : r;
    });
  }
}
