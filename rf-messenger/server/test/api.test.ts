import { createHmac, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.ts';
import { ACCOUNT, CHANNEL_SECRET, CLIENT_ID, CLIENT_SECRET, event, PUBLIC_URL, setupBridge, TEST_REDIS_URL, testEnv } from './helpers.ts';

let redis: Redis;
beforeAll(() => {
  redis = new Redis(TEST_REDIS_URL);
});
afterAll(async () => {
  await redis.quit();
});

let t: Awaited<ReturnType<typeof setupBridge>>;
let app: Awaited<ReturnType<typeof buildApp>>;
let tgCalls: string[];

beforeEach(async () => {
  t = await setupBridge();
  tgCalls = [];
  const tgFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    tgCalls.push(url);
    const ok = url.includes('/bot123456789:') && url.endsWith('/getMe');
    return new Response(JSON.stringify(ok ? { ok: true, result: { id: 777, username: 'rfdoor_test_bot', first_name: 'Test' } } : { ok: false, error_code: 401, description: 'Unauthorized' }));
  }) as typeof fetch;
  app = await buildApp({ env: t.env, store: t.store, files: t.files, bridge: t.bridge, amojo: t.amojo, box: t.box, redis, fetch: tgFetch });
});
afterEach(async () => {
  await app.close();
  await t.drop();
});

async function token(over: Record<string, unknown> = {}) {
  return new SignJWT({ account_id: ACCOUNT, user_id: 5, subdomain: 'aleksnevedrov', client_uuid: CLIENT_ID, is_admin: true, ...over })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(randomUUID())
    .setIssuer('https://aleksnevedrov.amocrm.ru')
    .setAudience('https://chat.example.ru')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(CLIENT_SECRET));
}

const BOT_TOKEN = `123456789:${'A'.repeat(35)}`;

