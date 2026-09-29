import { LlmError, sameModel, type ChatRequest, type ChatResponse, type ChatRoute, type LLMProvider, type ModelRef, type ProviderId } from './types.ts';

/** Провайдер по идентификатору для конкретного аккаунта; null — ключа нет. */
export type ProviderResolver = (id: ProviderId) => LLMProvider | null | Promise<LLMProvider | null>;

/** Сбой основной и резервной моделей (или ключей нет) — агент передаёт диалог менеджеру. */
export class LlmUnavailableError extends Error {
  override name = 'LlmUnavailableError';
  constructor(
    message: string,
    readonly attempts: Attempt[] = [],
  ) {
    super(message);
  }
}

export interface Attempt {
  ref: ModelRef;
  error: string;
  code: LlmError['code'] | 'no_key';
}

export interface RoutedResponse extends ChatResponse {
  /** Ответ дала резервная модель. */
  fallbackUsed: boolean;
  /** Модель, которая должна была отвечать. */
  requested: ModelRef;
  attempts: Attempt[];
}

export type RoutedRequest = Omit<ChatRequest, 'model'>;

/** Единая точка вызова модели: основная → при сбое резервная (любого провайдера с ключом). */
export interface LlmGateway {
  chat(req: RoutedRequest, route: ChatRoute): Promise<RoutedResponse>;
  /** Провайдеры, для которых есть ключ. */
  providers(): Promise<ProviderId[]>;
  provider(id: ProviderId): Promise<LLMProvider | null>;
}

/**
 * Вызов основной модели, при недоступности — резервной (раздел 2 ТЗ: rate_limit / overloaded / timeout —
 * повторы делает SDK с экспоненциальной паузой, здесь — переключение модели; not_found — модель пропала из API).
 */
export async function chatWithFallback(resolve: ProviderResolver, req: RoutedRequest, route: ChatRoute): Promise<RoutedResponse> {
  const attempts: Attempt[] = [];
  const fallback = route.fallback && !sameModel(route.fallback, route.primary) ? route.fallback : null;
  const run = async (ref: ModelRef): Promise<ChatResponse | null> => {
    const provider = await resolve(ref.provider);
    if (!provider) {
      attempts.push({ ref, error: `Нет ключа ${ref.provider}`, code: 'no_key' });
      return null;
    }
    try {
      return await provider.chat({ ...req, model: ref.model });
    } catch (err) {
      const e = err instanceof LlmError ? err : new LlmError('unknown', ref.provider, (err as Error).message, { cause: err });
      attempts.push({ ref, error: e.message, code: e.code });
      if (!e.retryable) throw e;
      return null;
    }
  };
  const primary = await run(route.primary);
  if (primary) return { ...primary, fallbackUsed: false, requested: route.primary, attempts };
  if (fallback) {
    const second = await run(fallback);
    if (second) return { ...second, fallbackUsed: true, requested: route.primary, attempts };
  }
  throw new LlmUnavailableError(attempts.map((a) => `${a.ref.provider}/${a.ref.model}: ${a.error}`).join('; ') || 'LLM недоступна', attempts);
}

/** Шлюз по функции-резолверу провайдеров (ключи аккаунта или серверные). */
export function gatewayFromResolver(resolve: ProviderResolver, ids: ProviderId[] | (() => Promise<ProviderId[]>)): LlmGateway {
  return {
    chat: (req, route) => chatWithFallback(resolve, req, route),
    providers: async () => (typeof ids === 'function' ? ids() : ids),
    provider: async (id) => resolve(id),
  };
}

/**
 * Шлюз с одним готовым адаптером: провайдер маршрута игнорируется, резервная модель —
 * только смена модели у того же адаптера (совместимость с тестами и серверным ключом одного провайдера).
 */
export function singleProviderGateway(provider: LLMProvider): LlmGateway {
  const resolve: ProviderResolver = () => provider;
  return {
    chat: (req, route) => {
      const fallback = route.fallback ? { provider: provider.id, model: route.fallback.model } : null;
      return chatWithFallback(resolve, req, { primary: { provider: provider.id, model: route.primary.model }, fallback });
    },
    providers: async () => [provider.id],
    provider: async (id) => (id === provider.id ? provider : null),
  };
}
