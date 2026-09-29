import type { SecretBox } from '@ai-door/shared';
import type { Db } from './pool.ts';

export type SecretKind = 'anthropic' | 'openai';
export const SECRET_KINDS: readonly SecretKind[] = ['anthropic', 'openai'];

/** Секреты аккаунта (ключи провайдеров), зашифрованные; обратно через API не отдаются. */
export class SecretsRepo {
  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
  ) {}

  async set(accountId: number, kind: SecretKind, value: string, userId: number): Promise<void> {
    await this.db.query(
      `INSERT INTO account_secrets (account_id, kind, value_enc, updated_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id, kind) DO UPDATE SET value_enc = EXCLUDED.value_enc, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [accountId, kind, this.box.encrypt(value), userId],
    );
  }

  async get(accountId: number, kind: SecretKind): Promise<string | null> {
    const { rows } = await this.db.query('SELECT value_enc FROM account_secrets WHERE account_id = $1 AND kind = $2', [accountId, kind]);
    return rows[0] ? this.box.decrypt(rows[0].value_enc) : null;
  }

  async has(accountId: number, kind: SecretKind): Promise<boolean> {
    const { rows } = await this.db.query('SELECT 1 FROM account_secrets WHERE account_id = $1 AND kind = $2', [accountId, kind]);
    return rows.length > 0;
  }

  /** Какие ключи сохранены у аккаунта. */
  async list(accountId: number): Promise<SecretKind[]> {
    const { rows } = await this.db.query('SELECT kind FROM account_secrets WHERE account_id = $1 ORDER BY kind', [accountId]);
    return rows.map((r) => r.kind as SecretKind).filter((k) => SECRET_KINDS.includes(k));
  }

  async remove(accountId: number, kind: SecretKind): Promise<void> {
    await this.db.query('DELETE FROM account_secrets WHERE account_id = $1 AND kind = $2', [accountId, kind]);
  }
}
