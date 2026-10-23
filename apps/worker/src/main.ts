import { MAIL_CLEANUP_JOB, MAIL_CLEANUP_EVERY_MS, runMailCleanup } from './jobs.ts';
import {
  AnthropicLlm,
  createAiProvider,
  DialogPipeline,
  INCOMING_QUEUE,
  Orchestrator,
  scheduleLead,
  scheduleUnanswered,
  type AmoAccess,
  summarizeDialog,
  type IncomingJob,
  type SweepDeps,
  resolveRoute,
} from '@retail/agent';
import { AmoApiClient, AmoOAuth, continueBot, TokenService } from '@core/amo';
import { CatalogImporter, CatalogRepo } from '@retail/catalog';
import { AccountsRepo, createPool, DialogRepo, DocumentsRepo, JournalRepo, MemoryRepo,
  MailAttachmentsRepo,
  WazzupDumpRepo, WazzupRepo, OutcomesRepo, PgTokenStore, SecretsRepo, SettingsRepo, SuggestionsRepo } from '@core/db';
import { DocumentService, TesseractOcr, YandexVision } from '@core/docs';
import { EmailChannel, ImapMailbox, MailRepo, SmtpSender } from '@retail/mail';
import { WhisperStt, YandexStt } from '@core/media';
import { PricingRepo } from '@retail/pricing';
import { KnowledgeRepo } from '@retail/knowledge';
import { amoRedirectUri, loadEnv, SecretBox, TelegramAlerter } from '@core/shared';
import { runWazzupFiles, WAZZUP_FILES_EVERY_MS, WAZZUP_FILES_JOB } from '@retail/agent';
import { buildLocalSources } from './local-sources.ts';
import { CALLS_DAY_CHECK_EVERY_MS, CALLS_DAY_JOB, CALLS_POLL_EVERY_MS, CALLS_POLL_JOB, CALLS_QUEUE, CallsRepo, DaySummariesRepo, REFUSAL_EVERY_MS, REFUSAL_JOB, RefusalsRepo, runCallsPollAll, runDaySummaryIfDue, runRefusalPollAll, type CallsDeps } from '@core/calls';
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
  TASKS_NEW_JOB,
  TASKS_NEW_EVERY_MS,
  TASKS_EVENING_JOB,
  TASKS_EVENING_EVERY_MS,
  runTaskSweeps,
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
// Зависимости обходов автопостановки задач.
const wazzupRepo = new WazzupRepo(db);

// Звонки (RFD-AI-AGENT-CALLS-RETAIL): записи ВАТС из примечаний amo, расшифровка, итог разговоров за день.
const callsRepo = new CallsRepo(db);
const daySummaries = new DaySummariesRepo(db);
const callsDeps: CallsDeps = {
  calls: callsRepo,
  days: daySummaries,
  refusals: new RefusalsRepo(db),
  journal,
  accounts,
  tokenService,
  fetch,
  filesRoot: process.env.MAIL_FILES_ROOT ?? '/data',
  keys: { speechkit: env.YANDEX_SPEECHKIT_API_KEY ?? null, openai: env.OPENAI_API_KEY ?? null },
  alerter,
  settingsFor: async (accountId) => (await settings.get(accountId)).settings,
  llmFor: async (accountId) => {
    const a = await ai(accountId);
    if (!a) return null;
    const { settings: s } = await settings.get(accountId);
    return { llm: a.llm, route: resolveRoute(s), pricing: s.billing.pricing, usdRubRate: s.billing.usdRubRate };
  },
  accountIds: () => settings.listAccountIds(),
  // Локальные источники общения (Wazzup, диалог агента, вложения писем) — общая сборка с calls-demo (RFD-AI-AGENT-CALLS-DEMO-SOURCES).
  sources: buildLocalSources(db),
};

