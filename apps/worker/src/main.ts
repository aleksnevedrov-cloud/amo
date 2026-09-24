import {
  AnthropicLlm,
  DialogPipeline,
  INCOMING_QUEUE,
  Orchestrator,
  scheduleLead,
  type AmoAccess,
  type IncomingJob,
} from '@ai-door/agent';
import { AmoApiClient, AmoOAuth, continueBot, TokenService } from '@ai-door/amo';
import { CatalogImporter, CatalogRepo } from '@ai-door/catalog';
import { AccountsRepo, createPool, DialogRepo, JournalRepo, MemoryRepo, PgTokenStore, SettingsRepo, SuggestionsRepo } from '@ai-door/db';
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
  REFRESH_EVERY_MS,
  REFRESH_TOKENS_JOB,
  runImportFeeds,
  runIncoming,
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

// Обслуживание: токены и импорт фидов.
const maintenance = new Queue(MAINTENANCE_QUEUE, { connection });
await maintenance.upsertJobScheduler(REFRESH_TOKENS_JOB, { every: REFRESH_EVERY_MS }, { name: REFRESH_TOKENS_JOB });
await maintenance.upsertJobScheduler(IMPORT_FEEDS_JOB, { every: IMPORT_CHECK_EVERY_MS }, { name: IMPORT_FEEDS_JOB });
const maintenanceWorker = new Worker(
  MAINTENANCE_QUEUE,
  async (job) => {
    if (job.name === REFRESH_TOKENS_JOB) return runRefreshTokens(tokenService, log);
    if (job.name === IMPORT_FEEDS_JOB) return runImportFeeds({ settings, catalog, importer, journal }, log);
    throw new Error(`Неизвестная задача ${job.name}`);
  },
  { connection, concurrency: 1 },
);

// Входящие сообщения клиентов.
const incoming = new Queue<IncomingJob>(INCOMING_QUEUE, { connection });
let pipeline: DialogPipeline | null = null;
if (env.ANTHROPIC_API_KEY) {
  const llm = new AnthropicLlm(env.ANTHROPIC_API_KEY);
  pipeline = new DialogPipeline({
    settings,
    dialog,
    journal,
    catalog,
    knowledge,
    pricing: new PricingRepo(db),
    memory: new MemoryRepo(db),
    suggestions: new SuggestionsRepo(db),
    orchestrator: new Orchestrator(llm),
    llm,
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
} else {
  log.warn('ANTHROPIC_API_KEY не задан — входящие сообщения не обрабатываются');
  await alerter.alert('ANTHROPIC_API_KEY не задан: AI не отвечает клиентам').catch(() => undefined);
}
const activePipeline = pipeline;
const incomingWorker = activePipeline
  ? new Worker<IncomingJob>(
      INCOMING_QUEUE,
      async (job) => {
        const outcome = await runIncoming(job.data, { pipeline: activePipeline, dialog, settings }, (j, w) =>
          scheduleLead(incoming, j, w),
        );
        log.info({ ...job.data, outcome: outcome.status }, 'incoming: обработано');
        return outcome;
      },
      { connection, concurrency: 5 },
    )
  : null;

for (const w of [maintenanceWorker, incomingWorker]) {
  w?.on('failed', (job, err) => log.error({ err, job: job?.name, data: job?.data }, 'задача упала'));
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
