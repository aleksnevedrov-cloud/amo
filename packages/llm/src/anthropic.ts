import Anthropic from '@anthropic-ai/sdk';
import { modelTraits, pricePublic, tariffKey, DEFAULT_PRICING, type PricingOverrides } from './pricing.ts';
import {
  LlmError,
  type ChatRequest,
  type ChatResponse,
  type KeyCheck,
  type LLMProvider,
  type LlmErrorCode,
  type ModelInfo,
  type StopReason,
  type SystemBlock,
  type ToolCall,
  type UnifiedImage,
  type UnifiedMessage,
  type UnifiedPart,
} from './types.ts';

export type AnthropicRequest = Anthropic.Beta.MessageCreateParamsNonStreaming;
export type AnthropicResponse = Anthropic.Beta.BetaMessage;

/** Низкоуровневый клиент Anthropic (в тестах подменяется скриптованным). */
export interface AnthropicClient {
  create(req: AnthropicRequest): Promise<AnthropicResponse>;
}

/** Модели, для которых включаем серверный fallback при отказе (stop_reason: refusal). */
const SERVER_FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-fable-5-1']);

export interface AnthropicClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
}

/** Клиент Anthropic поверх SDK: таймаут 60 с, 2 повтора на 429/5xx (экспоненциальная пауза в SDK). */
export class AnthropicSdkClient implements AnthropicClient {
  readonly client: Anthropic;

  constructor(apiKey?: string, opts: AnthropicClientOptions = {}) {
    this.client = new Anthropic({
      ...(apiKey ? { apiKey } : {}),
      timeout: opts.timeoutMs ?? 60_000,
      maxRetries: opts.maxRetries ?? 2,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  create(req: AnthropicRequest): Promise<AnthropicResponse> {
    const withFallback: AnthropicRequest = SERVER_FALLBACK_MODELS.has(req.model)
      ? { ...req, betas: [...(req.betas ?? []), 'server-side-fallback-2026-07-01'], fallbacks: 'default' }
      : req;
    return this.client.beta.messages.create(withFallback);
  }
}

/** Код единой ошибки по исключению SDK Anthropic. */
export function anthropicErrorCode(err: unknown): LlmErrorCode {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return 'auth';
  if (err instanceof Anthropic.RateLimitError) return 'rate_limit';
  if (err instanceof Anthropic.NotFoundError) return 'not_found';
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.UnprocessableEntityError) return 'bad_request';
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'timeout';
  if (err instanceof Anthropic.APIConnectionError) return 'timeout';
  if (err instanceof Anthropic.InternalServerError) return 'overloaded';
  if (err instanceof Anthropic.APIError) return (err.status ?? 0) >= 500 || err.status === 529 ? 'overloaded' : 'unknown';
  return 'unknown';
}

export function toAnthropicError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  const status = err instanceof Anthropic.APIError ? err.status : undefined;
  return new LlmError(anthropicErrorCode(err), 'anthropic', (err as Error)?.message ?? String(err), { status, cause: err });
}

const imageBlock = (img: UnifiedImage): Anthropic.Beta.BetaImageBlockParam => ({
  type: 'image',
  source: { type: 'base64', media_type: img.mime, data: img.data },
});

function partToBlock(p: UnifiedPart): Anthropic.Beta.BetaContentBlockParam {
  switch (p.type) {
    case 'text':
      return { type: 'text', text: p.text };
    case 'image':
      return imageBlock(p.image);
    case 'tool_call':
      return { type: 'tool_use', id: p.id, name: p.name, input: p.args };
    case 'tool_result':
      return { type: 'tool_result', tool_use_id: p.toolCallId, content: p.content, ...(p.isError ? { is_error: true } : {}) };
  }
}

/** Единая история → сообщения Anthropic. Ходы ассистента того же провайдера повторяются как есть. */
export function toAnthropicMessages(messages: UnifiedMessage[], images: UnifiedImage[] = []): Anthropic.Beta.BetaMessageParam[] {
  const out: Anthropic.Beta.BetaMessageParam[] = messages.map((m) => {
    if (m.role === 'assistant' && m.raw?.provider === 'anthropic') {
      return { role: 'assistant', content: m.raw.items as Anthropic.Beta.BetaContentBlockParam[] };
    }
    if (typeof m.content === 'string') return { role: m.role, content: m.content };
    return { role: m.role, content: m.content.map(partToBlock) };
  });
  if (images.length) {
    const last = out.at(-1);
    const blocks = images.map(imageBlock);
    if (last && last.role === 'user') {
      last.content = typeof last.content === 'string' ? [...blocks, { type: 'text', text: last.content }] : [...blocks, ...(last.content as Anthropic.Beta.BetaContentBlockParam[])];
    } else {
      out.push({ role: 'user', content: blocks });
    }
  }
  return out;
}

export function toAnthropicSystem(system: string | SystemBlock[]): Anthropic.Beta.BetaTextBlockParam[] {
  const blocks = typeof system === 'string' ? [{ text: system, cache: true }] : system;
  return blocks.map((b) => ({ type: 'text', text: b.text, ...(b.cache ? { cache_control: { type: 'ephemeral' as const } } : {}) }));
}

export function toAnthropicRequest(req: ChatRequest): AnthropicRequest {
  const traits = modelTraits('anthropic', req.model);
  const outputConfig: Anthropic.Beta.BetaOutputConfig = {};
  if (req.effort) outputConfig.effort = req.effort;
  if (req.outputSchema) outputConfig.format = { type: 'json_schema', schema: req.outputSchema.schema };
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    system: toAnthropicSystem(req.system),
    messages: toAnthropicMessages(req.messages, req.images),
    ...(req.tools?.length
      ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema })) }
      : {}),
    ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
    // Новые модели Claude не принимают temperature — не передаём (раздел 2 ТЗ: параметры под модель).
    ...(req.temperature !== null && req.temperature !== undefined && traits.temperature ? { temperature: Math.min(1, Math.max(0, req.temperature)) } : {}),
  };
}

