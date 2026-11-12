/* eslint-disable @typescript-eslint/no-explicit-any -- в тестах разбираем произвольный JSON запросов к amo */
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AmoRest } from '../src/amo/rest.ts';
import { buildApp } from '../src/api/app.ts';
import { Bridge, kindOfMime } from '../src/bridge.ts';
import type { HistoryCursor, InboundEvent } from '../src/connectors/types.ts';
import type { ChatEvent } from '../src/events.ts';
import { ACCOUNT, CLIENT_ID, CLIENT_SECRET, event, FakeConnector, setupBridge, TEST_REDIS_URL } from './helpers.ts';

let redis: Redis;
beforeAll(() => {
  redis = new Redis(TEST_REDIS_URL);
});
afterAll(async () => {
  await redis.quit();
});

const ADMIN = 5;
const MANAGER = 7;
const OTHER = 9;

async function token(over: Record<string, unknown> = {}) {
  return new SignJWT({ account_id: ACCOUNT, user_id: ADMIN, subdomain: 'x', client_uuid: CLIENT_ID, is_admin: true, ...over })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(randomUUID())
    .setIssuer('https://x.amocrm.ru')
    .setAudience('https://chat.example.ru')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(CLIENT_SECRET));
}
const admin = async () => ({ 'x-auth-token': await token(), 'content-type': 'application/json' });
const manager = async () => ({ 'x-auth-token': await token({ is_admin: false, user_id: MANAGER }), 'content-type': 'application/json' });
const other = async () => ({ 'x-auth-token': await token({ is_admin: false, user_id: OTHER }), 'content-type': 'application/json' });

/** Коннектор с историей: 2 старых сообщения. */
class HistoryConnector extends FakeConnector {
  historyCalls: { chat: string; limit: number; before: HistoryCursor | null }[] = [];
  async history(chat: string, limit: number, before: HistoryCursor | null): Promise<InboundEvent[]> {
    this.historyCalls.push({ chat, limit, before });
    return [
      event({ externalMessageId: 'h1', text: 'Старое от клиента', timestamp: 1_700_000_000 }),
      event({ externalMessageId: 'h2', text: 'Старый ответ с телефона', timestamp: 1_700_000_100, fromMe: true }),
    ];
  }
}

const LEAD = 30053436;
const CONTACT = 77;

function restStub(over: Partial<Record<keyof AmoRest, unknown>> = {}): AmoRest {
  return {
    connected: async () => true,
    lead: async (_a: number, id: number) => ({ id, name: 'Дверь входная', price: 25000, responsibleUserId: MANAGER, statusId: 1, pipelineId: 1, fields: { 'Дата доставки': '15.11.2026' }, contactIds: [CONTACT] }),
    contact: async (_a: number, id: number) => ({ id, name: 'Иван Петров', phones: ['+7 (936) 147-23-24'], responsibleUserId: MANAGER }),
    contactChats: async () => [{ chatId: 'amo-chat-1', contactId: CONTACT }],
    contactsByPhone: async () => [],
    contactLeads: async () => [{ id: LEAD, name: 'Дверь входная', price: 25000, statusId: 1, pipelineId: 1 }],
    userName: async (_a: number, id: number) => (id === MANAGER ? 'Мария Менеджер' : 'Админ'),
    userAmojoId: async () => 'amojo-user-7',
    leadContacts: async () => [{ id: CONTACT, name: 'Иван Петров', phones: ['+7 (936) 147-23-24'] }],
    linkChat: async () => undefined,
    ...over,
  } as unknown as AmoRest;
}

let t: Awaited<ReturnType<typeof setupBridge>>;
let app: Awaited<ReturnType<typeof buildApp>>;
let bus: Map<number, Set<(ev: ChatEvent) => void>>;
let published: ChatEvent[];
let bridge: Bridge;
let connector: HistoryConnector;

