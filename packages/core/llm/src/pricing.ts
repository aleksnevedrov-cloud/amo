/**
 * Таблица тарифов и характеристик моделей, $ за 1M токенов (без зависимостей — импортируется и виджетом).
 * Редактируется заказчиком в настройках («Лимиты» → тарифы); здесь — значения по умолчанию.
 * Сверять с прайс-листами провайдеров (п. 0.2 ТЗ): console.anthropic.com/pricing, openai.com/api/pricing.
 * Кэш: Anthropic — запись ×1.25, чтение ×0.1 от входа; OpenAI — чтение по cachedInput (автоматический кэш).
 */
import type { ModelInfo, ModelRef, ProviderId } from './types.ts';

export interface ModelPrice {
  input: number;
  output: number;
  /** $ за 1M токенов, прочитанных из кэша; по умолчанию — 10 % от входа. */
  cachedInput?: number;
}

export interface ModelTariff extends ModelPrice {
  name: string;
  /** Порядок рекомендации: 1 — модель по умолчанию для провайдера. */
  recommended?: number;
}

export const DEFAULT_PRICING: Record<ProviderId, Record<string, ModelTariff>> = {
  anthropic: {
    'claude-opus-5': { name: 'Claude Opus 5', input: 5, output: 25, recommended: 1 },
    'claude-sonnet-5': { name: 'Claude Sonnet 5', input: 2, output: 10, recommended: 2 },
    'claude-fable-5-1': { name: 'Claude Fable 5.1', input: 10, output: 50, recommended: 3 },
    'claude-fable-5': { name: 'Claude Fable 5', input: 10, output: 50 },
    'claude-opus-5-5': { name: 'Claude Opus 5.5', input: 4, output: 20 },
    'claude-opus-4-8': { name: 'Claude Opus 4.8', input: 5, output: 25 },
    'claude-opus-4-7': { name: 'Claude Opus 4.7', input: 5, output: 25 },
    'claude-opus-4-6': { name: 'Claude Opus 4.6', input: 5, output: 25 },
    'claude-sonnet-4-6': { name: 'Claude Sonnet 4.6', input: 3, output: 15 },
    'claude-haiku-4-5': { name: 'Claude Haiku 4.5', input: 1, output: 5, recommended: 4 },
  },
  openai: {
    'gpt-5.2': { name: 'GPT-5.2', input: 1.75, output: 14, cachedInput: 0.175, recommended: 1 },
    'gpt-5.1': { name: 'GPT-5.1', input: 1.25, output: 10, cachedInput: 0.125, recommended: 2 },
    'gpt-5': { name: 'GPT-5', input: 1.25, output: 10, cachedInput: 0.125, recommended: 3 },
    'gpt-5-mini': { name: 'GPT-5 mini', input: 0.25, output: 2, cachedInput: 0.025, recommended: 4 },
    'gpt-5-nano': { name: 'GPT-5 nano', input: 0.05, output: 0.4, cachedInput: 0.005 },
    'gpt-5.4': { name: 'GPT-5.4', input: 2.5, output: 15, cachedInput: 0.25 },
    'gpt-5.4-mini': { name: 'GPT-5.4 mini', input: 0.75, output: 4.5, cachedInput: 0.075 },
    'gpt-5.4-nano': { name: 'GPT-5.4 nano', input: 0.2, output: 1.25, cachedInput: 0.02 },
    'gpt-5.5': { name: 'GPT-5.5', input: 5, output: 30, cachedInput: 0.5 },
    'gpt-4.1': { name: 'GPT-4.1', input: 2, output: 8, cachedInput: 0.5, recommended: 5 },
    'gpt-4.1-mini': { name: 'GPT-4.1 mini', input: 0.4, output: 1.6, cachedInput: 0.1 },
    'gpt-4.1-nano': { name: 'GPT-4.1 nano', input: 0.1, output: 0.4, cachedInput: 0.025 },
    'gpt-4o': { name: 'GPT-4o', input: 2.5, output: 10, cachedInput: 1.25 },
    'gpt-4o-mini': { name: 'GPT-4o mini', input: 0.15, output: 0.6, cachedInput: 0.075 },
    o3: { name: 'o3', input: 2, output: 8, cachedInput: 0.5 },
    'o4-mini': { name: 'o4-mini', input: 1.1, output: 4.4, cachedInput: 0.275 },
  },
};

export const PROVIDER_LABELS: Record<ProviderId, string> = { anthropic: 'Anthropic Claude', openai: 'OpenAI ChatGPT' };
export const PROVIDER_SHORT: Record<ProviderId, string> = { anthropic: 'Claude', openai: 'ChatGPT' };

/** Переопределения тарифов из настроек аккаунта: ключ `provider:model`. */
export type PricingOverrides = Record<string, ModelPrice>;

/** Самая дорогая цена — для неизвестной модели, чтобы не занизить расход. */
const UNKNOWN_PRICE: ModelPrice = { input: 10, output: 50 };

