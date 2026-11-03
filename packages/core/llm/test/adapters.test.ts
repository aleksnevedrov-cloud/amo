import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../src/anthropic.ts';
import { chatWithFallback, gatewayFromResolver, LlmUnavailableError, singleProviderGateway } from '../src/fallback.ts';
import { fromOpenAiResponse, OpenAIProvider, toOpenAiRequest, type OpenAIResponseT } from '../src/openai.ts';
import { costOfUsage } from '../src/pricing.ts';
import { createProvider, verifyKey } from '../src/providers/index.ts';
import { LlmError, WebSearchUnavailableError, type ChatRequest, type LLMProvider } from '../src/types.ts';

type Handler = (url: string, init: RequestInit) => Promise<Response> | Response;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** Как настоящий fetch: при таймауте SDK отменяет запрос через signal. */
const fetchWith = (h: Handler): typeof fetch =>
  ((input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      const abort = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort);
      Promise.resolve(h(String(input), init ?? {})).then(resolve, reject);
    })) as typeof fetch;

const req: ChatRequest = { model: 'm', system: 'S', messages: [{ role: 'user', content: 'Привет' }], maxTokens: 100, tools: [] };

const anthropicOk = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  stop_reason: 'end_turn',
  stop_sequence: null,
  content: [{ type: 'text', text: 'Здравствуйте!' }],
  usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
};
const openaiOk = {
  id: 'resp_1',
  object: 'response',
  created_at: 1,
  status: 'completed',
  model: 'gpt-5',
  error: null,
  incomplete_details: null,
  output: [{ type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Добрый день!', annotations: [] }] }],
  usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 },
};

describe('адаптер Anthropic на моках API', () => {
  const mk = (h: Handler) => createProvider('anthropic', 'sk-ant-test', { fetch: fetchWith(h), maxRetries: 0, timeoutMs: 200 });

  it('успешный ответ: заголовки, тело запроса, единый ответ', async () => {
    let seen: { url: string; key: string | null; body: Record<string, unknown> } | null = null;
    const p = mk((url, init) => {
      seen = { url, key: new Headers(init.headers).get('x-api-key'), body: JSON.parse(String(init.body)) };
      return json(200, anthropicOk);
    });
    const r = await p.chat({ ...req, model: 'claude-opus-5', effort: 'low' });
    expect(seen!.url).toContain('/v1/messages');
    expect(seen!.key).toBe('sk-ant-test');
    expect(seen!.body).toMatchObject({ model: 'claude-opus-5', max_tokens: 100, fallbacks: 'default', output_config: { effort: 'low' } });
    expect(r).toMatchObject({ text: 'Здравствуйте!', stopReason: 'end', provider: 'anthropic', model: 'claude-opus-5' });
  });

  it('ошибки: auth, rate_limit, overloaded, timeout, not_found, bad_request', async () => {
    const code = async (p: LLMProvider) => {
      try {
        await p.chat(req);
        return 'ok';
      } catch (err) {
        expect(err).toBeInstanceOf(LlmError);
        return (err as LlmError).code;
      }
    };
    expect(await code(mk(() => json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })))).toBe('auth');
    expect(await code(mk(() => json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } })))).toBe('rate_limit');
    expect(await code(mk(() => json(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })))).toBe('overloaded');
    expect(await code(mk(() => json(404, { type: 'error', error: { type: 'not_found_error', message: 'model: nope' } })))).toBe('not_found');
    expect(await code(mk(() => json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } })))).toBe('bad_request');
    expect(await code(mk(() => new Promise<Response>(() => undefined)))).toBe('timeout');
  });

  it('список моделей: только чат-модели, с ценой и меткой изображений; проверка ключа', async () => {
    const p = mk((url) =>
      url.includes('/v1/models')
        ? json(200, {
            data: [
              { id: 'claude-opus-5', display_name: 'Claude Opus 5', created_at: '2026-05-01T00:00:00Z', type: 'model', capabilities: { image_input: { supported: true }, effort: { supported: true } }, max_tokens: 64000 },
              { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z', type: 'model', capabilities: null },
            ],
            has_more: false,
            first_id: null,
            last_id: null,
          })
        : json(404, {}),
    );
    const models = await p.listModels();
    expect(models.map((m) => m.id)).toEqual(['claude-opus-5', 'claude-haiku-4-5-20251001']);
    expect(models[0]).toMatchObject({ vision: true, tools: true, price: { input: 5, output: 25 }, recommended: 1, maxOutputTokens: 64000 });
    expect(models[1]).toMatchObject({ price: { input: 1, output: 5 }, temperature: true });
    expect(await p.validateKey()).toEqual({ ok: true, models: ['claude-opus-5', 'claude-haiku-4-5-20251001'] });
    const bad = await verifyKey('anthropic', 'sk-ant-bad', { fetch: fetchWith(() => json(401, { type: 'error', error: { type: 'authentication_error', message: 'x' } })) });
    expect(bad).toEqual({ ok: false, error: 'Ключ не принят: проверьте, что скопирован целиком' });
  });
});

