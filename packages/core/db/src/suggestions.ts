import { withTransaction, type Db } from './pool.ts';

export type SuggestionKind = 'draft' | 'hint';
export type SuggestionStatus = 'pending' | 'approved' | 'sent' | 'rejected' | 'used' | 'expired';

export interface Suggestion {
  id: number;
  leadId: number;
  kind: SuggestionKind;
  text: string;
  status: SuggestionStatus;
  details: Record<string, unknown>;
  createdAt: Date;
  decidedAt: Date | null;
  decidedBy: number | null;
}

const row = (r: Record<string, unknown>): Suggestion => ({
  id: Number(r.id),
  leadId: Number(r.lead_id),
  kind: r.kind as SuggestionKind,
  text: r.text as string,
  status: r.status as SuggestionStatus,
  details: (r.details as Record<string, unknown>) ?? {},
  createdAt: r.created_at as Date,
  decidedAt: (r.decided_at as Date | null) ?? null,
  decidedBy: r.decided_by === null ? null : Number(r.decided_by),
});

/** Черновики (режим «Полуавто») и подсказки менеджеру. */
export class SuggestionsRepo {
  constructor(private readonly db: Db) {}

  /** Новый черновик/подсказка; прежние ожидающие того же вида по сделке устаревают. */
  async add(accountId: number, leadId: number, kind: SuggestionKind, text: string, details: Record<string, unknown> = {}): Promise<number> {
    return withTransaction(this.db, async (c) => {
      await c.query(
        `UPDATE ai_suggestions SET status = 'expired', decided_at = now()
          WHERE account_id = $1 AND lead_id = $2 AND kind = $3 AND status = 'pending'`,
        [accountId, leadId, kind],
      );
      const { rows } = await c.query(
        'INSERT INTO ai_suggestions (account_id, lead_id, kind, text, details) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [accountId, leadId, kind, text, details],
      );
      return Number(rows[0].id);
    });
  }

  async get(accountId: number, id: number): Promise<Suggestion | null> {
    const { rows } = await this.db.query('SELECT * FROM ai_suggestions WHERE account_id = $1 AND id = $2', [accountId, id]);
    return rows[0] ? row(rows[0]) : null;
  }

  async listForLead(accountId: number, leadId: number, limit = 10): Promise<Suggestion[]> {
    const { rows } = await this.db.query(
      'SELECT * FROM ai_suggestions WHERE account_id = $1 AND lead_id = $2 ORDER BY id DESC LIMIT $3',
      [accountId, leadId, limit],
    );
    return rows.map(row);
  }

  /** Очередь черновиков на одобрение по аккаунту. */
  async pendingDrafts(accountId: number, limit = 50): Promise<Suggestion[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM ai_suggestions WHERE account_id = $1 AND kind = 'draft' AND status = 'pending' ORDER BY id LIMIT $2`,
      [accountId, limit],
    );
    return rows.map(row);
  }

  /** Решение менеджера; меняет только ожидающие. Возвращает обновлённую запись или null. */
  async decide(
    accountId: number,
    id: number,
    status: 'approved' | 'rejected' | 'used',
    userId: number,
    text?: string,
  ): Promise<Suggestion | null> {
    const { rows } = await this.db.query(
      `UPDATE ai_suggestions SET status = $3, decided_by = $4, decided_at = now(), text = coalesce($5, text)
        WHERE account_id = $1 AND id = $2 AND status = 'pending' RETURNING *`,
      [accountId, id, status, userId, text ?? null],
    );
    return rows[0] ? row(rows[0]) : null;
  }

  /** Забирает одобренный черновик для отправки ботом-отправщиком. */
  async takeApproved(accountId: number, leadId: number): Promise<Suggestion | null> {
    const { rows } = await this.db.query(
      `UPDATE ai_suggestions SET status = 'sent' WHERE id = (
         SELECT id FROM ai_suggestions WHERE account_id = $1 AND lead_id = $2 AND kind = 'draft' AND status = 'approved'
          ORDER BY decided_at LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [accountId, leadId],
    );
    return rows[0] ? row(rows[0]) : null;
  }

  async markSent(accountId: number, id: number): Promise<void> {
    await this.db.query(`UPDATE ai_suggestions SET status = 'sent' WHERE account_id = $1 AND id = $2`, [accountId, id]);
  }

  /** Вернуть в «одобрено», если отправка не удалась. */
  async markApprovedAgain(accountId: number, id: number): Promise<void> {
    await this.db.query(`UPDATE ai_suggestions SET status = 'approved' WHERE account_id = $1 AND id = $2 AND status = 'sent'`, [accountId, id]);
  }
}
