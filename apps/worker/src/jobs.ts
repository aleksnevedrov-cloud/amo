import type { DialogPipeline, IncomingJob } from '@ai-door/agent';
import type { TokenService } from '@ai-door/amo';
import type { CatalogImporter, CatalogRepo } from '@ai-door/catalog';
import type { DialogRepo, JournalRepo, SettingsRepo } from '@ai-door/db';

export const MAINTENANCE_QUEUE = 'maintenance';
export const REFRESH_TOKENS_JOB = 'refresh-tokens';
export const IMPORT_FEEDS_JOB = 'import-feeds';
export const REFRESH_EVERY_MS = 30 * 60_000;
export const IMPORT_CHECK_EVERY_MS = 30 * 60_000;

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
