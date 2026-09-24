import {
  AnthropicLlm,
  createIncomingQueue,
  Orchestrator,
  scheduleLead,
  type IncomingJob,
  type LlmClient,
} from '@ai-door/agent';
import { AmoOAuth, TokenService } from '@ai-door/amo';
import { CatalogImporter, CatalogRepo } from '@ai-door/catalog';
import {
  AccountsRepo,
  createPool,
  DialogRepo,
  JournalRepo,
  MemoryRepo,
  PgTokenStore,
  SettingsRepo,
  SuggestionsRepo,
  type Db,
} from '@ai-door/db';
import { EmailChannel, ImapMailbox, MailRepo, SmtpSender, type Mailbox, type MailSender, type MailServerConfig } from '@ai-door/mail';
import { PricingRepo } from '@ai-door/pricing';
import { AmoApiClient } from '@ai-door/amo';
import { KnowledgeRepo } from '@ai-door/knowledge';
import { amoRedirectUri, SecretBox, TelegramAlerter, type Alerter, type Env } from '@ai-door/shared';
import type { Queue } from 'bullmq';
import { Redis } from 'ioredis';

/** Постановка сделки в очередь обработки. */
export type ScheduleLead = (job: IncomingJob, windowMs: number) => Promise<void>;

export interface Deps {
  env: Env;
  db: Db;
  redis: Pick<Redis, 'ping'>;
  oauth: AmoOAuth;
  tokens: PgTokenStore;
  tokenService: TokenService;
  accounts: AccountsRepo;
  settings: SettingsRepo;
  dialog: DialogRepo;
  journal: JournalRepo;
  catalog: CatalogRepo;
  importer: CatalogImporter;
  knowledge: KnowledgeRepo;
  pricing: PricingRepo;
  mail: MailRepo;
  emailChannel: EmailChannel;
  /** Подключение к ящику и SMTP (подменяются в тестах). */
  mailConnect(cfg: MailServerConfig): Promise<Mailbox>;
  mailSender(cfg: MailServerConfig): MailSender;
  memory: MemoryRepo;
  suggestions: SuggestionsRepo;
  /** null — не задан ANTHROPIC_API_KEY. */
  orchestrator: Orchestrator | null;
  llm: LlmClient | null;
  schedule: ScheduleLead;
  alerter: Alerter;
  fetch: typeof fetch;
  close(): Promise<void>;
}

export type DepsOverrides = Partial<
  Pick<Deps, 'fetch' | 'redis' | 'alerter' | 'db' | 'schedule' | 'importer' | 'knowledge' | 'mailConnect' | 'mailSender'> & {
    llm: LlmClient | null;
  }
>;

export function createDeps(env: Env, overrides: DepsOverrides = {}): Deps {
  const db = overrides.db ?? createPool(env.DATABASE_URL);
  let redisConn: Redis | null = null;
  const redis = overrides.redis ?? (redisConn = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }));
  const fetchImpl = overrides.fetch ?? fetch;
  const alerter = overrides.alerter ?? new TelegramAlerter(env.TELEGRAM_ALERT_BOT_TOKEN, env.TELEGRAM_ALERT_CHAT_ID);
  const oauth = new AmoOAuth({
    clientId: env.AMO_CLIENT_ID,
    clientSecret: env.AMO_CLIENT_SECRET,
    redirectUri: amoRedirectUri(env),
    fetch: fetchImpl,
  });
  const secretBox = new SecretBox(env.TOKEN_ENCRYPTION_KEY);
  const tokens = new PgTokenStore(db, secretBox);
  const llm = overrides.llm !== undefined ? overrides.llm : env.ANTHROPIC_API_KEY ? new AnthropicLlm(env.ANTHROPIC_API_KEY) : null;

  let queue: Queue<IncomingJob> | null = null;
  const schedule: ScheduleLead =
    overrides.schedule ??
    (async (job, windowMs) => {
      queue ??= createIncomingQueue(redisConn ?? new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }));
      await scheduleLead(queue, job, windowMs);
    });

  const tokenService = new TokenService(tokens, oauth, env.TOKEN_REFRESH_MARGIN_SEC * 1000, alerter);
  const accounts = new AccountsRepo(db);
  const settingsRepo = new SettingsRepo(db);
  const mail = new MailRepo(db, secretBox);
  const mailConnect = overrides.mailConnect ?? ((cfg: MailServerConfig) => ImapMailbox.connect(cfg));
  const mailSender = overrides.mailSender ?? ((cfg: MailServerConfig) => new SmtpSender(cfg));
  const emailChannel = new EmailChannel({
    settings: settingsRepo,
    mail,
    connect: mailConnect,
    sender: mailSender,
    amo: async (accountId) => {
      const a = await accounts.get(accountId);
      if (!a) throw new Error('Аккаунт не подключён');
      return new AmoApiClient(a.accountDomain, () => tokenService.getAccessToken(accountId), fetchImpl);
    },
  });

  return {
    env,
    db,
    redis,
    oauth,
    tokens,
    tokenService,
    accounts,
    settings: settingsRepo,
    mail,
    emailChannel,
    mailConnect,
    mailSender,
    dialog: new DialogRepo(db),
    journal: new JournalRepo(db),
    catalog: new CatalogRepo(db),
    importer: overrides.importer ?? new CatalogImporter(db),
    knowledge: overrides.knowledge ?? new KnowledgeRepo(db),
    pricing: new PricingRepo(db),
    memory: new MemoryRepo(db),
    suggestions: new SuggestionsRepo(db),
    orchestrator: llm ? new Orchestrator(llm) : null,
    llm,
    schedule,
    alerter,
    fetch: fetchImpl,
    async close() {
      await queue?.close();
      await db.end();
      if (redisConn) await redisConn.quit();
    },
  };
}
