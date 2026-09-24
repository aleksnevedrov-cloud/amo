/** Цены Anthropic, $ за 1M токенов (первичный API). Кэш: запись ×1.25, чтение ×0.1 от входа. */
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

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

/** Стоимость ответа. Для неизвестной модели берётся самая дорогая цена — чтобы не занизить расход. */
export function costOf(model: string, u: Usage): Cost {
  const base = Object.keys(PRICES).find((k) => model === k || model.startsWith(`${k}-`));
  const p = (base && PRICES[base]) || { input: 10, output: 50 };
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const usd =
    (u.input_tokens * p.input + cacheWrite * p.input * 1.25 + cacheRead * p.input * 0.1 + u.output_tokens * p.output) /
    1_000_000;
  return { inputTokens: u.input_tokens + cacheWrite + cacheRead, outputTokens: u.output_tokens, usd };
}

export function addCost(a: Cost, b: Cost): Cost {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, usd: a.usd + b.usd };
}

export const ZERO_COST: Cost = { inputTokens: 0, outputTokens: 0, usd: 0 };
