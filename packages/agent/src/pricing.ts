import { costOfUsage, type ModelRef, type PricingOverrides } from '@ai-door/llm';

/**
 * Стоимость ответов. Таблица тарифов обоих провайдеров — в `@ai-door/llm` (`DEFAULT_PRICING`),
 * переопределения аккаунта — в настройках `billing.pricing`.
 */

/** Usage в формате Anthropic (совместимость 1.0.x). */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export interface Cost {
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

/** Стоимость ответа Anthropic по usage API. Для неизвестной модели берётся самая дорогая цена — чтобы не занизить расход. */
export function costOf(model: string, u: Usage, overrides: PricingOverrides = {}): Cost {
  return costOfUsage(
    { provider: 'anthropic', model },
    { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cachedInputTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0 },
    overrides,
  );
}

/** Стоимость ответа любого провайдера по единому usage. */
export function costOfResponse(ref: ModelRef, u: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheWriteTokens?: number }, overrides: PricingOverrides = {}): Cost {
  return costOfUsage(ref, u, overrides);
}

export function addCost(a: Cost, b: Cost): Cost {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, usd: a.usd + b.usd };
}

export const ZERO_COST: Cost = { inputTokens: 0, outputTokens: 0, usd: 0 };