describe('адаптер OpenAI на моках API', () => {
  const mk = (h: Handler) => createProvider('openai', 'sk-test', { fetch: fetchWith(h), maxRetries: 0, timeoutMs: 200 });

  it('успешный ответ: Responses API, заголовки, тело, единый ответ', async () => {
    let seen: { url: string; auth: string | null; body: Record<string, unknown> } | null = null;
    const p = mk((url, init) => {
      seen = { url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) };
      return json(200, openaiOk);
    });
    const r = await p.chat({ ...req, model: 'gpt-5', effort: 'medium' });
    expect(seen!.url).toContain('/v1/responses');
    expect(seen!.auth).toBe('Bearer sk-test');
    expect(seen!.body).toMatchObject({ model: 'gpt-5', instructions: 'S', max_output_tokens: 100, store: false, reasoning: { effort: 'medium' }, input: [{ role: 'user', content: 'Привет' }] });
    expect(r).toMatchObject({ text: 'Добрый день!', stopReason: 'end', provider: 'openai', model: 'gpt-5' });
  });

  it('ошибки: auth, rate_limit, quota, overloaded, timeout, model_not_found', async () => {
    const code = async (p: LLMProvider) => {
      try {
        await p.chat(req);
        return 'ok';
      } catch (err) {
        expect(err).toBeInstanceOf(LlmError);
        return (err as LlmError).code;
      }
    };
    expect(await code(mk(() => json(401, { error: { message: 'Incorrect API key', type: 'invalid_request_error', code: 'invalid_api_key' } })))).toBe('auth');
    expect(await code(mk(() => json(429, { error: { message: 'Rate limit', type: 'rate_limit_error', code: 'rate_limit_exceeded' } })))).toBe('rate_limit');
    expect(await code(mk(() => json(429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } })))).toBe('quota');
    expect(await code(mk(() => json(503, { error: { message: 'overloaded', type: 'server_error' } })))).toBe('overloaded');
    expect(await code(mk(() => json(404, { error: { message: 'The model `x` does not exist', type: 'invalid_request_error', code: 'model_not_found' } })))).toBe('not_found');
    expect(await code(mk(() => json(400, { error: { message: 'bad', type: 'invalid_request_error', code: null } })))).toBe('bad_request');
    expect(await code(mk(() => new Promise<Response>(() => undefined)))).toBe('timeout');
  });

  it('список моделей отфильтрован: без эмбеддингов, аудио, картинок; проверка ключа', async () => {
    const p = mk((url) =>
      url.includes('/v1/models')
        ? json(200, {
            object: 'list',
            data: [
              { id: 'gpt-5', object: 'model', created: 1_754_000_000, owned_by: 'openai' },
              { id: 'gpt-4.1-mini', object: 'model', created: 1_744_000_000, owned_by: 'openai' },
              { id: 'text-embedding-3-small', object: 'model', created: 1, owned_by: 'openai' },
              { id: 'whisper-1', object: 'model', created: 1, owned_by: 'openai' },
              { id: 'gpt-image-1', object: 'model', created: 1, owned_by: 'openai' },
              { id: 'gpt-4o-realtime-preview', object: 'model', created: 1, owned_by: 'openai' },
            ],
          })
        : json(404, {}),
    );
    const models = await p.listModels();
    expect(models.map((m) => m.id)).toEqual(['gpt-5', 'gpt-4.1-mini']);
    expect(models[0]).toMatchObject({ vision: true, reasoning: true, temperature: false, price: { input: 1.25, output: 10, cachedInput: 0.125 }, recommended: 3 });
    expect(await verifyKey('openai', 'sk-x', { fetch: fetchWith(() => json(401, { error: { message: 'bad key', type: 'invalid_request_error', code: 'invalid_api_key' } })) })).toEqual({
      ok: false,
      error: 'Ключ не принят: проверьте, что скопирован целиком',
    });
  });
});

