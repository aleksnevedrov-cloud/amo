import { z } from 'zod';
import { withTransaction, type Db } from './pool.ts';

const DEFAULT_PERSONA =
  'Вы — консультант магазина дверей «РФ-Двери» (rf-dveri.ru). Общаетесь вежливо, по-деловому и коротко, ' +
  'как опытный продавец: выясняете потребность (помещение, размеры проёма, стиль, бюджет), подбираете модели ' +
  'из каталога и объясняете разницу между покрытиями.';

const ids = z.array(z.number().int().positive());

/**
 * Схема настроек виджета. Каждый раздел имеет значения по умолчанию,
 * поэтому сохранённые ранее настройки остаются валидными при добавлении разделов.
 */
export const widgetSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    mode: z.enum(['auto', 'semi', 'hints', 'off']).default('off'),
    behavior: z
      .object({
        persona: z.string().max(4000).default(DEFAULT_PERSONA),
        rules: z.string().max(8000).default(''),
        forbiddenTopics: z.array(z.string().max(200)).max(50).default([]),
        greeting: z.string().max(1000).default(''),
        handoffPhrase: z
          .string()
          .max(1000)
          .default('Передаю ваш вопрос менеджеру — он свяжется с вами в ближайшее время.'),
      })
      .strict()
      .default({}),
    model: z
      .object({
        provider: z.literal('anthropic').default('anthropic'),
        model: z.string().min(1).default('claude-opus-5'),
        fallbackModel: z.string().min(1).nullable().default('claude-sonnet-5'),
        effort: z.enum(['low', 'medium', 'high']).default('low'),
        maxTokens: z.number().int().min(512).max(16000).default(4096),
      })
      .strict()
      .default({}),
    where: z
      .object({
        /** null — все воронки. */
        pipelineIds: ids.nullable().default(null),
        /** Этапы, на которых AI не пишет. */
        disabledStatusIds: ids.default([]),
        batchWindowSec: z.number().int().min(0).max(120).default(8),
        typingDelay: z.boolean().default(false),
      })
      .strict()
      .default({}),
    handoff: z
      .object({
        taskTypeId: z.number().int().positive().default(1),
        taskDeadlineMin: z.number().int().min(5).max(7 * 24 * 60).default(60),
        /** null — ответственный по сделке. */
        responsibleUserId: z.number().int().positive().nullable().default(null),
        /** Этап, на который переводить сделку при передаче; null — не переводить. */
        statusId: z.number().int().positive().nullable().default(null),
      })
      .strict()
      .default({}),
    catalog: z
      .object({
        feedUrl: z.union([z.literal(''), z.string().url()]).default(''),
        importEveryHours: z.number().int().min(1).max(168).default(24),
      })
      .strict()
      .default({}),
    limits: z
      .object({
        /** Дневной лимит расходов на LLM, ₽; null — без лимита. */
        dailyRub: z.number().positive().nullable().default(null),
        /** Что делать при превышении дневного лимита. */
        onExceed: z.enum(['stop', 'handoff', 'hints']).default('stop'),
        /** Лимит ответов AI в одной сделке; null — без лимита. */
        maxAiMessagesPerLead: z.number().int().positive().nullable().default(null),
      })
      .strict()
      .default({}),
    /** Типы задач, которые AI ставит сам (crm.create_task): тип amo и срок. */
    tasks: z
      .record(
        z.enum(['callback', 'send_offer', 'check_availability', 'measure', 'other']),
        z.object({ taskTypeId: z.number().int().positive(), deadlineMin: z.number().int().min(5).max(30 * 24 * 60) }).strict(),
      )
      .default({}),
    hints: z
      .object({
        /** Готовить подсказки менеджеру, когда AI на паузе (раздел 6 ТЗ). */
        whenPaused: z.boolean().default(true),
      })
      .strict()
      .default({}),
    salesbot: z
      .object({
        /** Бот-отправщик: через него уходят одобренные черновики (режим «Полуавто»). */
        senderBotId: z.number().int().positive().nullable().default(null),
      })
      .strict()
      .default({}),
    stt: z
      .object({
        provider: z.enum(['off', 'yandex', 'openai']).default('off'),
      })
      .strict()
      .default({}),
    billing: z
      .object({
        usdRubRate: z.number().positive().default(90),
      })
      .strict()
      .default({}),
  })
  .strict();

export type WidgetSettings = z.infer<typeof widgetSettingsSchema>;
export type WidgetSettingsInput = z.input<typeof widgetSettingsSchema>;

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

  /** Аккаунты с включённым AI и заданным фидом — для планового импорта. */
  async listWithFeeds(): Promise<{ accountId: number; feedUrl: string; everyHours: number }[]> {
    const { rows } = await this.db.query(
      `SELECT s.account_id, s.settings FROM widget_settings s JOIN accounts a ON a.id = s.account_id
        WHERE a.uninstalled_at IS NULL AND coalesce(s.settings->'catalog'->>'feedUrl', '') <> ''`,
    );
    return rows.map((r) => {
      const s = widgetSettingsSchema.parse(r.settings);
      return { accountId: Number(r.account_id), feedUrl: s.catalog.feedUrl, everyHours: s.catalog.importEveryHours };
    });
  }
}
