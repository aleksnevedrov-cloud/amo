import { z } from 'zod';
import { withTransaction, type Db } from './pool.ts';

const DEFAULT_PERSONA =
  'Вы — консультант магазина дверей «РФ-Двери» (rf-dveri.ru). Общаетесь вежливо, по-деловому и коротко, ' +
  'как опытный продавец: выясняете потребность (помещение, размеры проёма, стиль, бюджет), подбираете модели ' +
  'из каталога и объясняете разницу между покрытиями.';

const ids = z.array(z.number().int().positive());

export const llmProviderSchema = z.enum(['anthropic', 'openai']);
export type LlmProviderId = z.infer<typeof llmProviderSchema>;
export const llmModelRefSchema = z.object({ provider: llmProviderSchema, model: z.string().min(1) }).strict();
export type LlmModelRef = z.infer<typeof llmModelRefSchema>;

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
        /** Провайдер LLM (1.1.0): переключается в настройках, хранится в БД, действует со следующего сообщения. */
        provider: llmProviderSchema.default('anthropic'),
        model: z.string().min(1).default('claude-opus-5'),
        fallbackModel: z.string().min(1).nullable().default('claude-sonnet-5'),
        /** Провайдер резервной модели; null — тот же, что основной. */
        fallbackProvider: llmProviderSchema.nullable().default(null),
        effort: z.enum(['low', 'medium', 'high']).default('low'),
        maxTokens: z.number().int().min(512).max(16000).default(4096),
        /** null — значение провайдера по умолчанию; моделям без поддержки параметр не передаётся. */
        temperature: z.number().min(0).max(2).nullable().default(null),
        /** Модель по умолчанию для каждого провайдера — подставляется при переключении. */
        defaults: z.object({ anthropic: z.string().min(1).nullable().default(null), openai: z.string().min(1).nullable().default(null) }).strict().default({}),
        /** Переопределения для воронок и этапов (иерархия: сделка > этап > воронка > глобально, раздел 3 ТЗ). */
        overrides: z.object({ pipelines: z.record(llmModelRefSchema).default({}), statuses: z.record(llmModelRefSchema).default({}) }).strict().default({}),
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
        /** Основной фид (совместимость с ранними настройками); полный список — feedUrls. */
        feedUrl: z.union([z.literal(''), z.string().url()]).default(''),
        /** Дополнительные фиды того же магазина (у РФ-Двери: входные, межкомнатные, фурнитура). */
        feedUrls: z.array(z.string().url()).max(10).default([]),
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
    email: z
      .object({
        enabled: z.boolean().default(false),
        imapHost: z.string().max(200).default(''),
        imapPort: z.number().int().min(1).max(65535).default(993),
        imapSecure: z.boolean().default(true),
        smtpHost: z.string().max(200).default(''),
        smtpPort: z.number().int().min(1).max(65535).default(465),
        smtpSecure: z.boolean().default(true),
        username: z.string().max(200).default(''),
        /** Адрес отправителя; пусто — как логин. */
        fromAddress: z.union([z.literal(''), z.string().email()]).default(''),
        fromName: z.string().max(200).default('РФ-Двери'),
        inboxFolder: z.string().max(200).default('INBOX'),
        /** Пусто — определить по специальной метке \\Sent. */
        sentFolder: z.string().max(200).default(''),
        saveToSent: z.boolean().default(true),
        signature: z.string().max(2000).default('С уважением,\nРФ-Двери\nrf-dveri.ru'),
        /**
         * Отправитель не найден в amo:
         *  wait_for_amo — почта уже подключена к amo: ждать, пока amo сам создаст сделку, и ответить в ней;
         *  create_lead — создать контакт и сделку; skip — не отвечать.
         */
        unknownSender: z.enum(['wait_for_amo', 'create_lead', 'skip']).default('wait_for_amo'),
        /** Сколько ждать сделку от amo (включая принятие заявки из «Неразобранного»), минут. */
        waitForAmoMin: z.number().int().min(1).max(240).default(60),
        /** Если amo так и не создал сделку. */
        afterWait: z.enum(['skip', 'create_lead']).default('skip'),
        /** Дублировать ответ AI примечанием в сделке (не нужно, если почта подключена к amo). */
        noteInLead: z.boolean().default(false),
        newLeadPipelineId: z.number().int().positive().nullable().default(null),
        newLeadStatusId: z.number().int().positive().nullable().default(null),
        /** Защита от петель с автоответчиками. */
        maxRepliesPerAddressPerDay: z.number().int().min(1).max(100).default(10),
        /** Адреса и домены, на которые AI не отвечает (поставщики, сервисы). */
        ignore: z.array(z.string().max(200)).max(200).default([]),
      })
      .strict()
      .default({}),
    stt: z
      .object({
        provider: z.enum(['off', 'yandex', 'openai']).default('off'),
      })
      .strict()
      .default({}),
    /** Разбор файлов и фото (фаза 3). */
    vision: z
      .object({
        /**
         * OCR сканов и фото: Yandex Vision (данные в РФ; без ключа — Tesseract на нашем сервере),
         * Tesseract (бесплатно, только картинки, хуже на рукописном) или выключено.
         */
        provider: z.enum(['off', 'yandex', 'tesseract']).default('yandex'),
        /** Фото без текста (дверь, проём, интерьер) показывать модели Claude. */
        photosToClaude: z.boolean().default(true),
        /** Разбирать вложения из чатов и писем автоматически (иначе — только кнопкой в сделке). */
        autoParse: z.boolean().default(true),
        /** Записывать разбор примечанием в сделку. */
        noteInLead: z.boolean().default(true),
        /** Лимит файлов в сутки на аккаунт — защита от расхода. */
        maxFilesPerDay: z.number().int().min(1).max(1000).default(100),
      })
      .strict()
      .default({}),
    billing: z
      .object({
        usdRubRate: z.number().positive().default(90),
        /** Валюта в интерфейсе: ₽ по курсу или $. */
        currency: z.enum(['rub', 'usd']).default('rub'),
        /** Тарифы по моделям, $ за 1M токенов, ключ `provider:model`; пусто — таблица по умолчанию. */
        pricing: z
          .record(z.object({ input: z.number().min(0), output: z.number().min(0), cachedInput: z.number().min(0).optional() }).strict())
          .default({}),
      })
      .strict()
      .default({}),
  })
  .strict();

