import OpenAI from 'openai';
import type { ResponseCreateParamsNonStreaming, ResponseInput, ResponseInputItem, Tool, Response as OpenAIResponse } from 'openai/resources/responses/responses';
import { keyErrorText } from './anthropic.ts';
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

export type OpenAIRequest = ResponseCreateParamsNonStreaming;
export type OpenAIResponseT = OpenAIResponse;

/** Низкоуровневый клиент OpenAI Responses API (в тестах подменяется). */
export interface OpenAIClient {
  create(req: OpenAIRequest): Promise<OpenAIResponseT>;
}

export interface OpenAIClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  baseURL?: string;
}

/** Клиент OpenAI поверх официального SDK: таймаут 60 с, 2 повтора на 429/5xx с экспоненциальной паузой. */
export class OpenAISdkClient implements OpenAIClient {
  readonly client: OpenAI;

  constructor(apiKey: string, opts: OpenAIClientOptions = {}) {
    this.client = new OpenAI({
      apiKey,
      timeout: opts.timeoutMs ?? 60_000,
      maxRetries: opts.maxRetries ?? 2,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  create(req: OpenAIRequest): Promise<OpenAIResponseT> {
    return this.client.responses.create(req);
  }
}

const errCode = (err: unknown): string | undefined => (err as { code?: string; error?: { code?: string } } | null)?.code ?? (err as { error?: { code?: string } } | null)?.error?.code;

/** Код единой ошибки по исключению SDK OpenAI. */
export function openAiErrorCode(err: unknown): LlmErrorCode {
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) return 'auth';
  if (err instanceof OpenAI.RateLimitError) return errCode(err) === 'insufficient_quota' ? 'quota' : 'rate_limit';
  if (err instanceof OpenAI.NotFoundError) return 'not_found';
  if (err instanceof OpenAI.BadRequestError || err instanceof OpenAI.UnprocessableEntityError) {
    return errCode(err) === 'model_not_found' ? 'not_found' : 'bad_request';
  }
  if (err instanceof OpenAI.APIConnectionTimeoutError) return 'timeout';
  if (err instanceof OpenAI.APIConnectionError) return 'timeout';
  if (err instanceof OpenAI.InternalServerError) return 'overloaded';
  if (err instanceof OpenAI.APIError) return (err.status ?? 0) >= 500 ? 'overloaded' : 'unknown';
  return 'unknown';
}

export function toOpenAiError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  const status = err instanceof OpenAI.APIError ? err.status : undefined;
  return new LlmError(openAiErrorCode(err), 'openai', (err as Error)?.message ?? String(err), { status, cause: err });
}

const imageItem = (img: UnifiedImage) => ({ type: 'input_image' as const, detail: 'auto' as const, image_url: `data:${img.mime};base64,${img.data}` });

/** Единая история → items OpenAI Responses. Ходы ассистента того же провайдера повторяются как есть (reasoning, id). */
export function toOpenAiInput(messages: UnifiedMessage[], images: UnifiedImage[] = []): ResponseInput {
  const items: ResponseInputItem[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.raw?.provider === 'openai') {
      items.push(...(m.raw.items as ResponseInputItem[]));
      continue;
    }
    if (typeof m.content === 'string') {
      items.push({ role: m.role, content: m.content });
      continue;
    }
    const content: ({ type: 'input_text'; text: string } | ReturnType<typeof imageItem>)[] = [];
    const flush = () => {
      if (!content.length) return;
      if (m.role === 'assistant') items.push({ role: 'assistant', content: content.map((c) => (c.type === 'input_text' ? c.text : '')).join('\n') });
      else items.push({ role: 'user', content: [...content] });
      content.length = 0;
    };
    for (const p of m.content) {
      if (p.type === 'text') content.push({ type: 'input_text', text: p.text });
      else if (p.type === 'image') content.push(imageItem(p.image));
      else if (p.type === 'tool_call') {
        flush();
        // Без id: вызов другого провайдера (или прошлого хода) отправляется как новый item.
        items.push({ type: 'function_call', call_id: p.id, name: p.name, arguments: JSON.stringify(p.args) });
      } else if (p.type === 'tool_result') {
        flush();
        items.push({ type: 'function_call_output', call_id: p.toolCallId, output: p.content });
      }
    }
    flush();
  }
  if (images.length) {
    const last = items.at(-1);
    const imgs = images.map(imageItem);
    if (last && 'role' in last && last.role === 'user') {
      const prev = typeof last.content === 'string' ? [{ type: 'input_text' as const, text: last.content }] : last.content;
      last.content = [...imgs, ...prev];
    } else items.push({ role: 'user', content: imgs });
  }
  return items;
}

