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

export async function setup(opts: { llm?: LlmClient | null } = {}) {
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
