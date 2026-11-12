/* eslint-disable @typescript-eslint/no-explicit-any -- в тестах разбираем произвольный JSON */
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AmoRest } from '../src/amo/rest.ts';
import { buildApp } from '../src/api/app.ts';
import { Bridge } from '../src/bridge.ts';
import type { ChatEvent } from '../src/events.ts';
import { ACCOUNT, CLIENT_ID, CLIENT_SECRET, event, FakeConnector, setupBridge, TEST_REDIS_URL } from './helpers.ts';

let redis: Redis;
beforeAll(() => {
  redis = new Redis(TEST_REDIS_URL);
});
afterAll(async () => {
  await redis.quit();
});

const MANAGER = 7;
const OTHER = 9;
async function token(over: Record<string, unknown> = {}) {
  return new SignJWT({ account_id: ACCOUNT, user_id: 5, client_uuid: CLIENT_ID, is_admin: true, ...over })
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

const rest = {
  connected: async () => true,
  userAmojoId: async (_a: number, id: number) => `amojo-user-${id}`,
  userName: async () => 'Мария',
  contactsByPhone: async () => [],
  linkChat: async () => undefined,
  chatContacts: async () => [],
  contact: async (_a: number, id: number) => ({ id, name: 'Иван', phones: ['+79361472324'] }),
  searchContacts: async (_a: number, q: string) => (q.includes('Иван') ? [{ id: 77, name: 'Иван Петров', phones: ['+79361472324'] }] : []),
  createContact: async () => 901,
  createLead: async () => 30070001,
} as unknown as AmoRest;

let t: Awaited<ReturnType<typeof setupBridge>>;
let app: Awaited<ReturnType<typeof buildApp>>;
let bridge: Bridge;
let connector: FakeConnector;
let events: ChatEvent[];
let bus: Set<(ev: ChatEvent) => void>;

beforeEach(async () => {
  const stale = await redis.keys('rfm:chat:*');
  if (stale.length) await redis.del(...stale);
  t = await setupBridge();
  connector = t.connector;
  events = [];
  bus = new Set();
  bridge = new Bridge({
    ...t.bridgeDeps,
    rest,
    events: {
      publish: async (_a, ev) => {
        events.push(ev);
        for (const fn of bus) fn(ev);
      },
    },
  });
  await t.store.setChannelStatus(t.channel.id, 'connected');
  app = await buildApp({
    env: t.env, store: t.store, files: t.files, bridge, amojo: t.amojo, box: t.box, redis, rest, queue: t.queue,
    windowSend: (input) => bridge.sendFromWindow(input),
    events: { subscribe: (_a, fn) => (bus.add(fn), () => void bus.delete(fn)) },
  });
});
afterEach(async () => {
  await app.close();
  await t.drop();
});

const inbound = (chatExt: string, id: string, text = 'Привет', over: Record<string, unknown> = {}) =>
  bridge.onInbound(t.channel, connector, event({ externalChatId: chatExt, externalMessageId: id, text, chatTitle: `Клиент ${chatExt}`, contact: { phone: `+7936000${chatExt.padStart(4, '0')}` }, ...over }));
const list = async (h: Record<string, string>, qs = '') => (await app.inject({ method: 'GET', url: `/inbox/v1/chats${qs}`, headers: h })).json();
const row = (l: any, ext: string) => l.chats.find((c: any) => c.title === `Клиент ${ext}`);
const counters = (l: any, ext: string) => [row(l, ext).unanswered, row(l, ext).answered];

describe('раздел Rf Messenger: правило счётчиков', () => {
  it('входящее — красный; открытие ничего не меняет; ответ из раздела закрывает — серый; новое входящее возвращает красный', async () => {
    await inbound('1', 'a');
    await inbound('1', 'b');
    const h = await admin();
    expect(counters(await list(h), '1')).toEqual([2, 0]);
    expect((await list(h)).unansweredChats).toBe(1);
    const chatId = row(await list(h), '1').id;
    // Открыли чат (сообщения загружены, даже /read нажат) — ничего не изменилось.
    await app.inject({ method: 'GET', url: `/chat/v1/chats/${chatId}/messages`, headers: h });
    await app.inject({ method: 'POST', url: `/chat/v1/chats/${chatId}/read`, headers: h });
    expect(counters(await list(h), '1')).toEqual([2, 0]);
    // Ответ из раздела (та же отправка, что из карточки).
    const sent = await app.inject({ method: 'POST', url: `/chat/v1/chats/${chatId}/messages`, headers: h, payload: { text: 'Добрый день!' } });
    expect(sent.statusCode).toBe(200);
    expect(counters(await list(h), '1')).toEqual([0, 2]);
    expect((await list(h)).unansweredChats).toBe(0);
    expect(events.filter((e) => e.type === 'counters').at(-1)).toMatchObject({ type: 'counters', chatId, unanswered: 0, answered: 2 });
    // Новое входящее: серый исчезает, красный 1.
    await inbound('1', 'c');
    expect(counters(await list(h), '1')).toEqual([1, 0]);
    // Сообщения не удаляются: вся лента на месте.
    expect((await app.inject({ method: 'GET', url: `/chat/v1/chats/${chatId}/messages`, headers: h })).json().messages).toHaveLength(4);
  });

  it('ответ из чата amoCRM и с телефона менеджера тоже закрывают; «Отвечать не нужно» закрывает без ответа с записью кто', async () => {
    await inbound('2', 'a');
    const chat = row(await list(await admin()), '2');
    await bridge.onAmoHook(ACCOUNT, { message: { conversation: { client_id: (await t.store.chatById(chat.id))!.conversationId }, sender: { id: 'amojo-user-7', name: 'Мария' }, message: { id: 'amo-1', type: 'text', text: 'Ок' } } });
    expect(counters(await list(await admin()), '2')).toEqual([0, 1]);

    await inbound('3', 'a');
    await inbound('3', 'b', 'Ответьте', { fromMe: true });
    expect(counters(await list(await admin()), '3')).toEqual([0, 1]);

    await inbound('4', 'a');
    await inbound('4', 'b');
    await inbound('4', 'c');
    const c4 = row(await list(await admin()), '4');
    const r = await app.inject({ method: 'POST', url: `/inbox/v1/chats/${c4.id}/no-reply`, headers: await manager() });
    expect(r.json()).toMatchObject({ ok: true, answered: 3 });
    expect(counters(await list(await admin()), '4')).toEqual([0, 3]);
    const dbChat = await t.store.chatById(c4.id);
    expect(dbChat).toMatchObject({ closedBy: 'button', closedByUserId: MANAGER, unanswered: 0, answered: 3 });
    expect(dbChat?.closedAt).toBeInstanceOf(Date);
    // Повторное нажатие без неотвеченных ничего не ломает.
    expect((await app.inject({ method: 'POST', url: `/inbox/v1/chats/${c4.id}/no-reply`, headers: await manager() })).json().answered).toBe(3);
    // История не считается входящим.
    await t.store.insertFromChannel({ chat: dbChat!, source: 'client', kind: 'text', text: 'старое', author: null, externalId: 'h1', replyToExternalId: null, fromHistory: true, createdAt: new Date(0) });
    expect(counters(await list(await admin()), '4')).toEqual([0, 3]);
  });
});

describe('раздел Rf Messenger: список, фильтры, поиск, права', () => {
  it('сортировка: новое входящее поднимает чат наверх; закреплённые сверху; фильтры «Неотвеченные» и «Мои»', async () => {
    await inbound('1', 'a');
    await inbound('2', 'a');
    await inbound('3', 'a');
    const h = await admin();
    expect((await list(h)).chats.map((c: any) => c.title)).toEqual(['Клиент 3', 'Клиент 2', 'Клиент 1']);
    await inbound('1', 'b', 'снова');
    expect((await list(h)).chats.map((c: any) => c.title)).toEqual(['Клиент 1', 'Клиент 3', 'Клиент 2']);
    const c2 = row(await list(h), '2');
    await app.inject({ method: 'POST', url: `/inbox/v1/chats/${c2.id}/pin`, headers: h, payload: { pinned: true } });
    expect((await list(h)).chats.map((c: any) => c.title)).toEqual(['Клиент 2', 'Клиент 1', 'Клиент 3']);
    expect(row(await list(h), '2').pinned).toBe(true);

    // Менеджер 7 ответил в чат 3 → он «мой» для него, а для 9 — нет.
    const c3 = row(await list(await manager()), '3'); // показ в списке выдаёт менеджеру доступ к чату
    expect((await app.inject({ method: 'POST', url: `/chat/v1/chats/${c3.id}/messages`, headers: await manager(), payload: { text: 'Я на связи' } })).statusCode).toBe(200);
    expect((await list(h, '?filter=unanswered')).chats.map((c: any) => c.title)).toEqual(['Клиент 2', 'Клиент 1']);
    expect((await list(await manager(), '?filter=mine')).chats.map((c: any) => c.title)).toEqual(['Клиент 3']);
    expect((await list(await other(), '?filter=mine')).chats).toEqual([]);
    expect((await list(h, `?channelId=${t.channel.id + 100}`)).chats).toEqual([]);
  });

  it('поиск по имени, номеру, нику и тексту; минимум 2 символа', async () => {
    await inbound('1', 'a', 'Нужна дверь Торекс');
    await inbound('2', 'a', 'Привет', { chatTitle: 'Ольга', contact: { username: 'olga_d' } });
    const h = await admin();
    expect((await list(h, '?q=Торекс')).chats.map((c: any) => c.title)).toEqual(['Клиент 1']);
    expect((await list(h, '?q=0001')).chats.map((c: any) => c.title)).toEqual(['Клиент 1']);
    expect((await list(h, '?q=olga')).chats.map((c: any) => c.title)).toEqual(['Ольга']);
    expect((await list(h, '?q=Ольг')).chats.map((c: any) => c.title)).toEqual(['Ольга']);
    expect((await app.inject({ method: 'GET', url: '/inbox/v1/chats?q=x', headers: h })).statusCode).toBe(400);
  });

  it('пагинация по 50 с курсором; все сотрудники видят все чаты и получают доступ к сообщениям; без токена 401', async () => {
    for (let i = 1; i <= 55; i++) await inbound(String(i), 'a');
    const h = await other();
    const p1 = await list(h);
    expect(p1.chats).toHaveLength(50);
    expect(p1.hasMore).toBe(true);
    const p2 = await list(h, `?before=${p1.chats[49].id}`);
    expect(p2.chats).toHaveLength(5);
    expect(p2.hasMore).toBe(false);
    expect(new Set([...p1.chats, ...p2.chats].map((c: any) => c.id)).size).toBe(55);
    // Менеджер без карточки открывает сообщения чата из списка.
    expect((await app.inject({ method: 'GET', url: `/chat/v1/chats/${p1.chats[0].id}/messages`, headers: h })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/chat/v1/chats?chatId=${p1.chats[0].id}`, headers: h })).json().chats[0].id).toBe(p1.chats[0].id);
    expect((await app.inject({ method: 'GET', url: '/inbox/v1/chats' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/inbox/v1/counters', headers: { 'x-auth-token': await token({ account_id: 4242 }) } })).json().unansweredChats).toBe(0);
  });

  it('SSE раздела: события по всем чатам аккаунта, счётчики приходят без перезагрузки', async () => {
    await inbound('1', 'a');
    const session = (await app.inject({ method: 'POST', url: '/chat/v1/session', headers: await other() })).json();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as { port: number };
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${addr.port}/chat/v1/events?session=${session.token}&scope=inbox`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const read = async () => new TextDecoder().decode((await reader.read()).value);
    await read();
    await inbound('2', 'a', 'новый чат');
    let chunk = '';
    for (let i = 0; i < 5 && !chunk.includes('"type":"counters"'); i++) chunk += await read();
    expect(chunk).toContain('"type":"message"');
    expect(chunk).toContain('"type":"counters"');
    expect(chunk).toContain('"unanswered":1');
    ac.abort();
  });

  it('контакт и сделка из чата: поиск контакта, привязка, «Создать сделку» создаёт контакт с номером', async () => {
    await inbound('1', 'a');
    const h = await admin();
    const chat = row(await list(h), '1');
    expect((await app.inject({ method: 'GET', url: '/inbox/v1/contacts/search?q=Иван', headers: h })).json().contacts[0]).toMatchObject({ id: 77, name: 'Иван Петров' });
    const link = await app.inject({ method: 'POST', url: `/inbox/v1/chats/${chat.id}/link-contact`, headers: h, payload: { contactId: 77 } });
    expect(link.json()).toEqual({ ok: true, contactId: 77 });
    expect((await t.store.chatById(chat.id))?.amojoChatId).toBeTruthy();
    expect(t.calls.some((c) => c.path.endsWith('/chats'))).toBe(true);

    await inbound('2', 'a');
    const chat2 = row(await list(h), '2');
    const lead = await app.inject({ method: 'POST', url: `/inbox/v1/chats/${chat2.id}/lead`, headers: h, payload: {} });
    expect(lead.json()).toEqual({ ok: true, contactId: 901, leadId: 30070001 });
    expect((await app.inject({ method: 'POST', url: `/inbox/v1/chats/999999/lead`, headers: h, payload: {} })).statusCode).toBe(404);
  });
});
