/**
 * Единый интерфейс провайдера LLM (раздел 2 ТЗ 1.1.0). Оркестратор, инструменты, пост-фильтр и память
 * работают только с этими типами; перевод в формат Anthropic / OpenAI делают адаптеры.
 */

export const PROVIDER_IDS = ['anthropic', 'openai'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const isProviderId = (v: unknown): v is ProviderId => typeof v === 'string' && (PROVIDER_IDS as readonly string[]).includes(v);

/** Единые коды ошибок (раздел 2 ТЗ). `not_found` — модель пропала из API, `quota` — кончились средства. */
export type LlmErrorCode = 'auth' | 'rate_limit' | 'overloaded' | 'timeout' | 'bad_request' | 'content_filter' | 'not_found' | 'quota' | 'unknown';

/** Сбои, после которых есть смысл повторить или переключиться на резервную модель. */
export const RETRYABLE_CODES: ReadonlySet<LlmErrorCode> = new Set(['rate_limit', 'overloaded', 'timeout', 'not_found']);

export class LlmError extends Error {
  override name = 'LlmError';
  readonly code: LlmErrorCode;
  readonly provider: ProviderId;
  readonly status: number | undefined;

  constructor(code: LlmErrorCode, provider: ProviderId, message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.code = code;
    this.provider = provider;
    this.status = opts.status;
  }

  get retryable(): boolean {
    return RETRYABLE_CODES.has(this.code);
  }
}

export interface UnifiedImage {
  mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  /** base64 без префикса data: */
  data: string;
}

export type UnifiedPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: UnifiedImage }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; toolCallId: string; name?: string; content: string; isError?: boolean };

export interface UnifiedMessage {
  role: 'user' | 'assistant';
  content: string | UnifiedPart[];
  /**
   * Ответ модели «как есть» (блоки Anthropic / items OpenAI). Адаптер того же провайдера отправляет их
   * обратно без потерь (thinking, reasoning, id вызовов), адаптер другого провайдера собирает ход из `content`.
   */
  raw?: { provider: ProviderId; items: unknown[] };
}

export interface UnifiedTool {
  name: string;
  description: string;
  /** JSON Schema параметров (одна схема на инструмент). */
  inputSchema: Record<string, unknown>;
}

/** Блок системного промпта; `cache: true` — неизменяемая часть (точка кэширования Anthropic). */
export interface SystemBlock {
  text: string;
  cache?: boolean;
}

export type Effort = 'low' | 'medium' | 'high';

export interface ChatRequest {
  model: string;
  system: string | SystemBlock[];
  /** Единый формат истории. */
  messages: UnifiedMessage[];
  tools?: UnifiedTool[];
  maxTokens: number;
  /** null / undefined — не передавать (значение провайдера по умолчанию). */
  temperature?: number | null;
  effort?: Effort;
  /** Изображения к последнему сообщению клиента. */
  images?: UnifiedImage[];
  /** Ответ строго по JSON Schema (разбор документов). */
  outputSchema?: { name: string; schema: Record<string, unknown> };
  /** Стабильный ключ для кэша промпта (OpenAI prompt_cache_key). */
  cacheKey?: string;
}

export type StopReason = 'end' | 'tool_call' | 'max_tokens' | 'refusal' | 'error' | 'pause';

export interface ChatUsage {
  /** Входные токены без кэша. */
  inputTokens: number;
  outputTokens: number;
  /** Прочитано из кэша промпта. */
  cachedInputTokens: number;
  /** Записано в кэш (Anthropic). */
  cacheWriteTokens: number;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatResponse {
  text: string | null;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage: ChatUsage;
  provider: ProviderId;
  /** Фактическая модель ответа (может отличаться от запрошенной при серверном fallback). */
  model: string;
  /** Ход ассистента для добавления в историю (с `raw` для точного повтора). */
  assistantMessage: UnifiedMessage;
  latencyMs: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: ProviderId;
  /** Поддержка изображений на входе. */
  vision: boolean;
  /** Вызов инструментов (в список попадают только такие). */
  tools: boolean;
  /** Модель с рассуждениями (effort). */
  reasoning: boolean;
  /** Принимает temperature. */
  temperature: boolean;
  maxOutputTokens: number | null;
  createdAt: string | null;
  /** Цена, $ за 1M токенов; null — нет в таблице тарифов. */
  price: { input: number; output: number; cachedInput: number } | null;
  /** Порядок рекомендации из таблицы тарифов (1 — лучший выбор по умолчанию). */
  recommended: number | null;
}

export interface KeyCheck {
  ok: boolean;
  error?: string;
  /** Идентификаторы доступных моделей (при ok). */
  models?: string[];
}

export interface LLMProvider {
  readonly id: ProviderId;
  listModels(): Promise<ModelInfo[]>;
  validateKey(): Promise<KeyCheck>;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export interface ModelRef {
  provider: ProviderId;
  model: string;
}

export interface ChatRoute {
  primary: ModelRef;
  fallback: ModelRef | null;
}

export const sameModel = (a: ModelRef | null, b: ModelRef | null): boolean =>
  Boolean(a && b && a.provider === b.provider && a.model === b.model);

export const modelKey = (m: ModelRef): string => `${m.provider}:${m.model}`;

export function parseModelKey(key: string): ModelRef | null {
  const i = key.indexOf(':');
  if (i < 0) return null;
  const provider = key.slice(0, i);
  const model = key.slice(i + 1);
  return isProviderId(provider) && model ? { provider, model } : null;
}

/** Текст сообщения (для журнала и резюме). */
export function messageText(m: UnifiedMessage): string {
  if (typeof m.content === 'string') return m.content;
  return m.content
    .filter((p): p is Extract<UnifiedPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}
