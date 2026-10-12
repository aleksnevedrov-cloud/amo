import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../src/anthropic.ts';
import { chatWithFallback, gatewayFromResolver, LlmUnavailableError, singleProviderGateway } from '../src/fallback.ts';
import { OpenAIProvider } from '../src/openai.ts';
import { createProvider, verifyKey } from '../src/providers/index.ts';
import { LlmError, type ChatRequest, type LLMProvider } from '../src/types.ts';

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
