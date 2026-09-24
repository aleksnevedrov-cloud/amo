import Anthropic from '@anthropic-ai/sdk';

export type LlmRequest = Anthropic.Beta.MessageCreateParamsNonStreaming;
export type LlmResponse = Anthropic.Beta.BetaMessage;

export interface LlmClient {
  create(req: LlmRequest): Promise<LlmResponse>;
}

export class LlmUnavailableError extends Error {
  override name = 'LlmUnavailableError';
}

/** Модели, для которых включаем серверный fallback при отказе (stop_reason: refusal). */
const SERVER_FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-fable-5-1']);

export class AnthropicLlm implements LlmClient {
  private readonly client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic({ ...(apiKey ? { apiKey } : {}), timeout: 60_000, maxRetries: 2 });
  }

  create(req: LlmRequest): Promise<LlmResponse> {
    const withFallback: LlmRequest = SERVER_FALLBACK_MODELS.has(req.model)
      ? { ...req, betas: [...(req.betas ?? []), 'server-side-fallback-2026-07-01'], fallbacks: 'default' }
      : req;
    return this.client.beta.messages.create(withFallback);
  }
}

/** Сбой, при котором есть смысл переключиться на резервную модель. */
export function isRetryableLlmError(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.InternalServerError) return true;
  if (err instanceof Anthropic.APIError) return (err.status ?? 0) >= 500 || err.status === 529;
  return false;
}

/**
 * Вызов основной модели, при недоступности — резервной (раздел 13 ТЗ).
 * SDK уже делает 2 повтора на 429/5xx; здесь — переключение модели.
 */
export async function createWithFallback(
  llm: LlmClient,
  req: LlmRequest,
  fallbackModel: string | null,
  isRetryable: (err: unknown) => boolean = isRetryableLlmError,
): Promise<LlmResponse> {
  try {
    return await llm.create(req);
  } catch (err) {
    if (!isRetryable(err)) throw err;
    if (!fallbackModel || fallbackModel === req.model) throw new LlmUnavailableError((err as Error).message);
    try {
      return await llm.create({ ...req, model: fallbackModel });
    } catch (err2) {
      if (isRetryable(err2)) throw new LlmUnavailableError((err2 as Error).message);
      throw err2;
    }
  }
}