describe('резервная модель любого провайдера', () => {
  const fail = (code: LlmError['code'], provider: 'anthropic' | 'openai'): LLMProvider => ({
    id: provider,
    listModels: async () => [],
    validateKey: async () => ({ ok: true }),
    chat: async () => {
      throw new LlmError(code, provider, `${code} у ${provider}`);
    },
  });
  const ok = (provider: 'anthropic' | 'openai'): LLMProvider => ({
    id: provider,
    listModels: async () => [],
    validateKey: async () => ({ ok: true }),
    chat: async (r) => ({
      text: `ответ ${provider}/${r.model}`,
      toolCalls: [],
      stopReason: 'end',
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0 },
      provider,
      model: r.model,
      assistantMessage: { role: 'assistant', content: 'x' },
      latencyMs: 1,
    }),
  });
  const route = { primary: { provider: 'anthropic' as const, model: 'claude-opus-5' }, fallback: { provider: 'openai' as const, model: 'gpt-5' } };

  it('перегрузка Anthropic → ответ через OpenAI с отметкой fallback', async () => {
    const r = await chatWithFallback((id) => (id === 'anthropic' ? fail('overloaded', 'anthropic') : ok('openai')), req, route);
    expect(r).toMatchObject({ text: 'ответ openai/gpt-5', fallbackUsed: true, requested: route.primary, provider: 'openai' });
    expect(r.attempts).toEqual([{ ref: route.primary, error: 'overloaded у anthropic', code: 'overloaded' }]);
  });

  it('ключ основного провайдера не сохранён → сразу резервная; нет обоих → LlmUnavailableError', async () => {
    const r = await chatWithFallback((id) => (id === 'openai' ? ok('openai') : null), req, route);
    expect(r).toMatchObject({ fallbackUsed: true, attempts: [{ code: 'no_key' }] });
    await expect(chatWithFallback(() => null, req, route)).rejects.toBeInstanceOf(LlmUnavailableError);
    await expect(chatWithFallback((id) => fail(id === 'anthropic' ? 'timeout' : 'rate_limit', id), req, route)).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it('ошибка запроса (bad_request, auth) не маскируется переключением', async () => {
    await expect(chatWithFallback((id) => (id === 'anthropic' ? fail('auth', 'anthropic') : ok('openai')), req, route)).rejects.toMatchObject({ code: 'auth' });
    await expect(chatWithFallback((id) => (id === 'anthropic' ? fail('bad_request', 'anthropic') : ok('openai')), req, route)).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('модель пропала из API (not_found) → резервная', async () => {
    const r = await chatWithFallback((id) => (id === 'anthropic' ? fail('not_found', 'anthropic') : ok('openai')), req, route);
    expect(r.fallbackUsed).toBe(true);
    expect(r.attempts[0]?.code).toBe('not_found');
  });

  it('шлюз одного адаптера: провайдер маршрута игнорируется, резервная — та же модель у адаптера', async () => {
    const calls: string[] = [];
    const p = ok('anthropic');
    const g = singleProviderGateway({ ...p, chat: async (r) => (calls.push(r.model), p.chat(r)) });
    const r = await g.chat(req, { primary: { provider: 'openai', model: 'gpt-5' }, fallback: null });
    expect(r.provider).toBe('anthropic');
    expect(calls).toEqual(['gpt-5']);
    expect(await g.providers()).toEqual(['anthropic']);
    const g2 = gatewayFromResolver((id) => (id === 'openai' ? ok('openai') : null), ['openai']);
    expect((await g2.chat(req, route)).provider).toBe('openai');
  });
});

describe('провайдеры напрямую', () => {
  it('AnthropicProvider и OpenAIProvider с подменённым клиентом', async () => {
    const a = new AnthropicProvider({ create: async () => anthropicOk as never });
    expect((await a.chat(req)).text).toBe('Здравствуйте!');
    expect(await a.listModels()).toEqual([]);
    const o = new OpenAIProvider({ create: async () => openaiOk as never });
    expect((await o.chat(req)).text).toBe('Добрый день!');
  });
});

describe('веб-поиск в слое модели (RFD-AI-AGENT-OPT-PRICE, этап 1)', () => {
  const mk = (h: Handler) => createProvider('openai', 'sk-test', { fetch: fetchWith(h), maxRetries: 0, timeoutMs: 200 });
  const webSearchCall = {
    type: 'web_search_call',
    id: 'ws_1',
    status: 'completed',
    action: { type: 'search', query: 'дверь Турин цена', sources: [{ type: 'url', url: 'https://shop.ru/turin' }, { type: 'url', url: 'https://fabrika.ru/turin' }] },
  };
  const citedMessage = {
    type: 'message',
    id: 'm1',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: '{"offers":[]}', annotations: [{ type: 'url_citation', url: 'https://shop.ru/turin', title: 'Турин', start_index: 0, end_index: 1 }, { type: 'url_citation', url: 'https://market.ru/x', title: 'Маркет', start_index: 0, end_index: 1 }] }],
  };
  const withSearch = { ...openaiOk, output: [webSearchCall, citedMessage] } as unknown as OpenAIResponseT;

  it('без webSearch тело запроса прежнее: тот же набор ключей, без tools, tool_choice и include', () => {
    const body = toOpenAiRequest({ model: 'gpt-4.1', system: 'S', messages: [{ role: 'user', content: 'Привет' }], maxTokens: 100 });
    expect(Object.keys(body).sort()).toEqual(['input', 'instructions', 'max_output_tokens', 'model', 'store']);
    const reasoning = toOpenAiRequest({ model: 'gpt-5', system: 'S', messages: [{ role: 'user', content: 'Привет' }], maxTokens: 100 });
    expect(Object.keys(reasoning).sort()).toEqual(['include', 'input', 'instructions', 'max_output_tokens', 'model', 'reasoning', 'store']);
    expect(reasoning.include).toEqual(['reasoning.encrypted_content']);
  });

  it('с webSearch и toolChoice required: инструмент web_search с регионом, tool_choice, include с источниками и рассуждениями', () => {
    const body = toOpenAiRequest({ model: 'gpt-5', system: 'S', messages: [{ role: 'user', content: 'Цены' }], maxTokens: 100, webSearch: {}, toolChoice: 'required' });
    expect(body.tools).toEqual([{ type: 'web_search', user_location: { type: 'approximate', country: 'RU', city: 'Moscow', region: 'Moscow' } }]);
    expect(body.tool_choice).toBe('required');
    expect(body.include).toEqual(['reasoning.encrypted_content', 'web_search_call.action.sources']);
    expect(body).not.toHaveProperty('parallel_tool_calls');
    // Вместе с function-tools: веб-поиск первым, parallel_tool_calls как раньше; регион из запроса.
    const both = toOpenAiRequest({ ...req, model: 'gpt-4.1', tools: [{ name: 'f', description: 'd', inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }], webSearch: { region: { country: 'RU', city: 'Saint Petersburg' } } });
    expect(both.tools?.map((t) => t.type)).toEqual(['web_search', 'function']);
    expect(both.parallel_tool_calls).toBe(true);
    expect(both.include).toEqual(['web_search_call.action.sources']);
    expect((both.tools?.[0] as { user_location: { city: string; region: string } }).user_location).toMatchObject({ city: 'Saint Petersburg', region: 'Moscow' });
    expect(both).not.toHaveProperty('tool_choice');
    expect(both).not.toHaveProperty('max_tool_calls');
    // Удешевление поиска (RFD-AI-AGENT-OPT-PRICE-2-FIX): контекст источников и лимит вызовов — только если заданы.
    const cheap = toOpenAiRequest({ ...req, model: 'gpt-5', webSearch: { contextSize: 'low', maxCalls: 3 } });
    expect(cheap.tools).toEqual([{ type: 'web_search', user_location: { type: 'approximate', country: 'RU', city: 'Moscow', region: 'Moscow' }, search_context_size: 'low' }]);
    // В типах SDK поля max_tool_calls нет, в API Responses оно есть.
    expect((cheap as unknown as { max_tool_calls?: number }).max_tool_calls).toBe(3);
  });

  it('ответ с web_search_call: источники из вызова поиска и url_citation без дублей, число вызовов в usage и в стоимости', () => {
    const r = fromOpenAiResponse(withSearch);
    expect(r.sources).toEqual([{ url: 'https://shop.ru/turin' }, { url: 'https://fabrika.ru/turin' }, { url: 'https://market.ru/x', title: 'Маркет' }]);
    expect(r.usage.webSearchCalls).toBe(1);
    expect(r.text).toBe('{"offers":[]}');
    // Ответ без поиска — как раньше: ни sources, ни webSearchCalls.
    const plain = fromOpenAiResponse(openaiOk as unknown as OpenAIResponseT);
    expect(plain).not.toHaveProperty('sources');
    expect(plain.usage).not.toHaveProperty('webSearchCalls');
    // Тариф: вызов веб-поиска прибавляется к токенам ($0.01 по умолчанию, переопределяется в тарифе модели).
    const base = costOfUsage({ provider: 'openai', model: 'gpt-5' }, { inputTokens: 1000, outputTokens: 0 }).usd;
    expect(costOfUsage({ provider: 'openai', model: 'gpt-5' }, { inputTokens: 1000, outputTokens: 0, webSearchCalls: 2 }).usd).toBeCloseTo(base + 0.02, 6);
    expect(costOfUsage({ provider: 'openai', model: 'gpt-5' }, { inputTokens: 0, outputTokens: 0, webSearchCalls: 1 }, { 'openai:gpt-5': { input: 1, output: 1, webSearchPerCall: 0.03 } }).usd).toBeCloseTo(0.03, 6);
  });

  it('модель не вызвала поиск ни разу или провайдер отверг web_search → WebSearchUnavailableError с текстом провайдера', async () => {
    const silent = mk(() => json(200, openaiOk));
    await expect(silent.chat({ ...req, model: 'gpt-5', webSearch: {}, toolChoice: 'required' })).rejects.toBeInstanceOf(WebSearchUnavailableError);
    await expect(silent.chat({ ...req, model: 'gpt-5', webSearch: {}, toolChoice: 'required' })).rejects.toThrow(/ни разу не вызвала веб-поиск/);
    const rejected = mk(() => json(400, { error: { message: 'Hosted tool web_search is not supported with this model', type: 'invalid_request_error', code: null } }));
    await expect(rejected.chat({ ...req, model: 'gpt-5', webSearch: {} })).rejects.toThrow(/OpenAI отверг запрос с веб-поиском: .*web_search is not supported/);
    // Успешный поиск проходит насквозь.
    const ok = mk(() => json(200, withSearch));
    const r = await ok.chat({ ...req, model: 'gpt-5', webSearch: {}, toolChoice: 'required' });
    expect(r.sources?.length).toBe(3);
    // Без webSearch тот же ответ без поиска — не ошибка.
    await expect(silent.chat({ ...req, model: 'gpt-5' })).resolves.toMatchObject({ text: 'Добрый день!' });
  });

  it('Anthropic с webSearch → WebSearchUnavailableError без обращения к API', async () => {
    let called = false;
    const p = createProvider('anthropic', 'sk-ant', { fetch: fetchWith(() => ((called = true), json(200, anthropicOk))), maxRetries: 0 });
    await expect(p.chat({ ...req, model: 'claude-opus-5', webSearch: {} })).rejects.toThrow(/только у OpenAI/);
    expect(called).toBe(false);
  });

  it('резервная модель при WebSearchUnavailableError: только если она тоже OpenAI', async () => {
    const calls: string[] = [];
    const openai: LLMProvider = {
      id: 'openai',
      chat: async (r) => {
        calls.push(r.model);
        if (r.model === 'gpt-5.5') throw new WebSearchUnavailableError('openai', 'web_search недоступен для gpt-5.5');
        return fromOpenAiResponse(withSearch);
      },
      listModels: async () => [],
      validateKey: async () => ({ ok: true, models: [] }),
    };
    const anthropic: LLMProvider = { id: 'anthropic', chat: async () => { throw new Error('не должен вызываться'); }, listModels: async () => [], validateKey: async () => ({ ok: true, models: [] }) };
    const resolve = (id: 'openai' | 'anthropic') => (id === 'openai' ? openai : anthropic);
    const r = await chatWithFallback(resolve, { ...req, webSearch: {}, toolChoice: 'required' }, { primary: { provider: 'openai', model: 'gpt-5.5' }, fallback: { provider: 'openai', model: 'gpt-5.1' } });
    expect(r.fallbackUsed).toBe(true);
    expect(calls).toEqual(['gpt-5.5', 'gpt-5.1']);
    await expect(chatWithFallback(resolve, { ...req, webSearch: {} }, { primary: { provider: 'openai', model: 'gpt-5.5' }, fallback: { provider: 'anthropic', model: 'claude-opus-5' } })).rejects.toBeInstanceOf(WebSearchUnavailableError);
  });
});
