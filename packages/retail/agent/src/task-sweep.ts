import type { DialogRepo, JournalRepo, SettingsRepo, WidgetSettings } from '@core/db';
import type { AmoApiClient } from '@core/amo';
import { canCreateTask, taskBlockSummary, taskScope, type TaskBlockReason } from '@core/amo';

/** Префикс задач, поставленных агентом. */
export const SWEEP_PREFIX = 'AI:';

export interface SweepHistoryItem {
  role: string;
  text: string;
  createdAt: Date;
}

export interface SweepDeps {
  settings: SettingsRepo;
  dialog: DialogRepo;
  journal: JournalRepo;
  /** Доступ к amoCRM аккаунта. */
  amo(accountId: number): Promise<{ api: AmoApiClient }>;
  /** Сжатие переписки за день в один абзац; null — если модель недоступна. */
  summarize?(accountId: number, history: SweepHistoryItem[]): Promise<string | null>;
  /** RFD-AI-AGENT-CALLS-RETAIL: итог разговоров за день по сделке («Итог: …», «Следующий шаг: …») из таблицы итогов; нет — пусто. */
  callTexts?(accountId: number, leadId: number, since: Date): Promise<string[]>;
  /** Переписка в мессенджере по сделке за период (Wazzup). */
  messengerSince?(accountId: number, leadId: number, since: Date): Promise<SweepHistoryItem[]>;
  /** Писал ли сотрудник клиенту в мессенджере после `since`. */
  managerWroteSince?(accountId: number, leadId: number, since: Date): Promise<Date | null>;
  now?(): Date;
}

export interface SweepResult {
  checked: number;
  created: number;
  skipped: number;
  errors: number;
}

/** Начало текущих суток по Москве. */
export function startOfMskDay(now: Date): Date {
  const msk = new Date(now.getTime() + 3 * 3600_000);
  msk.setUTCHours(0, 0, 0, 0);
  return new Date(msk.getTime() - 3 * 3600_000);
}