beforeEach(async () => {
  // Схемы БД у тестов свои, а Redis общий: id чатов повторяются, поэтому права и сеансы прошлых тестов стираем.
  const stale = await redis.keys('rfm:chat:*');
  if (stale.length) await redis.del(...stale);
  t = await setupBridge();
  connector = new HistoryConnector();
  bus = new Map();
  published = [];
  const events = {
    publish: async (accountId: number, ev: ChatEvent) => {
      published.push(ev);
      for (const fn of bus.get(accountId) ?? []) fn(ev);
    },
  };
  bridge = new Bridge({ ...t.bridgeDeps, rest: restStub(), events, connector: (id) => (id === t.channel.id ? connector : undefined) });
  await t.store.setChannelStatus(t.channel.id, 'connected');
  app = await buildApp({
    env: t.env,
    store: t.store,
    files: t.files,
    bridge,
    amojo: t.amojo,
    box: t.box,
    redis,
    rest: restStub(),
    queue: t.queue,
    windowSend: (input) => bridge.sendFromWindow(input),
    events: {
      subscribe: (accountId, fn) => {
        const set = bus.get(accountId) ?? new Set();
        set.add(fn);
        bus.set(accountId, set);
        return () => void set.delete(fn);
      },
    },
  });
});
afterEach(async () => {
  await app.close();
  await t.drop();
});

/** Чат клиента: входящее по телефону контакта + привязка к чату amo. */
async function clientChat(n = 1) {
  for (let i = 1; i <= n; i++) await bridge.onInbound(t.channel, connector, event({ externalMessageId: String(i), text: `Сообщение ${i}`, contact: { phone: '+79361472324' } }));
  const chat = (await t.store.recentChats(ACCOUNT, t.channel.id))[0]!;
  await t.store.setAmojoChatId(chat.id, 'amo-chat-1');
  return chat;
}

describe('окно переписки: чаты и права', () => {
  it('администратор и ответственный менеджер видят чаты сделки; другой менеджер — 403; без карточки — 400', async () => {
    const chat = await clientChat(3);
    const a = await app.inject({ method: 'GET', url: `/chat/v1/chats?leadId=${LEAD}`, headers: await admin() });
    expect(a.statusCode).toBe(200);
    expect(a.json().chats).toHaveLength(1);
    expect(a.json().chats[0]).toMatchObject({ id: chat.id, kind: 'telegram_bot', title: 'Иван Петров', unread: 3, last: { text: 'Сообщение 3', direction: 'in' } });
    expect(a.json().lead).toEqual({ id: LEAD, name: 'Дверь входная', price: 25000 });
    expect(a.json().contacts[0].phones).toEqual(['+7 (936) 147-23-24']);

    const m = await app.inject({ method: 'GET', url: `/chat/v1/chats?leadId=${LEAD}`, headers: await manager() });
    expect(m.statusCode).toBe(200);
    expect(m.json().me).toEqual({ userId: MANAGER, isAdmin: false });

    expect((await app.inject({ method: 'GET', url: `/chat/v1/chats?leadId=${LEAD}`, headers: await other() })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/chat/v1/chats', headers: await admin() })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/chat/v1/chats?leadId=${LEAD}` })).statusCode).toBe(401);
  });

  it('сообщения чата: только после открытия карточки (ACL); чужой аккаунт — 404; чат по телефону без привязки в amo тоже находится', async () => {
    const chat = await clientChat(1);
    // Менеджер ещё не открывал карточку — доступа к чату нет.
    expect((await app.inject({ method: 'GET', url: `/chat/v1/chats/${chat.id}/messages`, headers: await manager() })).statusCode).toBe(404);
    await app.inject({ method: 'GET', url: `/chat/v1/chats?leadId=${LEAD}`, headers: await manager() });
    expect((await app.inject({ method: 'GET', url: `/chat/v1/chats/${chat.id}/messages`, headers: await manager() })).statusCode).toBe(200);
    // Другой менеджер открыть карточку не смог — и к чату доступа нет.
    expect((await app.inject({ method: 'GET', url: `/chat/v1/chats/${chat.id}/messages`, headers: await other() })).statusCode).toBe(404);
    // Администратор — без предварительного открытия.
    expect((await app.inject({ method: 'GET', url: `/chat/v1/chats/${chat.id}/messages`, headers: await admin() })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/chat/v1/chats/${chat.id}/messages`, headers: { 'x-auth-token': await token({ account_id: 4242 }) } })).statusCode).toBe(404);

    await t.store.setAmojoChatId(chat.id, 'other-amo-chat');
    const byPhone = await app.inject({ method: 'GET', url: `/chat/v1/chats?contactId=${CONTACT}`, headers: await admin() });
    expect(byPhone.json().chats.map((c: { id: number }) => c.id)).toEqual([chat.id]);
  });

  it('пагинация: порции по 50, старые — по before, hasMore', async () => {
    const chat = await clientChat(120);
    const h = await admin();
    const p1 = await app.inject({ method: 'GET', url: `/chat/v1/chats/${chat.id}/messages`, headers: h });
    expect(p1.json().messages).toHaveLength(50);
    expect(p1.json().hasMore).toBe(true);
    expect(p1.json().messages.at(-1).text).toBe('Сообщение 120');
    expect(p1.json().messages[0].text).toBe('Сообщение 71');
    const p2 = await app.inject({ method: 'GET', url: `/chat/v1/chats/${chat.id}/messages?before=${p1.json().messages[0].id}`, headers: h });
    expect(p2.json().messages.map((m: { text: string }) => m.text)).toEqual(Array.from({ length: 50 }, (_, i) => `Сообщение ${21 + i}`));
    const p3 = await app.inject({ method: 'GET', url: `/chat/v1/chats/${chat.id}/messages?before=${p2.json().messages[0].id}&limit=500`, headers: h });
    expect(p3.json().messages).toHaveLength(20);
    expect(p3.json().hasMore).toBe(false);
  });

  it('поиск по переписке: ILIKE, минимум 2 символа, спецсимволы экранируются', async () => {
    const chat = await clientChat(1);
    await bridge.onInbound(t.channel, connector, event({ externalMessageId: '2', text: 'Замер 100% в четверг' }));
    const h = await admin();
    expect((await app.inject({ method: 'GET', url: `/chat/v1/chats/${chat.id}/search?q=ЗАМЕР`, headers: h })).json().messages).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: `/chat/v1/chats/${chat.id}/search?q=100%25`, headers: h })).json().messages.map((m: { text: string }) => m.text)).toEqual(['Замер 100% в четверг']);
    expect((await app.inject({ method: 'GET', url: `/chat/v1/chats/${chat.id}/search?q=%25`, headers: h })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/chat/v1/chats/${chat.id}/search?q=нет такого`, headers: h })).json().messages).toEqual([]);
  });

  it('сделки контакта для шапки', async () => {
    const r = await app.inject({ method: 'GET', url: `/chat/v1/contacts/${CONTACT}/leads`, headers: await admin() });
    expect(r.json().leads[0]).toMatchObject({ id: LEAD, name: 'Дверь входная' });
  });
});

