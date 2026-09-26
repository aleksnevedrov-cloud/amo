import type { Db } from './pool.ts';

/** Исходы диалогов: где сделка была при первом ответе AI и куда пришла. */
export class OutcomesRepo {
  constructor(private readonly db: Db) {}

  /** Первый контакт AI со сделкой — запоминаем стартовый этап (повторно не перезаписывается). */
  async start(accountId: number, leadId: number, pipelineId: number, statusId: number): Promise<void> {
    await this.db.query(
      `INSERT INTO dialog_outcomes (account_id, lead_id, pipeline_id, first_status_id, last_status_id, last_pipeline_id)
       VALUES ($1, $2, $3, $4, $4, $3) ON CONFLICT (account_id, lead_id) DO NOTHING`,
      [accountId, leadId, pipelineId, statusId],
    );
  }

  /** Сделки, которые пора перепроверить: не закрыты, проверялись давно, AI общался не позже N дней назад. */
  async due(accountId: number, opts: { olderThanMs: number; withinDays: number; limit: number }): Promise<{ leadId: number; pipelineId: number | null; firstStatusId: number | null }[]> {
    const { rows } = await this.db.query(
      `SELECT lead_id, pipeline_id, first_status_id FROM dialog_outcomes
        WHERE account_id = $1 AND NOT won AND NOT lost
          AND first_ai_at >= now() - ($2::bigint || ' days')::interval
          AND (checked_at IS NULL OR checked_at < now() - ($3::bigint || ' milliseconds')::interval)
        ORDER BY checked_at NULLS FIRST LIMIT $4`,
      [accountId, opts.withinDays, opts.olderThanMs, opts.limit],
    );
    return rows.map((r) => ({ leadId: Number(r.lead_id), pipelineId: r.pipeline_id === null ? null : Number(r.pipeline_id), firstStatusId: r.first_status_id === null ? null : Number(r.first_status_id) }));
  }

  async record(accountId: number, leadId: number, r: { statusId: number; pipelineId: number; advanced: boolean; won: boolean; lost: boolean }): Promise<void> {
    await this.db.query(
      `UPDATE dialog_outcomes SET last_status_id = $3, last_pipeline_id = $4, advanced = $5, won = $6, lost = $7, checked_at = now()
        WHERE account_id = $1 AND lead_id = $2`,
      [accountId, leadId, r.statusId, r.pipelineId, r.advanced, r.won, r.lost],
    );
  }

  /** Сделка недоступна (удалена) — больше не проверяем. */
  async markGone(accountId: number, leadId: number): Promise<void> {
    await this.db.query('UPDATE dialog_outcomes SET lost = true, checked_at = now() WHERE account_id = $1 AND lead_id = $2', [accountId, leadId]);
  }

  async accountsWithDue(olderThanMs: number, withinDays: number): Promise<number[]> {
    const { rows } = await this.db.query(
      `SELECT DISTINCT o.account_id FROM dialog_outcomes o JOIN accounts a ON a.id = o.account_id
        WHERE a.uninstalled_at IS NULL AND NOT o.won AND NOT o.lost
          AND o.first_ai_at >= now() - ($2::bigint || ' days')::interval
          AND (o.checked_at IS NULL OR o.checked_at < now() - ($1::bigint || ' milliseconds')::interval)`,
      [olderThanMs, withinDays],
    );
    return rows.map((r) => Number(r.account_id));
  }
}

export const WON_STATUS = 142;
export const LOST_STATUS = 143;

/** Итог по сделке: этап дальше начального в той же воронке, выигрыш или проигрыш. */
export function classifyOutcome(
  first: { pipelineId: number | null; statusId: number | null },
  now: { pipelineId: number; statusId: number },
  order: Map<number, number>,
): { advanced: boolean; won: boolean; lost: boolean } {
  const won = now.statusId === WON_STATUS;
  const lost = now.statusId === LOST_STATUS;
  if (won) return { advanced: true, won, lost: false };
  if (lost) return { advanced: false, won: false, lost };
  if (first.statusId === null || first.pipelineId !== now.pipelineId) return { advanced: false, won, lost };
  const a = order.get(first.statusId);
  const b = order.get(now.statusId);
  return { advanced: a !== undefined && b !== undefined && b > a, won, lost };
}

export interface AnalyticsSummary {
  from: Date;
  to: Date;
  /** Сделок, где AI хоть раз ответил, подготовил черновик или подсказку, передал менеджеру. */
  dialogs: number;
  replies: number;
  drafts: number;
  hints: number;
  handoffs: number;
  documents: number;
  errors: number;
  costRub: number;
  avgCostPerDialogRub: number;
  outcomes: { tracked: number; advanced: number; won: number; lost: number; conversionPct: number | null };
  handoffReasons: { reason: string; count: number }[];
  byDay: { day: string; dialogs: number; replies: number; handoffs: number; costRub: number }[];
}

export interface BillingMonth {
  month: string;
  costRub: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  dialogs: number;
  replies: number;
}

const DIALOG_KINDS = ['reply', 'draft', 'hint', 'handoff'];

