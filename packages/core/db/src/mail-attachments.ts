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
  /** RFD-AI-AGENT-DEAL-FILES: mail — письмо; deal_file — файл сделки amo; yadisk — ссылка Яндекс Диска из примечания. */
  source: MailAttachmentSource;
}

export type MailAttachmentSource = 'mail' | 'deal_file' | 'yadisk';

export interface NewMailAttachment {
  accountId: number;
  leadId: number | null;
  messageUid: number | null;
  messageId: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  storagePath: string;
  source?: MailAttachmentSource;
}

const mapRow = (r: Record<string, unknown>): MailAttachmentRow => ({
  id: Number(r.id),
  accountId: Number(r.account_id),
  leadId: r.lead_id === null || r.lead_id === undefined ? null : Number(r.lead_id),
  filename: r.filename as string,
  mime: r.mime as string,
  sizeBytes: Number(r.size_bytes),
  storagePath: r.storage_path as string,
  amoFileUuid: (r.amo_file_uuid as string | null) ?? null,
  extractStatus: r.extract_status as string,
  extractedText: (r.extracted_text as string | null) ?? null,
  source: ((r.source as string | null) ?? 'mail') as MailAttachmentSource,
});

export class MailAttachmentsRepo {
  constructor(private readonly db: Db) {}

  /**
   * Вставка идемпотентна по (account_id, message_id, filename, size_bytes):
   * повторный опрос того же письма вернёт created = false и уже сохранённую строку.
   */
  async insert(a: NewMailAttachment): Promise<{ id: number; created: boolean }> {
    const { rows } = await this.db.query<{ id: string; created: boolean }>(
      `INSERT INTO mail_attachments
         (account_id, lead_id, message_uid, message_id, filename, mime, size_bytes, storage_path, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (account_id, message_id, filename, size_bytes) DO NOTHING
       RETURNING id, true AS created`,
      [a.accountId, a.leadId, a.messageUid, a.messageId, a.filename, a.mime, a.sizeBytes, a.storagePath, a.source ?? 'mail'],
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
      `SELECT id, account_id, lead_id, message_id, filename, mime, size_bytes, storage_path, amo_file_uuid, extract_status, extracted_text, created_at, source
         FROM mail_attachments WHERE account_id = $1 AND extract_status = 'deferred' AND storage_path <> '' ORDER BY created_at ASC LIMIT $2`,
      [accountId, limit],
    );
    return rows.map((r) => ({ ...mapRow(r), messageId: r.message_id, createdAt: r.created_at }));
  }

  /** RFD-AI-AGENT-DEAL-FILES: есть ли уже строка с этим ключом (deferred:<hash>) — файл сделки / ссылка уже в очереди или разобрана. */
  async hasMessageId(accountId: number, messageId: string): Promise<boolean> {
    const { rows } = await this.db.query('SELECT 1 FROM mail_attachments WHERE account_id = $1 AND message_id = $2 LIMIT 1', [accountId, messageId]);
    return rows.length > 0;
  }

  /** Файл карточки amo, который агент сам туда загрузил (вложение письма) — amo_file_uuid известен. */
  async findByAmoFileUuid(accountId: number, uuid: string): Promise<MailAttachmentRow | null> {
    const { rows } = await this.db.query(
      `SELECT id, account_id, lead_id, filename, mime, size_bytes, storage_path, amo_file_uuid, extract_status, extracted_text, source
         FROM mail_attachments WHERE account_id = $1 AND amo_file_uuid = $2 LIMIT 1`,
      [accountId, uuid],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /** Тот же файл у сделки по имени и размеру (из письма, файла сделки или ссылки) — второй раз не разбираем. */
  async findByNameSize(accountId: number, leadId: number, filename: string, sizeBytes: number): Promise<MailAttachmentRow | null> {
    const { rows } = await this.db.query(
      `SELECT id, account_id, lead_id, filename, mime, size_bytes, storage_path, amo_file_uuid, extract_status, extracted_text, source
         FROM mail_attachments WHERE account_id = $1 AND lead_id = $2 AND lower(filename) = lower($3) AND size_bytes = $4 ORDER BY id ASC LIMIT 1`,
      [accountId, leadId, filename, sizeBytes],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /** Разобранные файлы сделки и ссылок Диска за период — для контекста агента («Менеджер приложил файл к сделке»). */
  async listDealFiles(accountId: number, leadId: number, since: Date, limit = 30): Promise<(MailAttachmentRow & { createdAt: Date })[]> {
    const { rows } = await this.db.query(
      `SELECT id, account_id, lead_id, filename, mime, size_bytes, storage_path, amo_file_uuid, extract_status, extracted_text, source, created_at
         FROM mail_attachments WHERE account_id = $1 AND lead_id = $2 AND source IN ('deal_file', 'yadisk') AND created_at >= $3 ORDER BY created_at ASC LIMIT $4`,
      [accountId, leadId, since, limit],
    );
    return rows.map((r) => ({ ...mapRow(r), createdAt: r.created_at }));
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
              amo_file_uuid, extract_status, extracted_text, source
         FROM mail_attachments WHERE id = $1`,
      [id],
    );
    const r = rows[0];
    return r ? mapRow(r) : null;
  }

  /** RFD-AI-AGENT-WA-FILES: вложения писем сделки за период с извлечённым текстом — для ленты итога дня. */
  async listByLeadBetween(accountId: number, leadId: number, since: Date, until: Date, limit = 50): Promise<(MailAttachmentRow & { messageId: string; createdAt: Date })[]> {
    const { rows } = await this.db.query(
      `SELECT id, account_id, lead_id, message_id, filename, mime, size_bytes, storage_path, amo_file_uuid, extract_status, extracted_text, created_at, source
         FROM mail_attachments
         WHERE account_id = $1 AND lead_id = $2 AND created_at >= $3 AND created_at < $4
         ORDER BY created_at ASC LIMIT $5`,
      [accountId, leadId, since, until, limit],
    );
    return rows.map((r) => ({ ...mapRow(r), messageId: r.message_id, createdAt: r.created_at }));
  }

  async listByLead(accountId: number, leadId: number, limit = 50): Promise<MailAttachmentRow[]> {
    const { rows } = await this.db.query(
      `SELECT id, account_id, lead_id, filename, mime, size_bytes, storage_path,
              amo_file_uuid, extract_status, extracted_text, source
         FROM mail_attachments
         WHERE account_id = $1 AND lead_id = $2
         ORDER BY created_at DESC LIMIT $3`,
      [accountId, leadId, limit],
    );
    return rows.map(mapRow);
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
