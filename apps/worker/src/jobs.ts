import type { DialogPipeline, IncomingJob } from '@ai-door/agent';
import type { TokenService } from '@ai-door/amo';
import type { CatalogImporter, CatalogRepo } from '@ai-door/catalog';
import type { AmoApiClient } from '@ai-door/amo';
import { classifyOutcome, type DialogRepo, type JournalRepo, type OutcomesRepo, type SettingsRepo } from '@ai-door/db';
import { pollMailbox, type PollDeps, type PollResult } from '@ai-door/mail';

export const MAINTENANCE_QUEUE = 'maintenance';
export const REFRESH_TOKENS_JOB = 'refresh-tokens';
export const IMPORT_FEEDS_JOB = 'import-feeds';
export const REFRESH_EVERY_MS = 30 * 60_000;
export const IMPORT_CHECK_EVERY_MS = 30 * 60_000;
export const POLL_MAIL_JOB = 'poll-mail';
export const POLL_MAIL_EVERY_MS = 60_000;
export const REFRESH_OUTCOMES_JOB = 'refresh-outcomes';
export const REFRESH_OUTCOMES_EVERY_MS = 6 * 3600_000;
/** Как долго следим за сделкой после диалога с AI и как часто перепроверяем. */
export const OUTCOME_WINDOW_DAYS = 60;
export const OUTCOME_RECHECK_MS = 4 * 3600_000;

export interface JobLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/** Плановое обновление токенов amo, которые скоро истекут. */
export async function runRefreshTokens(tokenService: TokenService, log: JobLogger) {
  const result = await tokenService.refreshExpiring();
  if (result.failed.length) log.warn(result, 'amo: часть токенов не обновилась');
  else log.info(result, 'amo: плановое обновление токенов');
  return result;
}

/** Импорт фидов, у которых подошёл срок (по умолчанию раз в сутки). */
export async function runImportFeeds(
  d: { settings: SettingsRepo; catalog: CatalogRepo; importer: CatalogImporter; journal: JournalRepo },
  log: JobLogger,
  now: Date = new Date(),
) {
  const done: number[] = [];
  const failed: number[] = [];
  for (const f of await d.settings.listWithFeeds()) {
    const last = await d.catalog.lastSuccessAt(f.accountId);
    if (last && now.getTime() - last.getTime() < f.everyHours * 3600_000) continue;
    try {
      const r = await d.importer.importFromUrl(f.accountId, f.feedUrl);
      await d.journal.add({ accountId: f.accountId, kind: 'import', summary: `Каталог обновлён: ${r.products} товаров` });
      done.push(f.accountId);
    } catch (err) {
      await d.journal.add({ accountId: f.accountId, kind: 'error', summary: `Импорт каталога: ${(err as Error).message}` });
      failed.push(f.accountId);
    }
  }
  log.info({ done, failed }, 'catalog: плановый импорт');
  return { done, failed };
}

/**
 * Обработка сделки из очереди. Если пока шла обработка пришли новые сообщения,
 * сделка ставится в очередь снова.
 */
export async function runIncoming(
  job: IncomingJob,
  d: { pipeline: DialogPipeline; dialog: DialogRepo; settings: SettingsRepo },
  reschedule: (job: IncomingJob, windowMs: number) => Promise<void>,
) {
  const outcome = await d.pipeline.processLead(job.accountId, job.leadId);
  if (await d.dialog.lastPendingAt(job.accountId, job.leadId)) {
    const { settings } = await d.settings.get(job.accountId);
    await reschedule(job, settings.where.batchWindowSec * 1000);
  }
  return outcome;
}

/** Опрос почтовых ящиков всех аккаунтов с включённой почтой. */
export async function runPollMail(d: PollDeps, log: JobLogger): Promise<PollResult[]> {
  const results: PollResult[] = [];
  for (const accountId of await d.settings.listWithEmail()) {
    const r = await pollMailbox(accountId, d);
    results.push(r);
    if (r.error) log.warn(r, 'mail: ошибка опроса ящика');
    else if (r.received || r.managerReplies) log.info(r, 'mail: опрос ящика');
  }
  return results;
}

/**
 * Аналитика (фаза 4): перепроверяет этапы сделок, где AI общался, — ушла ли сделка вперёд по воронке,
 * выиграна или проиграна. Порядок этапов берётся из воронок аккаунта.
 */
export async function runRefreshOutcomes(
  d: { outcomes: OutcomesRepo; amo(accountId: number): Promise<AmoApiClient> },
  log: JobLogger,
  opts: { recheckMs?: number; windowDays?: number; batch?: number } = {},
): Promise<{ checked: number; advanced: number; errors: number }> {
  const recheckMs = opts.recheckMs ?? OUTCOME_RECHECK_MS;
  const windowDays = opts.windowDays ?? OUTCOME_WINDOW_DAYS;
  const res = { checked: 0, advanced: 0, errors: 0 };
  for (const accountId of await d.outcomes.accountsWithDue(recheckMs, windowDays)) {
    try {
      const api = await d.amo(accountId);
      const order = new Map<number, number>();
      for (const p of await api.getPipelines()) for (const st of p.statuses) order.set(st.id, st.sort);
      const due = await d.outcomes.due(accountId, { olderThanMs: recheckMs, withinDays: windowDays, limit: opts.batch ?? 500 });
      for (let i = 0; i < due.length; i += 50) {
        const chunk = due.slice(i, i + 50);
        const leads = new Map((await api.getLeadsByIds(chunk.map((x) => x.leadId))).map((l) => [l.id, l]));
        for (const x of chunk) {
          const lead = leads.get(x.leadId);
          if (!lead) {
            await d.outcomes.markGone(accountId, x.leadId);
            continue;
          }
          const c = classifyOutcome({ pipelineId: x.pipelineId, statusId: x.firstStatusId }, { pipelineId: lead.pipeline_id, statusId: lead.status_id }, order);
          await d.outcomes.record(accountId, x.leadId, { statusId: lead.status_id, pipelineId: lead.pipeline_id, ...c });
          res.checked += 1;
          if (c.advanced) res.advanced += 1;
        }
      }
    } catch (err) {
      res.errors += 1;
      log.warn({ accountId, err: (err as Error).message }, 'analytics: не удалось обновить исходы');
    }
  }
  if (res.checked) log.info(res, 'analytics: исходы обновлены');
  return res;
}
