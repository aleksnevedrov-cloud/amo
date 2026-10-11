import type { AmoApiClient } from './client.ts';

/**
 * Где агенту разрешено ставить задачи (RFD-AI-AGENT-ZADACHI-ZAKRYTYE-SDELKI).
 *
 * Замер 11.10.2026: за 06–11.10 поставлено 293 задачи с префиксом «AI:», среди них задачи
 * в закрытых сделках (сделка «81250» (#29549539) закрыта 10.02, задача 09.10) и в чужих
 * воронках («Фабрики», «Спам»). Причина — ни один из трёх механизмов постановки не проверял
 * ни статус сделки, ни воронку: `sweepNewLeads` брал сделки по дате создания без фильтра,
 * `ensureTask` смотрел только наличие открытой задачи и активность за сегодня.
 *
 * Проверка вынесена сюда, чтобы все три механизма — обход новых сделок, вечерний обход
 * и задача по неотвеченному сообщению — пользовались одним правилом.
 */

/**
 * Системные этапы amoCRM, одинаковые в любой воронке: 142 — «Успешно реализовано»,
 * 143 — «Закрыто и не реализовано». Сделка на них закрыта, задачи в неё не ставим.
 */
export const CLOSED_STATUS_IDS = [142, 143] as const;

export type TaskBlockReason = 'closed' | 'other_pipeline' | 'other_status' | 'has_task';

export interface TaskScope {
  /** Воронка, в которой агент ставит задачи; null — ограничения по воронке нет. */
  pipelineId: number | null;
  /** Этапы этой воронки; пустой список — ограничения по этапу нет. */
  statusIds: number[];
}

export interface TaskGuardLead {
  id: number;
  status_id: number;
  pipeline_id: number;
  /** Unix-секунды закрытия сделки; 0 или отсутствует — сделка открыта. */
  closed_at?: number | null;
}

export interface TaskGuardResult {
  allowed: boolean;
  reason?: TaskBlockReason;
  details?: Record<string, unknown>;
}

const OK: TaskGuardResult = { allowed: true };

export function isClosedLead(lead: TaskGuardLead): boolean {
  if ((CLOSED_STATUS_IDS as readonly number[]).includes(lead.status_id)) return true;
  return Boolean(lead.closed_at && lead.closed_at > 0);
}

/** Текст для журнала: почему задача не поставлена. */
export function taskBlockSummary(r: TaskGuardResult): string {
  switch (r.reason) {
    case 'closed':
      return 'Задача не поставлена: сделка закрыта';
    case 'other_pipeline':
      return 'Задача не поставлена: воронка вне списка работы агента';
    case 'other_status':
      return 'Задача не поставлена: этап вне списка работы агента';
    case 'has_task':
      return 'Задача не поставлена: в сделке уже есть незакрытая задача';
    default:
      return 'Задача не поставлена';
  }
}

/**
 * Можно ли поставить задачу в эту сделку. Проверки по порядку дешевизны:
 * закрытость и принадлежность воронке/этапу считаются по уже загруженной сделке,
 * и только в конце запрашиваются открытые задачи.
 *
 * Недоступность списка задач не блокирует постановку: иначе сбой API amoCRM
 * оставил бы менеджеров без задач вовсе. Но и дубль в этом случае возможен,
 * поэтому ошибка попадает в `details`.
 */
export async function canCreateTask(
  api: Pick<AmoApiClient, 'openLeadTasks'>,
  lead: TaskGuardLead,
  scope: TaskScope,
): Promise<TaskGuardResult> {
  if (isClosedLead(lead)) {
    return { allowed: false, reason: 'closed', details: { statusId: lead.status_id, closedAt: lead.closed_at ?? null } };
  }
  if (scope.pipelineId && lead.pipeline_id !== scope.pipelineId) {
    return { allowed: false, reason: 'other_pipeline', details: { pipelineId: lead.pipeline_id, allowed: scope.pipelineId } };
  }
  if (scope.statusIds.length && !scope.statusIds.includes(lead.status_id)) {
    return { allowed: false, reason: 'other_status', details: { statusId: lead.status_id, allowed: scope.statusIds } };
  }
  let open: { id: number; text: string }[];
  try {
    open = await api.openLeadTasks(lead.id);
  } catch (err) {
    return { allowed: true, details: { tasksCheckFailed: (err as Error).message } };
  }
  if (open.length) {
    return { allowed: false, reason: 'has_task', details: { taskIds: open.map((t) => t.id).slice(0, 5) } };
  }
  return OK;
}

/** Область работы агента по задачам из настроек. */
export function taskScope(s: { taskSweep: { pipelineId: number | null; statusIds: number[] } }): TaskScope {
  return { pipelineId: s.taskSweep.pipelineId, statusIds: s.taskSweep.statusIds };
}

export { OK as TASK_ALLOWED };
