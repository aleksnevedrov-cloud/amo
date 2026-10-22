import { AmoOAuth, TokenService } from '@core/amo';
import { CallsRepo, DaySummariesRepo, type CallsDeps } from '@core/calls';
import { AccountsRepo, createPool, DialogRepo, JournalRepo, PgTokenStore, SecretsRepo, SettingsRepo, WazzupRepo } from '@core/db';
import { createAiProvider, resolveRoute } from '@retail/agent';
import { amoRedirectUri, SecretBox, TelegramAlerter, type Env } from '@core/shared';

/** Зависимости модуля звонков для консольных команд (догрузка, проверка ролей) — те же, что у воркера. */
export function buildCallsDeps(env: Env): { deps: CallsDeps; settings: SettingsRepo; close: () => Promise<void> } {
  const db = createPool(env.DATABASE_URL);
  const alerter = new TelegramAlerter(env.TELEGRAM_ALERT_BOT_TOKEN, env.TELEGRAM_ALERT_CHAT_ID);
  const tokenService = new TokenService(new PgTokenStore(db, new SecretBox(env.TOKEN_ENCRYPTION_KEY)), new AmoOAuth({ clientId: env.AMO_CLIENT_ID, clientSecret: env.AMO_CLIENT_SECRET, redirectUri: amoRedirectUri(env) }), env.TOKEN_REFRESH_MARGIN_SEC * 1000, alerter);
  const settings = new SettingsRepo(db);
  const wazzupRepo = new WazzupRepo(db);
  const dialog = new DialogRepo(db);
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
  // RFD-AI-AGENT-CALLS-DAY-FULL: локальные источники общения для итога дня (Wazzup по сделке и телефонам, диалог агента).
    sources: {
      wazzup: async (accountId, leadId, phones, since, until) => (await wazzupRepo.chatForLeadBetween(accountId, leadId, phones, since, until)).map((m) => ({ id: m.messageId, direction: m.direction, author: m.direction === 'in' ? ('client' as const) : ('manager' as const), text: m.text, at: m.sentAt, channel: m.chatType ?? undefined })),
      dialog: async (accountId, leadId, since, until) => (await dialog.betweenByLead(accountId, leadId, since, until)).map((m) => ({ id: String(m.id), direction: m.role === 'client' ? ('in' as const) : ('out' as const), author: m.role === 'client' ? ('client' as const) : m.role === 'ai' ? ('agent' as const) : ('manager' as const), text: m.text, at: m.createdAt })),
      activeLeads: async (accountId, since, until) => [...new Set([...(await wazzupRepo.leadsActiveBetween(accountId, since, until)), ...(await dialog.leadsActiveBetween(accountId, since, until))])],
    },
  };
  return { deps, settings, close: () => db.end() };
}
