import { llmProviderSchema, widgetSettingsSchema, type Db, type WidgetSettings } from '@core/db';
import { sameModel, type ChatRoute, type ModelRef } from '@core/llm';
import { z } from 'zod';

/**
 * Настройки «Агента опт». У опта нет диалога, каталога и почтового ящика, поэтому схема
 * своя и короткая: модель, разбор файлов, письмо с КП, курс. Хранится в opt_settings,
 * версии — как у розницы (version растёт при каждом сохранении).
 */
export const optSettingsSchema = z
  .object({
    model: z
      .object({
        provider: llmProviderSchema.default('openai'),
        model: z.string().min(1).default('gpt-5.5'),
        fallbackModel: z.string().min(1).nullable().default('gpt-5.1'),
        /** Провайдер резервной модели; null — тот же, что основной. */
        fallbackProvider: llmProviderSchema.nullable().default(null),
        effort: z.enum(['low', 'medium', 'high']).default('low'),
        maxTokens: z.number().int().min(512).max(16000).default(4096),
      })
      .strict()
      .default({}),
    /** Разбор спецификаций из файлов сделки (@core/docs). */
    vision: z
      .object({
        provider: z.enum(['off', 'yandex', 'tesseract']).default('tesseract'),
        photosToClaude: z.boolean().default(false),
        maxFilesPerDay: z.number().int().min(1).max(1000).default(100),
      })
      .strict()
      .default({}),
    /** Письмо с КП: SMTP того же ящика, что подключён к amoCRM (ТЗ 6.6). Пароль — в account_secrets, kind = smtp. */
    mail: z
      .object({
        /** Чтение письма заявки по кнопке «Собрать КП» — только чтение, тот же логин и пароль (RFD-AI-AGENT-OPT-MAIL-READ). */
        imapHost: z.string().max(200).default('imap.yandex.ru'),
        imapPort: z.number().int().min(1).max(65535).default(993),
        imapSecure: z.boolean().default(true),
        smtpHost: z.string().max(200).default(''),
        smtpPort: z.number().int().min(1).max(65535).default(465),
        smtpSecure: z.boolean().default(true),
        username: z.string().max(200).default(''),
        fromName: z.string().max(200).default('РФ-Двери'),
        /** Пусто — адрес отправителя равен логину. */
        fromAddress: z.string().max(200).default(''),
        /** Адрес для копии (менеджер); пусто — без копии. */
        cc: z.string().max(200).default(''),
        /** Шаблоны темы и текста: {kpNo} — номер КП, {clientName} — покупатель. */
        subject: z.string().max(300).default('Коммерческое предложение {kpNo}'),
        text: z.string().max(4000).default('Здравствуйте!\n\nНаправляем коммерческое предложение по вашему запросу — документ во вложении.'),
        signature: z.string().max(1000).default(''),
      })
      .strict()
      .default({}),
    billing: z
      .object({
        usdRubRate: z.number().positive().default(90),
        /** Тарифы по моделям, $ за 1M токенов, ключ `provider:model`; пусто — таблица по умолчанию. */
        pricing: z.record(z.object({ input: z.number().min(0), output: z.number().min(0), cachedInput: z.number().min(0).optional() }).strict()).default({}),
      })
      .strict()
      .default({}),
  })
  .strict();

export type OptSettings = z.infer<typeof optSettingsSchema>;
export const defaultOptSettings = (): OptSettings => optSettingsSchema.parse({});

/** Основная и резервная модели по настройкам; совпадающая с основной резервная не считается. */
export function resolveOptRoute(s: OptSettings): ChatRoute {
  const m = s.model;
  const primary: ModelRef = { provider: m.provider, model: m.model };
  const fallback: ModelRef | null = m.fallbackModel ? { provider: m.fallbackProvider ?? m.provider, model: m.fallbackModel } : null;
  return { primary, fallback: sameModel(fallback, primary) ? null : fallback };
}

/**
 * Переходник для @core/docs: разбор файлов пока принимает настройки розничного виджета.
 * Берём из них только модель, разбор файлов и курс. Убирается на этапе 6, когда
 * DocumentService перестанет зависеть от схемы розницы.
 */
export function toWidgetSettings(s: OptSettings): WidgetSettings {
  return widgetSettingsSchema.parse({
    model: { ...s.model },
    vision: { ...s.vision, autoParse: false, noteInLead: false },
    billing: s.billing,
  });
}

export class OptSettingsRepo {
  constructor(private readonly db: Db) {}

  async get(accountId: number): Promise<{ settings: OptSettings; version: number }> {
    const { rows } = await this.db.query<{ settings: unknown; version: number }>('SELECT settings, version FROM opt_settings WHERE account_id = $1', [accountId]);
    const r = rows[0];
    if (!r) return { settings: defaultOptSettings(), version: 0 };
    return { settings: optSettingsSchema.parse(r.settings), version: r.version };
  }

  async save(accountId: number, userId: number, next: OptSettings): Promise<{ version: number }> {
    const { rows } = await this.db.query<{ version: number }>(
      `INSERT INTO opt_settings (account_id, settings, version, updated_by)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (account_id) DO UPDATE
         SET settings = EXCLUDED.settings, version = opt_settings.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING version`,
      [accountId, JSON.stringify(optSettingsSchema.parse(next)), userId],
    );
    return { version: rows[0]?.version ?? 1 };
  }
}