export const systemText = (system: string | SystemBlock[]): string => (typeof system === 'string' ? system : system.map((b) => b.text).join('\n\n'));

/**
 * Строгий режим OpenAI требует `additionalProperties: false` и все свойства в `required`.
 * Схемы инструментов с необязательными параметрами отправляются без strict.
 */
export function strictCompatible(schema: Record<string, unknown>): boolean {
  if (schema.type !== 'object' || schema.additionalProperties !== false) return false;
  const props = Object.keys((schema.properties as Record<string, unknown> | undefined) ?? {});
  const required = new Set((schema.required as string[] | undefined) ?? []);
  return props.every((p) => required.has(p));
}

export function toOpenAiRequest(req: ChatRequest): OpenAIRequest {
  const traits = modelTraits('openai', req.model);
  const tools: Tool[] | undefined = req.tools?.length
    ? req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema, strict: strictCompatible(t.inputSchema) }))
    : undefined;
  return {
    model: req.model,
    instructions: systemText(req.system),
    input: toOpenAiInput(req.messages, req.images),
    max_output_tokens: req.maxTokens,
    store: false,
    ...(tools ? { tools, parallel_tool_calls: true } : {}),
    ...(traits.reasoning ? { reasoning: { effort: req.effort ?? 'low' }, include: ['reasoning.encrypted_content'] } : {}),
    ...(req.temperature !== null && req.temperature !== undefined && traits.temperature ? { temperature: Math.min(2, Math.max(0, req.temperature)) } : {}),
    ...(req.outputSchema ? { text: { format: { type: 'json_schema', name: req.outputSchema.name, schema: req.outputSchema.schema, strict: false } } } : {}),
    ...(req.cacheKey ? { prompt_cache_key: req.cacheKey } : {}),
  };
}