function cut(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

/** Блок звонков в комментарии задачи: итог дня от модуля звонков или фраза, что разговоров не было. */
export function callsBlock(calls: string[]): string {
  return calls.length ? `Разговоры за день: ${calls.map((t) => t.trim()).filter(Boolean).join(' ')}` : 'За сегодня разговоров в сделке не было.';
}

/** Комментарий к задаче: переписка за день плюс блок «Разговоры за день» (итог дня по звонкам). */
export async function buildComment(
  d: SweepDeps,
  accountId: number,
  leadId: number,
  s: WidgetSettings,
  now: Date,
): Promise<string> {
  const since = startOfMskDay(now);
  let history: SweepHistoryItem[] = [];
  try {
    history = (await d.dialog.history(accountId, leadId, 80)).filter((m) => m.createdAt >= since);
  } catch {
    history = [];
  }
  let calls: string[] = [];
  try {
    calls = (await d.callTexts?.(accountId, leadId, since)) ?? [];
  } catch {
    calls = [];
  }
  let chat: SweepHistoryItem[] = [];
  try {
    chat = (await d.messengerSince?.(accountId, leadId, since)) ?? [];
  } catch {
    chat = [];
  }
  if (chat.length) {
    history = [...history, ...chat].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  // Блок звонков всегда отдельной строкой: итог дня — или что разговоров не было (ТЗ RFD-AI-AGENT-CALLS-RETAIL, п. 4).
  const withCalls = (text: string): string => cut(`${text}\n${callsBlock(calls)}`, 900);
  if (!history.length) return withCalls('За сегодня переписки в сделке не было.');

  if (s.taskSweep.llmComment && d.summarize) {
    try {
      const made = await d.summarize(accountId, history);
      if (made) return withCalls(cut(made, 700));
    } catch {
      // ниже — запасной вариант без модели
    }
  }
  const label = (r: string): string => (r === 'client' ? 'клиент' : r === 'ai' ? 'AI' : 'менеджер');
  const tail = history.slice(-6).map((m) => `${label(m.role)}: ${cut(m.text, 160)}`);
  return withCalls(cut(tail.join('\n'), 700));
}

/**
 * Работал ли кто-то по сделке после `since`: ответ сотрудника в чате,
 * его сообщение в мессенджере или закрытая задача. Ошибки источников
 * не считаются активностью — сделка тогда разбирается как обычно.
 */
async function hadActivity(
  d: SweepDeps,
  api: AmoApiClient,
  accountId: number,
  leadId: number,
  since: Date,
): Promise<boolean> {
  try {
    const events = await api.getOutgoingChatEvents(leadId, since);
    if (events.some((e) => e.created_by > 0)) return true;
  } catch {
    /* событий чата нет — проверяем дальше */
  }
  try {
    if (await d.managerWroteSince?.(accountId, leadId, since)) return true;
  } catch {
    /* мессенджер недоступен — проверяем дальше */
  }
  try {
    const done = await api.completedLeadTasksSince(leadId, since);
    if (done.length) return true;
  } catch {
    /* задачи недоступны */
  }
  return false;
}

/** Ставит задачу в сделку, если незакрытых задач в ней нет и по ней сегодня не работали. */
async function ensureTask(
  d: SweepDeps,
  api: AmoApiClient,
  accountId: number,
  s: WidgetSettings,
  lead: { id: number; responsible_user_id: number; status_id: number; pipeline_id: number; updated_at?: number; closed_at?: number | null },
  reason: string,
  now: Date,
  freshCounts: boolean,
): Promise<'created' | 'has_task' | 'has_activity' | 'error' | TaskBlockReason> {
  try {
    // Единое правило: открытая сделка, своя воронка и этап, задачи в сделке ещё нет.
    const gate = await canCreateTask(api, lead, taskScope(s));
    if (!gate.allowed) {
      await d.journal
        .add({ accountId, leadId: lead.id, kind: 'skipped', summary: taskBlockSummary(gate), details: { reason: gate.reason, ...gate.details } })
        .catch(() => undefined);
      return gate.reason ?? 'has_task';
    }
    const since = startOfMskDay(now);
    if (freshCounts && lead.updated_at && lead.updated_at * 1000 >= since.getTime())
      return 'has_activity';
    if (await hadActivity(d, api, accountId, lead.id, since)) return 'has_activity';
    const comment = await buildComment(d, accountId, lead.id, s, now);
    const text = cut(`${SWEEP_PREFIX} ${reason}\n${comment}`, 1000);
    await api.createTask({
      text,
      completeTill: new Date(now.getTime() + s.taskSweep.dueHours * 3600_000),
      leadId: lead.id,
      taskTypeId: s.taskSweep.taskTypeId,
      responsibleUserId: lead.responsible_user_id || undefined,
    });
    await d.journal.add({
      accountId,
      leadId: lead.id,
      kind: 'note',
      summary: `Поставлена задача: ${reason}`,
      details: { text },
    });
    return 'created';
  } catch (err) {
    await d.journal
      .add({
        accountId,
        leadId: lead.id,
        kind: 'error',
        summary: `Не удалось поставить задачу: ${(err as Error).message}`,
      })
      .catch(() => undefined);
    return 'error';
  }
}

/** Пункт 1: сделка создана, через N минут задачи в ней так и нет. */
export async function sweepNewLeads(d: SweepDeps, accountId: number): Promise<SweepResult> {
  const now = d.now?.() ?? new Date();
  const { settings: s } = await d.settings.get(accountId);
  const res: SweepResult = { checked: 0, created: 0, skipped: 0, errors: 0 };
  if (!s.taskSweep.enabled) return res;
  const { api } = await d.amo(accountId);
  const to = new Date(now.getTime() - s.taskSweep.newLeadAfterMin * 60_000);
  const from = new Date(to.getTime() - 60 * 60_000);
  // Новые сделки берём только из воронки агента: без фильтра под обход попадали
  // «Фабрики» и «Спам» (замер 11.10.2026).
  const leads = await api.listLeads({
    ...(s.taskSweep.pipelineId ? { pipelineId: s.taskSweep.pipelineId } : {}),
    createdFrom: from,
    createdTo: to,
    limit: 250,
  });
  for (const lead of leads) {
    if (res.created >= s.taskSweep.maxPerRun) break;
    res.checked += 1;
    if (!s.taskSweep.includeUnsorted && !lead.responsible_user_id) {
      res.skipped += 1;
      continue;
    }
    const r = await ensureTask(d, api, accountId, s, lead, 'сделка создана, задачи нет', now, false);
    if (r === 'created') res.created += 1;
    else if (r === 'error') res.errors += 1;
    else res.skipped += 1;
  }
  return res;
}

/** Пункт 2: вечерний обход воронки по указанным этапам. */
export async function sweepStages(d: SweepDeps, accountId: number): Promise<SweepResult> {
  const now = d.now?.() ?? new Date();
  const { settings: s } = await d.settings.get(accountId);
  const res: SweepResult = { checked: 0, created: 0, skipped: 0, errors: 0 };
  if (!s.taskSweep.enabled || !s.taskSweep.pipelineId || !s.taskSweep.statusIds.length) return res;
  const { api } = await d.amo(accountId);
  for (let page = 1; page <= 20; page += 1) {
    const leads = await api.listLeads({
      pipelineId: s.taskSweep.pipelineId,
      statusIds: s.taskSweep.statusIds,
      page,
      limit: 250,
    });
    if (!leads.length) break;
    for (const lead of leads) {
      if (res.created >= s.taskSweep.maxPerRun) return res;
      res.checked += 1;
      const r = await ensureTask(d, api, accountId, s, lead, 'вечерний обход: задачи в сделке нет', now, true);
      if (r === 'created') res.created += 1;
      else if (r === 'error') res.errors += 1;
      else res.skipped += 1;
    }
    if (leads.length < 250) break;
  }
  return res;
}
