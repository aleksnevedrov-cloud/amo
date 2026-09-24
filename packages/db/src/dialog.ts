import { withTransaction, type Db } from './pool.ts';

export type Role = 'client' | 'ai' | 'manager';

export interface ConversationState {
  paused: boolean;
  pauseReason: string | null;
  pausedAt: Date | null;
  misses: number;
  lastAiAt: Date | null;
}

export interface PendingMessage {
  id: number;
  accountId: number;
  leadId: number;
  text: string;
  returnUrl: string | null;
  attachmentUrl: string | null;
  attachmentType: string | null;
  receivedAt: Date;
}

const EMPTY: ConversationState = { paused: false, pauseReason: null, pausedAt: null, misses: 0, lastAiAt: null };

/** Состояние AI по сделке, переписка и очередь входящих сообщений. */
export class DialogRepo {
  constructor(private readonly db: Db) {}

  async state(accountId: number, leadId: number): Promise<ConversationState> {
    const { rows } = await this.db.query(
      'SELECT paused, pause_reason, paused_at, misses, last_ai_at FROM conversations WHERE account_id = $1 AND lead_id = $2',
      [accountId, leadId],
    );
    const r = rows[0];
    if (!r) return { ...EMPTY };
    return { paused: r.paused, pauseReason: r.pause_reason, pausedAt: r.paused_at, misses: r.misses, lastAiAt: r.last_ai_at };
  }

  async pause(accountId: number, leadId: number, reason: string): Promise<void> {
    await this.db.query(
      `INSERT INTO conversations (account_id, lead_id, paused, pause_reason, paused_at) VALUES ($1, $2, true, $3, now())
       ON CONFLICT (account_id, lead_id) DO UPDATE
         SET paused = true, pause_reason = EXCLUDED.pause_reason, paused_at = now(), updated_at = now()`,
      [accountId, leadId, reason],
    );
  }

  async resume(accountId: number, leadId: number): Promise<void> {
    await this.db.query(
      `INSERT INTO conversations (account_id, lead_id) VALUES ($1, $2)
       ON CONFLICT (account_id, lead_id) DO UPDATE
         SET paused = false, pause_reason = NULL, paused_at = NULL, misses = 0, updated_at = now()`,
      [accountId, leadId],
    );
  }

  /** Подряд идущие ходы без ответа; возвращает новое значение счётчика. */
  async registerTurn(accountId: number, leadId: number, missed: boolean): Promise<number> {
    const { rows } = await this.db.query(
      `INSERT INTO conversations (account_id, lead_id, misses, last_ai_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (account_id, lead_id) DO UPDATE
         SET misses = CASE WHEN $4 THEN conversations.misses + 1 ELSE 0 END,
             last_ai_at = now(), updated_at = now()
       RETURNING misses`,
      [accountId, leadId, missed ? 1 : 0, missed],
    );
    return rows[0].misses as number;
  }

  async addMessage(accountId: number, leadId: number, role: Role, text: string): Promise<void> {
    await this.db.query('INSERT INTO dialog_messages (account_id, lead_id, role, text) VALUES ($1, $2, $3, $4)', [
      accountId,
      leadId,
      role,
      text,
    ]);
  }

  /** Последние сообщения сделки в хронологическом порядке. */
  async history(accountId: number, leadId: number, limit = 30): Promise<{ role: Role; text: string; createdAt: Date }[]> {
    const { rows } = await this.db.query(
      `SELECT role, text, created_at FROM (
         SELECT id, role, text, created_at FROM dialog_messages
          WHERE account_id = $1 AND lead_id = $2 ORDER BY id DESC LIMIT $3
       ) t ORDER BY id`,
      [accountId, leadId, limit],
    );
    return rows.map((r) => ({ role: r.role, text: r.text, createdAt: r.created_at }));
  }

  async enqueue(
    accountId: number,
    leadId: number,
    text: string,
    returnUrl: string | null,
    attachment: { url: string; type: string | null } | null = null,
  ): Promise<number> {
    const { rows } = await this.db.query(
      `INSERT INTO pending_messages (account_id, lead_id, text, return_url, attachment_url, attachment_type)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [accountId, leadId, text, returnUrl, attachment?.url ?? null, attachment?.type ?? null],
    );
    return Number(rows[0].id);
  }

  /**
   * Забирает все необработанные сообщения сделки и помечает их обработанными.
   * Блокировка строк не даёт двум обработчикам взять одну пачку.
   */
  async takePending(accountId: number, leadId: number): Promise<PendingMessage[]> {
    return withTransaction(this.db, async (c) => {
      const { rows } = await c.query(
        `SELECT id, text, return_url, attachment_url, attachment_type, received_at FROM pending_messages
          WHERE account_id = $1 AND lead_id = $2 AND processed_at IS NULL
          ORDER BY id FOR UPDATE SKIP LOCKED`,
        [accountId, leadId],
      );
      if (rows.length) {
        await c.query('UPDATE pending_messages SET processed_at = now() WHERE id = ANY($1)', [rows.map((r) => r.id)]);
      }
      return rows.map((r) => ({
        id: Number(r.id),
        accountId,
        leadId,
        text: r.text,
        returnUrl: r.return_url,
        attachmentUrl: r.attachment_url,
        attachmentType: r.attachment_type,
        receivedAt: r.received_at,
      }));
    });
  }

  /** Число ответов AI в сделке — для лимита сообщений на сделку. */
  async aiMessagesCount(accountId: number, leadId: number): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT count(*)::int AS n FROM dialog_messages WHERE account_id = $1 AND lead_id = $2 AND role = 'ai'`,
      [accountId, leadId],
    );
    return rows[0].n;
  }

  /** Время последнего необработанного сообщения — для продления окна склейки. */
  async lastPendingAt(accountId: number, leadId: number): Promise<Date | null> {
    const { rows } = await this.db.query(
      'SELECT max(received_at) AS t FROM pending_messages WHERE account_id = $1 AND lead_id = $2 AND processed_at IS NULL',
      [accountId, leadId],
    );
    return rows[0]?.t ?? null;
  }
}
