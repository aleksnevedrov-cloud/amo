import { randomBytes } from 'node:crypto';
import { loadEnv } from '@ai-door/shared';
import { SignJWT } from 'jose';
import { freshDb } from '../../../packages/db/test/setup.ts';
import { buildApp } from '../src/app.ts';
import type { LlmClient } from '@ai-door/agent';
import type { IncomingJob } from '@ai-door/agent';
import { createDeps, type Deps } from '../src/deps.ts';

export const CLIENT_ID = '8b4f5e3a-2c1d-4e5f-9a8b-7c6d5e4f3a2b';
export const CLIENT_SECRET = 'test-client-secret-0123456789abcdef';
export const PUBLIC_URL = 'https://ai.example.ru';

export interface AmoMock {
  calls: { url: string; body: unknown; auth: string | null }[];
  tokenStatus: number;
}

export function amoFetch(mock: AmoMock): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    mock.calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null, auth: headers.get('authorization') });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.startsWith('https://api.anthropic.com/v1/models')) {
      const key = headers.get('x-api-key') ?? '';
      return key.startsWith('sk-ant-good') ? json(200, { data: [{ id: 'claude-opus-5' }, { id: 'claude-sonnet-5' }], has_more: false }) : json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    }
    // OpenAI (1.1.0): список моделей по ключу sk-good…, ответ Responses API — вызов каталога, затем текст с ценой из результата.
    if (url.startsWith('https://api.openai.com/v1/models')) {
      const key = headers.get('authorization') ?? '';
      return key.startsWith('Bearer sk-good')
        ? json(200, { object: 'list', data: [{ id: 'gpt-5', object: 'model', created: 1, owned_by: 'openai' }, { id: 'gpt-5-mini', object: 'model', created: 1, owned_by: 'openai' }, { id: 'text-embedding-3-small', object: 'model', created: 1, owned_by: 'openai' }] })
        : json(401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } });
    }
    if (url.startsWith('https://api.openai.com/v1/responses')) {
      const body = JSON.parse(String(init?.body)) as { model: string; input: { type?: string; role?: string; content?: unknown }[] };
      const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 110 };
      const base = { id: 'resp_1', object: 'response', created_at: 1, status: 'completed', model: body.model, error: null, incomplete_details: null, usage };
      const afterTool = body.input.some((i) => i.type === 'function_call_output');
      // Разбор документа (ответ по JSON Schema) — минимальный валидный документ.
      const schema = (body as { text?: { format?: { type?: string } } }).text?.format?.type === 'json_schema';
      const doc = { kind: 'measurement', title: 'Замерный лист', summary: 'Один проём 900×2100.', customer_type: 'b2c', openings: [{ room: null, label: '1', width_mm: 900, height_mm: 2100, wall_mm: 100, leaf_width_mm: null, qty: 1, double: null, side: null, note: null }], positions: [], requirements: [], questions: [], photo: null };
      return json(200, {
        ...base,
        output: schema
          ? [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(doc), annotations: [] }] }]
          : afterTool
          ? [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Рекомендую Турин 1 эмаль белая — 14 900 ₽, в наличии: https://rf-dveri.ru/catalog/test-1001/', annotations: [] }] }]
          : [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'catalog_search', arguments: JSON.stringify({ query: 'белая эмаль' }), status: 'completed' }],
      });
    }
    if (url.endsWith('/oauth2/access_token')) {
      if (mock.tokenStatus !== 200) return json(mock.tokenStatus, { hint: 'invalid code' });
      return json(200, { token_type: 'Bearer', expires_in: 86400, access_token: 'ACCESS', refresh_token: 'REFRESH' });
    }
    if (url.endsWith('/api/v4/account')) return json(200, { id: 31337, name: 'РФ-Двери', subdomain: 'aleksnevedrov' });
    if (url.endsWith('/api/v4/account?with=task_types')) return json(200, { _embedded: { task_types: [{ id: 1, name: 'Связаться' }] } });
    if (url.endsWith('/api/v4/leads/pipelines')) {
      return json(200, { _embedded: { pipelines: [{ id: 1, name: 'Продажи', _embedded: { statuses: [{ id: 10, name: 'Новая' }] } }] } });
    }
    if (url.endsWith('/api/v2/salesbot/run')) return json(200, {});
    if (url.includes('/salesbot/') && url.includes('/continue/')) return json(200, {});
    if (/\/api\/v4\/leads\/\d+\/notes$/.test(url)) return json(200, { _embedded: { notes: [{ id: 1 }] } });
    if (/\/api\/v4\/leads\/\d+/.test(url)) return json(200, { id: 1, name: 'x', price: 0, status_id: 10, pipeline_id: 1, responsible_user_id: 3, created_at: 0, custom_fields_values: null, _embedded: { contacts: [{ id: 77, is_main: true }] } });
    return json(404, {});
  }) as typeof fetch;
}

export async function setup(opts: { llm?: LlmClient | null; mailConnect?: Deps['mailConnect']; mailSender?: Deps['mailSender']; evalFixtures?: Deps['evalFixtures']; download?: Deps['download'] } = {}) {
  const { db, drop } = await freshDb();
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    PUBLIC_URL,
    DATABASE_URL: 'postgres://unused:unused@localhost/unused',
    REDIS_URL: 'redis://localhost:6379',
    AMO_CLIENT_ID: CLIENT_ID,
    AMO_CLIENT_SECRET: CLIENT_SECRET,
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  });
  const amo: AmoMock = { calls: [], tokenStatus: 200 };
  const alerts: string[] = [];
  const scheduled: { job: IncomingJob; windowMs: number }[] = [];
  const deps: Deps = {
    ...createDeps(env, {
      db,
      llm: opts.llm ?? null,
      ...(opts.mailConnect ? { mailConnect: opts.mailConnect } : {}),
      ...(opts.mailSender ? { mailSender: opts.mailSender } : {}),
      ...(opts.evalFixtures ? { evalFixtures: opts.evalFixtures } : {}),
      ...(opts.download ? { download: opts.download } : {}),
      schedule: async (job, windowMs) => void scheduled.push({ job, windowMs }),
      fetch: amoFetch(amo),
      redis: { ping: async () => 'PONG' },
      alerter: { alert: async (m) => void alerts.push(m) },
    }),
    close: async () => undefined,
  };
  const app = await buildApp(deps);
  return { app, deps, amo, alerts, scheduled, close: async () => (await app.close(), await drop()) };
}

export function widgetToken(claims: Record<string, unknown> = {}, key = CLIENT_SECRET) {
  return new SignJWT({
    subdomain: 'aleksnevedrov',
    account_id: 31337,
    user_id: 7,
    client_uuid: CLIENT_ID,
    is_admin: true,
    ...claims,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(randomBytes(8).toString('hex'))
    .setIssuer('https://aleksnevedrov.amocrm.ru')
    .setAudience(PUBLIC_URL)
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(new TextEncoder().encode(key));
}

export function botToken(claims: Record<string, unknown> = { account_id: 31337, subdomain: 'aleksnevedrov' }, key = CLIENT_SECRET) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS512' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(key));
}
