import { z } from 'zod';

const hex32 = z.string().regex(/^[0-9a-fA-F]{64}$/, 'должен быть 32-байтовым ключом в hex (64 символа)');
const list = (s: string) => s.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);

const proxyUrl = z
  .string()
  .default('')
  .refine((s) => !s.trim() || /^https?:$/.test(URL.canParse(s.trim()) ? new URL(s.trim()).protocol : ''), 'должен быть адресом http:// или https://');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3100),
  /** Публичный адрес сервиса: https://chat.rf-dveri.ru. От него ссылки на файлы и aud токена виджета. */
  PUBLIC_URL: z.string().url(),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  /** Интеграция amoCRM, в которую загружен виджет мессенджеров (не интеграция AI-агента). */
  AMO_CLIENT_ID: z.string().uuid(),
  AMO_CLIENT_SECRET: z.string().min(16),
  AMO_ALLOWED_DOMAINS: z.string().default('amocrm.ru,amocrm.com,kommo.com').transform(list),
  /** id аккаунтов amo, которым разрешён виджет (через запятую). Пусто — любой аккаунт с валидным токеном. */
  AMO_ACCOUNT_IDS: z
    .string()
    .default('')
    .transform((s) => list(s).map(Number).filter((n) => Number.isInteger(n) && n > 0)),

  /** API чатов amoCRM. id канала и секрет выдаёт техподдержка amo после регистрации канала. */
  AMOJO_BASE_URL: z.string().url().default('https://amojo.amocrm.ru'),
  AMOJO_CHANNEL_ID: z.string().optional(),
  AMOJO_CHANNEL_SECRET: z.string().optional(),
  AMOJO_CHANNEL_TITLE: z.string().default('РФ-Мессенджер'),

  /** AES-256-GCM: токены ботов, сессии WhatsApp/Telegram в БД. */
  ENCRYPTION_KEY: hex32,
  /** Подпись ссылок на файлы. */
  FILE_URL_SECRET: z.string().min(32),
  FILES_DIR: z.string().default('/data/files'),
  FILE_URL_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  MAX_FILE_MB: z.coerce.number().int().min(1).max(200).default(50),

  /** Пауза между исходящими в один чат (раздел 6 ТЗ). */
  OUTBOUND_PAUSE_MIN_MS: z.coerce.number().int().min(0).default(1000),
  OUTBOUND_PAUSE_MAX_MS: z.coerce.number().int().min(0).default(3000),

  /** HTTP(S)-прокси для Telegram и WhatsApp (http://логин:пароль@хост:порт). Пусто — напрямую. amoCRM всегда напрямую. */
  MESSENGER_PROXY_URL: proxyUrl,
  /** Запасной прокси: включается после 3 неудачных проверок основного подряд, обратно — после 3 удачных. Пусто — без запасного. */
  MESSENGER_PROXY_URL_FALLBACK: proxyUrl,

  /** Уведомления о сбоях прокси и каналов в Telegram. Оба пусты — уведомлений нет. */
  ALERT_TG_BOT_TOKEN: z.string().trim().default(''),
  ALERT_TG_CHAT_ID: z.string().trim().default(''),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Некорректная конфигурация окружения:\n${issues}`);
  }
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.AMO_ACCOUNT_IDS.length) {
    throw new Error('AMO_ACCOUNT_IDS обязателен в production: без него виджет примет токен любого аккаунта amo');
  }
  if (Boolean(parsed.data.ALERT_TG_BOT_TOKEN) !== Boolean(parsed.data.ALERT_TG_CHAT_ID)) {
    throw new Error('ALERT_TG_BOT_TOKEN и ALERT_TG_CHAT_ID задаются вместе');
  }
  if (parsed.data.OUTBOUND_PAUSE_MAX_MS < parsed.data.OUTBOUND_PAUSE_MIN_MS) {
    throw new Error('OUTBOUND_PAUSE_MAX_MS меньше OUTBOUND_PAUSE_MIN_MS');
  }
  return parsed.data;
}
