import { asGateway, type AccountAi } from '@ai-door/agent';
import type { EvalRunsRepo, LlmModelRef } from '@ai-door/db';
import { pricingRulesSchema } from '@ai-door/pricing';
import { dialogSchema, runDialog, summarize, withoutComment, type Dialog, type DialogReport, type EvalSummary } from '@ai-door/evals';
import dialogsFixture from '@ai-door/evals/dialogs' with { type: 'json' };
import { type EvalFixtures, pricingRulesFixture } from '@ai-door/evals/seed';
import { widgetSettingsSchema, type WidgetSettings } from '@ai-door/db';

/** Все эталонные диалоги eval-набора (evals/dialogs.json). */
export const EVAL_DIALOGS: Dialog[] = ((dialogsFixture as { dialogs: unknown[] }).dialogs ?? []).map((d) => dialogSchema.parse(d));

export interface EvalModelResult {
  ref: LlmModelRef;
  reports: DialogReport[];
  summary: EvalSummary | null;
  error?: string;
}

export interface EvalRunDeps {
  evalRuns: EvalRunsRepo;
  fixtures(): Promise<EvalFixtures>;
  ai: AccountAi;
  settings: WidgetSettings;
  log?: { info(o: unknown, msg: string): void; error(o: unknown, msg: string): void };
}

const pricing = pricingRulesSchema.parse(withoutComment(pricingRulesFixture as Record<string, unknown>));

/**
 * Прогон eval-набора на выбранных моделях (раздел 7 ТЗ 1.1.0). Каталог и база знаний — тестовые, во временной схеме;
 * ответы клиенту не уходят, CRM — песочница. Результаты по мере выполнения пишутся в eval_runs.
 */
export async function runEvalSet(d: EvalRunDeps, accountId: number, runId: number, models: LlmModelRef[], dialogIds: string[]): Promise<void> {
  const dialogs = dialogIds.length ? EVAL_DIALOGS.filter((x) => dialogIds.includes(x.id)) : EVAL_DIALOGS;
  const results: EvalModelResult[] = models.map((ref) => ({ ref, reports: [], summary: null }));
  let fixtures: EvalFixtures | null = null;
  try {
    const fx = await d.fixtures();
    fixtures = fx;
    const settings = widgetSettingsSchema.parse({ ...d.settings, enabled: true, mode: 'auto' });
    const fallback = settings.model.fallbackModel ? { provider: settings.model.fallbackProvider ?? settings.model.provider, model: settings.model.fallbackModel } : null;
    const llm = asGateway(d.ai.llm);
    for (const dialog of dialogs) {
      // Одна и та же реплика на всех моделях параллельно (провайдеры разные — лимиты не мешают).
      await Promise.all(
        results.map(async (r) => {
          if (r.error) return;
          try {
            const report = await runDialog(dialog, {
              accountId: 1,
              catalog: fx.catalog,
              knowledge: fx.knowledge,
              llm,
              route: { primary: r.ref, fallback: fallback && (fallback.provider !== r.ref.provider || fallback.model !== r.ref.model) ? fallback : null },
              settings,
              pricing,
              groundTruth: fx.groundTruth,
            });
            r.reports.push(report);
          } catch (err) {
            r.reports.push({
              id: dialog.id,
              topic: dialog.topic,
              passed: false,
              failures: [`ошибка: ${(err as Error).message}`],
              fabricated: [],
              final: 'blocked',
              handoffReason: null,
              transcript: [],
              sources: [],
              rejections: 0,
              costUsd: 0,
              latencyMs: [],
              provider: r.ref.provider,
              model: r.ref.model,
              fallbackUsed: false,
            });
          }
          r.summary = summarize(r.reports, dialogs);
        }),
      );
      await d.evalRuns.progress(accountId, runId, results);
    }
    await d.evalRuns.finish(accountId, runId, { results, summary: { dialogs: dialogs.length, models: results.map((r) => ({ ref: r.ref, ...r.summary })) } });
  } catch (err) {
    d.log?.error({ err, runId }, 'eval run failed');
    await d.evalRuns.finish(accountId, runId, { error: (err as Error).message });
  } finally {
    await fixtures?.drop().catch(() => undefined);
  }
}
