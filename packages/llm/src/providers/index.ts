/**
 * Реестр провайдеров (раздел 2 ТЗ): новый провайдер = новый файл-адаптер + строка здесь.
 */
import { AnthropicProvider, type AnthropicClientOptions } from '../anthropic.ts';
import { OpenAIProvider, type OpenAIClientOptions } from '../openai.ts';
import { PROVIDER_LABELS, PROVIDER_SHORT, type PricingOverrides } from '../pricing.ts';
import { PROVIDER_IDS, type LLMProvider, type ProviderId } from '../types.ts';

export interface ProviderOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  pricing?: PricingOverrides;
}

export interface ProviderDef {
  id: ProviderId;
  label: string;
  short: string;
  /** Подсказка формата ключа в поле ввода. */
  keyPlaceholder: string;
  /** Где взять ключ. */
  console: string;
  /** Переменная окружения с общим серверным ключом. */
  envKey: string;
  create(apiKey: string, opts?: ProviderOptions): LLMProvider;
}

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  anthropic: {
    id: 'anthropic',
    label: PROVIDER_LABELS.anthropic,
    short: PROVIDER_SHORT.anthropic,
    keyPlaceholder: 'sk-ant-…',
    console: 'console.anthropic.com',
    envKey: 'ANTHROPIC_API_KEY',
    create: (key, opts: AnthropicClientOptions & { pricing?: PricingOverrides } = {}) => AnthropicProvider.fromKey(key, opts),
  },
  openai: {
    id: 'openai',
    label: PROVIDER_LABELS.openai,
    short: PROVIDER_SHORT.openai,
    keyPlaceholder: 'sk-…',
    console: 'platform.openai.com',
    envKey: 'OPENAI_API_KEY',
    create: (key, opts: OpenAIClientOptions & { pricing?: PricingOverrides } = {}) => OpenAIProvider.fromKey(key, opts),
  },
};

export const providerIds = (): ProviderId[] => [...PROVIDER_IDS];

export function createProvider(id: ProviderId, apiKey: string, opts: ProviderOptions = {}): LLMProvider {
  return PROVIDERS[id].create(apiKey, opts);
}

/** Проверка ключа без генерации (список моделей), с таймаутом и без повторов. */
export async function verifyKey(id: ProviderId, apiKey: string, opts: ProviderOptions = {}): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  const r = await createProvider(id, apiKey, { timeoutMs: 15_000, maxRetries: 0, ...opts }).validateKey();
  return r.ok ? { ok: true, models: r.models ?? [] } : { ok: false, error: r.error ?? 'Ключ не принят' };
}

/** Маска ключа для интерфейса: первые символы и последние 4 (раздел 5 ТЗ). */
export function maskKey(key: string): string {
  const k = key.trim();
  if (k.length <= 8) return '…';
  const prefix = k.startsWith('sk-ant-') ? 'sk-ant-' : k.startsWith('sk-') ? 'sk-' : k.slice(0, 2);
  return `${prefix}…${k.slice(-4)}`;
}
