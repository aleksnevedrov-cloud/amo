/* eslint-disable @typescript-eslint/no-explicit-any -- в тестах разбираем произвольный JSON */
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.ts';
import { Bridge } from '../src/bridge.ts';
import { validateChannel } from '../src/channels.ts';
import { greenApiWebhookUrl } from '../src/connectors/host.ts';
import { channelStatusOf, desiredSettings, greenApiHosts, MaxGreenApiConnector, normalizeGreenHistoryItem, normalizeGreenNotification, settingsDiffer, webhookTokenMatches } from '../src/connectors/max-greenapi.ts';
import { PermanentSendError, type ConnectorSink, type InboundEvent } from '../src/connectors/types.ts';
import { ACCOUNT, CLIENT_ID, CLIENT_SECRET, event, FakeConnector, setupBridge, TEST_REDIS_URL } from './helpers.ts';

const base = (over: Record<string, unknown>) => ({
  typeWebhook: 'incomingMessageReceived',
  instanceData: { idInstance: 1101000001, wid: '79099724272@c.us', typeInstance: 'v3' },
  timestamp: 1_790_000_000,
  idMessage: '1763115112345',
  senderData: { chatId: '10000000', chatName: 'Иван Петров', chatType: 'user', sender: '10000000', senderName: 'Иван', senderType: 'user', senderContactName: 'Иван Петров', senderPhoneNumber: 79361472324 },
  messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'Здравствуйте' } },
  ...over,
});
const fileMd = (typeMessage: string, extra: Record<string, unknown> = {}) => ({
  typeMessage,
  fileMessageData: { downloadUrl: 'https://sw-media-1101.storage.yandexcloud.net/1101000001/a.bin', caption: 'Вот', fileName: '', mimeType: '', ...extra },
});

