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
  /** RFD-AI-AGENT-FILES-PRIORITY: новый файл / догрузка старого / отложенный по лимиту. */
  priority: DocumentPriority;
  createdAt: Date;
}

export type DocumentPriority = 'new' | 'backlog' | 'deferred';

export type NewDocument = Omit<DocumentRecord, 'id' | 'createdAt' | 'priority'> & { priority?: DocumentPriority };

/** Разборов за день по группам приоритета — для дневного лимита и показа расхода. */
export interface DocumentsUsage {
  total: number;
  new: number;
  backlog: number;
  deferred: number;
}

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
  priority: ((r.priority as string | null) ?? 'new') as DocumentPriority,
  createdAt: r.created_at as Date,
});

/** Разобранные документы (фаза 3). Файлы не хранятся. */
export class DocumentsRepo {
  constructor(private readonly db: Db) {}

  async add(d: NewDocument): Promise<number> {
    const { rows } = await this.db.query(
      `INSERT INTO documents (account_id, lead_id, source, filename, mime, size_bytes, format, ocr, kind, data, text_chars, pii_removed, model, cost_usd, created_by, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
      [d.accountId, d.leadId, d.source, d.filename, d.mime, d.sizeBytes, d.format, d.ocr, d.kind, d.data, d.textChars, d.piiRemoved, d.model, d.costUsd, d.createdBy, d.priority ?? 'new'],
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

  /** Разборов за день (по Москве; day — ГГГГ-ММ-ДД, без него — сегодня) по группам приоритета. */
  async usageOn(accountId: number, day?: string): Promise<DocumentsUsage> {
    const from = day ? `'${day}'::date` : "date_trunc('day', now() AT TIME ZONE 'Europe/Moscow')";
    const { rows } = await this.db.query<{ priority: string; n: string }>(
      `SELECT priority, count(*) AS n FROM documents
        WHERE account_id = $1 AND created_at >= (${from}) AT TIME ZONE 'Europe/Moscow' AND created_at < ((${from}) + interval '1 day') AT TIME ZONE 'Europe/Moscow'
        GROUP BY priority`,
      [accountId],
    );
    const u: DocumentsUsage = { total: 0, new: 0, backlog: 0, deferred: 0 };
    for (const r of rows) {
      const n = Number(r.n);
      u.total += n;
      if (r.priority === 'backlog') u.backlog += n;
      else if (r.priority === 'deferred') u.deferred += n;
      else u.new += n;
    }
    return u;
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
