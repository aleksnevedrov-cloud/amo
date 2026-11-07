import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/connectors/http.ts';
import { MaxConnector, normalizeMaxUpdate } from '../src/connectors/max.ts';
import { PermanentSendError, type ConnectorSink, type InboundEvent } from '../src/connectors/types.ts';
import { validateChannel } from '../src/channels.ts';

const sender = { user_id: 42, name: 'Иван Петров', username: 'ivan', is_bot: false };
const msg = (over: Record<string, unknown>, body: Record<string, unknown>) => ({
  update_type: 'message_created',
  timestamp: 1_790_000_000_000,
  message: { sender, recipient: { chat_id: 500, chat_type: 'dialog', user_id: 42 }, timestamp: 1_790_000_000_000, body: { mid: 'mid.1', seq: 1, ...body }, ...over },
});

describe('MAX: разбор обновлений', () => {
  it('личный текст: чат, имя, username, время в секундах', () => {
    expect(normalizeMaxUpdate(msg({}, { text: 'Привет' }))).toMatchObject({
      externalChatId: '500',
      chatTitle: 'Иван Петров',
      isGroup: false,
      contact: { username: 'ivan' },
      author: null,
      externalMessageId: 'mid.1',
      text: 'Привет',
      attachment: null,
      timestamp: 1_790_000_000,
      fromMe: false,
    });
  });

  it('фото с подписью и ответ с цитатой; файл с именем; голосовое', () => {
    const photo = normalizeMaxUpdate(msg({ link: { type: 'reply', message: { mid: 'mid.0' } } }, { text: 'Вот', attachments: [{ type: 'image', payload: { photo_id: 1, token: 't', url: 'https://i.max.ru/a.jpg' } }] }));
    expect(photo?.attachment).toMatchObject({ kind: 'picture', ref: 'https://i.max.ru/a.jpg' });
    expect(photo?.replyToExternalId).toBe('mid.0');
    const file = normalizeMaxUpdate(msg({}, { attachments: [{ type: 'file', filename: 'смета.pdf', size: 1234, payload: { token: 't', url: 'https://f.max.ru/x' } }] }));
    expect(file?.attachment).toMatchObject({ kind: 'file', name: 'смета.pdf', size: 1234 });
    const voice = normalizeMaxUpdate(msg({}, { attachments: [{ type: 'audio', payload: { token: 't', url: 'https://f.max.ru/v' } }] }));
    expect(voice?.attachment?.kind).toBe('voice');
  });

  it('группа: название из справочника, автор — участник; бот и каналы пропускаются', () => {
    const g = normalizeMaxUpdate(msg({ recipient: { chat_id: -7, chat_type: 'chat' } }, { text: 'Всем привет' }), { groupTitle: () => 'Объект Ленина' });
    expect(g).toMatchObject({ externalChatId: '-7', isGroup: true, chatTitle: 'Объект Ленина', author: { id: '42', name: 'Иван Петров' } });
    expect(normalizeMaxUpdate(msg({ sender: { ...sender, is_bot: true } }, { text: 'x' }))).toBeNull();
    expect(normalizeMaxUpdate(msg({}, { text: 'x' }), { botId: 42 })).toBeNull();
    expect(normalizeMaxUpdate(msg({ recipient: { chat_id: 1, chat_type: 'channel' } }, { text: 'x' }))).toBeNull();
    expect(normalizeMaxUpdate({ update_type: 'bot_started', timestamp: 1 })).toBeNull();
    expect(normalizeMaxUpdate(msg({}, { attachments: [{ type: 'location', latitude: 55.75, longitude: 37.61 }] }))?.text).toContain('Геопозиция');
  });
});