describe('GREEN-API (MAX по номеру): разбор уведомлений', () => {
  it('входящий текст: чат — chatId MAX, имя из контактов, телефон, время', () => {
    const n = normalizeGreenNotification(base({}));
    expect(n.kind).toBe('message');
    expect((n as any).event).toMatchObject({
      externalChatId: '10000000',
      chatTitle: 'Иван Петров',
      isGroup: false,
      contact: { phone: '+79361472324' },
      externalMessageId: '1763115112345',
      text: 'Здравствуйте',
      timestamp: 1_790_000_000,
      fromMe: false,
    });
  });

  it('все типы: ссылка, цитата, фото, видео, документ, голосовое, стикер, геопозиция, контакт', () => {
    const ev = (md: Record<string, unknown>) => (normalizeGreenNotification(base({ messageData: md })) as { event: InboundEvent }).event;
    expect(ev({ typeMessage: 'extendedTextMessage', extendedTextMessageData: { text: 'см. https://rf-dveri.ru', title: 'РФ' } }).text).toBe('см. https://rf-dveri.ru');
    const q = ev({ typeMessage: 'quotedMessage', extendedTextMessageData: { text: 'Да, это', stanzaId: '116413118178426437', participant: '10000000' } });
    expect(q).toMatchObject({ text: 'Да, это', replyToExternalId: '116413118178426437' });
    expect(ev(fileMd('imageMessage', { mimeType: 'image/webp' })).attachment).toMatchObject({ kind: 'picture', mime: 'image/webp', ref: 'https://sw-media-1101.storage.yandexcloud.net/1101000001/a.bin' });
    expect(ev(fileMd('imageMessage')).text).toBe('Вот');
    expect(ev(fileMd('videoMessage', { mimeType: 'video/mp4' })).attachment?.kind).toBe('video');
    expect(ev(fileMd('documentMessage', { fileName: 'смета.pdf', mimeType: 'application/pdf' })).attachment).toMatchObject({ kind: 'file', name: 'смета.pdf' });
    expect(ev(fileMd('audioMessage', { mimeType: 'audio/ogg; codecs=opus' })).attachment?.kind).toBe('voice');
    expect(ev(fileMd('audioMessage', { mimeType: 'audio/mpeg' })).attachment?.kind).toBe('audio');
    expect(ev(fileMd('stickerMessage', { mimeType: 'image/webp' })).attachment?.kind).toBe('sticker');
    expect(ev({ ...fileMd('imageMessage'), quotedMessage: { stanzaId: '555', participant: '10000000' } }).replyToExternalId).toBe('555');
    expect(ev({ typeMessage: 'locationMessage', locationMessageData: { nameLocation: 'Офис', address: 'Ленина 5', latitude: 55.75, longitude: 37.61 } }).text).toContain('Геопозиция: Офис, Ленина 5 https://yandex.ru/maps/?pt=37.61,55.75');
    expect(ev({ typeMessage: 'contactMessage', contactMessageData: { displayName: 'Пётр', vcard: 'BEGIN:VCARD\nTEL;type=CELL:+7 999 123-45-67\nEND:VCARD' } }).text).toBe('Контакт: Пётр +7 999 123-45-67');
  });

  it('группа: название и автор; с телефона — исходящее; через API — пропуск; реакции и каналы — пропуск', () => {
    const g = normalizeGreenNotification(base({ senderData: { chatId: '-69876543210123', chatName: 'Объект Ленина', chatType: 'group', sender: '10000000', senderName: 'Ольга', senderType: 'user', senderContactName: '', senderPhoneNumber: 0 } }));
    expect((g as any).event).toMatchObject({ externalChatId: '-69876543210123', isGroup: true, chatTitle: 'Объект Ленина', author: { id: '10000000', name: 'Ольга' }, contact: {} });
    const out = normalizeGreenNotification(base({ typeWebhook: 'outgoingMessageReceived', messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'Перезвоню' } } }));
    expect((out as any).event).toMatchObject({ fromMe: true, text: 'Перезвоню', chatTitle: 'Иван Петров' });
    expect(normalizeGreenNotification(base({ typeWebhook: 'outgoingAPIMessageReceived' }))).toEqual({ kind: 'skip', reason: 'отправлено через API' });
    expect(normalizeGreenNotification(base({ messageData: { typeMessage: 'reactionMessage' } })).kind).toBe('skip');
    expect(normalizeGreenNotification(base({ senderData: { chatId: '77', chatType: 'channel' } })).kind).toBe('skip');
    expect(normalizeGreenNotification({ typeWebhook: 'incomingCall' }).kind).toBe('skip');
  });

  it('статусы сообщений и состояние инстанса', () => {
    expect(normalizeGreenNotification({ typeWebhook: 'outgoingMessageStatus', chatId: '10000000', idMessage: '115', status: 'read' })).toEqual({ kind: 'status', chatId: '10000000', idMessage: '115', status: 'read', description: '' });
    expect(normalizeGreenNotification({ typeWebhook: 'outgoingMessageStatus', chatId: '10000000', idMessage: '116', status: 'noAccount' }).kind).toBe('status');
    expect(normalizeGreenNotification({ typeWebhook: 'stateInstanceChanged', stateInstance: 'suspended' })).toEqual({ kind: 'state', state: 'suspended' });
    expect(channelStatusOf('authorized')).toEqual({ status: 'connected', detail: null });
    expect(channelStatusOf('notAuthorized').status).toBe('session_ended');
    expect(channelStatusOf('notAuthorized').detail).toMatch(/Нужен вход по QR.*Устройства.*пароль/);
    expect(channelStatusOf('blocked')).toMatchObject({ status: 'error', detail: expect.stringContaining('Заблокирован') });
    expect(channelStatusOf('suspended', 1_790_000_000).detail).toMatch(/Ограничен.*до .*МСК/);
    expect(channelStatusOf('pendingPassword').detail).toMatch(/пароль/);
    expect(channelStatusOf('starting').status).toBe('starting');
  });

  it('хосты по idInstance, настройки инстанса и токен вебхука', () => {
    // Как в кабинете GREEN-API для MAX: apiUrl = mediaUrl = https://api.green-api.com; по idInstance ничего не вычисляется.
    expect(greenApiHosts('310022797820')).toEqual({ api: 'https://api.green-api.com', media: 'https://api.green-api.com' });
    expect(greenApiHosts('310022797820', { apiUrl: 'https://7103.api.green-api.com/' })).toEqual({ api: 'https://7103.api.green-api.com', media: 'https://7103.api.green-api.com' });
    expect(greenApiHosts('1', { apiUrl: 'https://a.green-api.com', mediaUrl: 'https://m.green-api.com' }).media).toBe('https://m.green-api.com');
    const d = desiredSettings('https://chat.example.ru/hooks/greenapi/5', 'secret1');
    expect(d).toMatchObject({ webhookUrl: 'https://chat.example.ru/hooks/greenapi/5', webhookUrlToken: 'Bearer secret1', incomingWebhook: 'yes', outgoingMessageWebhook: 'yes', outgoingAPIMessageWebhook: 'no', outgoingWebhook: 'yes', stateWebhook: 'yes' });
    expect(settingsDiffer({ ...d, delaySendMessagesMilliseconds: 1000 }, d)).toBe(false);
    expect(settingsDiffer({ ...d, webhookUrl: '' }, d)).toBe(true);
    expect(desiredSettings(null, null).webhookUrlToken).toBe('');
    expect(webhookTokenMatches('Bearer secret1', 'secret1')).toBe(true);
    expect(webhookTokenMatches('secret1', 'secret1')).toBe(true);
    expect(webhookTokenMatches('Bearer secret2', 'secret1')).toBe(false);
    expect(webhookTokenMatches(undefined, 'secret1')).toBe(false);
    expect(webhookTokenMatches('Bearer x', '')).toBe(false);
  });
});

