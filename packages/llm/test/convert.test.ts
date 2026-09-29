import { describe, expect, it } from 'vitest';
import { fromAnthropicResponse, toAnthropicMessages, toAnthropicRequest, type AnthropicResponse } from '../src/anthropic.ts';
import { fromOpenAiResponse, strictCompatible, toOpenAiInput, toOpenAiRequest, type OpenAIResponseT } from '../src/openai.ts';
import { costOfUsage, defaultModel, modelTraits, priceFor, tariffModels } from '../src/pricing.ts';
import { maskKey } from '../src/providers/index.ts';
import type { ChatRequest, UnifiedMessage, UnifiedTool } from '../src/types.ts';

const tools: UnifiedTool[] = [
  { name: 'catalog_search', description: 'Поиск', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  { name: 'crm_create_task', description: 'Задача', inputSchema: { type: 'object', properties: { type: { type: 'string' }, text: { type: 'string' } }, required: ['type'], additionalProperties: false } },
];

/** История с текстом, картинкой, двумя вызовами инструментов за ход и их результатами. */
const history: UnifiedMessage[] = [
  { role: 'user', content: 'Нужна белая дверь' },
  { role: 'assistant', content: 'Какой размер?' },
  { role: 'user', content: [{ type: 'text', text: 'Вот фото' }, { type: 'image', image: { mime: 'image/jpeg', data: 'AAAA' } }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Смотрю каталог' },
      { type: 'tool_call', id: 'c1', name: 'catalog_search', args: { query: 'белая эмаль' } },
      { type: 'tool_call', id: 'c2', name: 'catalog_search', args: { query: 'белая экошпон' } },
    ],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', toolCallId: 'c1', content: '{"items":[{"id":"1001","price":14900}]}' },
      { type: 'tool_result', toolCallId: 'c2', content: '{"error":"нет"}', isError: true },
    ],
  },
];

const req: ChatRequest = {
  model: 'claude-opus-5',
  system: [
    { text: 'Правила', cache: true },
    { text: 'Сегодня: понедельник' },
  ],
  messages: history,
  tools,
  maxTokens: 1000,
  effort: 'low',
  temperature: 0.3,
};

describe('единая история → Anthropic', () => {
  it('текст, изображение, вызовы инструментов и результаты', () => {
    const r = toAnthropicRequest(req);
    expect(r.system).toEqual([
      { type: 'text', text: 'Правила', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Сегодня: понедельник' },
    ]);
    expect(r.output_config).toEqual({ effort: 'low' });
    // Opus 5 не принимает temperature — не передаём.
    expect(r).not.toHaveProperty('temperature');
    expect(r.tools?.map((t) => (t as { name: string }).name)).toEqual(['catalog_search', 'crm_create_task']);
    const m = r.messages;
    expect(m[0]).toEqual({ role: 'user', content: 'Нужна белая дверь' });
    expect(m[2]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Вот фото' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }] });
    expect(m[3]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Смотрю каталог' },
        { type: 'tool_use', id: 'c1', name: 'catalog_search', input: { query: 'белая эмаль' } },
        { type: 'tool_use', id: 'c2', name: 'catalog_search', input: { query: 'белая экошпон' } },
      ],
    });
    expect(m[4]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'c1', content: '{"items":[{"id":"1001","price":14900}]}' },
        { type: 'tool_result', tool_use_id: 'c2', content: '{"error":"нет"}', is_error: true },
      ],
    });
  });

  it('temperature уходит только моделям, которые её принимают; изображения запроса — к последнему сообщению', () => {
    const r = toAnthropicRequest({ ...req, model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'Что на фото?' }], images: [{ mime: 'image/png', data: 'BBBB' }] });
    expect(r.temperature).toBe(0.3);
    expect(r.messages[0]?.content).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } }, { type: 'text', text: 'Что на фото?' }]);
  });

  it('ход ассистента Anthropic повторяется как есть, чужой — собирается из частей', () => {
    const raw = [{ type: 'text', text: 'x', citations: null }];
    const m = toAnthropicMessages([
      { role: 'assistant', content: [{ type: 'text', text: 'x' }], raw: { provider: 'anthropic', items: raw } },
      { role: 'assistant', content: [{ type: 'text', text: 'y' }], raw: { provider: 'openai', items: [{ type: 'reasoning' }] } },
    ]);
    expect(m[0]?.content).toBe(raw);
    expect(m[1]?.content).toEqual([{ type: 'text', text: 'y' }]);
  });
});