const sweepDeps: SweepDeps = {
  // Итог разговоров за день по сделке — из таблицы итогов (своя БД, без сетевых запросов): «Итог», «Следующий шаг».
  callTexts: async (accountId: number, leadId: number, since: Date) => {
    const day = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(since);
    const g = (t: string) => day.find((x) => x.type === t)?.value ?? '';
    const rows = (await daySummaries.forLead(accountId, leadId, `${g('year')}-${g('month')}-${g('day')}`)).filter((r) => r.business);
    const last = rows.at(-1);
    if (!last) return [];
    return [`Итог: ${last.summary.summary}`, ...(last.summary.nextStep ? [`Следующий шаг: ${last.summary.nextStep}`] : [])];
  },
  messengerSince: async (accountId: number, leadId: number, since: Date) =>
    (await wazzupRepo.historyByLead(accountId, leadId, since, 40)).map((m) => ({
      role: m.direction === 'in' ? 'client' : 'manager',
      text: m.text,
      createdAt: m.sentAt,
    })),
  managerWroteSince: (accountId: number, leadId: number, since: Date) =>
    wazzupRepo.managerWroteSinceByLead(accountId, leadId, since),
  settings,
  dialog,
  journal,
  amo: async (accountId: number) => ({ api: await amoClient(accountId) }),
  summarize: async (accountId: number, history) => {
    const a = await ai(accountId);
    if (!a) return null;
    const { settings: s } = await settings.get(accountId);
    const res = await summarizeDialog(a.llm, s, {
      history: history.map((m) => ({
        role: (m.role === 'call' ? 'manager' : m.role) as 'client' | 'ai' | 'manager',
        text: m.text,
      })),
    });
    return res.text || null;
  },
};
await maintenance.upsertJobScheduler(
  MAIL_CLEANUP_JOB,
  { every: MAIL_CLEANUP_EVERY_MS },
  { name: MAIL_CLEANUP_JOB },
);
await maintenance.upsertJobScheduler(TASKS_NEW_JOB, { every: TASKS_NEW_EVERY_MS }, { name: TASKS_NEW_JOB });
await maintenance.upsertJobScheduler(TASKS_EVENING_JOB, { every: TASKS_EVENING_EVERY_MS }, { name: TASKS_EVENING_JOB });

// Очередь звонков отдельно от обслуживания: опрос с расшифровкой идёт минутами и не должен задерживать почту и задачи.
const callsQueue = new Queue(CALLS_QUEUE, { connection });
await callsQueue.upsertJobScheduler(CALLS_POLL_JOB, { every: CALLS_POLL_EVERY_MS }, { name: CALLS_POLL_JOB, opts: { removeOnComplete: 50, removeOnFail: 50 } });
await callsQueue.upsertJobScheduler(CALLS_DAY_JOB, { every: CALLS_DAY_CHECK_EVERY_MS }, { name: CALLS_DAY_JOB, opts: { removeOnComplete: 50, removeOnFail: 50 } });
// Файлы Wazzup в обе стороны (RFD-AI-AGENT-WA-FILES): раз в 5 минут, тем же DocumentService, что вложения писем; не больше 2 файлов одновременно.
await callsQueue.upsertJobScheduler(WAZZUP_FILES_JOB, { every: WAZZUP_FILES_EVERY_MS }, { name: WAZZUP_FILES_JOB, opts: { removeOnComplete: 50, removeOnFail: 50 } });
// Анализ сделки при переносе в «Отказ» (RFD-AI-AGENT-REFUSAL-ANALYSIS): события lead_status_changed раз в 5 минут.
await callsQueue.upsertJobScheduler(REFUSAL_JOB, { every: REFUSAL_EVERY_MS }, { name: REFUSAL_JOB, opts: { removeOnComplete: 50, removeOnFail: 50 } });
const callsWorker = new Worker(
  CALLS_QUEUE,
  async (job) => {
    if (job.name === CALLS_POLL_JOB) {
      const results = await runCallsPollAll(callsDeps);
      for (const r of results) if (r.enabled && (r.inserted || r.downloaded || r.unavailable || r.failed || r.errors.length || r.transcribed?.transcribed || r.transcribed?.failed)) log.info({ ...r }, 'calls-poll: аккаунт опрошен');
      return { accounts: results.filter((r) => r.enabled).length, inserted: results.reduce((n, r) => n + r.inserted, 0) };
    }
    if (job.name === WAZZUP_FILES_JOB) return runWazzupFiles({ wazzup: wazzupRepo, settings, journal, documents: docs }, log);
    if (job.name === REFUSAL_JOB) {
      const results = await runRefusalPollAll(callsDeps);
      for (const r of results) if (r.matched || r.retried || r.errors) log.info({ ...r }, 'refusal-poll: переходы в «Отказ»');
      return { accounts: results.length, analyzed: results.reduce((n, r) => n + r.analyzed, 0) };
    }
    if (job.name === CALLS_DAY_JOB) {
      // Раз в 5 минут: у кого наступило время итога (calls.daySummaryTime) и сегодня не запускали — один запуск; иначе ничего.
      const out: unknown[] = [];
      for (const accountId of await callsDeps.accountIds()) {
        try {
          const r = await runDaySummaryIfDue(callsDeps, accountId);
          if (r) {
            log.info({ ...r }, 'calls-day-summary: итог дня');
            out.push(r);
          }
        } catch (err) {
          log.warn({ accountId, err: (err as Error).message }, 'calls-day-summary: сбой');
        }
      }
      return { accounts: out.length };
    }
    throw new Error(`Неизвестная задача ${job.name}`);
  },
  { connection, concurrency: 1 },
);
callsWorker.on('failed', (job, err) => log.error({ err, job: job?.name }, 'calls: задача упала'));

