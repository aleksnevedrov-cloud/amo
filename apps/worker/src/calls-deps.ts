import { AmoOAuth, TokenService } from '@core/amo';
import { CallsRepo, DaySummariesRepo, type CallsDeps } from '@core/calls';
import { AccountsRepo, createPool, JournalRepo, PgTokenStore, SecretsRepo, SettingsRepo } from '@core/db';
import { createAiProvider, resolveRoute } from '@retail/agent';
import { buildLocalSources } from './local-sources.ts';
import { amoRedirectUri, SecretBox, TelegramAlerter, type Env } from '@core/shared';

/** Зависимости модуля звонков для консольных команд (догрузка, проверка ролей) — те же, что у воркера. */
export function buildCallsDeps(env: Env): { deps: CallsDeps; settings: SettingsRepo; close: () => Promise<void> } {
  const db = createPool(env.DATABASE_URL);
  const alerter = new TelegramAlerter(env.TELEGRAM_ALERT_BOT_TOKEN, env.TELEGRAM_ALERT_CHAT_ID);
  const tokenService = new TokenService(new PgTokenStore(db, new SecretBox(env.TOKEN_ENCRYPTION_KEY)), new AmoOAuth({ clientId: env.AMO_CLIENT_ID, clientSecret: env.AMO_CLIENT_SECRET, redirectUri: amoRedirectUri(env) }), env.TOKEN_REFRESH_MARGIN_SEC * 1000, alerter);
  const settings = new SettingsRepo(db);
  const secrets = new SecretsRepo(db, new SecretBox(env.TOKEN_ENCRYPTION_KEY));
  const ai = createAiProvider({ accountKey: (accountId, provider) => secrets.get(accountId, provider), serverKeys: { anthropic: env.ANTHROPIC_API_KEY, openai: env.OPENAI_API_KEY } });
  const deps: CallsDeps = {
    calls: new CallsRepo(db),
    days: new DaySummariesRepo(db),
    journal: new JournalRepo(db),
    accounts: new AccountsRepo(db),
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
    // Локальные источники общения — та же сборка, что у воркера (RFD-AI-AGENT-CALLS-DEMO-SOURCES).
    sources: buildLocalSources(db),
  };
  return { deps, settings, close: () => db.end() };
}
