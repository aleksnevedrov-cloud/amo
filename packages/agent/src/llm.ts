import Anthropic from '@anthropic-ai/sdk';
import {
  AnthropicProvider,
  AnthropicSdkClient,
  LlmUnavailableError,
  singleProviderGateway,
  type AnthropicClient,
  type AnthropicRequest,
  type AnthropicResponse,
  type LlmGateway,
} from '@ai-door/llm';

/**
 * Совместимость с 1.0.x: «сырой» клиент Anthropic (`create`) остаётся, оркестратор и резюме работают
 * через единый шлюз (`LlmGateway`), а сырой клиент оборачивается адаптером Anthropic.
 */
export type LlmRequest = AnthropicRequest;
export type LlmResponse = AnthropicResponse;
export type LlmClient = AnthropicClient;

export { LlmUnavailableError };
export type { LlmGateway };

/** Клиент Anthropic по ключу (серверному или аккаунта). */
export class AnthropicLlm extends AnthropicSdkClient implements LlmClient {}

const gateways = new WeakMap<object, LlmGateway>();

export const isGateway = (x: unknown): x is LlmGateway => typeof (x as LlmGateway | null)?.chat === 'function' && typeof (x as LlmGateway).providers === 'function';

/** Единый шлюз из чего угодно: готовый шлюз или сырой клиент Anthropic (тесты, серверный ключ одного провайдера). */
export function asGateway(x: LlmClient | LlmGateway): LlmGateway {
  if (isGateway(x)) return x;
  let g = gateways.get(x);
  if (!g) {
    g = singleProviderGateway(new AnthropicProvider(x));
    gateways.set(x, g);
  }
  return g;
}

/** Сбой, при котором есть смысл переключиться на резервную модель (сырой клиент Anthropic). */
export function isRetryableLlmError(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.InternalServerError) return true;
  if (err instanceof Anthropic.APIError) return (err.status ?? 0) >= 500 || err.status === 529;
  return false;
}

/**
 * Вызов основной модели сырым клиентом Anthropic, при недоступности — резервной (совместимость 1.0.x).
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
