import type { Db } from './pool.ts';
import type { LlmModelRef, LlmProviderId } from './settings.ts';

/** Кэш списка моделей провайдера по аккаунту (раздел 4 ТЗ: 24 ч + «Обновить список»). */
export class ModelsCacheRepo {
  constructor(private readonly db: Db) {}

  async get<T = unknown>(accountId: number, provider: LlmProviderId): Promise<{ models: T[]; fetchedAt: Date } | null> {
    const { rows } = await this.db.query('SELECT models, fetched_at FROM llm_models_cache WHERE account_id = $1 AND provider = $2', [accountId, provider]);
    return rows[0] ? { models: rows[0].models as T[], fetchedAt: rows[0].fetched_at as Date } : null;
  }

  async set(accountId: number, provider: LlmProviderId, models: unknown[]): Promise<void> {
    await this.db.query(
      `INSERT INTO llm_models_cache (account_id, provider, models, fetched_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (account_id, provider) DO UPDATE SET models = EXCLUDED.models, fetched_at = now()`,
      [accountId, provider, JSON.stringify(models)],
    );
  }

  async clear(accountId: number, provider: LlmProviderId): Promise<void> {
    await this.db.query('DELETE FROM llm_models_cache WHERE account_id = $1 AND provider = $2', [accountId, provider]);
  }
}

export type EvalRunStatus = 'running' | 'done' | 'failed';

export interface EvalRun {
  id: number;
  accountId: number;
  status: EvalRunStatus;
  models: LlmModelRef[];
  dialogIds: string[];
  results: unknown[];
  summary: unknown | null;
  error: string | null;
  startedBy: number | null;
  startedAt: Date;
  finishedAt: Date | null;
}

const row = (r: Record<string, unknown>): EvalRun => ({
  id: Number(r.id),
  accountId: Number(r.account_id),
  status: r.status as EvalRunStatus,
  models: (r.models as LlmModelRef[]) ?? [],
  dialogIds: (r.dialog_ids as string[]) ?? [],
  results: (r.results as unknown[]) ?? [],
  summary: r.summary ?? null,
  error: (r.error as string | null) ?? null,
  startedBy: r.started_by === null ? null : Number(r.started_by),
  startedAt: r.started_at as Date,
  finishedAt: (r.finished_at as Date | null) ?? null,
});

/** Прогоны eval-набора на моделях (раздел 7 ТЗ). */
export class EvalRunsRepo {
  constructor(private readonly db: Db) {}

  async start(accountId: number, models: LlmModelRef[], dialogIds: string[], userId: number | null): Promise<number> {
    const { rows } = await this.db.query(
      'INSERT INTO eval_runs (account_id, models, dialog_ids, started_by) VALUES ($1, $2, $3, $4) RETURNING id',
      [accountId, JSON.stringify(models), JSON.stringify(dialogIds), userId],
    );
    return Number(rows[0].id);
  }

  async progress(accountId: number, id: number, results: unknown[]): Promise<void> {
    await this.db.query('UPDATE eval_runs SET results = $3 WHERE account_id = $1 AND id = $2', [accountId, id, JSON.stringify(results)]);
  }

  async finish(accountId: number, id: number, r: { results: unknown[]; summary: unknown } | { error: string }): Promise<void> {
    if ('error' in r) {
      await this.db.query(`UPDATE eval_runs SET status = 'failed', error = $3, finished_at = now() WHERE account_id = $1 AND id = $2`, [accountId, id, r.error.slice(0, 2000)]);
      return;
    }
    await this.db.query(`UPDATE eval_runs SET status = 'done', results = $3, summary = $4, finished_at = now() WHERE account_id = $1 AND id = $2`, [
      accountId,
      id,
      JSON.stringify(r.results),
      JSON.stringify(r.summary),
    ]);
  }

  async get(accountId: number, id: number): Promise<EvalRun | null> {
    const { rows } = await this.db.query('SELECT * FROM eval_runs WHERE account_id = $1 AND id = $2', [accountId, id]);
    return rows[0] ? row(rows[0]) : null;
  }

  async list(accountId: number, limit = 10): Promise<EvalRun[]> {
    const { rows } = await this.db.query('SELECT * FROM eval_runs WHERE account_id = $1 ORDER BY id DESC LIMIT $2', [accountId, limit]);
    return rows.map(row);
  }

  async running(accountId: number): Promise<EvalRun | null> {
    const { rows } = await this.db.query(`SELECT * FROM eval_runs WHERE account_id = $1 AND status = 'running' ORDER BY id DESC LIMIT 1`, [accountId]);
    return rows[0] ? row(rows[0]) : null;
  }
}
