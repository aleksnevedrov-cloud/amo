import { RefusalsRepo } from '@core/calls';
import type { AmoApiClient } from '@core/amo';
import { JournalRepo, ReactivationRepo, SettingsRepo, SuggestionsRepo, type Db, type DialogRepo } from '@core/db';
import { senderBotSend, type ReactivationDeps, type ReplyDeps } from '@retail/agent';

/**
 * Зависимости догона отказных сделок (RFD-AI-AGENT-REAKTIVATSIYA).
 * Отбор идёт по разобранным отказам, отправка — ботом-отправщиком.
 */
export function reactivationDeps(
  db: Db,
  parts: {
    settings: SettingsRepo;
    journal: JournalRepo;
    dialog: DialogRepo;
    amo(accountId: number): Promise<AmoApiClient>;
    /** Дубль касания письмом; нет — только WhatsApp. */
    email?(accountId: number, leadId: number, text: string): Promise<boolean>;
  },
): ReplyDeps & { accountIds(): Promise<number[]> } {
  const refusals = new RefusalsRepo(db);
  const suggestions = new SuggestionsRepo(db);
  const amo = async (accountId: number) => ({ api: await parts.amo(accountId) });
  const base = {
    settings: parts.settings,
    journal: parts.journal,
    reactivation: new ReactivationRepo(db),
    suggestions,
    amo,
    accountIds: () => parts.settings.listAccountIds(),
    async analyzedRefusals(accountId: number, since: Date, statusId: number, pipelineIds: number[], limit: number) {
      const rows = await refusals.listAnalyzedSince(accountId, since, statusId, pipelineIds, limit);
      return rows.map((r) => ({ leadId: r.leadId, eventId: r.eventId, changedAt: r.changedAt, analysis: r.analysis }));
    },
    email: parts.email,
  } satisfies Omit<ReactivationDeps, 'send'> & { accountIds(): Promise<number[]> };
  return {
    ...base,
    send: senderBotSend({ settings: parts.settings, suggestions, journal: parts.journal, dialog: parts.dialog, amo }),
  };
}
