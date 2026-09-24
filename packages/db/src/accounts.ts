import type { Db } from './pool.ts';

export interface AccountRow {
  id: number;
  subdomain: string;
  accountDomain: string;
  name: string | null;
  installedAt: Date;
  uninstalledAt: Date | null;
}

export class AccountsRepo {
  constructor(private readonly db: Db) {}

  async upsertInstalled(a: { id: number; subdomain: string; accountDomain: string; name?: string | null }): Promise<void> {
    await this.db.query(
      `INSERT INTO accounts (id, subdomain, account_domain, name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE
         SET subdomain = EXCLUDED.subdomain,
             account_domain = EXCLUDED.account_domain,
             name = COALESCE(EXCLUDED.name, accounts.name),
             installed_at = CASE WHEN accounts.uninstalled_at IS NULL THEN accounts.installed_at ELSE now() END,
             uninstalled_at = NULL,
             updated_at = now()`,
      [a.id, a.subdomain, a.accountDomain, a.name ?? null],
    );
  }

  /** Деинсталляция: помечаем аккаунт и удаляем токены (они больше недействительны). */
  async markUninstalled(id: number): Promise<void> {
    await this.db.query('UPDATE accounts SET uninstalled_at = now(), updated_at = now() WHERE id = $1', [id]);
    await this.db.query('DELETE FROM amo_tokens WHERE account_id = $1', [id]);
  }

  async get(id: number): Promise<AccountRow | null> {
    const { rows } = await this.db.query(
      `SELECT id, subdomain, account_domain, name, installed_at, uninstalled_at FROM accounts WHERE id = $1`,
      [id],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: Number(r.id),
      subdomain: r.subdomain,
      accountDomain: r.account_domain,
      name: r.name,
      installedAt: r.installed_at,
      uninstalledAt: r.uninstalled_at,
    };
  }
}
