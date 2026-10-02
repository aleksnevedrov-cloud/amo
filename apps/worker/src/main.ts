import {
  AnthropicLlm,
  createAiProvider,
  DialogPipeline,
  INCOMING_QUEUE,
  Orchestrator,
  scheduleLead,
  type AmoAccess,
  type IncomingJob,
} from '@ai-door/agent';
import { AmoApiClient, AmoOAuth, continueBot, TokenService } from '@ai-door/amo';
import { CatalogImporter, CatalogRepo } from '@ai-door/catalog';
import { AccountsRepo, createPool, DialogRepo, DocumentsRepo, JournalRepo, MemoryRepo,
  WazzupDumpRepo, WazzupRepo, OutcomesRepo, PgTokenStore, SecretsRepo, SettingsRepo, SuggestionsRepo } from '@ai-door/db';
import { DocumentService, TesseractOcr, YandexVision } from '@ai-door/docs';
import { EmailChannel, ImapMailbox, MailRepo, SmtpSender } from '@ai-door/mail';
import { WhisperStt, YandexStt } from '@ai-door/media';
import { PricingRepo } from '@ai-door/pricing';
import { KnowledgeRepo } from '@ai-door/knowledge';
import { amoRedirectUri, loadEnv, SecretBox, TelegramAlerter } from '@ai-door/shared';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import {
  IMPORT_CHECK_EVERY_MS,
  IMPORT_FEEDS_JOB,
  MAINTENANCE_QUEUE,
  POLL_MAIL_EVERY_MS,
  POLL_MAIL_JOB,
  PURGE_CHECK_EVERY_MS,
  PURGE_UNINSTALLED_JOB,
  REFRESH_EVERY_MS,
  REFRESH_OUTCOMES_EVERY_MS,
  REFRESH_OUTCOMES_JOB,
  REFRESH_TOKENS_JOB,
  runImportFeeds,
  runPurgeUninstalled,
  runRefreshOutcomes,
  runIncoming,
  runPollMail,
  runWazzupDumps,
  WAZZUP_DUMP_EVERY_MS,
  WAZZUP_DUMP_JOB,
  runRefreshTokens,
} from './jobs.ts';

const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL });
const db = createPool(env.DATABASE_URL);
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const alerter = new TelegramAlerter(env.TELEGRAM_ALERT_BOT_TOKEN, env.TELEGRAM_ALERT_CHAT_ID);
const tokenService = new TokenService(
  new PgTokenStore(db, new SecretBox(env.TOKEN_ENCRYPTION_KEY)),
  new AmoOAuth({ clientId: env.AMO_CLIENT_ID, clientSecret: env.AMO_CLIENT_SECRET, redirectUri: amoRedirectUri(env) }),
  env.TOKEN_REFRESH_MARGIN_SEC * 1000,
  alerter,
);
const accounts = new AccountsRepo(db);
const settings = new SettingsRepo(db);
const dialog = new DialogRepo(db);
const journal = new JournalRepo(db);
const catalog = new CatalogRepo(db);
const importer = new CatalogImporter(db);
const knowledge = new KnowledgeRepo(db);
const mail = new MailRepo(db, new SecretBox(env.TOKEN_ENCRYPTION_KEY));
const outcomes = new OutcomesRepo(db);
const amoClient = async (accountId: number) => {
  const account = await accounts.get(accountId);
  if (!account || account.uninstalledAt) throw new Error(`Аккаунт ${accountId} не подключён`);
  return new AmoApiClient(account.accountDomain, () => tokenService.getAccessToken(accountId));
};
const llm = env.ANTHROPIC_API_KEY ? new AnthropicLlm(env.ANTHROPIC_API_KEY) : null;
// Ключ аккаунта (Маркетплейс) приоритетнее серверного.
const secrets = new SecretsRepo(db, new SecretBox(env.TOKEN_ENCRYPTION_KEY));
const wazzupDumps = new WazzupDumpRepo(db);
const ai = createAiProvider({
  accountKey: (accountId, provider) => secrets.get(accountId, provider),
  serverKeys: { anthropic: env.ANTHROPIC_API_KEY, openai: env.OPENAI_API_KEY },
});
// Разбор файлов клиентов (фаза 3): OCR в Yandex Vision (РФ) или Tesseract на сервере, структура — Claude.
let tesseract: TesseractOcr | null = null;
const docs = new DocumentService({
  llm,
  llmFor: async (id) => (await ai(id))?.llm ?? null,
  catalog,
  documents: new DocumentsRepo(db),
  ocr(provider) {
    if (provider === 'off') return null;
    const key = env.YANDEX_VISION_API_KEY ?? env.YANDEX_SPEECHKIT_API_KEY;
    if (provider === 'yandex' && key && env.YANDEX_FOLDER_ID) return new YandexVision(key, env.YANDEX_FOLDER_ID);
    // Без ключа Yandex — Tesseract на сервере (бесплатно, только картинки).
    return (tesseract ??= new TesseractOcr());
  },
});
const emailChannel = new EmailChannel({
  settings,
  mail,
  amo: amoClient,
  connect: (cfg) => ImapMailbox.connect(cfg),
  sender: (cfg) => new SmtpSender(cfg),
});

// Очередь входящих — нужна и опросу почты.
const incoming = new Queue<IncomingJob>(INCOMING_QUEUE, { connection });