describe('Anthropic → единый ответ', () => {
  const res = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    stop_reason: 'tool_use',
    stop_sequence: null,
    content: [
      { type: 'text', text: 'Ищу', citations: null },
      { type: 'tool_use', id: 't1', name: 'catalog_search', input: { query: 'a' } },
      { type: 'tool_use', id: 't2', name: 'knowledge_search', input: { query: 'b' } },
    ],
    usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 500, cache_read_input_tokens: 2000 },
  } as unknown as AnthropicResponse;

  it('несколько вызовов за ход, usage с кэшем, raw для повтора', () => {
    const r = fromAnthropicResponse(res, 12);
    expect(r).toMatchObject({ text: 'Ищу', stopReason: 'tool_call', provider: 'anthropic', model: 'claude-opus-5', latencyMs: 12 });
    expect(r.toolCalls).toEqual([
      { id: 't1', name: 'catalog_search', args: { query: 'a' } },
      { id: 't2', name: 'knowledge_search', args: { query: 'b' } },
    ]);
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 2000, cacheWriteTokens: 500 });
    expect(r.assistantMessage.raw).toEqual({ provider: 'anthropic', items: res.content });
    // Обратная конвертация даёт те же блоки.
    expect(toAnthropicMessages([r.assistantMessage])[0]?.content).toBe(res.content);
  });

  it('refusal / max_tokens / end_turn', () => {
    expect(fromAnthropicResponse({ ...res, stop_reason: 'refusal', content: [] }).stopReason).toBe('refusal');
    expect(fromAnthropicResponse({ ...res, stop_reason: 'max_tokens', content: [] }).stopReason).toBe('max_tokens');
    expect(fromAnthropicResponse({ ...res, stop_reason: 'end_turn', content: [{ type: 'text', text: 'ок', citations: null }] } as AnthropicResponse)).toMatchObject({ stopReason: 'end', text: 'ок', toolCalls: [] });
  });
});

