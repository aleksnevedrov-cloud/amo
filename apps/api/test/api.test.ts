import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createState } from '../src/oauth-state.ts';
import { CLIENT_ID, CLIENT_SECRET, setup, widgetToken } from './helpers.ts';

let ctx: Awaited<ReturnType<typeof setup>>;

beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx.close());
beforeEach(() => {
  ctx.amo.calls.length = 0;
  ctx.amo.tokenStatus = 200;
});

const install = () =>
  ctx.app.inject({ url: '/oauth/amo/callback', query: { code: 'CODE', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });

describe('health', () => {
  it('отвечает ok при живых БД и Redis', async () => {
    const res = await ctx.app.inject({ url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', checks: { db: 'ok', redis: 'ok' } });
  });
});

describe('OAuth callback', () => {
  it('обменивает код, сохраняет аккаунт и зашифрованные токены', async () => {
    const res = await install();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Интеграция подключена');

    const tokenCall = ctx.amo.calls[0];
    expect(tokenCall?.url).toBe('https://aleksnevedrov.amocrm.ru/oauth2/access_token');
    expect(tokenCall?.body).toMatchObject({
      client_id: CLIENT_ID,
      grant_type: 'authorization_code',
      code: 'CODE',
      redirect_uri: 'https://ai.example.ru/oauth/amo/callback',
    });
    expect(ctx.amo.calls[1]?.auth).toBe('Bearer ACCESS');

    expect(await ctx.deps.accounts.get(31337)).toMatchObject({ subdomain: 'aleksnevedrov', name: 'РФ-Двери' });
    const { rows } = await ctx.deps.db.query('SELECT access_token_enc FROM amo_tokens WHERE account_id = 31337');
    expect(rows[0].access_token_enc).not.toContain('ACCESS');
    expect(await ctx.deps.tokenService.getAccessToken(31337)).toBe('ACCESS');
  });

  it('не отправляет client_secret на чужой домен', async () => {
    const res = await ctx.app.inject({
      url: '/oauth/amo/callback',
      query: { code: 'C', referer: 'evil.example.com', from_widget: '1' },
    });
    expect(res.statusCode).toBe(400);
    expect(ctx.amo.calls).toHaveLength(0);
  });

  it('требует валидный state вне виджета', async () => {
    const bad = await ctx.app.inject({ url: '/oauth/amo/callback', query: { code: 'C', referer: 'aleksnevedrov.amocrm.ru', state: 'x.1.y' } });
    expect(bad.statusCode).toBe(400);
    const good = await ctx.app.inject({
      url: '/oauth/amo/callback',
      query: { code: 'C', referer: 'aleksnevedrov.amocrm.ru', state: createState(CLIENT_SECRET) },
    });
    expect(good.statusCode).toBe(200);
  });

  it('отклоняет код другой интеграции', async () => {
    const res = await ctx.app.inject({
      url: '/oauth/amo/callback',
      query: { code: 'C', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1', client_id: 'other' },
    });
    expect(res.statusCode).toBe(400);
    expect(ctx.amo.calls).toHaveLength(0);
  });

  it('сообщает об отказе amo и шлёт алерт', async () => {
    ctx.amo.tokenStatus = 400;
    const res = await install();
    expect(res.statusCode).toBe(502);
    expect(ctx.alerts.at(-1)).toContain('не удалось подключить');
  });

  it('/oauth/amo/start перенаправляет в amo с подписанным state', async () => {
    const res = await ctx.app.inject({ url: '/oauth/amo/start' });
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location as string);
    expect(loc.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(loc.searchParams.get('state')).toMatch(/^[\w-]+\.\d+\.[\w-]+$/);
  });
});

describe('API виджета', () => {
  beforeAll(async () => {
    await install();
  });

  it('без токена — 401', async () => {
    expect((await ctx.app.inject({ url: '/widget/v1/status' })).statusCode).toBe(401);
  });

  it('с поддельным токеном — 401', async () => {
    const res = await ctx.app.inject({
      url: '/widget/v1/status',
      headers: { 'x-auth-token': await widgetToken({}, 'wrong-secret-wrong-secret') },
    });
    expect(res.statusCode).toBe(401);
  });

  it('возвращает статус подключения', async () => {
    const res = await ctx.app.inject({ url: '/widget/v1/status', headers: { 'x-auth-token': await widgetToken() } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accountId: 31337, connected: true, enabled: false, mode: 'off' });
  });

  it('сохраняет настройки (только админ) с аудитом', async () => {
    const user = await widgetToken({ is_admin: false });
    const denied = await ctx.app.inject({
      method: 'PUT',
      url: '/widget/v1/settings',
      headers: { 'x-auth-token': user },
      payload: { enabled: true, mode: 'auto' },
    });
    expect(denied.statusCode).toBe(403);

    const admin = await widgetToken();
    const invalid = await ctx.app.inject({
      method: 'PUT',
      url: '/widget/v1/settings',
      headers: { 'x-auth-token': admin },
      payload: { enabled: true, mode: 'turbo' },
    });
    expect(invalid.statusCode).toBe(400);

    const ok = await ctx.app.inject({
      method: 'PUT',
      url: '/widget/v1/settings',
      headers: { 'x-auth-token': admin },
      payload: { enabled: true, mode: 'auto' },
    });
    expect(ok.statusCode).toBe(200);
    const got = await ctx.app.inject({ url: '/widget/v1/settings', headers: { 'x-auth-token': user } });
    expect(got.json().settings).toMatchObject({ enabled: true, mode: 'auto', model: { model: 'claude-opus-5' } });
    const { rows } = await ctx.deps.db.query('SELECT count(*)::int AS n FROM settings_audit WHERE account_id = 31337');
    expect(rows[0].n).toBe(1);
  });

  it('данные одного аккаунта не видны другому', async () => {
    const res = await ctx.app.inject({
      url: '/widget/v1/status',
      headers: { 'x-auth-token': await widgetToken({ account_id: 999 }) },
    });
    expect(res.json()).toMatchObject({ accountId: 999, connected: false, mode: 'off' });
  });

  it('отдаёт заглушку панели сделки', async () => {
    const res = await ctx.app.inject({ url: '/widget/v1/leads/555/panel', headers: { 'x-auth-token': await widgetToken() } });
    expect(res.json()).toMatchObject({ leadId: 555, hints: [], products: [] });
  });

  it('CORS разрешает только домены amo', async () => {
    const ok = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/widget/v1/status',
      headers: { origin: 'https://aleksnevedrov.amocrm.ru', 'access-control-request-method': 'GET' },
    });
    expect(ok.headers['access-control-allow-origin']).toBe('https://aleksnevedrov.amocrm.ru');
    const evil = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/widget/v1/status',
      headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'GET' },
    });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('хук отключения', () => {
  const sign = (uuid: string, id: number) => createHmac('sha256', CLIENT_SECRET).update(`${uuid}|${id}`).digest('hex');

  it('отклоняет неверную подпись', async () => {
    const res = await ctx.app.inject({
      url: '/oauth/amo/disconnect',
      query: { account_id: '31337', client_uuid: CLIENT_ID, signature: 'f'.repeat(64) },
    });
    expect(res.statusCode).toBe(401);
  });

  it('помечает аккаунт отключённым и удаляет токены', async () => {
    await install();
    const res = await ctx.app.inject({
      url: '/oauth/amo/disconnect',
      query: { account_id: '31337', client_uuid: CLIENT_ID, signature: sign(CLIENT_ID, 31337) },
    });
    expect(res.statusCode).toBe(200);
    expect((await ctx.deps.accounts.get(31337))?.uninstalledAt).toBeInstanceOf(Date);
    expect(await ctx.deps.tokens.status(31337)).toBeNull();
  });
});