const maintenanceWorker = new Worker(
  MAINTENANCE_QUEUE,
  async (job) => {
    if (job.name === REFRESH_TOKENS_JOB) return runRefreshTokens(tokenService, log);
    if (job.name === IMPORT_FEEDS_JOB) return runImportFeeds({ settings, catalog, importer, journal }, log);
    if (job.name === REFRESH_OUTCOMES_JOB) return runRefreshOutcomes({ outcomes, amo: amoClient }, log);
    if (job.name === PURGE_UNINSTALLED_JOB) return runPurgeUninstalled({ accounts }, env.PURGE_UNINSTALLED_AFTER_DAYS, log);
    if (job.name === WAZZUP_DUMP_JOB) return runWazzupDumps({ dumps: wazzupDumps, secrets, journal }, log);
    if (job.name === MAIL_CLEANUP_JOB) return runMailCleanup({ attachments: new MailAttachmentsRepo(db) }, log);
      if (job.name === TASKS_NEW_JOB) return runTaskSweeps({ settings, sweep: sweepDeps }, 'new', log);
      if (job.name === TASKS_EVENING_JOB) return runTaskSweeps({ settings, sweep: sweepDeps }, 'evening', log);
    if (job.name === POLL_MAIL_JOB) {
      return runPollMail(
        {
          settings,
          mail,
          dialog,
          journal,
          amo: amoClient,
          connect: (cfg, hooks) => ImapMailbox.connect(cfg, hooks),
          schedule: (j, w) => scheduleLead(incoming, j, w),
          log,
          documents: docs,
        // Вложения писем: файл на диск, строка в mail_attachments, копия в сделке.
        attachments: {
          attachments: new MailAttachmentsRepo(db),
          journal,
          root: process.env.MAIL_FILES_ROOT ?? '/data',
          publicUrl: process.env.PUBLIC_URL,
          linkSecret: process.env.MAIL_FILES_SECRET ?? process.env.TOKEN_ENCRYPTION_KEY,
        },
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
    log: (fields, msg) => log.warn(fields, msg),
    outcomes,
    email: {
      reply: (a, l, meta, text) => emailChannel.reply(a, l, { ...meta, from: String(meta.from ?? '') }, text),
      managerRepliedSince: (a, addrs, since) => emailChannel.managerRepliedSince(a, addrs, since),
    },
    async stt(accountId: number, provider: 'off' | 'yandex' | 'openai') {
      if (provider === 'yandex' && env.YANDEX_SPEECHKIT_API_KEY && env.YANDEX_FOLDER_ID) {
        return new YandexStt(env.YANDEX_SPEECHKIT_API_KEY, env.YANDEX_FOLDER_ID);
      }
      if (provider === 'openai') {
        // Ключ Whisper: сначала переменная окружения, иначе ключ OpenAI, подключённый для LLM.
        const key = env.OPENAI_API_KEY || (await secrets.get(accountId, 'openai'));
        if (key) return new WhisperStt(key);
      }
      return null;
    },
    async amo(accountId): Promise<AmoAccess> {
      const account = await accounts.get(accountId);
      if (!account || account.uninstalledAt) throw new Error(`Аккаунт ${accountId} не подключён`);
      const accessToken = () => tokenService.getAccessToken(accountId);
      return { api: new AmoApiClient(account.accountDomain, accessToken), accessToken, accountDomain: account.accountDomain };
    },
  async onUnanswered(accountId, leadId, info) {
    await scheduleUnanswered(incoming, { accountId, leadId, unanswered: info });
  },
    async send(access, returnUrl, messages) {
      await continueBot(returnUrl, await access.accessToken(), messages);
    },
});
if (!env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY) log.warn('ANTHROPIC_API_KEY и OPENAI_API_KEY не заданы — отвечать смогут только аккаунты со своими ключами');
const incomingWorker = new Worker<IncomingJob>(
  INCOMING_QUEUE,
  async (job) => {
    if (job.data.unanswered) {
      const r = await pipeline.checkUnanswered(job.data.accountId, job.data.leadId, job.data.unanswered);
      log.info({ ...job.data, result: r.status }, 'без ответа: проверено');
      return r;
    }
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
    await callsWorker.close();
    await incoming.close();
    await maintenance.close();
    await callsQueue.close();
    await connection.quit();
    await db.end();
    process.exit(0);
  });
}