describe('API виджета', () => {
  it('401 без токена, с чужой подписью и при повторе токена', async () => {
    expect((await app.inject({ method: 'GET', url: '/widget/v1/status' })).statusCode).toBe(401);
    const bad = await new SignJWT({ account_id: ACCOUNT, user_id: 5, client_uuid: CLIENT_ID, is_admin: true })
      .setProtectedHeader({ alg: 'HS256' })
      .setJti('x')
      .setIssuer('https://a.amocrm.ru')
      .setAudience('https://chat.example.ru')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('wrong-secret-0123456789abcdef'));
    expect((await app.inject({ method: 'GET', url: '/widget/v1/status', headers: { 'x-auth-token': bad } })).statusCode).toBe(401);
    const tk = await token();
    expect((await app.inject({ method: 'GET', url: '/widget/v1/status', headers: { 'x-auth-token': tk } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/widget/v1/status', headers: { 'x-auth-token': tk } })).statusCode).toBe(401);
  });

  it('403 не администратору', async () => {
    const r = await app.inject({ method: 'GET', url: '/widget/v1/status', headers: { 'x-auth-token': await token({ is_admin: false }) } });
    expect(r.statusCode).toBe(403);
  });

  it('подключение Telegram-бота: токен проверяется у Telegram, шифруется и не возвращается', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/widget/v1/channels',
      headers: { 'x-auth-token': await token() },
      payload: { kind: 'telegram_bot', token: BOT_TOKEN },
    });
    expect(r.statusCode).toBe(201);
    expect(r.body).not.toContain(BOT_TOKEN);
    expect(r.json()).toMatchObject({ title: '@rfdoor_test_bot', status: 'starting' });
    const row = await t.db.query('SELECT credentials FROM channels WHERE id = $1', [r.json().id]);
    expect(row.rows[0].credentials).not.toContain(BOT_TOKEN);
    expect(JSON.parse(t.box.decrypt(row.rows[0].credentials))).toEqual({ token: BOT_TOKEN });

    const again = await app.inject({ method: 'POST', url: '/widget/v1/channels', headers: { 'x-auth-token': await token() }, payload: { kind: 'telegram_bot', token: BOT_TOKEN } });
    expect(again.statusCode).toBe(409);

    const st = await app.inject({ method: 'GET', url: '/widget/v1/status', headers: { 'x-auth-token': await token() } });
    expect(st.body).not.toContain(BOT_TOKEN);
    expect(st.json().channels.map((c: { title: string; statusText: string }) => [c.title, c.statusText])).toEqual([
      ['@door_bot', 'Подключается…'],
      ['@rfdoor_test_bot', 'Подключается…'],
    ]);
  });

  it('неверный токен бота — 400/422', async () => {
    const bad = await app.inject({ method: 'POST', url: '/widget/v1/channels', headers: { 'x-auth-token': await token() }, payload: { kind: 'telegram_bot', token: 'nope' } });
    expect(bad.statusCode).toBe(400);
    const rejected = await app.inject({
      method: 'POST',
      url: '/widget/v1/channels',
      headers: { 'x-auth-token': await token() },
      payload: { kind: 'telegram_bot', token: `987654321:${'B'.repeat(35)}` },
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error).toBe('Telegram не принял токен бота');
  });

  it('другой аккаунт не видит и не удаляет чужие каналы', async () => {
    const other = await token({ account_id: 4242 });
    const st = await app.inject({ method: 'GET', url: '/widget/v1/status', headers: { 'x-auth-token': other } });
    expect(st.json().channels).toEqual([]);
    const del = await app.inject({ method: 'DELETE', url: `/widget/v1/channels/${t.channel.id}`, headers: { 'x-auth-token': await token({ account_id: 4242 }) } });
    expect(del.statusCode).toBe(404);
    const mine = await app.inject({ method: 'DELETE', url: `/widget/v1/channels/${t.channel.id}`, headers: { 'x-auth-token': await token() } });
    expect(mine.statusCode).toBe(200);
  });

  it('аккаунт вне AMO_ACCOUNT_IDS — 403', async () => {
    await app.close();
    const env = { ...t.env, AMO_ACCOUNT_IDS: [1] };
    app = await buildApp({ env, store: t.store, files: t.files, bridge: t.bridge, amojo: t.amojo, box: t.box, redis });
    const r = await app.inject({ method: 'GET', url: '/widget/v1/status', headers: { 'x-auth-token': await token() } });
    expect(r.statusCode).toBe(403);
  });

  it('подключение канала чатов к аккаунту сохраняет scope_id', async () => {
    const u = await setupBridge({ connected: false });
    try {
      const a = await buildApp({ env: u.env, store: u.store, files: u.files, bridge: u.bridge, amojo: u.amojo, box: u.box, redis });
      const r = await a.inject({
        method: 'POST',
        url: '/widget/v1/amojo/connect',
        headers: { 'x-auth-token': await token() },
        payload: { amojoAccountId: '6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b' },
      });
      expect(r.statusCode).toBe(200);
      expect(await u.store.getConnection(ACCOUNT)).toEqual({ amojoAccountId: '6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b', scopeId: 'scope-xyz' });
      await a.close();
    } finally {
      await u.drop();
    }
  });
});

describe('вебхук amo', () => {
  const sign = (raw: string) => createHmac('sha1', CHANNEL_SECRET).update(raw).digest('hex');

  it('401 без подписи и с неверной, 404 на чужой scope, 200 и постановка в очередь на верной', async () => {
    await t.bridge.onInbound(t.channel, t.connector, event());
    await t.bridge.deliverToAmo(t.queue.jobs[0]!.data.messageId);
    const conv = (t.calls.at(-1)!.body.payload as { conversation_id: string }).conversation_id;
    const raw = JSON.stringify({ message: { conversation: { client_id: conv }, message: { id: 'amo-1', type: 'text', text: 'Здравствуйте' } } });
    const post = (url: string, sig?: string) =>
      app.inject({ method: 'POST', url, payload: raw, headers: { 'content-type': 'application/json', ...(sig ? { 'x-signature': sig } : {}) } });

    expect((await post('/amojo/v1/hook/scope-xyz')).statusCode).toBe(401);
    expect((await post('/amojo/v1/hook/scope-xyz', sign(raw + ' '))).statusCode).toBe(401);
    expect((await post('/amojo/v1/hook/other-scope', sign(raw))).statusCode).toBe(404);
    const ok = await post('/amojo/v1/hook/scope-xyz', sign(raw));
    expect(ok.statusCode).toBe(200);
    expect(t.queue.jobs.filter((j) => j.name === 'to-channel')).toHaveLength(1);
  });
});

describe('файлы по ссылке', () => {
  it('отдаёт по подписи, 403 на подделку, 410 после срока', async () => {
    const f = await t.files.save({ accountId: ACCOUNT, channelId: t.channel.id, data: Buffer.from('hello'), name: 'чертёж.pdf', mime: 'application/pdf' });
    const url = new URL(t.files.signedUrl(f));
    expect(url.origin).toBe(PUBLIC_URL);
    const ok = await app.inject({ method: 'GET', url: url.pathname + url.search });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('hello');
    expect(ok.headers['content-type']).toBe('application/pdf');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.headers['content-disposition']).toMatch(/^inline;/);

    const html = await t.files.save({ accountId: ACCOUNT, channelId: t.channel.id, data: Buffer.from('<script>1</script>'), name: 'x.html', mime: 'text/html' });
    const hu = new URL(t.files.signedUrl(html));
    const hr = await app.inject({ method: 'GET', url: hu.pathname + hu.search });
    expect(hr.headers['content-disposition']).toMatch(/^attachment;/);

    const forged = new URL(url);
    forged.searchParams.set('e', String(Number(url.searchParams.get('e')) + 1));
    expect((await app.inject({ method: 'GET', url: forged.pathname + forged.search })).statusCode).toBe(403);

    const old = new URL(t.files.signedUrl(f, new Date(Date.now() - 31 * 86400_000)));
    expect((await app.inject({ method: 'GET', url: old.pathname + old.search })).statusCode).toBe(410);
  });
});

describe('прокси и окружение', () => {
  it('rate limit считает адрес от nginx, а не подставленный клиентом X-Forwarded-For', async () => {
    let seen = '';
    const probe = await buildApp({ env: t.env, store: t.store, files: t.files, bridge: t.bridge, amojo: t.amojo, box: t.box, redis });
    probe.get('/ip-probe', async (req) => { seen = req.ip; return {}; });
    await probe.inject({ method: 'GET', url: '/ip-probe', remoteAddress: '172.18.0.1', headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } });
    expect(seen).toBe('5.6.7.8');
    await probe.close();
  });

  it('production без AMO_ACCOUNT_IDS не стартует', () => {
    expect(() => testEnv({ NODE_ENV: 'production' })).toThrow(/AMO_ACCOUNT_IDS/);
    expect(testEnv({ NODE_ENV: 'production', AMO_ACCOUNT_IDS: '123' }).AMO_ACCOUNT_IDS).toEqual([123]);
  });
});
