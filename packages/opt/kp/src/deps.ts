import { AmoApiClient, AmoOAuth, TokenService } from '@core/amo';
import { AccountsRepo, createPool, DocumentsRepo, JournalRepo, ModelsCacheRepo, PgTokenStore, SecretsRepo, type Db } from '@core/db';
import { DocumentService, TesseractOcr, YandexVision, type DocumentServiceDeps, type OcrProvider } from '@core/docs';
import type { LLMProvider, ProviderId } from '@core/llm';
import { amoRedirectUri, SecretBox, TelegramAlerter, type Alerter, type Env } from '@core/shared';
import { createOptAi, type OptAiProvider } from './llm.ts';
import { readLatestMail, type FetchedMail, type MailReadConfig, type MailSearch } from './mail-read.ts';
import { KpRepo } from './repo.ts';
import { OptSettingsRepo } from './settings.ts';

/**
 * Общие службы «Агента опт» для opt-api и opt-worker: БД опта, токены своей интеграции amoCRM,
 * настройки, журнал, секреты, разбор файлов и шлюз LLM. Очередь и HTTP у каждого приложения свои.
 */
export interface OptCore {
  env: Env;
  db: Db;
  oauth: AmoOAuth;
  tokens: PgTokenStore;
  tokenService: TokenService;
  accounts: AccountsRepo;
  settings: OptSettingsRepo;
  journal: JournalRepo;
  secrets: SecretsRepo;
  modelsCache: ModelsCacheRepo;
  documents: DocumentsRepo;
  /** Разбор спецификаций из файлов сделки. */
  docs: DocumentService;
  ai: OptAiProvider;
  kp: KpRepo;
  /** База знаний опта: пять справочников (ТЗ раздел 9). */
  /** Корень файлов опта: шаблон КП и собранные документы (/data в контейнере, том opt_data). */
  filesRoot: string;
  /** Чтение письма заявки из ящика по IMAP, только чтение (вариант А); в тестах подменяется. */
  mailRead(cfg: MailReadConfig, search: MailSearch): Promise<FetchedMail | null>;
  alerter: Alerter;
  fetch: typeof fetch;
  /** Клиент amoCRM аккаунта по токенам опта; аккаунт не подключён — ошибка. */
  amoFor(accountId: number): Promise<AmoApiClient>;
  close(): Promise<void>;
}

export interface OptCoreOverrides {
  db?: Db;
  fetch?: typeof fetch;
  alerter?: Alerter;
  ai?: OptAiProvider;
  make?(provider: ProviderId, key: string): LLMProvider;
  ocr?: DocumentServiceDeps['ocr'];
  filesRoot?: string;
  mailRead?: OptCore['mailRead'];
}

/**
 * Каталога у опта нет (ТЗ 6.5): разбор файлов @core/docs пока требует каталог розницы для сопоставления
 * позиций, поэтому подставляется пустой поиск — совпадений не будет, позиции остаются как в документе.
 * Тип подменяется через cast, прямого импорта @retail/catalog здесь нет. Убирается на этапе 6.
 */
const NO_CATALOG = { search: async () => [] } as unknown as DocumentServiceDeps['catalog'];

export function createOptCore(env: Env, overrides: OptCoreOverrides = {}): OptCore {
  const db = overrides.db ?? createPool(env.DATABASE_URL);
  const fetchImpl = overrides.fetch ?? fetch;
  const alerter = overrides.alerter ?? new TelegramAlerter(env.TELEGRAM_ALERT_BOT_TOKEN, env.TELEGRAM_ALERT_CHAT_ID);
  const oauth = new AmoOAuth({ clientId: env.AMO_CLIENT_ID, clientSecret: env.AMO_CLIENT_SECRET, redirectUri: amoRedirectUri(env), fetch: fetchImpl });
  const secretBox = new SecretBox(env.TOKEN_ENCRYPTION_KEY);
  const tokens = new PgTokenStore(db, secretBox);
  const tokenService = new TokenService(tokens, oauth, env.TOKEN_REFRESH_MARGIN_SEC * 1000, alerter);
  const accounts = new AccountsRepo(db);
  const secrets = new SecretsRepo(db, secretBox);
  const documents = new DocumentsRepo(db);
  const ai =
    overrides.ai ??
    createOptAi({
      accountKey: (accountId, provider) => secrets.get(accountId, provider),
      serverKeys: { anthropic: env.ANTHROPIC_API_KEY, openai: env.OPENAI_API_KEY },
      ...(overrides.make ? { make: overrides.make } : {}),
      fetch: fetchImpl,
    });
  const docs = new DocumentService({
    llm: null,
    llmFor: async (id) => (await ai(id))?.llm ?? null,
    catalog: NO_CATALOG,
    documents,
    ocr: overrides.ocr ?? ocrFactory(env, fetchImpl),
  });
  return {
    env,
    db,
    oauth,
    tokens,
    tokenService,
    accounts,
    settings: new OptSettingsRepo(db),
    journal: new JournalRepo(db),
    secrets,
    modelsCache: new ModelsCacheRepo(db),
    documents,
    docs,
    ai,
    kp: new KpRepo(db),
    filesRoot: overrides.filesRoot ?? process.env.KP_FILES_ROOT ?? '/data',
    mailRead: overrides.mailRead ?? readLatestMail,
    alerter,
    fetch: fetchImpl,
    async amoFor(accountId) {
      const a = await accounts.get(accountId);
      if (!a || a.uninstalledAt) throw new Error(`Аккаунт ${accountId} не подключён к «Агенту опт»`);
      return new AmoApiClient(a.accountDomain, () => tokenService.getAccessToken(accountId), fetchImpl);
    },
    async close() {
      await db.end();
    },
  };
}

/** OCR по настройке: Yandex Vision при ключе, иначе Tesseract на сервере (один воркер на процесс). */
function ocrFactory(env: Env, fetchImpl: typeof fetch): DocumentServiceDeps['ocr'] {
  let tesseract: TesseractOcr | null = null;
  return (provider): OcrProvider | null => {
    if (provider === 'off') return null;
    const key = env.YANDEX_VISION_API_KEY ?? env.YANDEX_SPEECHKIT_API_KEY;
    if (provider === 'yandex' && key && env.YANDEX_FOLDER_ID) return new YandexVision(key, env.YANDEX_FOLDER_ID, fetchImpl);
    return (tesseract ??= new TesseractOcr());
  };
}
