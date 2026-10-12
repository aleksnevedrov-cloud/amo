import type { Db } from './pool.ts';

export type DocumentSource = 'chat' | 'email' | 'widget' | 'sandbox';

export interface DocumentRecord {
  id: number;
  accountId: number;
  leadId: number | null;
  source: DocumentSource;
  filename: string | null;
  mime: string | null;
  sizeBytes: number;
  format: string;
  ocr: string | null;
  kind: string;
  data: Record<string, unknown>;
  textChars: number;
  piiRemoved: number;
  model: string | null;
  costUsd: number;
  createdBy: number | null;
  createdAt: Date;
}

export type NewDocument = Omit<DocumentRecord, 'id' | 'createdAt'>;

const row = (r: Record<string, unknown>): DocumentRecord => ({
  id: Number(r.id),
  accountId: Number(r.account_id),
  leadId: r.lead_id === null ? null : Number(r.lead_id),
  source: r.source as DocumentSource,
  filename: (r.filename as string | null) ?? null,
  mime: (r.mime as string | null) ?? null,
  sizeBytes: Number(r.size_bytes),
  format: r.format as string,
  ocr: (r.ocr as string | null) ?? null,
  kind: r.kind as string,
  data: (r.data as Record<string, unknown>) ?? {},
  textChars: Number(r.text_chars),
  piiRemoved: Number(r.pii_removed),
  model: (r.model as string | null) ?? null,
  costUsd: Number(r.cost_usd),
  createdBy: r.created_by === null ? null : Number(r.created_by),
  createdAt: r.created_at as Date,
});

/** Разобранные документы (фаза 3). Файлы не хранятся. */
export class DocumentsRepo {
  constructor(private readonly db: Db) {}

  async add(d: NewDocument): Promise<number> {
    const { rows } = await this.db.query(
      `INSERT INTO documents (account_id, lead_id, source, filename, mime, size_bytes, format, ocr, kind, data, text_chars, pii_removed, model, cost_usd, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [d.accountId, d.leadId, d.source, d.filename, d.mime, d.sizeBytes, d.format, d.ocr, d.kind, d.data, d.textChars, d.piiRemoved, d.model, d.costUsd, d.createdBy],
    );
    return Number(rows[0].id);
  }

  async get(accountId: number, id: number): Promise<DocumentRecord | null> {
    const { rows } = await this.db.query('SELECT * FROM documents WHERE account_id = $1 AND id = $2', [accountId, id]);
    return rows[0] ? row(rows[0]) : null;
  }

  /** Разборов за сегодня (по Москве) — для дневного лимита. */
  async countToday(accountId: number): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT count(*) AS n FROM documents WHERE account_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow'`,
      [accountId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async listForLead(accountId: number, leadId: number, limit = 20): Promise<DocumentRecord[]> {
    const { rows } = await this.db.query('SELECT * FROM documents WHERE account_id = $1 AND lead_id = $2 ORDER BY created_at DESC LIMIT $3', [
      accountId,
      leadId,
      limit,
    ]);
    return rows.map(row);
  }
}
