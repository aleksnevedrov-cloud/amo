import { z } from 'zod';
import { withTransaction, type Db } from './pool.ts';

/**
 * Схема настроек виджета. Фаза 0 — только каркас: режим и флаг включения.
 * Разделы из п. 11.1 ТЗ добавляются в своих фазах.
 */
export const widgetSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    mode: z.enum(['auto', 'semi', 'hints', 'off']).default('off'),
  })
  .strict();

export type WidgetSettings = z.infer<typeof widgetSettingsSchema>;

export const defaultSettings = (): WidgetSettings => widgetSettingsSchema.parse({});

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  async get(accountId: number): Promise<{ settings: WidgetSettings; version: number }> {
    const { rows } = await this.db.query('SELECT settings, version FROM widget_settings WHERE account_id = $1', [
      accountId,
    ]);
    const r = rows[0];
    if (!r) return { settings: defaultSettings(), version: 0 };
    return { settings: widgetSettingsSchema.parse(r.settings), version: r.version };
  }

  /** Сохраняет настройки и пишет запись аудита с автором изменения. */
  async save(accountId: number, userId: number, next: WidgetSettings): Promise<{ version: number }> {
    return withTransaction(this.db, async (c) => {
      const prev = await c.query('SELECT settings FROM widget_settings WHERE account_id = $1 FOR UPDATE', [accountId]);
      const { rows } = await c.query(
        `INSERT INTO widget_settings (account_id, settings, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (account_id) DO UPDATE
           SET settings = EXCLUDED.settings, updated_by = EXCLUDED.updated_by,
               version = widget_settings.version + 1, updated_at = now()
         RETURNING version`,
        [accountId, next, userId],
      );
      await c.query('INSERT INTO settings_audit (account_id, user_id, before, after) VALUES ($1, $2, $3, $4)', [
        accountId,
        userId,
        prev.rows[0]?.settings ?? null,
        next,
      ]);
      return { version: rows[0].version as number };
    });
  }
}