describe('окно переписки: отправка, прочитанность, статусы', () => {
  it('отправка из окна: клиенту через коннектор, в amo — исходящее от сотрудника, в окне — с именем менеджера', async () => {
    const chat = await clientChat(1);
    await app.inject({ method: 'GET', url: `/chat/v1/chats?leadId=${LEAD}`, headers: await manager() });
    const first = (await t.store.messagesPage(chat.id, null, 10)).messages[0]!;
    const r = await app.inject({ method: 'POST', url: `/chat/v1/chats/${chat.id}/messages`, headers: await manager(), payload: { text: 'Добрый день! Замер в четверг', replyToMessageId: first.id } });
    expect(r.statusCode).toBe(200);
    const m = r.json().messages[0];
    expect(m).toMatchObject({ direction: 'out', source: 'phone', text: 'Добрый день! Замер в четверг', senderName: 'Мария Менеджер', replyTo: { id: first.id, text: 'Сообщение 1' } });
    expect(connector.sent).toEqual([{ externalChatId: '42', text: 'Добрый день! Замер в четверг', file: null, replyToExternalId: '1' }]);
    const amo = t.calls.filter((c) => c.path === '/v2/origin/custom/scope-xyz').at(-1)!.body.payload as Record<string, any>;
    expect(amo.sender).toEqual({ ref_id: 'amojo-user-7' });
    expect(amo.receiver.name).toBe('Иван Петров');
    expect(amo.silent).toBe(true);
    expect(published.filter((e) => e.type === 'message')).toHaveLength(2);
    expect((await app.inject({ method: 'POST', url: `/chat/v1/chats/${chat.id}/messages`, headers: await manager(), payload: { text: '  ' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/chat/v1/chats/${chat.id}/messages`, headers: await other(), payload: { text: 'x' } })).statusCode).toBe(404);
  });

  it('файл: загрузка по сеансу (multipart), отправка по fileId как фото; чужой сеанс — 401', async () => {
    const chat = await clientChat(1);
    const session = (await app.inject({ method: 'POST', url: '/chat/v1/session', headers: await admin() })).json();
    expect(session.token).toMatch(/^[0-9a-f]{48}$/);
    const boundary = 'xBoundary';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="door.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      Buffer.from('JPEGDATA'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await app.inject({ method: 'POST', url: '/chat/v1/files', headers: { 'x-rfm-session': session.token, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toMatchObject({ name: 'door.jpg', mime: 'image/jpeg', size: 8 });
    expect(up.json().url).toContain('https://chat.example.ru/f/');
    expect((await app.inject({ method: 'POST', url: '/chat/v1/files', headers: { 'x-rfm-session': 'f'.repeat(48), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body })).statusCode).toBe(401);

    const r = await app.inject({ method: 'POST', url: `/chat/v1/chats/${chat.id}/messages`, headers: await admin(), payload: { text: 'Вот такая', fileIds: [up.json().id] } });
    expect(r.statusCode).toBe(200);
    expect(r.json().messages[0]).toMatchObject({ kind: 'picture', text: 'Вот такая', file: { name: 'door.jpg', mime: 'image/jpeg' } });
    expect(connector.sent[0]?.file).toMatchObject({ name: 'door.jpg', mime: 'image/jpeg', kind: 'picture' });
    expect(kindOfMime('audio/webm;codecs=opus')).toBe('voice');
    expect(kindOfMime('application/pdf')).toBe('file');
  });

  it('открытый чат помечается прочитанным; статусы доставки из мессенджера доходят до окна и в amo', async () => {
    const chat = await clientChat(2);
    const h = await admin();
    expect((await app.inject({ method: 'GET', url: `/chat/v1/chats?leadId=${LEAD}`, headers: h })).json().chats[0].unread).toBe(2);
    await app.inject({ method: 'POST', url: `/chat/v1/chats/${chat.id}/read`, headers: h });
    expect((await app.inject({ method: 'GET', url: `/chat/v1/chats?leadId=${LEAD}`, headers: h })).json().chats[0].unread).toBe(0);

    // Ответ из amo → отправлен → мессенджер сообщил «прочитано».
    const conv = chat.conversationId;
    await bridge.onAmoHook(ACCOUNT, { message: { conversation: { client_id: conv }, sender: { id: 'amojo-user-7', name: 'Мария' }, message: { id: 'amo-out-1', type: 'text', text: 'Ок' } } });
    const out = t.queue.jobs.find((j) => j.name === 'to-channel')!;
    await bridge.deliverToChannel(out.data.messageId, false);
    await bridge.onDelivery(t.channel, '42', String(1000 + connector.sent.length), 'read');
    const msg = await t.store.messageById(out.data.messageId);
    expect(msg?.status).toBe('read');
    expect(msg?.senderName).toBe('Мария');
    expect(published.some((e) => e.type === 'status' && e.messageId === out.data.messageId && e.status === 'read')).toBe(true);
    expect(t.calls.at(-1)!.body).toMatchObject({ msgid: 'amo-out-1', delivery_status: 2 });
  });

  it('Telegram: «прочитано до id» красит синим все наши сообщения до него, чат находится без access_hash', async () => {
    const chat = await clientChat(1);
    await t.db.query("UPDATE chats SET external_chat_id = 'u:42:987654' WHERE id = $1", [chat.id]);
    const conv = chat.conversationId;
    const ids: number[] = [];
    for (const [i, text] of ['Первое', 'Второе', 'Третье'].entries()) {
      await bridge.onAmoHook(ACCOUNT, { message: { conversation: { client_id: conv }, message: { id: `amo-tg-${i}`, type: 'text', text } } });
      const job = t.queue.jobs.filter((j) => j.name === 'to-channel').at(-1)!;
      await bridge.deliverToChannel(job.data.messageId, false);
      ids.push(job.data.messageId);
    }
    const ext = await Promise.all(ids.map(async (id) => Number((await t.store.messageById(id))!.externalId)));
    await bridge.onReadUpTo(t.channel, 'u:42', ext[1]!);
    const st = await Promise.all(ids.map(async (id) => (await t.store.messageById(id))!.status));
    expect(st).toEqual(['read', 'read', 'sent']);
    expect(published.flatMap((e) => (e.type === 'status' && e.status === 'read' ? [e.messageId] : []))).toEqual(expect.arrayContaining([ids[0], ids[1]]));
    expect(t.calls.filter((c) => (c.body as { delivery_status?: number }).delivery_status === 2)).toHaveLength(2);
    await bridge.onReadUpTo(t.channel, 'u:43', ext[2]!); // чужой чат — ничего не меняется
    expect((await t.store.messageById(ids[2]!))!.status).toBe('sent');
  });

  it('повтор недоставленного сообщения из amo', async () => {
    const chat = await clientChat(1);
    await bridge.onAmoHook(ACCOUNT, { message: { conversation: { client_id: chat.conversationId }, message: { id: 'amo-out-2', type: 'text', text: 'Не дошло' } } });
    const out = t.queue.jobs.find((j) => j.name === 'to-channel')!;
    await t.store.markFailed(out.data.messageId, 'сеть');
    const r = await app.inject({ method: 'POST', url: `/chat/v1/messages/${out.data.messageId}/retry`, headers: await admin() });
    expect(r.statusCode).toBe(200);
    expect((await t.store.messageById(out.data.messageId))?.status).toBe('queued');
    expect(t.queue.jobs.filter((j) => j.name === 'to-channel')).toHaveLength(2);
    expect((await app.inject({ method: 'POST', url: `/chat/v1/messages/${out.data.messageId}/retry`, headers: await admin() })).statusCode).toBe(409);
  });
});

describe('окно переписки: история и живые события', () => {
  it('первое сообщение нового чата ставит задачу на историю; история сохраняется без передачи в amo', async () => {
    const chat = await clientChat(1);
    expect(t.queue.jobs.find((j) => j.name === 'history')).toEqual({ name: 'history', data: { messageId: 0, chatId: chat.id }, jobId: `history-${chat.id}-first` });
    const n = await bridge.importHistory(chat.id);
    expect(n).toBe(2);
    expect(connector.historyCalls[0]).toMatchObject({ chat: '42', limit: 100, before: { externalMessageId: '1', fromMe: false } });
    const page = await t.store.messagesPage(chat.id, null, 10);
    expect(page.messages.map((m) => [m.text, m.fromHistory, m.direction])).toEqual([
      ['Старое от клиента', true, 'in'],
      ['Старый ответ с телефона', true, 'out'],
      ['Сообщение 1', false, 'in'],
    ]);
    expect(page.messages[0]!.createdAt.toISOString()).toBe('2023-11-14T22:13:20.000Z');
    // В amo история не уходит ни сразу, ни через повтор зависших.
    expect(t.queue.jobs.filter((j) => j.name === 'to-amo')).toHaveLength(1);
    await bridge.deliverToAmo(page.messages[2]!.id);
    expect(await bridge.requeueStuckInbound(0)).toBe(0);
    expect(published.at(-1)).toEqual({ type: 'history', chatId: chat.id, count: 2 });
    // Повторная загрузка — ничего нового.
    expect(await bridge.importHistory(chat.id)).toBe(0);
    const r = await app.inject({ method: 'POST', url: `/chat/v1/chats/${chat.id}/history`, headers: await admin() });
    expect(r.json()).toEqual({ queued: true });
  });

  it('SSE: события только по доступным чатам, по сеансу; неверный сеанс — 401', async () => {
    const chat = await clientChat(1);
    const session = (await app.inject({ method: 'POST', url: '/chat/v1/session', headers: await manager() })).json();
    await app.inject({ method: 'GET', url: `/chat/v1/chats?leadId=${LEAD}`, headers: await manager() });
    const foreign = await t.store.upsertChat(t.channel, { externalChatId: '99', isGroup: false, title: 'Чужой', contact: {} });
    expect((await app.inject({ method: 'GET', url: '/chat/v1/events?session=bad' })).statusCode).toBe(401);

    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as { port: number };
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${addr.port}/chat/v1/events?session=${session.token}&chats=${chat.id},${foreign.id}`, { signal: ac.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const read = async () => new TextDecoder().decode((await reader.read()).value);
    expect(await read()).toContain(`"chats":[${chat.id}]`);
    await bridge.onInbound(t.channel, connector, event({ externalChatId: '99', externalMessageId: 'f1', text: 'чужое' }));
    await bridge.onInbound(t.channel, connector, event({ externalMessageId: '2', text: 'своё' }));
    const chunk = await read();
    expect(chunk).toContain(`"chatId":${chat.id}`);
    expect(chunk).not.toContain(`"chatId":${foreign.id}`);
    ac.abort();
  });
});

describe('шаблоны сообщений', () => {
  it('общие — администратор, личные — каждый свои; частые сверху; чужие личные не видны и не правятся', async () => {
    const h = await manager();
    expect((await app.inject({ method: 'POST', url: '/chat/v1/templates', headers: h, payload: { title: 'Общий', text: 'x', shared: true } })).statusCode).toBe(403);
    const shared = await app.inject({ method: 'POST', url: '/chat/v1/templates', headers: await admin(), payload: { title: 'Замер', text: 'Здравствуйте, {имя_клиента}! Замер по сделке {номер_сделки}', folder: 'Замер', shared: true } });
    expect(shared.statusCode).toBe(201);
    expect(shared.json()).toMatchObject({ title: 'Замер', folder: 'Замер', shared: true });
    const mine = await app.inject({ method: 'POST', url: '/chat/v1/templates', headers: h, payload: { title: 'Моё', text: 'Это {имя_менеджера}' } });
    expect(mine.statusCode).toBe(201);
    await app.inject({ method: 'POST', url: '/chat/v1/templates', headers: await other(), payload: { title: 'Чужое личное', text: 'y' } });

    const list = (await app.inject({ method: 'GET', url: '/chat/v1/templates', headers: h })).json().templates;
    expect(list.map((x: { title: string }) => x.title).sort()).toEqual(['Замер', 'Моё']);

    await app.inject({ method: 'POST', url: `/chat/v1/templates/${mine.json().id}/used`, headers: h });
    await app.inject({ method: 'POST', url: `/chat/v1/templates/${mine.json().id}/used`, headers: h });
    expect((await app.inject({ method: 'GET', url: '/chat/v1/templates', headers: h })).json().templates[0].title).toBe('Моё');

    expect((await app.inject({ method: 'PUT', url: `/chat/v1/templates/${shared.json().id}`, headers: h, payload: { title: 'Хак', text: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: `/chat/v1/templates/${mine.json().id}`, headers: await other(), payload: { title: 'Хак', text: 'x' } })).statusCode).toBe(404);
    const upd = await app.inject({ method: 'PUT', url: `/chat/v1/templates/${mine.json().id}`, headers: h, payload: { title: 'Моё 2', text: 'z', folder: 'Оплата' } });
    expect(upd.json()).toMatchObject({ title: 'Моё 2', folder: 'Оплата' });
    expect((await app.inject({ method: 'PUT', url: `/chat/v1/templates/${shared.json().id}`, headers: await admin(), payload: { title: 'Замер 2', text: 'x' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/chat/v1/templates/${shared.json().id}`, headers: h })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/chat/v1/templates/${mine.json().id}`, headers: h })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/chat/v1/templates', headers: h, payload: { title: '', text: 'x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/chat/v1/templates', headers: h, payload: { title: 'a', text: 'x', attachments: [{ fileId: randomUUID(), name: 'a', mime: 'image/png', size: 1 }] } })).statusCode).toBe(400);
  });

  it('контекст переменных: клиент, менеджер, сделка, бюджет, поля', async () => {
    const r = await app.inject({ method: 'GET', url: `/chat/v1/templates/context?leadId=${LEAD}`, headers: await manager() });
    expect(r.json()).toEqual({ client: 'Иван Петров', manager: 'Мария Менеджер', leadId: LEAD, leadName: 'Дверь входная', budget: 25000, fields: { 'Дата доставки': '15.11.2026' } });
  });
});
