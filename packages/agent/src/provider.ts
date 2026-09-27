import Anthropic from '@anthropic-ai/sdk';
import { AnthropicLlm, type LlmClient } from './llm.ts';
import { Orchestrator } from './orchestrator.ts';

/** LLM и оркестратор для конкретного аккаунта; null — ключа нет ни у аккаунта, ни на сервере. */
export interface AccountAi {
  llm: LlmClient;
  orchestrator: Orchestrator;
  /** Откуда ключ: свой у аккаунта или общий серверный. */
  source: 'account' | 'server';
}

export type AiProvider = (accountId: number) => Promise<AccountAi | null>;

/**
 * Провайдер по ключам: у аккаунта из Маркетплейса — свой ключ (п. 0.4 ТЗ: токены вводит заказчик),
 * у аккаунта РФ-Двери — серверный из .env. Клиенты кэшируются по ключу.
 */
export function createAiProvider(
  accountKey: (accountId: number) => Promise<string | null>,
  serverKey: string | undefined,
  make: (key: string) => LlmClient = (key) => new AnthropicLlm(key),
): AiProvider {
  const cache = new Map<string, AccountAi>();
  const forKey = (key: string, source: AccountAi['source']): AccountAi => {
    const cached = cache.get(key);
    if (cached) return cached;
    const llm = make(key);
    const ai: AccountAi = { llm, orchestrator: new Orchestrator(llm), source };
    if (cache.size > 500) cache.clear();
    cache.set(key, ai);
    return ai;
  };
  return async (accountId) => {
    const own = await accountKey(accountId);
    if (own) return forKey(own, 'account');
    if (serverKey) return forKey(serverKey, 'server');
    return null;
  };
}

/**
 * Проверка ключа без генерации: список моделей. Возвращает доступные модели из настроек
 * или текст ошибки (неверный ключ, нет доступа).
 */
export async function verifyAnthropicKey(apiKey: string, fetchImpl?: typeof fetch): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  try {
    const client = new Anthropic({ apiKey, timeout: 15_000, maxRetries: 0, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
    const page = await client.models.list({ limit: 100 });
    return { ok: true, models: page.data.map((m) => m.id) };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return { ok: false, error: 'Ключ не принят: проверьте, что скопирован целиком' };
    if (err instanceof Anthropic.PermissionDeniedError) return { ok: false, error: 'Ключ действует, но у него нет доступа к API' };
    if (err instanceof Anthropic.APIConnectionError) return { ok: false, error: 'Нет связи с api.anthropic.com с сервера' };
    return { ok: false, error: (err as Error).message };
  }
}
