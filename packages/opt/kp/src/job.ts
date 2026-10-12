import type { OptCore } from './deps.ts';
import { buildKpDraft, type KpDraftDeps } from './draft.ts';
import { resolveOptRoute, toWidgetSettings } from './settings.ts';

/** Очередь опта в Redis (база 1): задание «собрать черновик» по кнопке менеджера; плановых задач нет (ТЗ 6.5). */
export const KP_QUEUE = 'kp';
export const DRAFT_JOB = 'draft';

export interface DraftJob {
  accountId: number;
  leadId: number;
  userId: number | null;
}

/** Один черновик на сделку в очереди: повторное нажатие не плодит задания. */
export const draftJobId = (accountId: number, leadId: number) => `draft-${accountId}-${leadId}`;

/**
 * Черновик КП из карточки сделки: письма и файлы читаются через API amoCRM, спецификации
 * разбираются @core/docs, позиции кладутся в kp_drafts без цен. Любая ошибка — в журнал (kp_error)
 * и наверх: задание помечается упавшим, виджет показывает текст.
 */
export async function runDraftJob(core: OptCore, job: DraftJob): Promise<{ draftId: number }> {
  const { accountId, leadId } = job;
  try {
    const ai = await core.ai(accountId);
    if (!ai) throw new Error('LLM не настроена: задайте ключ провайдера в настройках «Модель»');
    const { settings } = await core.settings.get(accountId);
    const route = resolveOptRoute(settings);
    const amo = await core.amoFor(accountId);
    const widgetSettings = toWidgetSettings(settings);
    const analyze: KpDraftDeps['analyze'] =
      settings.vision.provider === 'off'
        ? null
        : async (file) => {
            const r = await core.docs.analyze({ accountId, leadId, source: 'widget', filename: file.filename, mime: file.mime, bytes: file.bytes, settings: widgetSettings, createdBy: job.userId, hint: 'request', route });
            return { id: r.id, filename: file.filename, kind: r.kind, positions: r.data.positions, questions: r.data.questions, requirements: r.data.requirements };
          };
    const r = await buildKpDraft(ai.llm, { accountId, leadId, route, pricing: settings.billing.pricing }, { amo, analyze });
    const draftId = await core.kp.createDraft(accountId, leadId, r.payload as unknown as Record<string, unknown>, job.userId);
    await core.journal.add({
      accountId,
      leadId,
      kind: 'kp_draft',
      summary: `Черновик КП: позиций ${r.payload.items.length}, документов ${r.payload.source.documents.length}` + (r.payload.source.skipped.length ? `, пропущено файлов ${r.payload.source.skipped.length}` : ''),
      details: { draftId, model: r.model, provider: r.provider, userId: job.userId, skipped: r.payload.source.skipped },
      inputTokens: r.cost.inputTokens,
      outputTokens: r.cost.outputTokens,
      costUsd: r.cost.usd,
      costRub: r.cost.usd * settings.billing.usdRubRate,
    });
    return { draftId };
  } catch (err) {
    await core.journal.add({ accountId, leadId, kind: 'kp_error', summary: `Черновик КП не собран: ${(err as Error).message}`, details: { userId: job.userId } }).catch(() => undefined);
    throw err;
  }
}