describe('единая история → OpenAI Responses', () => {
  it('system → instructions, tool_use/tool_result → function_call/function_call_output, изображения → input_image', () => {
    const r = toOpenAiRequest({ ...req, model: 'gpt-5' });
    expect(r.instructions).toBe('Правила\n\nСегодня: понедельник');
    expect(r.max_output_tokens).toBe(1000);
    expect(r.reasoning).toEqual({ effort: 'low' });
    expect(r.store).toBe(false);
    // Модель с рассуждениями не принимает temperature.
    expect(r).not.toHaveProperty('temperature');
    expect(r.tools).toEqual([
      { type: 'function', name: 'catalog_search', description: 'Поиск', parameters: tools[0]!.inputSchema, strict: true },
      { type: 'function', name: 'crm_create_task', description: 'Задача', parameters: tools[1]!.inputSchema, strict: false },
    ]);
    const input = r.input as unknown[];
    expect(input[0]).toEqual({ role: 'user', content: 'Нужна белая дверь' });
    expect(input[1]).toEqual({ role: 'assistant', content: 'Какой размер?' });
    expect(input[2]).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'Вот фото' }, { type: 'input_image', detail: 'auto', image_url: 'data:image/jpeg;base64,AAAA' }] });
    expect(input.slice(3, 6)).toEqual([
      { role: 'assistant', content: 'Смотрю каталог' },
      { type: 'function_call', call_id: 'c1', name: 'catalog_search', arguments: '{"query":"белая эмаль"}' },
      { type: 'function_call', call_id: 'c2', name: 'catalog_search', arguments: '{"query":"белая экошпон"}' },
    ]);
    expect(input.slice(6)).toEqual([
      { type: 'function_call_output', call_id: 'c1', output: '{"items":[{"id":"1001","price":14900}]}' },
      { type: 'function_call_output', call_id: 'c2', output: '{"error":"нет"}' },
    ]);
  });

  it('gpt-4.1: temperature есть, reasoning нет; схема ответа → text.format', () => {
    const r = toOpenAiRequest({ ...req, model: 'gpt-4.1', outputSchema: { name: 'doc', schema: { type: 'object' } } });
    expect(r.temperature).toBe(0.3);
    expect(r).not.toHaveProperty('reasoning');
    expect(r.text).toEqual({ format: { type: 'json_schema', name: 'doc', schema: { type: 'object' }, strict: false } });
  });

  it('ход ассистента OpenAI повторяется items как есть (reasoning с encrypted_content)', () => {
    const items = [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'x', summary: [] }, { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'catalog_search', arguments: '{}' }];
    const input = toOpenAiInput([{ role: 'assistant', content: [{ type: 'tool_call', id: 'call_1', name: 'catalog_search', args: {} }], raw: { provider: 'openai', items } }]);
    expect(input).toEqual(items);
  });

  it('strict-режим только для схем без необязательных параметров', () => {
    expect(strictCompatible({ type: 'object', properties: { a: {} }, required: ['a'], additionalProperties: false })).toBe(true);
    expect(strictCompatible({ type: 'object', properties: { a: {}, b: {} }, required: ['a'], additionalProperties: false })).toBe(false);
    expect(strictCompatible({ type: 'object', properties: { a: {} }, required: ['a'] })).toBe(false);
  });
});

describe('OpenAI → единый ответ', () => {
  const base = {
    id: 'resp_1',
    object: 'response',
    created_at: 1,
    status: 'completed',
    model: 'gpt-5-2025-08-07',
    error: null,
    incomplete_details: null,
    output: [],
    usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 10 }, total_tokens: 1230 },
  };

  it('текст + два вызова инструментов, cached_tokens вычитаются из входа', () => {
    const res = {
      ...base,
      output: [
        { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc' },
        { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Ищу', annotations: [] }] },
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'catalog_search', arguments: '{"query":"a"}', status: 'completed' },
        { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'knowledge_search', arguments: 'not json', status: 'completed' },
      ],
    } as unknown as OpenAIResponseT;
    const r = fromOpenAiResponse(res, 5);
    expect(r).toMatchObject({ text: 'Ищу', stopReason: 'tool_call', provider: 'openai', model: 'gpt-5-2025-08-07' });
    expect(r.toolCalls).toEqual([
      { id: 'call_1', name: 'catalog_search', args: { query: 'a' } },
      { id: 'call_2', name: 'knowledge_search', args: {} },
    ]);
    expect(r.usage).toEqual({ inputTokens: 200, outputTokens: 30, cachedInputTokens: 1000, cacheWriteTokens: 0 });
    const raw = r.assistantMessage.raw!.items as { type: string; status?: unknown }[];
    expect(raw.map((i) => i.type)).toEqual(['reasoning', 'message', 'function_call', 'function_call']);
    expect(raw.every((i) => !('status' in i))).toBe(true);
  });

  it('max_output_tokens → max_tokens, refusal / content_filter → refusal, failed → ошибка', () => {
    expect(fromOpenAiResponse({ ...base, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } as unknown as OpenAIResponseT).stopReason).toBe('max_tokens');
    expect(fromOpenAiResponse({ ...base, output: [{ type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'no' }] }] } as unknown as OpenAIResponseT).stopReason).toBe('refusal');
    expect(fromOpenAiResponse({ ...base, status: 'incomplete', incomplete_details: { reason: 'content_filter' } } as unknown as OpenAIResponseT).stopReason).toBe('refusal');
    expect(() => fromOpenAiResponse({ ...base, status: 'failed', error: { code: 'server_error', message: 'boom' } } as unknown as OpenAIResponseT)).toThrow(/boom/);
  });
});

