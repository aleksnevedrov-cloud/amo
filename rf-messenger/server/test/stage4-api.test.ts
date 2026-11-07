import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.ts';
import { avitoWebhookUrl } from '../src/connectors/host.ts';
import { collectProblems } from '../src/alerts.ts';
import { ACCOUNT, CLIENT_ID, CLIENT_SECRET, event, setupBridge, TEST_REDIS_URL } from './helpers.ts';

let redis: Redis;
beforeAll(() => {
  redis = new Redis(TEST_REDIS_URL);
});
afterAll(async () => {
  await redis.quit();
});

let t: Awaited<ReturnType<typeof setupBridge>>;
beforeEach(async () => {
  t = await setupBridge();
});
afterEach(async () => {
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

/** Заглушки MAX, VK и Авито для проверки ключей при подключении. */
const extFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const u = new URL(String(input));
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  if (u.hostname === 'platform-api.max.ru') return new Headers(init?.headers).get('authorization') === 'good-max-token-0123456789' ? json({ user_id: 11, name: 'Bot', username: 'rfd_max_bot' }) : json({ code: 'verify.token' }, 401);
  if (u.hostname === 'api.vk.com') return String(init?.body).includes('access_token=good-vk-token-0123456789') ? json({ response: { groups: [{ id: 123, name: 'РФ-Двери' }] } }) : json({ error: { error_code: 5, error_msg: 'User authorization failed' } });
  if (u.hostname === 'api.avito.ru') {
    if (u.pathname === '/token') return String(init?.body).includes('client_secret=good-avito-secret') ? json({ access_token: 'tok', expires_in: 3600 }) : json({ error: 'invalid_client' }, 400);
    return json({ id: 777, name: 'РФ-Двери на Авито' });
  }
  return json({}, 404);
}) as typeof fetch;

