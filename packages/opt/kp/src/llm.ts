import { createProvider, gatewayFromResolver, PROVIDER_IDS, type LLMProvider, type LlmGateway, type ProviderId } from '@core/llm';

/**
 * Шлюз LLM аккаунта по ключам: свой ключ из account_secrets приоритетнее серверного из .env.
 * Копия логики createAiProvider из @retail/agent без оркестратора диалога (ТЗ 6.5: диалога у опта нет).
 * На этапе 6 общая часть уезжает в @core/llm и используется обоими агентами.
 */
export interface OptAi {
  llm: LlmGateway;
  source: 'account' | 'server';
  providers: ProviderId[];
  keySources: Partial<Record<ProviderId, 'account' | 'server'>>;
}

export type OptAiProvider = (accountId: number) => Promise<OptAi | null>;

/**
 * Таймаут одного запроса к модели (RFD-AI-AGENT-OPT-XLSX-TIMEOUT, п. 1): 180 с вместо 60 с по умолчанию SDK —
 * разбор таблицы по схеме и поиск цен с веб-поиском отвечают дольше минуты.
 */
export const OPT_LLM_TIMEOUT_MS = 180_000;
/** Повторов внутри SDK нет: повтор после таймаута — один, на уровне вызова (п. 4), резервная модель — в шлюзе. */
export const OPT_LLM_SDK_RETRIES = 0;

export interface OptAiOptions {
  accountKey(accountId: number, provider: ProviderId): Promise<string | null>;
  serverKeys?: Partial<Record<ProviderId, string | undefined>>;
  /** Сборка адаптера (в тестах подменяется). */
  make?(provider: ProviderId, key: string): LLMProvider;
  fetch?: typeof fetch;
}

export function createOptAi(opts: OptAiOptions): OptAiProvider {
  const adapters = new Map<string, LLMProvider>();
  const accounts = new Map<string, OptAi>();
  const adapter = (provider: ProviderId, key: string): LLMProvider => {
    const k = `${provider}:${key}`;
    let p = adapters.get(k);
    if (!p) {
      p = opts.make ? opts.make(provider, key) : createProvider(provider, key, { timeoutMs: OPT_LLM_TIMEOUT_MS, maxRetries: OPT_LLM_SDK_RETRIES, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
      if (adapters.size > 1000) adapters.clear();
      adapters.set(k, p);
    }
    return p;
  };

  return async (accountId) => {
    const keys: Partial<Record<ProviderId, { key: string; source: 'account' | 'server' }>> = {};
    for (const id of PROVIDER_IDS) {
      const own = await opts.accountKey(accountId, id);
      if (own) keys[id] = { key: own, source: 'account' };
      else if (opts.serverKeys?.[id]) keys[id] = { key: opts.serverKeys[id] as string, source: 'server' };
    }
    const ids = PROVIDER_IDS.filter((id) => keys[id]);
    if (!ids.length) return null;
    // Один объект на набор ключей: смена ключа в настройках действует со следующего запроса без перезапуска.
    const signature = ids.map((id) => `${id}:${keys[id]?.source}:${keys[id]?.key}`).join('|');
    const cached = accounts.get(signature);
    if (cached) return cached;
    for (const id of ids) adapter(id, keys[id]?.key ?? '');
    const ai: OptAi = {
      llm: gatewayFromResolver((id) => (keys[id] ? adapter(id, keys[id].key) : null), ids),
      source: ids.some((id) => keys[id]?.source === 'account') ? 'account' : 'server',
      providers: ids,
      keySources: Object.fromEntries(ids.map((id) => [id, keys[id]?.source])) as OptAi['keySources'],
    };
    if (accounts.size > 500) accounts.clear();
    accounts.set(signature, ai);
    return ai;
  };
}