type Call = { url: string; method: string; auth: string | null; body: unknown };
function maxFetch(calls: Call[], respond: (path: string, body: unknown, call: Call) => Response | unknown): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const headers = new Headers(init?.headers);
    let body: unknown = null;
    if (init?.body instanceof FormData) body = Object.fromEntries(init.body.entries());
    else if (typeof init?.body === 'string') body = JSON.parse(init.body);
    const call: Call = { url: u.toString(), method: init?.method ?? 'GET', auth: headers.get('authorization'), body };
    calls.push(call);
    const r = respond(u.pathname, body, call);
    return r instanceof Response ? r : new Response(JSON.stringify(r), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
const noSleep = async () => undefined;

describe('MAX: отправка и проверка токена', () => {
  it('текст с цитатой → POST /messages с токеном в заголовке', async () => {
    const calls: Call[] = [];
    const c = new MaxConnector('max-token-xyz', { fetch: maxFetch(calls, () => ({ message: { body: { mid: 'mid.9' } } })), sleep: noSleep });
    const r = await c.send({ externalChatId: '500', text: 'Цена 15 000 ₽', file: null, replyToExternalId: 'mid.1' });
    expect(r.externalMessageId).toBe('mid.9');
    expect(calls[0]).toMatchObject({ method: 'POST', auth: 'max-token-xyz', body: { text: 'Цена 15 000 ₽', link: { type: 'reply', mid: 'mid.1' } } });
    expect(new URL(calls[0]!.url).searchParams.get('chat_id')).toBe('500');
  });

  it('фото: /uploads → загрузка → attachments; attachment.not.ready повторяется', async () => {
    const calls: Call[] = [];
    let notReady = 1;
    const f = maxFetch(calls, (path, body) => {
      if (path === '/uploads') return { url: 'https://up.max.ru/slot' };
      if (path === '/slot') return { photos: { k1: { token: 'phototoken' } } };
      if (path === '/messages' && notReady-- > 0) return new Response(JSON.stringify({ code: 'attachment.not.ready', message: 'not ready' }), { status: 400 });
      expect((body as { attachments: unknown[] }).attachments).toEqual([{ type: 'image', payload: { photos: { k1: { token: 'phototoken' } } } }]);
      return { message: { body: { mid: 'mid.10' } } };
    });
    const c = new MaxConnector('t', { fetch: f, sleep: noSleep });
    await c.send({ externalChatId: '500', text: 'Каталог', file: { data: Buffer.from('jpg'), name: 'a.jpg', mime: 'image/jpeg', kind: 'picture' }, replyToExternalId: null });
    expect(calls.filter((x) => x.url.endsWith('/messages?chat_id=500'))).toHaveLength(2);
    expect(calls[1]!.body).toMatchObject({ data: expect.anything() });
  });

  it('403 — постоянная ошибка; 5xx повторяется и затем успех', async () => {
    const forbidden = new MaxConnector('t', { fetch: maxFetch([], () => new Response(JSON.stringify({ code: 'access.denied' }), { status: 403 })), sleep: noSleep });
    await expect(forbidden.send({ externalChatId: '1', text: 'x', file: null, replyToExternalId: null })).rejects.toBeInstanceOf(PermanentSendError);
    let n = 0;
    const calls: Call[] = [];
    const flaky = new MaxConnector('t', { fetch: maxFetch(calls, () => (n++ < 2 ? new Response('', { status: 503 }) : { message: { body: { mid: 'ok' } } })), retry: { sleep: noSleep }, sleep: noSleep });
    expect((await flaky.send({ externalChatId: '1', text: 'x', file: null, replyToExternalId: null })).externalMessageId).toBe('ok');
    expect(calls).toHaveLength(3);
  });

  it('long polling: маркер двигается, сообщения уходят в мост; 401 — ошибка токена и остановка', async () => {
    let n = 0;
    const calls: Call[] = [];
    const f = maxFetch(calls, (path) => {
      if (path === '/me') return { user_id: 1, name: 'Bot', username: 'rfd_bot' };
      n++;
      if (n === 1) return { updates: [msg({}, { text: 'Добрый день' })], marker: 77 };
      return new Response(JSON.stringify({ code: 'verify.token', message: 'Invalid access_token' }), { status: 401 });
    });
    const got: InboundEvent[] = [];
    const statuses: string[] = [];
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    const sink: ConnectorSink = {
      inbound: async (ev) => void got.push(ev),
      status: async (s, d) => {
        statuses.push(`${s}${d ? `:${d}` : ''}`);
        if (s === 'error') done();
      },
    };
    const c = new MaxConnector('t', { fetch: f, sleep: noSleep, retry: { sleep: noSleep } });
    await c.start(sink);
    await finished;
    await c.stop();
    expect(got.map((e) => e.text)).toEqual(['Добрый день']);
    expect(statuses[0]).toBe('connected');
    expect(statuses[1]).toMatch(/^error:MAX не принял токен/);
    const second = calls.filter((x) => x.url.includes('/updates'))[1]!;
    expect(new URL(second.url).searchParams.get('marker')).toBe('77');
  });

  it('подключение из виджета: токен проверяется через /me; неверный — понятная ошибка', async () => {
    const ok = await validateChannel({ kind: 'max', token: 'a'.repeat(40) }, { fetch: maxFetch([], () => ({ user_id: 99, name: 'РФ-Двери', username: 'rfdveri_bot' })) });
    expect(ok).toEqual({ kind: 'max', title: '@rfdveri_bot', externalId: '99', credentials: { token: 'a'.repeat(40) } });
    await expect(validateChannel({ kind: 'max', token: 'b'.repeat(40) }, { fetch: maxFetch([], () => new Response('{"code":"verify.token"}', { status: 401 })) })).rejects.toThrow('MAX не принял токен бота');
    const err = new ApiError(401, 'x');
    expect(err.status).toBe(401);
  });
});
