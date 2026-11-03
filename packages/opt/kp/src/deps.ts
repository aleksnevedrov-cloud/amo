import { AmoApiClient, AmoOAuth, TokenService } from '@core/amo';
import { AccountsRepo, createPool, DocumentsRepo, JournalRepo, ModelsCacheRepo, PgTokenStore, SecretsRepo, type Db } from '@core/db';
import { DocumentService, TesseractOcr, YandexVision, type DocumentServiceDeps, type OcrProvider } from '@core/docs';
import type { LLMProvider, LlmGateway, ProviderId } from '@core/llm';
import { amoRedirectUri, SecretBox, TelegramAlerter, type Alerter, type Env } from '@core/shared';
import { createKbCore, createUrlFetcher, DEFAULT_EMBEDDING_MODEL, loadKbEnv, OpenAiEmbedder, type EmbedderFor, type KbCore, type UrlFetcher } from '@opt/kb';
import { createOptAi, OPT_LLM_TIMEOUT_MS, type OptAiProvider } from './llm.ts';
import { readLatestMail, type MailReadConfig, type MailReadOptions, type MailReadResult, type MailSearch } from './mail-read.ts';
import { KpRepo } from './repo.ts';
import { KpPriceResearchRepo } from './research-repo.ts';
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
  /** KP-PARSE-RETRY: тот же разбор с заданным шлюзом модели (шлюз с записью сырого ответа — для журнала). */
  docsFor(llm: LlmGateway): DocumentService;
  ai: OptAiProvider;
  kp: KpRepo;
  /** Результаты поиска рыночных цен и кэш (этап 3). */
  research: KpPriceResearchRepo;
  /** База знаний опта (RFD-AI-AGENT-OPT-KB): отдельная БД ai_door_opt_kb, файлы на томе opt-kb-files, индексация и поиск. */
  kb: KbCore;
  /** Корень файлов опта: шаблон КП и собранные документы (/data в контейнере, том opt_data). */
  filesRoot: string;
  /** Чтение письма заявки из ящика по IMAP, только чтение (вариант А); в тестах подменяется. */
  mailRead(cfg: MailReadConfig, search: MailSearch, opts?: MailReadOptions): Promise<MailReadResult>;
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
  /** БД базы знаний (в тестах — своя схема); без неё читается KB_DATABASE_URL. */
  kbDb?: Db;
  kbFilesRoot?: string;
  /** Эмбеддер по аккаунту (в тестах подменяется); по умолчанию — OpenAI по ключу аккаунта или серверному. */
  embedderFor?: EmbedderFor;
  /** Скачивание ссылок базы знаний (в тестах подменяется). */
  kbFetchUrl?: UrlFetcher;
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
  const ocr = overrides.ocr ?? ocrFactory(env, fetchImpl);
  const docs = new DocumentService({
    llm: null,
    llmFor: async (id) => (await ai(id))?.llm ?? null,
    catalog: NO_CATALOG,
    documents,
    ocr,
  });
  const settings = new OptSettingsRepo(db);
  const journal = new JournalRepo(db);
  // База знаний: своя БД (KB_DATABASE_URL) и свой том; эмбеддинги — тем же ключом OpenAI, что чат-модель опта.
  const kbDb = overrides.kbDb ?? createPool(loadKbEnv().KB_DATABASE_URL);
  const kbModel = process.env.KB_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
  const embedders = new Map<string, OpenAiEmbedder>();
  const embedderFor: EmbedderFor =
    overrides.embedderFor ??
    (async (accountId) => {
      const key = (await secrets.get(accountId, 'openai')) ?? env.OPENAI_API_KEY ?? null;
      if (!key) return null;
      const k = `${kbModel}:${key}`;
      let e = embedders.get(k);
      if (!e) {
        e = new OpenAiEmbedder(key, { model: kbModel, fetch: fetchImpl, timeoutMs: OPT_LLM_TIMEOUT_MS, maxRetries: 1 });
        if (embedders.size > 500) embedders.clear();
        embedders.set(k, e);
      }
      return e;
    });
  const kb = createKbCore({
    db: kbDb,
    filesRoot: overrides.kbFilesRoot ?? process.env.KB_FILES_ROOT ?? '/kb-files',
    embedderFor,
    ocrFor: async (accountId) => ocr((await settings.get(accountId)).settings.vision.provider),
    journal,
    usdRubRate: async (accountId) => (await settings.get(accountId)).settings.billing.usdRubRate,
    fetchUrl: overrides.kbFetchUrl ?? createUrlFetcher({ fetch: fetchImpl }),
  });
  return {
    env,
    db,
    oauth,
    tokens,
    tokenService,
    accounts,
    settings,
    journal,
    secrets,
    modelsCache: new ModelsCacheRepo(db),
    documents,
    docs,
    docsFor: (llm) => new DocumentService({ llm, catalog: NO_CATALOG, documents, ocr }),
    ai,
    kp: new KpRepo(db),
    research: new KpPriceResearchRepo(db),
    kb,
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
      // Пул базы знаний, созданный здесь, закрываем сами; подменённый в тестах закрывает его владелец.
      if (!overrides.kbDb) await kb.close();
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