type Call = { url: string; method: string; body: unknown };
function gaFetch(calls: Call[], respond: (method: string, body: unknown, url: URL) => unknown): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    let body: unknown = null;
    if (init?.body instanceof FormData) body = Object.fromEntries(init.body.entries());
    else if (typeof init?.body === 'string') body = JSON.parse(init.body);
    calls.push({ url: u.toString(), method: init?.method ?? 'GET', body });
    const method = u.pathname.split('/')[2] ?? '';
    const r = respond(method, body, u);
    return r instanceof Response ? r : new Response(JSON.stringify(r), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
const CREDS = { idInstance: '1101000001', apiTokenInstance: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6ab' };
const noSleep = async () => undefined;
const fastSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5)));
const deps = (over: Record<string, unknown> = {}) => ({ onQr: async () => undefined, onIdentity: async () => true, sleep: fastSleep, stateCheckMs: 20, qrPollMs: 5, ...over });

describe('GREEN-API: подключение, QR, отправка', () => {
  it('токен в пути, не в тексте ошибок; текст с цитатой → sendMessage; файл → sendFileByUpload на media-хост', async () => {
    const calls: Call[] = [];
    const c = new MaxGreenApiConnector(CREDS, { ...deps(), fetch: gaFetch(calls, () => ({ idMessage: '1763115112345' })) });
    const r = await c.send({ externalChatId: '10000000', text: 'Цена 15 000 ₽', file: null, replyToExternalId: '116' });
    expect(r.externalMessageId).toBe('1763115112345');
    expect(calls[0]!.url).toBe(`https://api.green-api.com/waInstance1101000001/sendMessage/${CREDS.apiTokenInstance}`);
    expect(calls[0]!.body).toEqual({ chatId: '10000000', message: 'Цена 15 000 ₽', quotedMessageId: '116' });
    await c.send({ externalChatId: '10000000', text: 'Фото', file: { data: Buffer.from('jpg'), name: 'a.jpg', mime: 'image/jpeg', kind: 'picture' }, replyToExternalId: null });
    expect(calls[1]!.url).toContain('https://api.green-api.com/waInstance1101000001/sendFileByUpload/');
    expect(calls[1]!.body).toMatchObject({ chatId: '10000000', fileName: 'a.jpg', caption: 'Фото' });

    const bad = new MaxGreenApiConnector(CREDS, { ...deps(), fetch: gaFetch([], () => new Response('{"message":"Your account is suspended"}', { status: 403 })), retry: { sleep: noSleep } });
    const err = await bad.send({ externalChatId: '1', text: 'x', file: null, replyToExternalId: null }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PermanentSendError);
    expect((err as Error).message).not.toContain(CREDS.apiTokenInstance);
    expect((err as Error).message).toMatch(/ограничен/);
  });

  it('не авторизован → QR каждые 5 с и статус «Нужен вход»; после входа — номер, настройки вебхука, «Подключён»', async () => {
    const calls: Call[] = [];
    let state = 'notAuthorized';
    const qrs: (string | null)[] = [];
    const ids: string[] = [];
    const f = gaFetch(calls, (m) => {
      if (m === 'getStateInstance') return { stateInstance: state };
      if (m === 'qr') return state === 'notAuthorized' ? { type: 'qrCode', message: 'iVBORw0KGgo=' } : { type: 'alreadyLogged', message: 'instance account already authorized' };
      if (m === 'getAccountSettings') return { phone: '79099724272', stateInstance: state, chatId: '20000000' };
      if (m === 'getSettings') return { webhookUrl: '', webhookUrlToken: '', incomingWebhook: 'no' };
      if (m === 'setSettings') return { saveSettings: true };
      if (m === 'receiveNotification') return new Response('null', { headers: { 'content-type': 'application/json' } });
      throw new Error(m);
    });
    const statuses: string[] = [];
    const sink: ConnectorSink = { inbound: async () => undefined, status: async (s, d) => void statuses.push(`${s}${d ? `:${d}` : ''}`) };
    const c = new MaxGreenApiConnector(CREDS, { ...deps({ onQr: async (q: string | null) => void qrs.push(q), onIdentity: async (p: string) => (ids.push(p), true) }), fetch: f, webhookUrl: 'https://chat.example.ru/hooks/greenapi/5', webhookToken: 'secret1' });
    await c.start(sink);
    await new Promise((r) => setTimeout(r, 40));
    expect(qrs[0]).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(statuses[0]).toMatch(/^session_ended:Нужен вход по QR/);
    expect(calls.filter((x) => x.url.includes('/qr/')).length).toBeGreaterThan(1);
    state = 'authorized';
    await new Promise((r) => setTimeout(r, 60));
    await c.stop();
    expect(ids).toEqual(['+79099724272']);
    expect(qrs.at(-1)).toBeNull();
    const set = calls.find((x) => x.url.includes('/setSettings/'))!;
    expect(set.body).toMatchObject({ webhookUrl: 'https://chat.example.ru/hooks/greenapi/5', webhookUrlToken: 'Bearer secret1', incomingWebhook: 'yes', outgoingAPIMessageWebhook: 'no' });
    expect(statuses.at(-1)).toBe('connected');
    expect(c.webhookMode).toBe(true);
  });

  it('без адреса вебхука — опрос receiveNotification/deleteNotification; уведомления уходят в мост', async () => {
    const calls: Call[] = [];
    let served = false;
    const f = gaFetch(calls, (m, _b, u) => {
      if (m === 'getStateInstance') return { stateInstance: 'authorized' };
      if (m === 'getAccountSettings') return { phone: '79099724272' };
      if (m === 'getSettings') return { webhookUrl: '', webhookUrlToken: '', incomingWebhook: 'yes', outgoingMessageWebhook: 'yes', outgoingAPIMessageWebhook: 'no', outgoingWebhook: 'yes', stateWebhook: 'yes', markIncomingMessagesReaded: 'no' };
      if (m === 'receiveNotification') {
        if (served) return new Promise((r) => setTimeout(() => r(new Response('null', { headers: { 'content-type': 'application/json' } })), 15));
        served = true;
        return { receiptId: 777, body: base({}) };
      }
      if (m === 'deleteNotification') {
        expect(u.pathname.endsWith('/777')).toBe(true);
        return { result: true };
      }
      throw new Error(m);
    });
    const got: InboundEvent[] = [];
    const c = new MaxGreenApiConnector(CREDS, { ...deps(), fetch: f });
    await c.start({ inbound: async (ev) => void got.push(ev), status: async () => undefined });
    await new Promise((r) => setTimeout(r, 60));
    await c.stop();
    expect(got.map((e) => e.text)).toEqual(['Здравствуйте']);
    expect(calls.some((x) => x.url.includes('/setSettings/'))).toBe(false); // настройки уже такие — инстанс не перезапускаем
    expect(calls.some((x) => x.method === 'DELETE' && x.url.includes('/deleteNotification/'))).toBe(true);
    expect(c.webhookMode).toBe(false);
  });

  it('неверные ключи — «Ошибка» с подсказкой; blocked и suspended — свои статусы', async () => {
    const statuses: string[] = [];
    const bad = new MaxGreenApiConnector(CREDS, { ...deps(), fetch: gaFetch([], () => new Response('{"message":"Unauthorized"}', { status: 401 })), retry: { sleep: noSleep } });
    await bad.start({ inbound: async () => undefined, status: async (s, d) => void statuses.push(`${s}:${d}`) });
    await new Promise((r) => setTimeout(r, 20));
    await bad.stop();
    expect(statuses.at(-1)).toMatch(/^error:GREEN-API не принял idInstance/);

    const st: string[] = [];
    const blocked = new MaxGreenApiConnector(CREDS, { ...deps(), fetch: gaFetch([], (m) => (m === 'getStateInstance' ? { stateInstance: 'blocked' } : {})) });
    await blocked.start({ inbound: async () => undefined, status: async (s, d) => void st.push(`${s}:${d}`) });
    await new Promise((r) => setTimeout(r, 15));
    await blocked.stop();
    expect(st[0]).toMatch(/^error:Заблокирован/);
  });

  it('вебхук в коннекторе: статусы доставки и ошибки доставки, смена состояния', async () => {
    const delivered: string[] = [];
    const failed: string[] = [];
    const statuses: string[] = [];
    const c = new MaxGreenApiConnector(CREDS, { ...deps(), fetch: gaFetch([], (m) => (m === 'getStateInstance' ? { stateInstance: 'authorized' } : m === 'getAccountSettings' ? { phone: '79099724272' } : m === 'getSettings' ? desiredSettings(null, null) : null)) });
    await c.start({
      inbound: async () => undefined,
      status: async (s, d) => void statuses.push(`${s}${d ? `:${d}` : ''}`),
      delivery: async (chat, id, s) => void delivered.push(`${chat}/${id}/${s}`),
      sendFailed: async (chat, id, reason) => void failed.push(`${chat}/${id}/${reason}`),
    });
    await new Promise((r) => setTimeout(r, 15));
    await c.onWebhook({ typeWebhook: 'outgoingMessageStatus', chatId: '10000000', idMessage: '115', status: 'read' });
    await c.onWebhook({ typeWebhook: 'outgoingMessageStatus', chatId: '10000000', idMessage: '116', status: 'noAccount' });
    await c.onWebhook({ typeWebhook: 'stateInstanceChanged', stateInstance: 'notAuthorized' });
    await c.stop();
    expect(delivered).toEqual(['10000000/115/read']);
    expect(failed).toEqual(['10000000/116/У получателя нет аккаунта MAX']);
    expect(statuses.at(-1)).toMatch(/^session_ended/);
  });

  it('checkAccount для «Написать»: есть MAX → chatId; нет — null; лимит — понятная ошибка; номер не РФ/РБ — ошибка', async () => {
    const calls: Call[] = [];
    let answer: unknown = { exist: true, chatId: '10000000', fromCache: true };
    const c = new MaxGreenApiConnector(CREDS, { ...deps(), fetch: gaFetch(calls, () => answer) });
    expect(await c.resolvePhone('+7 (936) 147-23-24')).toEqual({ externalChatId: '10000000' });
    expect(calls[0]!.body).toEqual({ phoneNumber: 79361472324 });
    answer = { exist: false, chatId: '', fromCache: false };
    expect(await c.resolvePhone('+79361472325')).toBeNull();
    answer = { status: false, reason: 'User get contact info limit reached' };
    await expect(c.resolvePhone('+79361472325')).rejects.toThrow(/лимит проверок/);
    await expect(c.resolvePhone('+4915112345678')).rejects.toThrow(/только номера РФ/);
  });

  it('история чата: getChatHistory → сообщения от старых к новым; «старше известного» отсекается; чужие чаты и реакции — мимо', async () => {
    const item = (id: string, ts: number, over: Record<string, unknown> = {}) => ({ type: 'incoming', idMessage: id, timestamp: ts, typeMessage: 'textMessage', chatId: '10000000', chatType: 'user', senderId: '10000000', senderName: 'Иван', textMessage: `т${id}`, ...over });
    expect(normalizeGreenHistoryItem(item('1', 100))).toMatchObject({ externalChatId: '10000000', externalMessageId: '1', text: 'т1', fromMe: false, timestamp: 100 });
    expect(normalizeGreenHistoryItem(item('2', 101, { type: 'outgoing', sendByApi: true }))).toMatchObject({ fromMe: true, text: 'т2' });
    expect(normalizeGreenHistoryItem(item('3', 102, { typeMessage: 'imageMessage', textMessage: undefined, caption: 'Фото', downloadUrl: 'https://sw-media-1101.storage.yandexcloud.net/a.jpg', mimeType: 'image/jpeg' }))).toMatchObject({ text: 'Фото', attachment: { kind: 'picture', mime: 'image/jpeg' } });
    expect(normalizeGreenHistoryItem(item('4', 103, { typeMessage: 'extendedTextMessage', textMessage: undefined, extendedTextMessage: { text: 'ссылка' }, quotedMessage: { stanzaId: '2' } }))).toMatchObject({ text: 'ссылка', replyToExternalId: '2' });
    expect(normalizeGreenHistoryItem(item('5', 104, { typeMessage: 'reactionMessage' }))).toBeNull();

    const calls: Call[] = [];
    const list = [item('9', 109), item('8', 108), item('7', 107, { type: 'outgoing' }), item('6', 106), item('x', 105, { chatId: '20000000' }), item('5', 104, { typeMessage: 'reactionMessage' })];
    const c = new MaxGreenApiConnector(CREDS, { ...deps(), fetch: gaFetch(calls, () => list) });
    const last = await c.history('10000000', 2, null);
    expect(calls[0]!.url).toBe(`https://api.green-api.com/waInstance1101000001/getChatHistory/${CREDS.apiTokenInstance}`);
    expect(calls[0]!.body).toEqual({ chatId: '10000000', count: 2 });
    expect(last.map((e) => e.externalMessageId)).toEqual(['8', '9']);
    const older = await c.history('10000000', 10, { externalMessageId: '8', timestamp: 108, fromMe: false });
    expect(calls[1]!.body).toEqual({ chatId: '10000000', count: 510 });
    expect(older.map((e) => [e.externalMessageId, e.fromMe])).toEqual([['6', false], ['7', true]]);
  });

  it('подключение из виджета: проверка инстанса; авторизованный — сразу номер в названии', async () => {
    const authorized = gaFetch([], (m) => (m === 'getStateInstance' ? { stateInstance: 'authorized' } : { phone: '79099724272' }));
    const v = await validateChannel({ kind: 'max_phone', ...CREDS }, { fetch: authorized });
    expect(v).toMatchObject({ kind: 'max_phone', title: 'MAX +79099724272', externalId: '+79099724272', credentials: { idInstance: CREDS.idInstance, apiTokenInstance: CREDS.apiTokenInstance } });
    expect(v.credentials.webhookSecret).toMatch(/^[0-9a-f]{48}$/);
    const fresh = await validateChannel({ kind: 'max_phone', ...CREDS }, { fetch: gaFetch([], () => ({ stateInstance: 'notAuthorized' })) });
    expect(fresh.title).toContain('ожидает QR');
    expect(fresh.externalId).toBe('ga-1101000001');
    await expect(validateChannel({ kind: 'max_phone', ...CREDS }, { fetch: gaFetch([], () => new Response('{}', { status: 401 })) })).rejects.toThrow('GREEN-API не принял idInstance или apiTokenInstance');
    // Необязательный apiUrl из кабинета сохраняется в ключах и используется в запросах; чужой домен не принимается.
    const urls: string[] = [];
    const withHost = await validateChannel({ kind: 'max_phone', ...CREDS, apiUrl: 'https://7103.api.green-api.com' }, { fetch: gaFetch([], (_m, _b, u) => (urls.push(u.origin), { stateInstance: 'notAuthorized' })) });
    expect(withHost.credentials.apiUrl).toBe('https://7103.api.green-api.com');
    expect(urls[0]).toBe('https://7103.api.green-api.com');
    const { createChannelSchema } = await import('../src/channels.ts');
    expect(createChannelSchema.safeParse({ kind: 'max_phone', ...CREDS, apiUrl: 'https://evil.example' }).success).toBe(false);
    expect(createChannelSchema.safeParse({ kind: 'max_phone', ...CREDS, apiUrl: '' }).success).toBe(true);
  });
});

