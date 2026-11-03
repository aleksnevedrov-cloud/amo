import type { Db } from '@core/db';
import type { SecretBox } from '@core/shared';

export interface FolderState {
  uidValidity: string;
  lastUid: number;
  lastOkAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
}

export class MailRepo {
  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
  ) {}

  /** Пароль ящика (RFD-AI-AGENT-FIX-PACK-2410, ч. 2: на каждый ящик; прежний — main). */
  async setPassword(accountId: number, mailboxId: string, password: string, userId: number): Promise<void> {
    await this.db.query(
      `INSERT INTO mailbox_credentials (account_id, mailbox_id, password_enc, updated_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id, mailbox_id) DO UPDATE SET password_enc = EXCLUDED.password_enc, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [accountId, mailboxId, this.box.encrypt(password), userId],
    );
  }

  async getPassword(accountId: number, mailboxId = 'main'): Promise<string | null> {
    const { rows } = await this.db.query('SELECT password_enc FROM mailbox_credentials WHERE account_id = $1 AND mailbox_id = $2', [accountId, mailboxId]);
    return rows[0] ? this.box.decrypt(rows[0].password_enc) : null;
  }

  /** Пароль и когда он менялся: по дате опрос понимает, что после отказа входа заказчик ввёл новый пароль. */
  async credentials(accountId: number, mailboxId = 'main'): Promise<{ password: string; updatedAt: Date } | null> {
    const { rows } = await this.db.query('SELECT password_enc, updated_at FROM mailbox_credentials WHERE account_id = $1 AND mailbox_id = $2', [accountId, mailboxId]);
    return rows[0] ? { password: this.box.decrypt(rows[0].password_enc), updatedAt: rows[0].updated_at } : null;
  }

  async hasPassword(accountId: number, mailboxId = 'main'): Promise<boolean> {
    const { rows } = await this.db.query('SELECT 1 FROM mailbox_credentials WHERE account_id = $1 AND mailbox_id = $2', [accountId, mailboxId]);
    return rows.length > 0;
  }

  /** Ящики, у которых сохранён пароль. */
  async mailboxesWithPassword(accountId: number): Promise<Set<string>> {
    const { rows } = await this.db.query<{ mailbox_id: string }>('SELECT mailbox_id FROM mailbox_credentials WHERE account_id = $1', [accountId]);
    return new Set(rows.map((r) => r.mailbox_id));
  }

  async deletePassword(accountId: number, mailboxId: string): Promise<void> {
    await this.db.query('DELETE FROM mailbox_credentials WHERE account_id = $1 AND mailbox_id = $2', [accountId, mailboxId]);
  }

  async folderState(accountId: number, mailboxId: string, folder: string): Promise<FolderState | null> {
    const { rows } = await this.db.query(
      'SELECT uid_validity, last_uid, last_ok_at, last_error, last_error_at FROM mailbox_state WHERE account_id = $1 AND mailbox_id = $2 AND folder = $3',
      [accountId, mailboxId, folder],
    );
    const r = rows[0];
    return r
      ? { uidValidity: r.uid_validity, lastUid: Number(r.last_uid), lastOkAt: r.last_ok_at, lastError: r.last_error, lastErrorAt: r.last_error_at }
      : null;
  }

  async saveFolderState(accountId: number, mailboxId: string, folder: string, uidValidity: string, lastUid: number): Promise<void> {
    await this.db.query(
      `INSERT INTO mailbox_state (account_id, mailbox_id, folder, uid_validity, last_uid, last_ok_at) VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (account_id, mailbox_id, folder) DO UPDATE
         SET uid_validity = EXCLUDED.uid_validity, last_uid = EXCLUDED.last_uid, last_ok_at = now(), last_error = NULL, last_error_at = NULL`,
      [accountId, mailboxId, folder, uidValidity, lastUid],
    );
  }

  async markError(accountId: number, mailboxId: string, folder: string, error: string): Promise<void> {
    await this.db.query(
      `INSERT INTO mailbox_state (account_id, mailbox_id, folder, uid_validity, last_uid, last_error, last_error_at) VALUES ($1, $2, $3, '', 0, $4, now())
       ON CONFLICT (account_id, mailbox_id, folder) DO UPDATE SET last_error = EXCLUDED.last_error, last_error_at = now()`,
      [accountId, mailboxId, folder, error.slice(0, 1000)],
    );
  }

  async status(accountId: number): Promise<{ mailboxId: string; folder: string; lastOkAt: Date | null; lastError: string | null }[]> {
    const { rows } = await this.db.query('SELECT mailbox_id, folder, last_ok_at, last_error FROM mailbox_state WHERE account_id = $1 ORDER BY mailbox_id, folder', [accountId]);
    return rows.map((r) => ({ mailboxId: r.mailbox_id, folder: r.folder, lastOkAt: r.last_ok_at, lastError: r.last_error }));
  }

  async logOutbound(accountId: number, leadId: number, to: string, messageId: string): Promise<void> {
    await this.db.query(
      'INSERT INTO email_outbound (account_id, lead_id, to_address, message_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [accountId, leadId, to.toLowerCase(), messageId],
    );
  }

  async repliesToday(accountId: number, to: string): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT count(*)::int AS n FROM email_outbound WHERE account_id = $1 AND lower(to_address) = $2 AND sent_at > now() - interval '24 hours'`,
      [accountId, to.toLowerCase()],
    );
    return rows[0].n;
  }

  async isOurMessage(accountId: number, messageId: string): Promise<boolean> {
    const { rows } = await this.db.query('SELECT 1 FROM email_outbound WHERE account_id = $1 AND message_id = $2', [accountId, messageId]);
    return rows.length > 0;
  }

  async managerWrote(accountId: number, address: string, at: Date): Promise<void> {
    await this.db.query(
      `INSERT INTO email_manager_activity (account_id, address, last_at) VALUES ($1, $2, $3)
       ON CONFLICT (account_id, address) DO UPDATE SET last_at = GREATEST(email_manager_activity.last_at, EXCLUDED.last_at)`,
      [accountId, address.toLowerCase(), at],
    );
  }

  async managerRepliedSince(accountId: number, addresses: string[], since: Date): Promise<boolean> {
    if (!addresses.length) return false;
    const { rows } = await this.db.query(
      'SELECT 1 FROM email_manager_activity WHERE account_id = $1 AND address = ANY($2) AND last_at > $3 LIMIT 1',
      [accountId, addresses.map((a) => a.toLowerCase()), since],
    );
    return rows.length > 0;
  }

  /** Письмо ждёт, пока почта amo создаст сделку. */

  async addWaiting(accountId: number, w: { from: string; fromName: string; subject: string; text: string; meta: Record<string, unknown> }): Promise<void> {
    await this.db.query(
      'INSERT INTO email_waiting (account_id, from_address, from_name, subject, text, meta) VALUES ($1, $2, $3, $4, $5, $6)',
      [accountId, w.from.toLowerCase(), w.fromName, w.subject, w.text, w.meta],
    );
  }

  async listWaiting(accountId: number): Promise<{ id: number; from: string; fromName: string; subject: string; text: string; meta: Record<string, unknown>; receivedAt: Date }[]> {
    const { rows } = await this.db.query(
      'SELECT id, from_address, from_name, subject, text, meta, received_at FROM email_waiting WHERE account_id = $1 ORDER BY id LIMIT 100',
      [accountId],
    );
    return rows.map((r) => ({ id: Number(r.id), from: r.from_address, fromName: r.from_name, subject: r.subject, text: r.text, meta: r.meta, receivedAt: r.received_at }));
  }

  async removeWaiting(accountId: number, id: number): Promise<void> {
    await this.db.query('DELETE FROM email_waiting WHERE account_id = $1 AND id = $2', [accountId, id]);
  }
}
