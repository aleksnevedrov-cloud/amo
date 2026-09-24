import type { StoredTokens, TokenPair, TokenStore } from '@ai-door/amo';
import type { SecretBox } from '@ai-door/shared';
import { withTransaction, type Db } from './pool.ts';

export interface TokenStatus {
  expiresAt: Date;
  refreshedAt: Date;
  lastError: string | null;
  lastErrorAt: Date | null;
}

export class PgTokenStore implements TokenStore {
  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
  ) {}

  /** Сохранение пары после первичной авторизации. */
  async put(accountId: number, t: TokenPair): Promise<void> {
    await this.db.query(
      `INSERT INTO amo_tokens (account_id, access_token_enc, refresh_token_enc, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id) DO UPDATE
         SET access_token_enc = EXCLUDED.access_token_enc,
             refresh_token_enc = EXCLUDED.refresh_token_enc,
             expires_at = EXCLUDED.expires_at,
             refreshed_at = now(), last_error = NULL, last_error_at = NULL`,
      [accountId, this.box.encrypt(t.accessToken), this.box.encrypt(t.refreshToken), t.expiresAt],
    );
  }

  withLock<T>(
    accountId: number,
    fn: (current: StoredTokens | null, save: (t: TokenPair) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    return withTransaction(this.db, async (c) => {
      const { rows } = await c.query(
        `SELECT t.access_token_enc, t.refresh_token_enc, t.expires_at, a.account_domain
           FROM amo_tokens t JOIN accounts a ON a.id = t.account_id
          WHERE t.account_id = $1 AND a.uninstalled_at IS NULL
          FOR UPDATE OF t`,
        [accountId],
      );
      const r = rows[0];
      const current: StoredTokens | null = r
        ? {
            accountId,
            accountDomain: r.account_domain,
            accessToken: this.box.decrypt(r.access_token_enc),
            refreshToken: this.box.decrypt(r.refresh_token_enc),
            expiresAt: r.expires_at,
          }
        : null;
      const save = async (t: TokenPair) => {
        await c.query(
          `UPDATE amo_tokens SET access_token_enc = $2, refresh_token_enc = $3, expires_at = $4,
                  refreshed_at = now(), last_error = NULL, last_error_at = NULL
            WHERE account_id = $1`,
          [accountId, this.box.encrypt(t.accessToken), this.box.encrypt(t.refreshToken), t.expiresAt],
        );
      };
      return fn(current, save);
    });
  }

  async markError(accountId: number, error: string): Promise<void> {
    await this.db.query('UPDATE amo_tokens SET last_error = $2, last_error_at = now() WHERE account_id = $1', [
      accountId,
      error.slice(0, 1000),
    ]);
  }

  async listExpiring(before: Date): Promise<number[]> {
    const { rows } = await this.db.query(
      `SELECT t.account_id FROM amo_tokens t JOIN accounts a ON a.id = t.account_id
        WHERE t.expires_at < $1 AND a.uninstalled_at IS NULL ORDER BY t.expires_at`,
      [before],
    );
    return rows.map((r) => Number(r.account_id));
  }

  async status(accountId: number): Promise<TokenStatus | null> {
    const { rows } = await this.db.query(
      'SELECT expires_at, refreshed_at, last_error, last_error_at FROM amo_tokens WHERE account_id = $1',
      [accountId],
    );
    const r = rows[0];
    return r
      ? { expiresAt: r.expires_at, refreshedAt: r.refreshed_at, lastError: r.last_error, lastErrorAt: r.last_error_at }
      : null;
  }
}