describe('тарифы и характеристики моделей', () => {
  it('стоимость с кэшем у обоих провайдеров, неизвестная модель — по максимуму', () => {
    expect(costOfUsage({ provider: 'anthropic', model: 'claude-opus-5' }, { inputTokens: 1_000_000, outputTokens: 0 }).usd).toBe(5);
    expect(costOfUsage({ provider: 'anthropic', model: 'claude-opus-5-20260101' }, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 1_000_000 }).usd).toBeCloseTo(0.5);
    expect(costOfUsage({ provider: 'anthropic', model: 'claude-opus-5' }, { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 }).usd).toBeCloseTo(6.25);
    expect(costOfUsage({ provider: 'openai', model: 'gpt-5-2025-08-07' }, { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 1_000_000 }).usd).toBeCloseTo(11.375);
    expect(costOfUsage({ provider: 'openai', model: 'gpt-5-mini' }, { inputTokens: 1_000_000, outputTokens: 0 }).usd).toBe(0.25);
    expect(costOfUsage({ provider: 'openai', model: 'unknown-x' }, { inputTokens: 1_000_000, outputTokens: 0 }).usd).toBe(10);
    // Переопределение из настроек аккаунта.
    expect(priceFor('openai', 'gpt-5', { 'openai:gpt-5': { input: 2, output: 20 } })).toMatchObject({ input: 2, output: 20 });
    expect(costOfUsage({ provider: 'openai', model: 'gpt-5' }, { inputTokens: 1_000_000, outputTokens: 0 }, { 'openai:gpt-5': { input: 2, output: 20 } }).usd).toBe(2);
  });

  it('фильтр моделей: только чат с инструментами; эмбеддинги, аудио, картинки — нет', () => {
    for (const id of ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o', 'o3', 'o4-mini', 'gpt-5.2-2025-12-11']) expect(modelTraits('openai', id).chat, id).toBe(true);
    for (const id of ['text-embedding-3-large', 'whisper-1', 'gpt-4o-audio-preview', 'gpt-image-1', 'dall-e-3', 'gpt-4o-realtime-preview', 'tts-1', 'gpt-5-chat-latest', 'chatgpt-4o-latest', 'o1-mini', 'gpt-4o-search-preview', 'omni-moderation-latest']) {
      expect(modelTraits('openai', id).chat, id).toBe(false);
    }
    expect(modelTraits('openai', 'gpt-5')).toMatchObject({ vision: true, reasoning: true, temperature: false });
    expect(modelTraits('openai', 'gpt-4.1-mini')).toMatchObject({ vision: true, reasoning: false, temperature: true });
    expect(modelTraits('anthropic', 'claude-opus-5')).toMatchObject({ chat: true, vision: true, temperature: false });
    expect(modelTraits('anthropic', 'claude-sonnet-4-6')).toMatchObject({ temperature: true });
  });

  it('модель по умолчанию — первая рекомендованная из таблицы; маска ключа', () => {
    expect(defaultModel('anthropic')).toBe('claude-opus-5');
    expect(defaultModel('openai')).toBe('gpt-5.2');
    expect(tariffModels('openai')[0]).toMatchObject({ id: 'gpt-5.2', price: { input: 1.75, output: 14 }, vision: true });
    expect(maskKey('sk-ant-api03-abcdefghijklmnop1234')).toBe('sk-ant-…1234');
    expect(maskKey('sk-proj-abcdefghijklmnop5678')).toBe('sk-…5678');
    expect(maskKey('short')).toBe('…');
  });
});
