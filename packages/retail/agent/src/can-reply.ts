/**
 * Технический допуск агента к отправке сообщения клиенту.
 *
 * Проверка «менеджер уже ведёт диалог» стоит в начале хода, но между ней и отправкой проходит
 * 17–31 с: окно склейки, вызов модели (замер 30.09: 12,1 с), имитация набора. Если менеджер
 * написал в этом окне, ответ агента всё равно уходил клиенту. Поэтому допуск перечитывается
 * непосредственно перед отправкой — и ответ, и одобренный черновик бота-отправщика.
 *
 * Ограничение держится кодом, а не формулировкой в промпте: промпт снижает риск, но не гарантирует.
 */

/** Причина запрета — попадает в журнал, чтобы видеть, какое правило сработало. */
export type ReplyBlockReason = 'paused' | 'manager_active' | 'check_failed' | 'answer_already_in_history';

export interface CanReplyResult {
  /** Единственное условие отправки: true. Иначе писать клиенту нельзя. */
  allowed: boolean;
  reason?: ReplyBlockReason;
  /** Чем вызван запрет: причина паузы или время сообщения менеджера. */
  details?: Record<string, unknown>;
}

export const ALLOWED: CanReplyResult = { allowed: true };

export interface CanReplyDeps {
  /** Состояние диалога: пауза и её причина. */
  state(accountId: number, leadId: number): Promise<{ paused: boolean; pauseReason: string | null; lastAiAt: Date | null }>;
  /** Исходящие события чата amo: сообщения менеджера имеют created_by > 0. */
  outgoingChatEvents(leadId: number, since: Date): Promise<{ created_by: number; created_at?: number }[]>;
  /** Когда сотрудник писал клиенту в мессенджере после since (без ответов самого агента). */
  managerWroteSince?(since: Date): Promise<Date | null>;
}

/** Сколько назад смотреть события менеджера, если агент в этой сделке ещё не отвечал. */
const LOOKBACK_MS = 7 * 24 * 3600_000;

/**
 * Можно ли агенту писать клиенту прямо сейчас. Вызывается перед каждой отправкой:
 * из конвейера перед `release` и из бота-отправщика перед выдачей одобренного черновика.
 *
 * `manualReturn` — явная передача диалога агенту («Возврат AI» в карточке или обращение
 * по имени в разрешённой группе): снимает запрет по паузе, но не запрет по активному менеджеру.
 */
export async function canReply(
  deps: CanReplyDeps,
  args: { accountId: number; leadId: number; now?: Date; manualReturn?: boolean; checkChat?: boolean },
): Promise<CanReplyResult> {
  const { accountId, leadId } = args;
  const now = args.now ?? new Date();

  const state = await deps.state(accountId, leadId);
  if (state.paused && !args.manualReturn) {
    return { allowed: false, reason: 'paused', details: { pauseReason: state.pauseReason } };
  }

  const since = state.lastAiAt ?? new Date(now.getTime() - LOOKBACK_MS);

  // Менеджеры отвечают из WhatsApp: в событиях чата amo их нет, в мессенджере есть.
  if (deps.managerWroteSince) {
    let at: Date | null = null;
    try {
      at = await deps.managerWroteSince(since);
    } catch {
      return { allowed: false, reason: 'check_failed' };
    }
    if (at) return { allowed: false, reason: 'manager_active', details: { messengerAt: at.toISOString() } };
  }

  if (args.checkChat === false) return ALLOWED;
  let events: { created_by: number; created_at?: number }[];
  try {
    events = await deps.outgoingChatEvents(leadId, since);
  } catch {
    // amo отдаёт 429 при 7 запросах в секунду — одна попытка повтора.
    try {
      await new Promise((r) => setTimeout(r, 400));
      events = await deps.outgoingChatEvents(leadId, since);
    } catch {
      // Допуск не подтверждён: клиенту не пишем, текст уходит менеджеру черновиком.
      return { allowed: false, reason: 'check_failed' };
    }
  }
  const manager = events.find((e) => e.created_by > 0);
  if (manager) {
    return {
      allowed: false,
      reason: 'manager_active',
      details: { createdBy: manager.created_by, at: manager.created_at ? new Date(manager.created_at * 1000).toISOString() : null },
    };
  }
  return ALLOWED;
}

/** Текст для журнала при заблокированной отправке. */
export function blockSummary(r: CanReplyResult): string {
  if (r.reason === 'check_failed') return 'Ответ не отправлен: проверка допуска не прошла';
  if (r.reason === 'answer_already_in_history') return 'Ответ не отправлен: вопрос повторяет данные из истории';
  if (r.reason === 'manager_active') return 'Ответ не отправлен: менеджер ведёт диалог';
  if (r.reason === 'paused') return 'Ответ не отправлен: AI на паузе';
  return 'Ответ не отправлен: нет допуска';
}

/** Структурный итог проверки перед отправкой — целиком пишется в журнал. */
export interface GateReport {
  can_reply_to_client: boolean;
  manager_active: boolean;
  explicit_permission: boolean;
  history_checked: boolean;
  question_to_client: boolean;
  question_topic: string | null;
  data_already_known: boolean;
  block_reason: ReplyBlockReason | null;
}

export function gateReport(
  r: CanReplyResult,
  x: { explicitPermission: boolean; questionTopic: string | null; dataAlreadyKnown: boolean },
): GateReport {
  return {
    can_reply_to_client: r.allowed,
    manager_active: r.reason === 'manager_active',
    explicit_permission: x.explicitPermission,
    history_checked: r.reason !== 'check_failed',
    question_to_client: x.questionTopic !== null,
    question_topic: x.questionTopic,
    data_already_known: x.dataAlreadyKnown,
    block_reason: r.reason ?? null,
  };
}
