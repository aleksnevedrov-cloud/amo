import { AmoOAuth, TokenService } from '@ai-door/amo';
import { AccountsRepo, createPool, PgTokenStore, SettingsRepo, type Db } from '@ai-door/db';
import { amoRedirectUri, SecretBox, TelegramAlerter, type Alerter, type Env } from '@ai-door/shared';
import { Redis } from 'ioredis';

export interface Deps {
  env: Env;
  db: Db;
  redis: Pick<Redis, 'ping'>;
  oauth: AmoOAuth;
  tokens: PgTokenStore;
  tokenService: TokenService;
  accounts: AccountsRepo;
  settings: SettingsRepo;
  alerter: Alerter;
  fetch: typeof fetch;
  close(): Promise<void>;
}

export function createDeps(env: Env, overrides: Partial<Pick<Deps, 'fetch' | 'redis' | 'alerter' | 'db'>> = {}): Deps {
  const db = overrides.db ?? createPool(env.DATABASE_URL);
  const redis = overrides.redis ?? new Redis(env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 1 });
  const fetchImpl = overrides.fetch ?? fetch;
  const alerter = overrides.alerter ?? new TelegramAlerter(env.TELEGRAM_ALERT_BOT_TOKEN, env.TELEGRAM_ALERT_CHAT_ID);
  const oauth = new AmoOAuth({
    clientId: env.AMO_CLIENT_ID,
    clientSecret: env.AMO_CLIENT_SECRET,
    redirectUri: amoRedirectUri(env),
    fetch: fetchImpl,
  });
  const tokens = new PgTokenStore(db, new SecretBox(env.TOKEN_ENCRYPTION_KEY));
  return {
    env,
    db,
    redis,
    oauth,
    tokens,
    tokenService: new TokenService(tokens, oauth, env.TOKEN_REFRESH_MARGIN_SEC * 1000, alerter),
    accounts: new AccountsRepo(db),
    settings: new SettingsRepo(db),
    alerter,
    fetch: fetchImpl,
    async close() {
      await db.end();
      if ('quit' in redis && typeof redis.quit === 'function') await redis.quit();
    },
  };
}
