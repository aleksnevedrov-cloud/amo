import { withTransaction, type Db } from '@ai-door/db';
import { emptyRules, pricingRulesSchema, type PricingRules } from './rules.ts';

export class PricingRepo {
  constructor(private readonly db: Db) {}

  async get(accountId: number): Promise<{ rules: PricingRules; version: number; updatedAt: Date | null }> {
    const { rows } = await this.db.query('SELECT rules, version, updated_at FROM pricing_rules WHERE account_id = $1', [accountId]);
    const r = rows[0];
    if (!r) return { rules: emptyRules(), version: 0, updatedAt: null };
    return { rules: pricingRulesSchema.parse(r.rules), version: r.version, updatedAt: r.updated_at };
  }

  /** Сохраняет правила; изменение пишется в общий аудит настроек. */
  async save(accountId: number, userId: number, rules: PricingRules): Promise<{ version: number }> {
    return withTransaction(this.db, async (c) => {
      const prev = await c.query('SELECT rules FROM pricing_rules WHERE account_id = $1 FOR UPDATE', [accountId]);
      const { rows } = await c.query(
        `INSERT INTO pricing_rules (account_id, rules, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (account_id) DO UPDATE
           SET rules = EXCLUDED.rules, updated_by = EXCLUDED.updated_by, version = pricing_rules.version + 1, updated_at = now()
         RETURNING version`,
        [accountId, rules, userId],
      );
      await c.query('INSERT INTO settings_audit (account_id, user_id, before, after) VALUES ($1, $2, $3, $4)', [
        accountId,
        userId,
        prev.rows[0] ? { pricingRules: prev.rows[0].rules } : null,
        { pricingRules: rules },
      ]);
      return { version: rows[0].version as number };
    });
  }
}