/** Базовое имя модели в таблице: точное совпадение или префикс (`claude-opus-5-20260101` → `claude-opus-5`). */
export function tariffKey(provider: ProviderId, model: string): string | null {
  const table = DEFAULT_PRICING[provider];
  if (table[model]) return model;
  const candidates = Object.keys(table).filter((k) => model.startsWith(`${k}-`));
  // Самый длинный префикс: gpt-5.4-mini важнее gpt-5.
  return candidates.sort((a, b) => b.length - a.length)[0] ?? null;
}

export function priceFor(provider: ProviderId, model: string, overrides: PricingOverrides = {}): ModelPrice & { known: boolean } {
  const exact = overrides[`${provider}:${model}`];
  if (exact) return { ...exact, known: true };
  const base = tariffKey(provider, model);
  const override = base ? overrides[`${provider}:${base}`] : undefined;
  if (override) return { ...override, known: true };
  const t = base ? DEFAULT_PRICING[provider][base] : undefined;
  return t ? { input: t.input, output: t.output, cachedInput: t.cachedInput, known: true } : { ...UNKNOWN_PRICE, known: false };
}

export interface UsageLike {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
}

export interface CostResult {
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

/** Стоимость ответа по таблице тарифов с учётом кэша. inputTokens в результате — все входные, включая кэш. */
export function costOfUsage(ref: ModelRef, u: UsageLike, overrides: PricingOverrides = {}): CostResult {
  const p = priceFor(ref.provider, ref.model, overrides);
  const cached = u.cachedInputTokens ?? 0;
  const write = u.cacheWriteTokens ?? 0;
  const cachedPrice = p.cachedInput ?? p.input * 0.1;
  const writePrice = ref.provider === 'anthropic' ? p.input * 1.25 : p.input;
  const usd = (u.inputTokens * p.input + cached * cachedPrice + write * writePrice + u.outputTokens * p.output) / 1_000_000;
  return { inputTokens: u.inputTokens + cached + write, outputTokens: u.outputTokens, usd };
}

/** Модели провайдера из таблицы тарифов (когда список из API недоступен), рекомендованные первыми. */
export function tariffModels(provider: ProviderId, overrides: PricingOverrides = {}): ModelInfo[] {
  return Object.entries(DEFAULT_PRICING[provider])
    .map(([id, t]) => ({ id, ...modelTraits(provider, id), name: t.name, provider, price: pricePublic(provider, id, overrides), recommended: t.recommended ?? null, maxOutputTokens: null, createdAt: null }))
    .sort((a, b) => (a.recommended ?? 99) - (b.recommended ?? 99) || a.id.localeCompare(b.id));
}

export function pricePublic(provider: ProviderId, model: string, overrides: PricingOverrides = {}): ModelInfo['price'] {
  const p = priceFor(provider, model, overrides);
  return p.known ? { input: p.input, output: p.output, cachedInput: p.cachedInput ?? p.input * 0.1 } : null;
}

/** Первая рекомендованная модель провайдера — модель по умолчанию при первом выборе провайдера (раздел 4 ТЗ). */
export function defaultModel(provider: ProviderId): string {
  return tariffModels(provider)[0]?.id ?? Object.keys(DEFAULT_PRICING[provider])[0] ?? '';
}

export interface ModelTraits {
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
  temperature: boolean;
  /** Чат-модель с текстовым ответом (эмбеддинги, аудио, картинки — false). */
  chat: boolean;
}

/**
 * Возможности модели по идентификатору. Для Anthropic API отдаёт capabilities явно (адаптер их уточняет),
 * для OpenAI список моделей без характеристик — определяем по семейству.
 */
export function modelTraits(provider: ProviderId, id: string): ModelTraits {
  const m = id.toLowerCase();
  if (provider === 'anthropic') {
    const chat = m.startsWith('claude-');
    // Модели после Claude Opus 4.6 не принимают temperature (документация Anthropic SDK).
    const legacy = /claude-(3|sonnet-4-6|opus-4-6|opus-4-5|sonnet-4-5|haiku-4-5|sonnet-4-|opus-4-1|opus-4-2|opus-4-0|haiku-4-0)/.test(m) && !/opus-4-[7-9]/.test(m);
    return { chat, vision: chat, tools: chat, reasoning: chat && !/claude-3/.test(m), temperature: chat && legacy };
  }
  const excluded = /(embedding|whisper|tts|audio|realtime|transcribe|moderation|dall-e|image|search-preview|deep-research|computer-use|codex|instruct|babbage|davinci|chat-latest|chatgpt-|o1-mini|o1-preview|-pro\b|-pro-)/;
  const chat = /^(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4$|gpt-5|gpt-6|o1$|o1-2|o3|o4)/.test(m) && !excluded.test(m);
  const reasoning = /^(gpt-5|gpt-6|o1|o3|o4)/.test(m);
  const vision = chat && !/^o3-mini/.test(m);
  return { chat, vision, tools: chat, reasoning, temperature: chat && !reasoning };
}