export type WidgetSettings = z.infer<typeof widgetSettingsSchema>;
export type WidgetSettingsInput = z.input<typeof widgetSettingsSchema>;

export const defaultSettings = (): WidgetSettings => widgetSettingsSchema.parse({});

/** Все адреса фидов аккаунта без повторов. */
export const feedUrlsOf = (s: WidgetSettings): string[] => [...new Set([s.catalog.feedUrl, ...s.catalog.feedUrls].filter(Boolean))];

export interface SettingsVersion {
  id: number;
  userId: number | null;
  changedAt: Date;
  /** Какие разделы настроек изменились относительно предыдущей версии. */
  changed: string[];
}

/** Разделы верхнего уровня, отличающиеся между двумя снимками (по JSON). */
export function changedSections(before: Record<string, unknown> | null, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);
  return [...keys].filter((k) => JSON.stringify(before?.[k] ?? null) !== JSON.stringify(after[k] ?? null)).sort();
}

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

  /** История изменений (версии настроек, раздел 11.1 ТЗ). Новые — первыми. */
  async history(accountId: number, limit = 50): Promise<SettingsVersion[]> {
    const { rows } = await this.db.query(
      'SELECT id, user_id, changed_at, before, after FROM settings_audit WHERE account_id = $1 ORDER BY id DESC LIMIT $2',
      [accountId, limit],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      userId: r.user_id === null ? null : Number(r.user_id),
      changedAt: r.changed_at as Date,
      changed: changedSections(r.before as Record<string, unknown> | null, r.after as Record<string, unknown>),
    }));
  }

  async version(accountId: number, id: number): Promise<(SettingsVersion & { settings: WidgetSettings }) | null> {
    const { rows } = await this.db.query('SELECT id, user_id, changed_at, before, after FROM settings_audit WHERE account_id = $1 AND id = $2', [accountId, id]);
    const r = rows[0];
    if (!r) return null;
    const parsed = widgetSettingsSchema.safeParse(r.after);
    if (!parsed.success) return null;
    return {
      id: Number(r.id),
      userId: r.user_id === null ? null : Number(r.user_id),
      changedAt: r.changed_at as Date,
      changed: changedSections(r.before as Record<string, unknown> | null, r.after as Record<string, unknown>),
      settings: parsed.data,
    };
  }

  /** Откат: сохраняет снимок версии как новую версию (история не теряется). */
  async restore(accountId: number, userId: number, id: number): Promise<{ version: number } | null> {
    const v = await this.version(accountId, id);
    if (!v) return null;
    return this.save(accountId, userId, v.settings);
  }

  /** Аккаунты с включённой почтой — для опроса ящиков. */
  async listWithEmail(): Promise<number[]> {
    const { rows } = await this.db.query(
      `SELECT s.account_id FROM widget_settings s JOIN accounts a ON a.id = s.account_id
        WHERE a.uninstalled_at IS NULL AND (s.settings->'email'->>'enabled')::boolean IS TRUE`,
    );
    return rows.map((r) => Number(r.account_id));
  }

  /** Аккаунты с включённым AI и заданным фидом — для планового импорта. */
  async listWithFeeds(): Promise<{ accountId: number; feedUrls: string[]; everyHours: number }[]> {
    const { rows } = await this.db.query(
      `SELECT s.account_id, s.settings FROM widget_settings s JOIN accounts a ON a.id = s.account_id
        WHERE a.uninstalled_at IS NULL
          AND (coalesce(s.settings->'catalog'->>'feedUrl', '') <> '' OR jsonb_array_length(coalesce(s.settings->'catalog'->'feedUrls', '[]'::jsonb)) > 0)`,
    );
    return rows.map((r) => {
      const s = widgetSettingsSchema.parse(r.settings);
      return { accountId: Number(r.account_id), feedUrls: feedUrlsOf(s), everyHours: s.catalog.importEveryHours };
    });
  }
}
