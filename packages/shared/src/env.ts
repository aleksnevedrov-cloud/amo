import { z } from 'zod';

const hex32 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'должен быть 32-байтовым ключом в hex (64 символа)');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  /** Публичный адрес бэкенда, на него amo шлёт redirect и запросы виджета. */
  PUBLIC_URL: z.string().url(),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  AMO_CLIENT_ID: z.string().uuid(),
  AMO_CLIENT_SECRET: z.string().min(16),
  /** Разрешённые домены аккаунтов amo, куда можно отправлять client_secret. */
  AMO_ALLOWED_DOMAINS: z
    .string()
    .default('amocrm.ru,amocrm.com,kommo.com')
    .transform((s) => s.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean)),

  /** Ключ AES-256-GCM для шифрования токенов в БД. */
  TOKEN_ENCRYPTION_KEY: hex32,

  /** Обновлять access-токен, если до истечения осталось меньше N секунд. */
  TOKEN_REFRESH_MARGIN_SEC: z.coerce.number().int().positive().default(6 * 3600),

  /** Ключ Anthropic API. Без него AI не отвечает, песочница сообщает об ошибке. */
  ANTHROPIC_API_KEY: z.string().optional(),

  /** Распознавание голосовых: Yandex SpeechKit (данные в РФ) или OpenAI Whisper. */
  YANDEX_SPEECHKIT_API_KEY: z.string().optional(),
  YANDEX_FOLDER_ID: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  TELEGRAM_ALERT_BOT_TOKEN: z.string().optional(),
  TELEGRAM_ALERT_CHAT_ID: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Некорректная конфигурация окружения:\n${issues}`);
  }
  return parsed.data;
}

/** Адрес, который регистрируется в интеграции amo как «Ссылка для перенаправления». */
export function amoRedirectUri(env: Pick<Env, 'PUBLIC_URL'>): string {
  return new URL('/oauth/amo/callback', env.PUBLIC_URL).toString();
}