// Обслуживание: токены, импорт фидов, опрос почты.
const maintenance = new Queue(MAINTENANCE_QUEUE, { connection });
await maintenance.upsertJobScheduler(REFRESH_TOKENS_JOB, { every: REFRESH_EVERY_MS }, { name: REFRESH_TOKENS_JOB });
await maintenance.upsertJobScheduler(IMPORT_FEEDS_JOB, { every: IMPORT_CHECK_EVERY_MS }, { name: IMPORT_FEEDS_JOB });
await maintenance.upsertJobScheduler(POLL_MAIL_JOB, { every: POLL_MAIL_EVERY_MS }, { name: POLL_MAIL_JOB });
await maintenance.upsertJobScheduler(REFRESH_OUTCOMES_JOB, { every: REFRESH_OUTCOMES_EVERY_MS }, { name: REFRESH_OUTCOMES_JOB });
await maintenance.upsertJobScheduler(PURGE_UNINSTALLED_JOB, { every: PURGE_CHECK_EVERY_MS }, { name: PURGE_UNINSTALLED_JOB });
await maintenance.upsertJobScheduler(WAZZUP_DUMP_JOB, { every: WAZZUP_DUMP_EVERY_MS }, { name: WAZZUP_DUMP_JOB });
const maintenanceWorker = new Worker(
  MAINTENANCE_QUEUE,
  async (job) => {
    if (job.name === REFRESH_TOKENS_JOB) return runRefreshTokens(tokenService, log);
    if (job.name === IMPORT_FEEDS_JOB) return runImportFeeds({ settings, catalog, importer, journal }, log);
    if (job.name === REFRESH_OUTCOMES_JOB) return runRefreshOutcomes({ outcomes, amo: amoClient }, log);
    if (job.name === PURGE_UNINSTALLED_JOB) return runPurgeUninstalled({ accounts }, env.PURGE_UNINSTALLED_AFTER_DAYS, log);
    if (job.name === WAZZUP_DUMP_JOB) return runWazzupDumps({ dumps: wazzupDumps, secrets, journal }, log);
    if (job.name === POLL_MAIL_JOB) {
      return runPollMail(
        {
          settings,
          mail,
          dialog,
          journal,
          amo: amoClient,
          connect: (cfg) => ImapMailbox.connect(cfg),
          schedule: (j, w) => scheduleLead(incoming, j, w),
          documents: docs,
        },
        log,
      );
    }
    throw new Error(`Неизвестная задача ${job.name}`);
  },
  { connection, concurrency: 1 },
);

// Входящие сообщения клиентов.
// Конвейер работает и без серверного ключа: аккаунты Маркетплейса приходят со своими.
const pipeline = new DialogPipeline({
    settings,
    dialog,
    journal,
    catalog,
    knowledge,
    pricing: new PricingRepo(db),
    memory: new MemoryRepo(db),
    wazzup: new WazzupRepo(db),
    suggestions: new SuggestionsRepo(db),
    orchestrator: llm ? new Orchestrator(llm) : null,
    llm,
    ai,
    documents: docs,
    outcomes,
    email: {
      reply: (a, l, meta, text) => emailChannel.reply(a, l, { ...meta, from: String(meta.from ?? '') }, text),
      managerRepliedSince: (a, addrs, since) => emailChannel.managerRepliedSince(a, addrs, since),
    },
    stt(provider) {
      if (provider === 'yandex' && env.YANDEX_SPEECHKIT_API_KEY && env.YANDEX_FOLDER_ID) {
        return new YandexStt(env.YANDEX_SPEECHKIT_API_KEY, env.YANDEX_FOLDER_ID);
      }
      if (provider === 'openai' && env.OPENAI_API_KEY) return new WhisperStt(env.OPENAI_API_KEY);
      return null;
    },
    async amo(accountId): Promise<AmoAccess> {
      const account = await accounts.get(accountId);
      if (!account || account.uninstalledAt) throw new Error(`Аккаунт ${accountId} не подключён`);
      const accessToken = () => tokenService.getAccessToken(accountId);
      return { api: new AmoApiClient(account.accountDomain, accessToken), accessToken, accountDomain: account.accountDomain };
    },
    async send(access, returnUrl, messages) {
      await continueBot(returnUrl, await access.accessToken(), messages);
    },
});
if (!env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY) log.warn('ANTHROPIC_API_KEY и OPENAI_API_KEY не заданы — отвечать смогут только аккаунты со своими ключами');
const incomingWorker = new Worker<IncomingJob>(
  INCOMING_QUEUE,
  async (job) => {
    const outcome = await runIncoming(job.data, { pipeline, dialog, settings }, (j, w) => scheduleLead(incoming, j, w));
    log.info({ ...job.data, outcome: outcome.status }, 'incoming: обработано');
    return outcome;
  },
  { connection, concurrency: 5 },
);

for (const w of [maintenanceWorker, incomingWorker]) {
  w.on('failed', (job, err) => log.error({ err, job: job?.name, data: job?.data }, 'задача упала'));
}
log.info('worker запущен');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await incomingWorker?.close();
    await maintenanceWorker.close();
    await incoming.close();
    await maintenance.close();
    await connection.quit();
    await db.end();
    process.exit(0);
  });
}