describe('GREEN-API: маршрут вебхука и лимит первых сообщений', () => {
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
  const token = () =>
    new SignJWT({ account_id: ACCOUNT, user_id: 5, client_uuid: CLIENT_ID, is_admin: true })
      .setProtectedHeader({ alg: 'HS256' })
      .setJti(randomUUID())
      .setIssuer('https://x.amocrm.ru')
      .setAudience('https://chat.example.ru')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(CLIENT_SECRET));

  it('POST /hooks/greenapi/:id: тело в очередь при верном Bearer, 401 при неверном, 404 для чужого вида канала', async () => {
    const hooks: { channelId: number; body: unknown }[] = [];
    const app = await buildApp({ env: t.env, store: t.store, files: t.files, bridge: t.bridge, amojo: t.amojo, box: t.box, redis, webhooks: { add: async (channelId, body) => void hooks.push({ channelId, body }) } });
    const ch = (await t.store.createChannel({ accountId: ACCOUNT, kind: 'max_phone', title: 'MAX', externalId: 'ga-1101000001', credentials: t.box.encrypt(JSON.stringify({ ...CREDS, webhookSecret: 'a'.repeat(48) })) }))!;
    const url = new URL(greenApiWebhookUrl('https://chat.example.ru', ch.id));
    expect(url.pathname).toBe(`/hooks/greenapi/${ch.id}`);
    const body = base({});
    expect((await app.inject({ method: 'POST', url: url.pathname, headers: { authorization: `Bearer ${'a'.repeat(48)}`, 'content-type': 'application/json' }, payload: body })).json()).toEqual({ ok: true });
    expect(hooks).toEqual([{ channelId: ch.id, body }]);
    expect((await app.inject({ method: 'POST', url: url.pathname, headers: { authorization: `Bearer ${'b'.repeat(48)}` }, payload: body })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: url.pathname, payload: body })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/hooks/greenapi/${t.channel.id}`, headers: { authorization: `Bearer ${'a'.repeat(48)}` }, payload: body })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/hooks/greenapi/abc', payload: body })).statusCode).toBe(404);
    expect(hooks).toHaveLength(1);

    // В списке каналов и в «Написать» новый вид виден, ключи не возвращаются.
    const h = { 'x-auth-token': await token() };
    const st = await app.inject({ method: 'GET', url: '/widget/v1/status', headers: h });
    expect(st.body).not.toContain(CREDS.apiTokenInstance);
    expect(st.json().channels.find((c: { id: number }) => c.id === ch.id)).toMatchObject({ kind: 'max_phone', kindText: 'MAX по номеру' });
    const qr = await app.inject({ method: 'GET', url: `/widget/v1/channels/${ch.id}/qr`, headers: h });
    expect(qr.statusCode).toBe(200);
    await redis.set(`rfm:max:qr:${ch.id}`, 'data:image/png;base64,iVBORw0KGgo=', 'EX', 30);
    expect((await app.inject({ method: 'GET', url: `/widget/v1/channels/${ch.id}/qr`, headers: h })).json().svg).toContain('<img src="data:image/png;base64,iVBORw0KGgo="');
    await redis.del(`rfm:max:qr:${ch.id}`);
    await app.close();
  });

  it('«Написать»: 25 первых сообщений подряд на один канал уходят без отказа (суточного лимита нет)', async () => {
    const rest = { contact: async () => ({ id: 1, name: 'Иван', phones: [] }), linkChat: async () => undefined, userAmojoId: async () => 'op-1' } as unknown as import('../src/amo/rest.ts').AmoRest;
    const connector = new FakeConnector();
    const bridge = new Bridge({ ...t.bridgeDeps, rest, connector: () => connector });
    await t.store.setChannelStatus(t.channel.id, 'connected');
    await t.db.query("UPDATE channels SET kind = 'max_phone' WHERE id = $1", [t.channel.id]);
    for (let i = 0; i < 25; i++) {
      const phone = `+7936000${String(i).padStart(4, '0')}`;
      connector.phones.set(phone, `1000${i}`);
      await expect(bridge.startChat({ accountId: ACCOUNT, userId: 5, channelId: t.channel.id, contactId: 1, phone, text: 'Добрый день' })).resolves.toBeTruthy();
    }
    expect(connector.sent).toHaveLength(25);
    expect(await t.store.recentChats(ACCOUNT, t.channel.id, 100)).toHaveLength(25);
    expect(t.queue.jobs.filter((j) => j.name === 'history')).toHaveLength(0); // у FakeConnector нет истории
    // Канал с историей: новый чат из «Написать» → задача подгрузки прежней переписки, повторное «Написать» — без неё.
    (connector as FakeConnector & { history?: unknown }).history = async () => [];
    connector.phones.set('+79360009999', '19999');
    const r = await bridge.startChat({ accountId: ACCOUNT, userId: 5, channelId: t.channel.id, contactId: 1, phone: '+79360009999', text: 'Добрый день' });
    expect(t.queue.jobs.filter((j) => j.name === 'history').map((j) => j.data.chatId)).toEqual([r.chatId]);
    await bridge.startChat({ accountId: ACCOUNT, userId: 5, channelId: t.channel.id, contactId: 1, phone: '+79360009999', text: 'Ещё' });
    expect(t.queue.jobs.filter((j) => j.name === 'history')).toHaveLength(1);
    // Чат, где клиент уже писал, продолжается без создания второго.
    await bridge.onInbound(t.channel, connector, event({ externalChatId: '42', contact: { phone: '+79361472324' } }));
    await expect(bridge.startChat({ accountId: ACCOUNT, userId: 5, channelId: t.channel.id, contactId: 1, phone: '+79361472324', text: 'ок' })).resolves.toBeTruthy();
  });
});