describe('этап 4: подключение MAX, VK, Авито из виджета', () => {
  it('ключи проверяются у сервиса, шифруются и не возвращаются; неверные — 422 с понятным текстом', async () => {
    const hooks: { channelId: number; body: unknown }[] = [];
    const app = await buildApp({ env: t.env, store: t.store, files: t.files, bridge: t.bridge, amojo: t.amojo, box: t.box, redis, fetch: extFetch, webhooks: { add: async (channelId, body) => void hooks.push({ channelId, body }) } });
    const h = { 'x-auth-token': await token(), 'content-type': 'application/json' };
    const post = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/widget/v1/channels', headers: h, payload });

    const max = await post({ kind: 'max', token: 'good-max-token-0123456789' });
    expect(max.statusCode).toBe(201);
    expect(max.json()).toMatchObject({ title: '@rfd_max_bot', status: 'starting' });
    expect(max.body).not.toContain('good-max-token');
    expect((await post({ kind: 'max', token: 'bad-max-token-0123456789x' })).json()).toEqual({ error: 'MAX не принял токен бота' });

    const vk = await post({ kind: 'vk', token: 'good-vk-token-0123456789', groupId: '123' });
    expect(vk.statusCode).toBe(201);
    expect(vk.json().title).toBe('РФ-Двери');
    expect((await post({ kind: 'vk', token: 'bad-vk-token-01234567890', groupId: 123 })).json().error).toBe('VK не принял ключ доступа сообщества');
    expect((await post({ kind: 'vk', token: 'good-vk-token-0123456789', groupId: 'abc' })).statusCode).toBe(400);

    const avito = await post({ kind: 'avito', clientId: 'cid-1', clientSecret: 'good-avito-secret', userId: 777 });
    expect(avito.statusCode).toBe(201);
    expect(avito.json().title).toBe('РФ-Двери на Авито');
    expect((await post({ kind: 'avito', clientId: 'cid-1', clientSecret: 'bad-avito-secret-xx', userId: 777 })).json().error).toBe('Авито не принял client_id и client_secret');
    expect((await post({ kind: 'avito', clientId: 'cid-1', clientSecret: 'good-avito-secret', userId: 1 })).json().error).toContain('другому профилю');

    const rows = await t.db.query("SELECT kind, credentials FROM channels WHERE kind IN ('max','vk','avito') ORDER BY id");
    expect(rows.rows).toHaveLength(3);
    for (const r of rows.rows) {
      expect(r.credentials).not.toMatch(/good-|cid-1/);
      expect(JSON.parse(t.box.decrypt(r.credentials))).toBeTruthy();
    }
    const st = await app.inject({ method: 'GET', url: '/widget/v1/status', headers: h });
    expect(st.body).not.toMatch(/good-|cid-1/);
    expect(st.json().channels.map((c: { kindText: string }) => c.kindText)).toEqual(['Telegram-бот', 'MAX', 'VK', 'Авито']);

    // Вебхук Авито: секрет из ключей канала, тело — в очередь; чужой секрет и чужой канал отклоняются.
    const avitoId = avito.json().id as number;
    const secret = (JSON.parse(t.box.decrypt(rows.rows[2].credentials)) as { webhookSecret: string }).webhookSecret;
    const url = new URL(avitoWebhookUrl('https://chat.example.ru', avitoId, secret));
    const body = { payload: { type: 'message', value: { id: 'm1', chat_id: 'c', author_id: 42, created: 1, type: 'text', content: { text: 'hi' } } } };
    expect((await app.inject({ method: 'POST', url: url.pathname, headers: { 'content-type': 'application/json' }, payload: body })).json()).toEqual({ ok: true });
    expect(hooks).toEqual([{ channelId: avitoId, body }]);
    expect((await app.inject({ method: 'POST', url: `/hooks/avito/${avitoId}/${'f'.repeat(48)}`, payload: body })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/hooks/avito/${max.json().id}/${secret}`, payload: body })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/hooks/avito/${avitoId}/bad`, payload: body })).statusCode).toBe(404);
    expect(hooks).toHaveLength(1);
    await app.close();
  });

  it('«Написать»: VK и MAX — только в существующие чаты, Авито — нет; ответ без ключей', async () => {
    const started: unknown[] = [];
    const rest = { connected: async () => true, leadContacts: async () => [{ id: 1, name: 'Иван', phones: [] }], contact: async () => ({ id: 1, name: 'Иван', phones: [] }) } as unknown as import('../src/amo/rest.ts').AmoRest;
    const app = await buildApp({ env: t.env, store: t.store, files: t.files, bridge: t.bridge, amojo: t.amojo, box: t.box, redis, rest, startChat: async (input) => (started.push(input), { chatId: 1, messageId: 2 }) });
    const vk = (await t.store.createChannel({ accountId: ACCOUNT, kind: 'vk', title: 'РФ-Двери', externalId: '123', credentials: t.box.encrypt('{"token":"secret-vk"}') }))!;
    const avito = (await t.store.createChannel({ accountId: ACCOUNT, kind: 'avito', title: 'Авито', externalId: '777', credentials: t.box.encrypt('{}') }))!;
    await t.store.setChannelStatus(vk.id, 'connected');
    await t.store.setChannelStatus(avito.id, 'connected');
    const chat = await t.store.upsertChat(vk, { externalChatId: '42', isGroup: false, title: 'Иван Петров', contact: { link: 'https://vk.com/id42' } });
    await t.store.upsertChat(vk, { externalChatId: '2000000001', isGroup: true, title: 'Беседа', contact: {} });
    // Чат другого аккаунта не должен быть виден.
    const other = (await t.store.createChannel({ accountId: 4242, kind: 'vk', title: 'x', externalId: '9', credentials: t.box.encrypt('{}') }))!;
    await t.store.upsertChat(other, { externalChatId: '1', isGroup: false, title: 'Чужой', contact: {} });

    const h = { 'x-auth-token': await token({ is_admin: false, user_id: 7 }), 'content-type': 'application/json' };
    const c = await app.inject({ method: 'GET', url: '/widget/v1/compose?leadId=100', headers: h });
    expect(c.json().channels).toEqual([{ id: vk.id, kind: 'vk', kindText: 'VK', title: 'РФ-Двери', connected: true, byChat: true, chats: [{ id: chat.id, title: 'Иван Петров' }] }]);
    expect(c.body).not.toContain('secret-vk');

    const s = await app.inject({ method: 'POST', url: '/widget/v1/chats/start', headers: h, payload: { channelId: vk.id, contactId: 1, chatId: chat.id, text: 'Добрый день' } });
    expect(s.statusCode).toBe(200);
    expect(started).toEqual([{ accountId: ACCOUNT, userId: 7, channelId: vk.id, contactId: 1, chatId: chat.id, text: 'Добрый день' }]);
    expect((await app.inject({ method: 'POST', url: '/widget/v1/chats/start', headers: h, payload: { channelId: vk.id, contactId: 1, text: 'x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/widget/v1/chats/start', headers: h, payload: { channelId: vk.id, contactId: 1, chatId: chat.id, phone: '+79990000000', text: 'x' } })).statusCode).toBe(400);
    await app.close();
  });
});

