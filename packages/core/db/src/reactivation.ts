import type { Db } from './pool.ts';

/**
 * Реактивация отказных сделок (RFD-AI-AGENT-REAKTIVATSIYA).
 *
 * Состояние догона на сделку. Переход в «Отказ» агент уже ловит для анализа
 * (`refusal_analyses`), поэтому своего опроса событий здесь нет: отбор идёт по
 * разобранным отказам, а эта таблица помнит, сколько касаний сделано и чем кончилось.
 */

export type ReactivationState =
  /** Касание запланировано на `nextTouchAt`. */
  | 'planned'
  /** Касание отправлено, ждём ответа клиента. */
  | 'touched'
  /** Клиент проявил интерес: сделка переведена на этап заказа, задача у менеджера. */
  | 'interested'
  /** Клиент назвал срок: задача менеджеру на этот срок, сделка переведена на этап заказа. */
  | 'postponed'
  /** «Подумаю» без срока: агент напомнит сам через `remindDays` — последнее касание. */
  | 'reminder'
  /** Больше не пишем никогда. */
  | 'stopped'
  /** Клиент отказал повторно: отправлен шаблон «Отказ», ответ сохраняется без ответа агента. */
  | 'done';

export interface ReactivationLead {
  id: number;
  leadId: number;
  eventId: string;
  refusedAt: Date;
  budget: number;
  reason: string | null;
  reasonCode: string;
  state: ReactivationState;
  stopReason: string | null;
  touches: number;
  lastTouchAt: Date | null;
  nextTouchAt: Date | null;
  clientReplyAt: Date | null;
  finalSent: boolean;
  taskId: number | null;
  movedAt: Date | null;
}

const row = (r: Record<string, unknown>): ReactivationLead => ({
  id: Number(r.id),
  leadId: Number(r.lead_id),
  eventId: r.event_id as string,
  refusedAt: r.refused_at as Date,
  budget: Number(r.budget),
  reason: (r.reason as string | null) ?? null,
  reasonCode: r.reason_code as string,
  state: r.state as ReactivationState,
  stopReason: (r.stop_reason as string | null) ?? null,
  touches: Number(r.touches),
  lastTouchAt: (r.last_touch_at as Date | null) ?? null,
  nextTouchAt: (r.next_touch_at as Date | null) ?? null,
  clientReplyAt: (r.client_reply_at as Date | null) ?? null,
  finalSent: Boolean(r.final_sent),
  taskId: r.task_id === null || r.task_id === undefined ? null : Number(r.task_id),
  movedAt: (r.moved_at as Date | null) ?? null,
});

export interface ReactivationPlan {
  leadId: number;
  eventId: string;
  refusedAt: Date;
  budget: number;
  reason: string | null;
  reasonCode: string;
  nextTouchAt: Date;
}

export class ReactivationRepo {
  constructor(private readonly db: Db) {}

  /**
   * Поставить сделку в очередь догона. Одна сделка — одна строка: повторный переход
   * в «Отказ» новый догон не начинает, поэтому конфликт молча пропускается.
   * Возвращает id новой строки или null, если сделка уже в очереди (или уже была).
   */
  async plan(accountId: number, p: ReactivationPlan): Promise<number | null> {
    const { rows } = await this.db.query(
      `INSERT INTO reactivation_leads
         (account_id, lead_id, event_id, refused_at, budget, reason, reason_code, next_touch_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (account_id, lead_id) DO NOTHING
       RETURNING id`,
      [accountId, p.leadId, p.eventId, p.refusedAt, p.budget, p.reason, p.reasonCode, p.nextTouchAt],
    );
    return rows[0] ? Number(rows[0].id) : null;
  }

  /**
   * Сделка догону не подходит (бюджет ниже порога, её уже увели с «Отказа»).
   * Запись нужна, чтобы отбор не дёргал её из amo при каждом проходе.
   */
  async skip(accountId: number, p: Omit<ReactivationPlan, 'nextTouchAt'>, reason: string): Promise<number | null> {
    const { rows } = await this.db.query(
      `INSERT INTO reactivation_leads
         (account_id, lead_id, event_id, refused_at, budget, reason, reason_code, next_touch_at, state, stop_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 'stopped', $8)
       ON CONFLICT (account_id, lead_id) DO NOTHING
       RETURNING id`,
      [accountId, p.leadId, p.eventId, p.refusedAt, p.budget, p.reason, p.reasonCode, reason],
    );
    return rows[0] ? Number(rows[0].id) : null;
  }

  /** Сделки, которым пора отправить касание. */
  async due(accountId: number, now: Date, limit = 20): Promise<ReactivationLead[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM reactivation_leads
        WHERE account_id = $1 AND next_touch_at IS NOT NULL AND next_touch_at <= $2
          AND state IN ('planned', 'touched', 'reminder')
        ORDER BY next_touch_at LIMIT $3`,
      [accountId, now, limit],
    );
    return rows.map(row);
  }

  async byLead(accountId: number, leadId: number): Promise<ReactivationLead | null> {
    const { rows } = await this.db.query('SELECT * FROM reactivation_leads WHERE account_id = $1 AND lead_id = $2', [accountId, leadId]);
    return rows[0] ? row(rows[0]) : null;
  }

  /** Касание отправлено. `nextTouchAt` = null — больше по расписанию не пишем. */
  async markTouched(accountId: number, id: number, at: Date, nextTouchAt: Date | null, state: ReactivationState = 'touched'): Promise<void> {
    await this.db.query(
      `UPDATE reactivation_leads
          SET touches = touches + 1, last_touch_at = $3, next_touch_at = $4, state = $5, updated_at = now()
        WHERE account_id = $1 AND id = $2`,
      [accountId, id, at, nextTouchAt, state],
    );
  }

  /** Исход по ответу клиента; расписание снимается, если `nextTouchAt` не задан. */
  async resolve(
    accountId: number,
    id: number,
    state: ReactivationState,
    patch: {
      stopReason?: string | null;
      clientReplyAt?: Date | null;
      nextTouchAt?: Date | null;
      taskId?: number | null;
      movedAt?: Date | null;
      finalSent?: boolean;
    } = {},
  ): Promise<void> {
    await this.db.query(
      `UPDATE reactivation_leads
          SET state = $3,
              stop_reason = coalesce($4, stop_reason),
              client_reply_at = coalesce($5, client_reply_at),
              next_touch_at = $6,
              task_id = coalesce($7, task_id),
              moved_at = coalesce($8, moved_at),
              final_sent = final_sent OR $9,
              updated_at = now()
        WHERE account_id = $1 AND id = $2`,
      [
        accountId,
        id,
        state,
        patch.stopReason ?? null,
        patch.clientReplyAt ?? null,
        patch.nextTouchAt ?? null,
        patch.taskId ?? null,
        patch.movedAt ?? null,
        patch.finalSent ?? false,
      ],
    );
  }

  /** Больше не пишем этой сделке никогда. */
  async stop(accountId: number, id: number, reason: string): Promise<void> {
    await this.resolve(accountId, id, 'stopped', { stopReason: reason });
  }
}
