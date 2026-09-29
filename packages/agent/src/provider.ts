import {
  AnthropicProvider,
  createProvider,
  gatewayFromResolver,
  verifyKey,
  PROVIDER_IDS,
  type LLMProvider,
  type LlmGateway,
  type PricingOverrides,
  type ProviderId,
} from '@ai-door/llm';
import type { LlmClient } from './llm.ts';
import { Orchestrator } from './orchestrator.ts';

/** LLM и оркестратор для конкретного аккаунта; null — ни у аккаунта, ни на сервере нет ни одного ключа. */
export interface AccountAi {
  /** Единый шлюз: основная модель → резервная любого провайдера с ключом. */
  llm: LlmGateway;
  orchestrator: Orchestrator;
  /** Откуда ключи: хотя бы один свой у аккаунта или только общие серверные. */
  source: 'account' | 'server';
  /** Провайдеры, для которых есть ключ (свой или серверный). */
  providers: ProviderId[];
  /** Откуда ключ каждого провайдера. */
  keySources: Partial<Record<ProviderId, 'account' | 'server'>>;
}

export type AiProvider = (accountId: number) => Promise<AccountAi | null>;

export interface AiProviderOptions {
  /** Ключ аккаунта по провайдеру (из зашифрованного хранилища). */
  accountKey(accountId: number, provider: ProviderId): Promise<string | null>;
  /** Общие серверные ключи из .env (для аккаунта РФ-Двери). */
  serverKeys?: Partial<Record<ProviderId, string | undefined>>;
  /** Тарифы аккаунта — переопределения таблицы по умолчанию. */
  pricing?(accountId: number): Promise<PricingOverrides>;
  /** Сборка адаптера (в тестах подменяется). */
  make?(provider: ProviderId, key: string): LLMProvider;
  fetch?: typeof fetch;
}

/**
 * Провайдер по ключам: у аккаунта из Маркетплейса — свои ключи (п. 0.3 ТЗ), у аккаунта РФ-Двери — серверные из .env.
 * Адаптеры кэшируются по ключу; смена провайдера в настройках действует со следующего сообщения без перезапуска.
 */
export function createAiProvider(opts: AiProviderOptions): AiProvider;
/** Совместимость 1.0.x: один ключ Anthropic (аккаунта или серверный). */
export function createAiProvider(accountKey: (accountId: number) => Promise<string | null>, serverKey: string | undefined, make?: (key: string) => LlmClient): AiProvider;
export function createAiProvider(
  a: AiProviderOptions | ((accountId: number) => Promise<string | null>),
  serverKey?: string,
  makeLegacy?: (key: string) => LlmClient,
): AiProvider {
  const opts: AiProviderOptions =
    typeof a === 'function'
      ? {
          accountKey: (id, provider) => (provider === 'anthropic' ? a(id) : Promise.resolve(null)),
          serverKeys: { anthropic: serverKey },
          ...(makeLegacy ? { make: (provider, key) => (provider === 'anthropic' ? new AnthropicProvider(makeLegacy(key)) : createProvider(provider, key)) } : {}),
        }
      : a;
  const adapters = new Map<string, LLMProvider>();
  const accounts = new Map<string, AccountAi>();
  const adapter = (provider: ProviderId, key: string): LLMProvider => {
    const k = `${provider}:${key}`;
    let p = adapters.get(k);
    if (!p) {
      p = opts.make ? opts.make(provider, key) : createProvider(provider, key, opts.fetch ? { fetch: opts.fetch } : {});
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
    // Один объект на набор ключей: конвейер и тесты полагаются на кэш.
    const signature = ids.map((id) => `${id}:${keys[id]?.source}:${keys[id]?.key}`).join('|');
    const cached = accounts.get(signature);
    if (cached) return cached;
    // Адаптеры создаются сразу: ключ проверяется на формат при первом обращении, а не в середине диалога.
    for (const id of ids) adapter(id, keys[id]?.key ?? '');
    const resolve = (id: ProviderId) => (keys[id] ? adapter(id, keys[id].key) : null);
    const llm = gatewayFromResolver(resolve, ids);
    const ai: AccountAi = {
      llm,
      orchestrator: new Orchestrator(llm),
      source: ids.some((id) => keys[id]?.source === 'account') ? 'account' : 'server',
      providers: ids,
      keySources: Object.fromEntries(ids.map((id) => [id, keys[id]?.source])) as AccountAi['keySources'],
    };
    if (accounts.size > 500) accounts.clear();
    accounts.set(signature, ai);
    return ai;
  };
}

/**
 * Проверка ключа Anthropic без генерации (совместимость 1.0.x); для любого провайдера — `verifyKey` из @ai-door/llm.
 */
export async function verifyAnthropicKey(apiKey: string, fetchImpl?: typeof fetch): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  return verifyKey('anthropic', apiKey, fetchImpl ? { fetch: fetchImpl } : {});
}