function parseArgs(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Ответ OpenAI → единый ответ. Items ответа сохраняются в `raw` (reasoning с encrypted_content, id вызовов). */
export function fromOpenAiResponse(res: OpenAIResponseT, latencyMs = 0): ChatResponse {
  if (res.status === 'failed' || res.error) {
    throw new LlmError(res.error?.code === 'rate_limit_exceeded' ? 'rate_limit' : 'overloaded', 'openai', res.error?.message ?? 'Ответ OpenAI со статусом failed');
  }
  const parts: UnifiedPart[] = [];
  const toolCalls: ToolCall[] = [];
  let refusal = false;
  for (const item of res.output) {
    if (item.type === 'message') {
      for (const c of item.content) {
        if (c.type === 'output_text') parts.push({ type: 'text', text: c.text });
        else if (c.type === 'refusal') refusal = true;
      }
    } else if (item.type === 'function_call') {
      const args = parseArgs(item.arguments);
      toolCalls.push({ id: item.call_id, name: item.name, args });
      parts.push({ type: 'tool_call', id: item.call_id, name: item.name, args });
    }
  }
  const text = parts
    .filter((p): p is Extract<UnifiedPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();
  let stopReason: StopReason = toolCalls.length ? 'tool_call' : 'end';
  const reason = res.incomplete_details?.reason;
  if (res.status === 'incomplete' && reason === 'max_output_tokens') stopReason = 'max_tokens';
  else if (reason === 'content_filter' || refusal) stopReason = 'refusal';
  const u = res.usage;
  const cached = u?.input_tokens_details?.cached_tokens ?? 0;
  return {
    text: text || null,
    toolCalls,
    stopReason,
    usage: { inputTokens: Math.max(0, (u?.input_tokens ?? 0) - cached), outputTokens: u?.output_tokens ?? 0, cachedInputTokens: cached, cacheWriteTokens: 0 },
    provider: 'openai',
    model: res.model,
    // Items ответа (в т. ч. reasoning) уходят обратно как есть — так требует Responses API при store: false.
    assistantMessage: { role: 'assistant', content: parts, raw: { provider: 'openai', items: res.output.map(stripStatus) } },
    latencyMs,
  };
}

/** Поля статуса из items ответа при повторной отправке не нужны. */
function stripStatus(item: OpenAIResponseT['output'][number]): unknown {
  const rest: Record<string, unknown> = { ...(item as unknown as Record<string, unknown>) };
  delete rest.status;
  return rest;
}

/** Адаптер OpenAI (Responses API) к единому интерфейсу. */
export class OpenAIProvider implements LLMProvider {
  readonly id = 'openai' as const;

  constructor(
    private readonly client: OpenAIClient,
    private readonly opts: { models?: OpenAI['models'] | null; pricing?: PricingOverrides } = {},
  ) {}

  static fromKey(apiKey: string, opts: OpenAIClientOptions & { pricing?: PricingOverrides } = {}): OpenAIProvider {
    const sdk = new OpenAISdkClient(apiKey, opts);
    return new OpenAIProvider(sdk, { models: sdk.client.models, pricing: opts.pricing });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    try {
      const res = await this.client.create(toOpenAiRequest(req));
      return fromOpenAiResponse(res, Date.now() - started);
    } catch (err) {
      throw toOpenAiError(err);
    }
  }

  /** Только чат-модели с инструментами: эмбеддинги, аудио, картинки, поиск — скрыты (раздел 4 ТЗ). */
  async listModels(): Promise<ModelInfo[]> {
    if (!this.opts.models) return [];
    try {
      const ids: { id: string; created: number }[] = [];
      for await (const m of this.opts.models.list()) ids.push({ id: m.id, created: m.created });
      return ids
        .filter((m) => modelTraits('openai', m.id).chat)
        .map((m) => infoOf(m, this.opts.pricing))
        .sort((a, b) => (a.recommended ?? 99) - (b.recommended ?? 99) || (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    } catch (err) {
      throw toOpenAiError(err);
    }
  }

  async validateKey(): Promise<KeyCheck> {
    try {
      const models = await this.listModels();
      return { ok: true, models: models.map((m) => m.id) };
    } catch (err) {
      return { ok: false, error: keyErrorText(toOpenAiError(err)) };
    }
  }
}

function infoOf(m: { id: string; created: number }, pricing?: PricingOverrides): ModelInfo {
  const traits = modelTraits('openai', m.id);
  const base = tariffKey('openai', m.id);
  return {
    id: m.id,
    name: (base && DEFAULT_PRICING.openai[base]?.name && (base === m.id ? DEFAULT_PRICING.openai[base]?.name : `${DEFAULT_PRICING.openai[base]?.name} (${m.id})`)) || m.id,
    provider: 'openai',
    vision: traits.vision,
    tools: traits.tools,
    reasoning: traits.reasoning,
    temperature: traits.temperature,
    maxOutputTokens: null,
    createdAt: m.created ? new Date(m.created * 1000).toISOString() : null,
    price: pricePublic('openai', m.id, pricing),
    recommended: base === m.id ? (DEFAULT_PRICING.openai[base]?.recommended ?? null) : null,
  };
}
