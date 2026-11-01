import type { Db } from './pool.ts';

export interface MailAttachmentRow {
  id: number;
  accountId: number;
  leadId: number | null;
  filename: string;
  mime: string;
  sizeBytes: number;
  storagePath: string;
  amoFileUuid: string | null;
  extractStatus: string;
  extractedText: string | null;
}

export interface NewMailAttachment {
  accountId: number;
  leadId: number | null;
  messageUid: number | null;
  messageId: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  storagePath: string;
}

export class MailAttachmentsRepo {
  constructor(private readonly db: Db) {}

  /**
   * Вставка идемпотентна по (account_id, message_id, filename, size_bytes):
   * повторный опрос того же письма вернёт created = false и уже сохранённую строку.
   */
  async insert(a: NewMailAttachment): Promise<{ id: number; created: boolean }> {
    const { rows } = await this.db.query<{ id: string; created: boolean }>(
      `INSERT INTO mail_attachments
         (account_id, lead_id, message_uid, message_id, filename, mime, size_bytes, storage_path)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (account_id, message_id, filename, size_bytes) DO NOTHING
       RETURNING id, true AS created`,
      [a.accountId, a.leadId, a.messageUid, a.messageId, a.filename, a.mime, a.sizeBytes, a.storagePath],
    );
    if (rows[0]) return { id: Number(rows[0].id), created: true };
    const old = await this.db.query<{ id: string }>(
      `SELECT id FROM mail_attachments
         WHERE account_id = $1 AND message_id = $2 AND filename = $3 AND size_bytes = $4`,
      [a.accountId, a.messageId, a.filename, a.sizeBytes],
    );
    return { id: Number(old.rows[0]?.id ?? 0), created: false };
  }

  /** Сделка могла появиться позже самого письма. */
  async setLead(id: number, leadId: number): Promise<void> {
    await this.db.query('UPDATE mail_attachments SET lead_id = $2 WHERE id = $1', [id, leadId]);
  }

  /** Текст вложения, извлечённый при разборе письма (этап 2 темы RFD-AI-AGENT-KP). */
  async setExtract(
    id: number,
    r: { text?: string | null; error?: string | null; deferred?: boolean },
  ): Promise<void> {
    await this.db.query(
      `UPDATE mail_attachments
          SET extracted_text = $2,
              extract_status = $3,
              extract_error = $4,
              extracted_at = now()
        WHERE id = $1`,
      [id, r.text ?? null, r.deferred ? 'deferred' : r.error ? 'error' : 'done', r.error ? r.error.slice(0, 500) : null],
    );
  }

  /** RFD-AI-AGENT-FILES-PRIORITY: вложения, отложенные по дневному лимиту, — на повторный разбор (старые раньше). */
  async listDeferred(accountId: number, limit = 20): Promise<(MailAttachmentRow & { messageId: string; createdAt: Date })[]> {
    const { rows } = await this.db.query(
      `SELECT id, account_id, lead_id, message_id, filename, mime, size_bytes, storage_path, amo_file_uuid, extract_status, extracted_text, created_at
         FROM mail_attachments WHERE account_id = $1 AND extract_status = 'deferred' AND storage_path <> '' ORDER BY created_at ASC LIMIT $2`,
      [accountId, limit],
    );
    return rows.map((r) => ({ id: Number(r.id), accountId: Number(r.account_id), leadId: r.lead_id === null ? null : Number(r.lead_id), messageId: r.message_id, filename: r.filename, mime: r.mime, sizeBytes: Number(r.size_bytes), storagePath: r.storage_path, amoFileUuid: r.amo_file_uuid, extractStatus: r.extract_status, extractedText: r.extracted_text, createdAt: r.created_at }));
  }

  async markUploaded(id: number, fileUuid: string): Promise<void> {
    await this.db.query(
      'UPDATE mail_attachments SET amo_file_uuid = $2, amo_error = NULL WHERE id = $1',
      [id, fileUuid],
    );
  }

  async markUploadError(id: number, error: string): Promise<void> {
    await this.db.query('UPDATE mail_attachments SET amo_error = $2 WHERE id = $1', [
      id,
      error.slice(0, 500),
    ]);
  }

  async byId(id: number): Promise<MailAttachmentRow | null> {
    const { rows } = await this.db.query(
      `SELECT id, account_id, lead_id, filename, mime, size_bytes, storage_path,
              amo_file_uuid, extract_status, extracted_text
         FROM mail_attachments WHERE id = $1`,
      [id],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: Number(r.id),
      accountId: Number(r.account_id),
      leadId: r.lead_id === null ? null : Number(r.lead_id),
      filename: r.filename,
      mime: r.mime,
      sizeBytes: Number(r.size_bytes),
      storagePath: r.storage_path,
      amoFileUuid: r.amo_file_uuid,
      extractStatus: r.extract_status,
      extractedText: r.extracted_text,
    };
  }

  /** RFD-AI-AGENT-WA-FILES: вложения писем сделки за период с извлечённым текстом — для ленты итога дня. */
  async listByLeadBetween(accountId: number, leadId: number, since: Date, until: Date, limit = 50): Promise<(MailAttachmentRow & { messageId: string; createdAt: Date })[]> {
    const { rows } = await this.db.query(
      `SELECT id, account_id, lead_id, message_id, filename, mime, size_bytes, storage_path, amo_file_uuid, extract_status, extracted_text, created_at
         FROM mail_attachments
         WHERE account_id = $1 AND lead_id = $2 AND created_at >= $3 AND created_at < $4
         ORDER BY created_at ASC LIMIT $5`,
      [accountId, leadId, since, until, limit],
    );
    return rows.map((r) => ({ id: Number(r.id), accountId: Number(r.account_id), leadId: r.lead_id === null ? null : Number(r.lead_id), messageId: r.message_id, filename: r.filename, mime: r.mime, sizeBytes: Number(r.size_bytes), storagePath: r.storage_path, amoFileUuid: r.amo_file_uuid, extractStatus: r.extract_status, extractedText: r.extracted_text, createdAt: r.created_at }));
  }

  async listByLead(accountId: number, leadId: number, limit = 50): Promise<MailAttachmentRow[]> {
    const { rows } = await this.db.query(
      `SELECT id, account_id, lead_id, filename, mime, size_bytes, storage_path,
              amo_file_uuid, extract_status, extracted_text
         FROM mail_attachments
         WHERE account_id = $1 AND lead_id = $2
         ORDER BY created_at DESC LIMIT $3`,
      [accountId, leadId, limit],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      accountId: Number(r.account_id),
      leadId: r.lead_id === null ? null : Number(r.lead_id),
      filename: r.filename,
      mime: r.mime,
      sizeBytes: Number(r.size_bytes),
      storagePath: r.storage_path,
      amoFileUuid: r.amo_file_uuid,
      extractStatus: r.extract_status,
      extractedText: r.extracted_text,
    }));
  }

  /** Пути файлов старше N дней — для чистки диска; строки остаются как след. */
  async pathsOlderThan(days: number, limit = 500): Promise<{ id: number; path: string }[]> {
    const { rows } = await this.db.query(
      `SELECT id, storage_path FROM mail_attachments
         WHERE storage_path <> '' AND created_at < now() - ($1 || ' days')::interval
         ORDER BY created_at ASC LIMIT $2`,
      [String(days), limit],
    );
    return rows.map((r) => ({ id: Number(r.id), path: r.storage_path }));
  }

  async clearPath(id: number): Promise<void> {
    await this.db.query("UPDATE mail_attachments SET storage_path = '' WHERE id = $1", [id]);
  }
}