/** Аналитика по журналу и исходам (раздел 11.1 ТЗ: диалоги, передачи, конверсия, средняя стоимость). */
export class AnalyticsRepo {
  constructor(private readonly db: Db) {}

  async summary(accountId: number, from: Date, to: Date): Promise<AnalyticsSummary> {
    const params = [accountId, from, to];
    const [totals, reasons, days, outcomes] = await Promise.all([
      this.db.query(
        `SELECT count(DISTINCT lead_id) FILTER (WHERE kind = ANY($4)) AS dialogs,
                count(*) FILTER (WHERE kind = 'reply') AS replies,
                count(*) FILTER (WHERE kind = 'draft' AND details->>'delivery' = 'draft') AS drafts,
                count(*) FILTER (WHERE kind = 'hint') AS hints,
                count(*) FILTER (WHERE kind = 'handoff' AND details ? 'reason') AS handoffs,
                count(*) FILTER (WHERE kind = 'document') AS documents,
                count(*) FILTER (WHERE kind = 'error') AS errors,
                coalesce(sum(cost_rub), 0) AS cost
           FROM ai_journal WHERE account_id = $1 AND created_at >= $2 AND created_at < $3`,
        [...params, DIALOG_KINDS],
      ),
      this.db.query(
        `SELECT details->>'reason' AS reason, count(*) AS n FROM ai_journal
          WHERE account_id = $1 AND created_at >= $2 AND created_at < $3 AND kind = 'handoff' AND details ? 'reason'
          GROUP BY 1 ORDER BY 2 DESC`,
        params,
      ),
      this.db.query(
        `SELECT to_char(created_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS day,
                count(DISTINCT lead_id) FILTER (WHERE kind = ANY($4)) AS dialogs,
                count(*) FILTER (WHERE kind = 'reply') AS replies,
                count(*) FILTER (WHERE kind = 'handoff' AND details ? 'reason') AS handoffs,
                coalesce(sum(cost_rub), 0) AS cost
           FROM ai_journal WHERE account_id = $1 AND created_at >= $2 AND created_at < $3
          GROUP BY 1 ORDER BY 1`,
        [...params, DIALOG_KINDS],
      ),
      this.db.query(
        `SELECT count(*) AS tracked, count(*) FILTER (WHERE advanced) AS advanced,
                count(*) FILTER (WHERE won) AS won, count(*) FILTER (WHERE lost) AS lost
           FROM dialog_outcomes WHERE account_id = $1 AND first_ai_at >= $2 AND first_ai_at < $3`,
        params,
      ),
    ]);
    const t = totals.rows[0] ?? {};
    const o = outcomes.rows[0] ?? {};
    const dialogs = Number(t.dialogs ?? 0);
    const costRub = Number(t.cost ?? 0);
    const tracked = Number(o.tracked ?? 0);
    return {
      from,
      to,
      dialogs,
      replies: Number(t.replies ?? 0),
      drafts: Number(t.drafts ?? 0),
      hints: Number(t.hints ?? 0),
      handoffs: Number(t.handoffs ?? 0),
      documents: Number(t.documents ?? 0),
      errors: Number(t.errors ?? 0),
      costRub,
      avgCostPerDialogRub: dialogs ? costRub / dialogs : 0,
      outcomes: {
        tracked,
        advanced: Number(o.advanced ?? 0),
        won: Number(o.won ?? 0),
        lost: Number(o.lost ?? 0),
        conversionPct: tracked ? (Number(o.advanced ?? 0) / tracked) * 100 : null,
      },
      handoffReasons: reasons.rows.map((r) => ({ reason: String(r.reason), count: Number(r.n) })),
      byDay: days.rows.map((r) => ({ day: String(r.day), dialogs: Number(r.dialogs), replies: Number(r.replies), handoffs: Number(r.handoffs), costRub: Number(r.cost) })),
    };
  }

  /** Расход по месяцам — учёт для биллинга (по решению заказчика тарифов пока нет). */
  async billing(accountId: number, months = 6): Promise<BillingMonth[]> {
    const { rows } = await this.db.query(
      `SELECT to_char(date_trunc('month', created_at AT TIME ZONE 'Europe/Moscow'), 'YYYY-MM') AS month,
              coalesce(sum(cost_rub), 0) AS rub, coalesce(sum(cost_usd), 0) AS usd,
              coalesce(sum(input_tokens), 0) AS inp, coalesce(sum(output_tokens), 0) AS outp,
              count(DISTINCT lead_id) FILTER (WHERE kind = ANY($3)) AS dialogs,
              count(*) FILTER (WHERE kind = 'reply') AS replies
         FROM ai_journal
        WHERE account_id = $1 AND created_at >= date_trunc('month', now() AT TIME ZONE 'Europe/Moscow') - ($2::int || ' months')::interval
        GROUP BY 1 ORDER BY 1 DESC`,
      [accountId, months - 1, DIALOG_KINDS],
    );
    return rows.map((r) => ({
      month: String(r.month),
      costRub: Number(r.rub),
      costUsd: Number(r.usd),
      inputTokens: Number(r.inp),
      outputTokens: Number(r.outp),
      dialogs: Number(r.dialogs),
      replies: Number(r.replies),
    }));
  }
}