const STOP: Record<string, StopReason> = {
  end_turn: 'end',
  stop_sequence: 'end',
  tool_use: 'tool_call',
  max_tokens: 'max_tokens',
  refusal: 'refusal',
  pause_turn: 'pause',
};

/** Ответ Anthropic → единый ответ. Блоки сохраняются в `raw` для точного повтора в следующем запросе. */
export function fromAnthropicResponse(res: AnthropicResponse, latencyMs = 0): ChatResponse {
  const parts: UnifiedPart[] = [];
  const toolCalls: ToolCall[] = [];
  for (const b of res.content) {
    if (b.type === 'text') parts.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_use') {
      const args = (b.input ?? {}) as Record<string, unknown>;
      toolCalls.push({ id: b.id, name: b.name, args });
      parts.push({ type: 'tool_call', id: b.id, name: b.name, args });
    }
  }
  const text = parts
    .filter((p): p is Extract<UnifiedPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();
  const u = res.usage;
  return {
    text: text || null,
    toolCalls,
    stopReason: STOP[res.stop_reason ?? ''] ?? (toolCalls.length ? 'tool_call' : 'end'),
    usage: {
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cachedInputTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    },
    provider: 'anthropic',
    model: res.model,
    assistantMessage: { role: 'assistant', content: parts, raw: { provider: 'anthropic', items: res.content as unknown[] } },
    latencyMs,
  };
}

/** Адаптер Anthropic к единому интерфейсу (раздел 2 ТЗ). */
export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic' as const;

  constructor(
    private readonly client: AnthropicClient,
    private readonly opts: { models?: Anthropic['models'] | null; pricing?: PricingOverrides } = {},
  ) {}

  static fromKey(apiKey: string, opts: AnthropicClientOptions & { pricing?: PricingOverrides } = {}): AnthropicProvider {
    const sdk = new AnthropicSdkClient(apiKey, opts);
    return new AnthropicProvider(sdk, { models: sdk.client.models, pricing: opts.pricing });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    try {
      const res = await this.client.create(toAnthropicRequest(req));
      return fromAnthropicResponse(res, Date.now() - started);
    } catch (err) {
      throw toAnthropicError(err);
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.opts.models) return [];
    try {
      const page = await this.opts.models.list({ limit: 100 });
      return page.data
        .map((m) => infoOf(m, this.opts.pricing))
        .filter((m): m is ModelInfo => m !== null)
        .sort((a, b) => (a.recommended ?? 99) - (b.recommended ?? 99) || (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    } catch (err) {
      throw toAnthropicError(err);
    }
  }

  async validateKey(): Promise<KeyCheck> {
    try {
      const models = await this.listModels();
      return { ok: true, models: models.map((m) => m.id) };
    } catch (err) {
      return { ok: false, error: keyErrorText(err) };
    }
  }
}

function infoOf(m: Anthropic.ModelInfo, pricing?: PricingOverrides): ModelInfo | null {
  const traits = modelTraits('anthropic', m.id);
  const caps = m.capabilities;
  const tools = caps ? true : traits.tools;
  const chat = traits.chat && tools;
  if (!chat) return null;
  const base = tariffKey('anthropic', m.id);
  return {
    id: m.id,
    name: m.display_name || (base ? DEFAULT_PRICING.anthropic[base]?.name : undefined) || m.id,
    provider: 'anthropic',
    vision: caps ? caps.image_input?.supported !== false : traits.vision,
    tools,
    reasoning: caps ? caps.effort?.supported !== false : traits.reasoning,
    temperature: traits.temperature,
    maxOutputTokens: m.max_tokens ?? null,
    createdAt: m.created_at ?? null,
    price: pricePublic('anthropic', m.id, pricing),
    recommended: base ? (DEFAULT_PRICING.anthropic[base]?.recommended ?? null) : null,
  };
}

/** Понятный текст ошибки проверки ключа. */
export function keyErrorText(err: unknown): string {
  const e = err instanceof LlmError ? err : toAnthropicError(err);
  if (e.code === 'auth' && e.status === 403) return 'Ключ действует, но у него нет доступа к API';
  if (e.code === 'auth') return 'Ключ не принят: проверьте, что скопирован целиком';
  if (e.code === 'timeout') return `Нет связи с ${e.provider === 'anthropic' ? 'api.anthropic.com' : 'api.openai.com'} с сервера`;
  if (e.code === 'quota') return 'На счёте провайдера закончились средства';
  return e.message;
}
