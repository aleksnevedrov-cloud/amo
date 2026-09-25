import type { Db } from './pool.ts';

export type JournalKind =
  | 'reply'
  | 'handoff'
  | 'pause'
  | 'resume'
  | 'skipped'
  | 'blocked'
  | 'error'
  | 'note'
  | 'import'
  | 'sandbox'
  | 'draft'
  | 'hint'
  | 'summary'
  | 'task'
  | 'document';

export interface JournalEntry {
  accountId: number;
  leadId?: number | null;
  kind: JournalKind;
  summary: string;
  details?: Record<string, unknown>;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  costRub?: number;
}

export interface JournalRow extends Required<Omit<JournalEntry, 'leadId'>> {
  id: number;
  leadId: number | null;
  createdAt: Date;
}

export class JournalRepo {
  constructor(private readonly db: Db) {}

  async add(e: JournalEntry): Promise<void> {
    await this.db.query(
      `INSERT INTO ai_journal (account_id, lead_id, kind, summary, details, input_tokens, output_tokens, cost_usd, cost_rub)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        e.accountId,
        e.leadId ?? null,
        e.kind,
        e.summary.slice(0, 2000),
        e.details ?? {},
        e.inputTokens ?? 0,
        e.outputTokens ?? 0,
        e.costUsd ?? 0,
        e.costRub ?? 0,
      ],
    );
  }

  async list(
    accountId: number,
    f: { leadId?: number; kind?: string; before?: number; limit?: number } = {},
  ): Promise<JournalRow[]> {
    const { rows } = await this.db.query(
      `SELECT id, account_id, lead_id, kind, summary, details, input_tokens, output_tokens, cost_usd, cost_rub, created_at
         FROM ai_journal
        WHERE account_id = $1
          AND ($2::bigint IS NULL OR lead_id = $2)
          AND ($3::text IS NULL OR kind = $3)
          AND ($4::bigint IS NULL OR id < $4)
        ORDER BY id DESC LIMIT $5`,
      [accountId, f.leadId ?? null, f.kind ?? null, f.before ?? null, Math.min(f.limit ?? 50, 200)],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      accountId: Number(r.account_id),
      leadId: r.lead_id === null ? null : Number(r.lead_id),
      kind: r.kind,
      summary: r.summary,
      details: r.details,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      costUsd: Number(r.cost_usd),
      costRub: Number(r.cost_rub),
      createdAt: r.created_at,
    }));
  }

  /** Расход за текущие сутки (по времени сервера БД, МСК задаётся timezone БД). */
  async spentTodayRub(accountId: number): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT coalesce(sum(cost_rub), 0) AS s FROM ai_journal WHERE account_id = $1 AND created_at >= date_trunc('day', now())`,
      [accountId],
    );
    return Number(rows[0].s);
  }

  async spentSummary(accountId: number): Promise<{ todayRub: number; monthRub: number }> {
    const { rows } = await this.db.query(
      `SELECT
         coalesce(sum(cost_rub) FILTER (WHERE created_at >= date_trunc('day', now())), 0) AS today,
         coalesce(sum(cost_rub) FILTER (WHERE created_at >= date_trunc('month', now())), 0) AS month
       FROM ai_journal WHERE account_id = $1`,
      [accountId],
    );
    return { todayRub: Number(rows[0].today), monthRub: Number(rows[0].month) };
  }
}
