import type { Db } from './pool.ts';

/**
 * RFD-AI-AGENT-DEAL-FILES, часть Б: ссылки Яндекс Диска из примечаний сделки — одна строка на (сделка, ссылка): статус, попытки,
 * последняя ошибка Диска. 404 / закрыт доступ — failed без повторов; 429 и сеть — retry до трёх раз.
 */
export interface DealFileLinkRow {
  id: number;
  accountId: number;
  leadId: number;
  noteId: number | null;
  url: string;
  status: 'queued' | 'done' | 'failed' | 'retry';
  attempts: number;
  files: number;
  error: string | null;
  createdAt: Date;
}

const map = (r: Record<string, unknown>): DealFileLinkRow => ({
  id: Number(r.id),
  accountId: Number(r.account_id),
  leadId: Number(r.lead_id),
  noteId: r.note_id === null || r.note_id === undefined ? null : Number(r.note_id),
  url: r.url as string,
  status: r.status as DealFileLinkRow['status'],
  attempts: Number(r.attempts ?? 0),
  files: Number(r.files ?? 0),
  error: (r.error as string | null) ?? null,
  createdAt: r.created_at as Date,
});

export class DealFileLinksRepo {
  constructor(private readonly db: Db) {}

  /** Занять ссылку: новая строка или уже существующая (повтор события / та же ссылка в другом примечании той же сделки). */
  async claim(r: { accountId: number; leadId: number; noteId: number | null; url: string }): Promise<{ row: DealFileLinkRow; created: boolean }> {
    const { rows } = await this.db.query(
      `INSERT INTO deal_file_links (account_id, lead_id, note_id, url) VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id, lead_id, url) DO NOTHING RETURNING *`,
      [r.accountId, r.leadId, r.noteId, r.url],
    );
    if (rows[0]) return { row: map(rows[0]), created: true };
    const old = await this.db.query('SELECT * FROM deal_file_links WHERE account_id = $1 AND lead_id = $2 AND url = $3', [r.accountId, r.leadId, r.url]);
    return { row: map(old.rows[0]), created: false };
  }

  async setDone(id: number, files: number): Promise<void> {
    await this.db.query(`UPDATE deal_file_links SET status = 'done', files = $2, error = NULL, updated_at = now() WHERE id = $1`, [id, files]);
  }

  /** Ошибка: retry — повтор следующим проходом (попытка засчитана), иначе — failed без повторов. */
  async setFailed(id: number, error: string, retry: boolean): Promise<void> {
    await this.db.query(`UPDATE deal_file_links SET status = $3, attempts = attempts + 1, error = $2, updated_at = now() WHERE id = $1`, [id, error.slice(0, 1000), retry ? 'retry' : 'failed']);
  }

  /** На повтор: 429 и сетевые, попыток меньше max. */
  async listRetry(accountId: number, maxAttempts: number, limit = 20): Promise<DealFileLinkRow[]> {
    const { rows } = await this.db.query(`SELECT * FROM deal_file_links WHERE account_id = $1 AND status = 'retry' AND attempts < $2 ORDER BY updated_at ASC LIMIT $3`, [accountId, maxAttempts, limit]);
    return rows.map(map);
  }

  async forLead(accountId: number, leadId: number): Promise<DealFileLinkRow[]> {
    const { rows } = await this.db.query('SELECT * FROM deal_file_links WHERE account_id = $1 AND lead_id = $2 ORDER BY id ASC', [accountId, leadId]);
    return rows.map(map);
  }
}