describe('этап 4: мост', () => {
  it('startChat в существующий чат VK: без поиска по номеру, чужой чат отклоняется', async () => {
    const rest = { contact: async () => ({ id: 1, name: 'Иван', phones: [] }), linkChat: async () => undefined, userAmojoId: async () => 'op-1' } as unknown as import('../src/amo/rest.ts').AmoRest;
    const { Bridge } = await import('../src/bridge.ts');
    const bridge = new Bridge({ ...t.bridgeDeps, rest });
    await t.store.setChannelStatus(t.channel.id, 'connected');
    await t.db.query("UPDATE channels SET kind = 'vk' WHERE id = $1", [t.channel.id]);
    // Клиент писал раньше — чат есть.
    await t.bridge.onInbound(t.channel, t.connector, event({ externalChatId: '42', chatTitle: 'Иван Петров' }));
    const chat = (await t.store.recentChats(ACCOUNT, t.channel.id))[0]!;
    const r = await bridge.startChat({ accountId: ACCOUNT, userId: 7, channelId: t.channel.id, contactId: 1, chatId: chat.id, text: 'Добрый день!' });
    expect(r.chatId).toBe(chat.id);
    expect(t.connector.sent).toEqual([{ externalChatId: '42', text: 'Добрый день!', file: null, replyToExternalId: null }]);
    const msg = await t.store.messageById(r.messageId);
    expect(msg).toMatchObject({ source: 'phone', text: 'Добрый день!' });
    await expect(bridge.startChat({ accountId: 4242, userId: 7, channelId: t.channel.id, contactId: 1, chatId: chat.id, text: 'x' })).rejects.toThrow('Канал не найден');
    await expect(bridge.startChat({ accountId: ACCOUNT, userId: 7, channelId: t.channel.id, contactId: 1, chatId: chat.id + 999, text: 'x' })).rejects.toThrow('Чат не найден');
    await t.db.query("UPDATE channels SET kind = 'avito' WHERE id = $1", [t.channel.id]);
    await expect(bridge.startChat({ accountId: ACCOUNT, userId: 7, channelId: t.channel.id, contactId: 1, chatId: chat.id, text: 'x' })).rejects.toThrow('только по номеру');
  });

  it('уведомления о сбоях: каналы MAX, VK и Авито под наблюдением', async () => {
    const vk = (await t.store.createChannel({ accountId: ACCOUNT, kind: 'vk', title: 'РФ-Двери', externalId: '123', credentials: '' }))!;
    await t.store.setChannelStatus(vk.id, 'error', 'VK не принял ключ доступа сообщества');
    const problems = collectProblems(null, await t.store.activeChannels());
    expect(problems.find((p) => p.key === `channel:${vk.id}`)).toMatchObject({ title: `Канал «РФ-Двери» (id ${vk.id}, VK)`, detail: 'Статус: ошибка — VK не принял ключ доступа сообщества' });
  });
});
