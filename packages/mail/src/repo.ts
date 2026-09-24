import type { Db } from '@ai-door/db';
import type { SecretBox } from '@ai-door/shared';

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

  async setPassword(accountId: number, password: string, userId: number): Promise<void> {
    await this.db.query(
      `INSERT INTO mailbox_credentials (account_id, password_enc, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (account_id) DO UPDATE SET password_enc = EXCLUDED.password_enc, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [accountId, this.box.encrypt(password), userId],
    );
  }

  async getPassword(accountId: number): Promise<string | null> {
    const { rows } = await this.db.query('SELECT password_enc FROM mailbox_credentials WHERE account_id = $1', [accountId]);
    return rows[0] ? this.box.decrypt(rows[0].password_enc) : null;
  }

  async hasPassword(accountId: number): Promise<boolean> {
    const { rows } = await this.db.query('SELECT 1 FROM mailbox_credentials WHERE account_id = $1', [accountId]);
    return rows.length > 0;
  }

  async folderState(accountId: number, folder: string): Promise<FolderState | null> {
    const { rows } = await this.db.query(
      'SELECT uid_validity, last_uid, last_ok_at, last_error, last_error_at FROM mailbox_state WHERE account_id = $1 AND folder = $2',
      [accountId, folder],
    );
    const r = rows[0];
    return r
      ? { uidValidity: r.uid_validity, lastUid: Number(r.last_uid), lastOkAt: r.last_ok_at, lastError: r.last_error, lastErrorAt: r.last_error_at }
      : null;
  }

  async saveFolderState(accountId: number, folder: string, uidValidity: string, lastUid: number): Promise<void> {
    await this.db.query(
      `INSERT INTO mailbox_state (account_id, folder, uid_validity, last_uid, last_ok_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (account_id, folder) DO UPDATE
         SET uid_validity = EXCLUDED.uid_validity, last_uid = EXCLUDED.last_uid, last_ok_at = now(), last_error = NULL, last_error_at = NULL`,
      [accountId, folder, uidValidity, lastUid],
    );
  }

  async markError(accountId: number, folder: string, error: string): Promise<void> {
    await this.db.query(
      `INSERT INTO mailbox_state (account_id, folder, uid_validity, last_uid, last_error, last_error_at) VALUES ($1, $2, '', 0, $3, now())
       ON CONFLICT (account_id, folder) DO UPDATE SET last_error = EXCLUDED.last_error, last_error_at = now()`,
      [accountId, folder, error.slice(0, 1000)],
    );
  }

  async status(accountId: number): Promise<{ folder: string; lastOkAt: Date | null; lastError: string | null }[]> {
    const { rows } = await this.db.query('SELECT folder, last_ok_at, last_error FROM mailbox_state WHERE account_id = $1 ORDER BY folder', [accountId]);
    return rows.map((r) => ({ folder: r.folder, lastOkAt: r.last_ok_at, lastError: r.last_error }));
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
}
