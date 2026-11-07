import { describe, expect, it } from 'vitest';
import { validateChannel } from '../src/channels.ts';
import { AvitoConnector, avitoChatInfo, normalizeAvitoMessage } from '../src/connectors/avito.ts';
import { PermanentSendError, type ConnectorSink, type InboundEvent } from '../src/connectors/types.ts';

const USER = 777;
const chatJson = {
  id: 'u2i-abc',
  context: { type: 'item', value: { id: 1, title: 'Дверь входная Торекс', url: 'https://www.avito.ru/item/1', price_string: '25 000 ₽' } },
  users: [
    { id: USER, name: 'РФ-Двери' },
    { id: 42, name: 'Иван', public_user_profile: { url: 'https://www.avito.ru/user/42' } },
  ],
};
const hook = (value: Record<string, unknown>) => ({ id: 'evt', version: 'v3.0.0', timestamp: 1, payload: { type: 'message', value: { id: 'm1', chat_id: 'u2i-abc', user_id: USER, author_id: 42, created: 1_790_000_000, type: 'text', chat_type: 'u2i', content: { text: 'Здравствуйте' }, direction: 'in', ...value } } });

describe('Авито: разбор сообщений', () => {
  it('текст: имя собеседника, ссылка на профиль; объявление — в первом сообщении чата', () => {
    const chat = avitoChatInfo(chatJson, USER);
    expect(chat).toEqual({ title: 'Иван', link: 'https://www.avito.ru/user/42', item: { title: 'Дверь входная Торекс', url: 'https://www.avito.ru/item/1' } });
    const first = normalizeAvitoMessage(hook({}).payload.value, { userId: USER, chat, firstInChat: true });
    expect(first).toMatchObject({ externalChatId: 'u2i-abc', chatTitle: 'Иван', contact: { link: 'https://www.avito.ru/user/42' }, externalMessageId: 'm1', timestamp: 1_790_000_000, fromMe: false });
    expect(first?.text).toBe('Объявление: «Дверь входная Торекс»\nhttps://www.avito.ru/item/1\n\nЗдравствуйте');
    const next = normalizeAvitoMessage(hook({ id: 'm2' }).payload.value, { userId: USER, chat, firstInChat: false });
    expect(next?.text).toBe('Здравствуйте');
  });

  it('фото — самый крупный размер; исходящее из приложения Авито — fromMe; system и deleted пропускаются', () => {
    const img = normalizeAvitoMessage(hook({ type: 'image', content: { image: { sizes: { '140x105': 'https://i/s.jpg', '1280x960': 'https://i/l.jpg' } } } }).payload.value, { userId: USER });
    expect(img?.attachment).toMatchObject({ kind: 'picture', ref: 'https://i/l.jpg' });
    expect(normalizeAvitoMessage(hook({ author_id: USER, direction: 'out' }).payload.value, { userId: USER })?.fromMe).toBe(true);
    expect(normalizeAvitoMessage({ id: 'm3', chat_id: 'c', author_id: USER, created: 1, type: 'text', content: { text: 'x' } }, { userId: USER })?.fromMe).toBe(true);
    expect(normalizeAvitoMessage(hook({ type: 'system', content: { text: 'x' } }).payload.value, { userId: USER })).toBeNull();
    expect(normalizeAvitoMessage(hook({ type: 'deleted' }).payload.value, { userId: USER })).toBeNull();
    expect(normalizeAvitoMessage(hook({ type: 'voice', content: { voice: { voice_id: 'v9' } } }).payload.value, { userId: USER })?.attachment).toMatchObject({ kind: 'voice', ref: 'voice:v9' });
  });
});

type Call = { url: string; method: string; auth: string | null; body: unknown };
function avitoFetch(calls: Call[], respond: (path: string, call: Call) => Response | unknown): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const headers = new Headers(init?.headers);
    let body: unknown = null;
    if (init?.body instanceof FormData) body = Object.fromEntries(init.body.entries());
    else if (typeof init?.body === 'string') body = init.body.startsWith('{') ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body));
    const call: Call = { url: u.toString(), method: init?.method ?? 'GET', auth: headers.get('authorization'), body };
    calls.push(call);
    const r = respond(u.pathname, call);
    return r instanceof Response ? r : new Response(JSON.stringify(r), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
const noSleep = async () => undefined;
const fastSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5)));
const creds = { clientId: 'cid', clientSecret: 'csecret-0123456789', userId: USER };
const tokenOk = { access_token: 'tok-1', expires_in: 86400, token_type: 'Bearer' };

describe('Авито: токен, отправка, вебхук', () => {
  it('токен client_credentials кэшируется; текст → POST messages с Bearer', async () => {
    const calls: Call[] = [];
    const c = new AvitoConnector(creds, { fetch: avitoFetch(calls, (p) => (p === '/token' ? tokenOk : { id: 'sent-1' })), sleep: noSleep });
    expect((await c.send({ externalChatId: 'u2i-abc', text: 'Добрый день', file: null, replyToExternalId: null })).externalMessageId).toBe('sent-1');
    await c.send({ externalChatId: 'u2i-abc', text: 'Ещё', file: null, replyToExternalId: null });
    expect(calls.filter((x) => x.url.endsWith('/token'))).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ grant_type: 'client_credentials', client_id: 'cid', client_secret: 'csecret-0123456789' });
    expect(calls[1]).toMatchObject({ method: 'POST', auth: 'Bearer tok-1', body: { message: { text: 'Добрый день' }, type: 'text' } });
    expect(calls[1]!.url).toBe(`https://api.avito.ru/messenger/v1/accounts/${USER}/chats/u2i-abc/messages`);
  });

  it('фото: uploadImages → messages/image; файл — постоянная ошибка (Авито принимает только текст и фото)', async () => {
    const calls: Call[] = [];
    const c = new AvitoConnector(creds, { fetch: avitoFetch(calls, (p) => (p === '/token' ? tokenOk : p.endsWith('/uploadImages') ? { 'img-55': { '1280x960': 'https://i/x' } } : { id: 'sent-2' })), sleep: noSleep });
    await c.send({ externalChatId: 'u2i-abc', text: '', file: { data: Buffer.from('jpg'), name: 'a.jpg', mime: 'image/jpeg', kind: 'picture' }, replyToExternalId: null });
    expect(calls.map((x) => new URL(x.url).pathname).slice(1)).toEqual([`/messenger/v1/accounts/${USER}/uploadImages`, `/messenger/v1/accounts/${USER}/chats/u2i-abc/messages/image`]);
    expect(calls[2]!.body).toEqual({ image_id: 'img-55' });
    await expect(c.send({ externalChatId: 'u2i-abc', text: '', file: { data: Buffer.from('x'), name: 'a.pdf', mime: 'application/pdf', kind: 'file' }, replyToExternalId: null })).rejects.toBeInstanceOf(PermanentSendError);
  });

  it('401 на запросе — токен обновляется и запрос повторяется один раз', async () => {
    const calls: Call[] = [];
    let tokens = 0;
    const c = new AvitoConnector(creds, {
      fetch: avitoFetch(calls, (p, call) => (p === '/token' ? { ...tokenOk, access_token: `tok-${++tokens}` } : call.auth === 'Bearer tok-1' ? new Response('{"error":"unauthorized"}', { status: 401 }) : { id: 'ok' })),
      sleep: noSleep,
    });
    expect((await c.send({ externalChatId: 'c', text: 'x', file: null, replyToExternalId: null })).externalMessageId).toBe('ok');
    expect(calls.map((x) => `${new URL(x.url).pathname.split('/').pop()}:${x.auth ?? '-'}`)).toEqual(['token:-', 'messages:Bearer tok-1', 'token:-', 'messages:Bearer tok-2']);
  });

  it('запуск: self → подписка вебхука → connected; вебхук с сообщением → в мост, повтор отсекается мостом', async () => {
    const calls: Call[] = [];
    const f = avitoFetch(calls, (p) => {
      if (p === '/token') return tokenOk;
      if (p === '/core/v1/accounts/self') return { id: USER, name: 'РФ-Двери' };
      if (p === '/messenger/v3/webhook') return { ok: true };
      if (p.endsWith('/chats')) return { chats: [] };
      if (p.endsWith('/chats/u2i-abc')) return chatJson;
      throw new Error(p);
    });
    const got: InboundEvent[] = [];
    const statuses: string[] = [];
    const sink: ConnectorSink = { inbound: async (ev) => void got.push(ev), status: async (s, d) => void statuses.push(`${s}${d ? `:${d}` : ''}`) };
    const c = new AvitoConnector(creds, { fetch: f, webhookUrl: 'https://chat.example.ru/hooks/avito/5/abc', sleep: fastSleep, safetyPollMs: 5 });
    await c.start(sink);
    await new Promise((r) => setTimeout(r, 30));
    expect(statuses[0]).toBe('connected');
    expect(c.webhookActive).toBe(true);
    expect(calls.find((x) => x.url.endsWith('/messenger/v3/webhook'))?.body).toEqual({ url: 'https://chat.example.ru/hooks/avito/5/abc' });
    await c.onWebhook(hook({}));
    await c.onWebhook(hook({ id: 'm2', content: { text: 'Второе' } }));
    await c.stop();
    expect(got.map((e) => e.text)).toEqual(['Объявление: «Дверь входная Торекс»\nhttps://www.avito.ru/item/1\n\nЗдравствуйте', 'Второе']);
    expect(got[0]?.chatTitle).toBe('Иван');
  });

  it('вебхук не подписался — опрос непрочитанных чатов, прочитанными помечаются переданные', async () => {
    const calls: Call[] = [];
    const f = avitoFetch(calls, (p) => {
      if (p === '/token') return tokenOk;
      if (p === '/core/v1/accounts/self') return { id: USER };
      if (p === '/messenger/v3/webhook') return new Response('{"error":{"message":"forbidden"}}', { status: 403 });
      if (p.endsWith('/chats')) return { chats: [chatJson] };
      if (p.endsWith('/messages/')) return { messages: [{ id: 'p1', author_id: 42, created: Math.floor(Date.now() / 1000) - 60, type: 'text', content: { text: 'Из опроса' } }, { id: 'p0', chat_id: 'u2i-abc', author_id: USER, created: 1, type: 'text', content: { text: 'наше' } }] };
      if (p.endsWith('/read')) return { ok: true };
      throw new Error(p);
    });
    const got: InboundEvent[] = [];
    const statuses: string[] = [];
    const c = new AvitoConnector(creds, { fetch: f, webhookUrl: 'https://chat.example.ru/hooks/avito/5/abc', sleep: fastSleep, pollMs: 5 });
    await c.start({ inbound: async (ev) => void got.push(ev), status: async (s, d) => void statuses.push(`${s}:${d}`) });
    await new Promise((r) => setTimeout(r, 30));
    await c.stop();
    expect(statuses[0]).toMatch(/^connected:Без вебхука/);
    expect(got[0]?.text).toContain('Из опроса');
    expect(calls.some((x) => x.url.endsWith('/chats/u2i-abc/read'))).toBe(true);
  });

  it('неверные ключи — статус «Ошибка» с текстом; подключение из виджета сверяет id профиля', async () => {
    const statuses: string[] = [];
    const bad = new AvitoConnector(creds, { fetch: avitoFetch([], () => new Response('{"error":"invalid_client"}', { status: 400 })), sleep: fastSleep, retry: { sleep: noSleep } });
    await bad.start({ inbound: async () => undefined, status: async (s, d) => void statuses.push(`${s}:${d}`) });
    await new Promise((r) => setTimeout(r, 20));
    await bad.stop();
    expect(statuses.at(-1)).toMatch(/^error:Авито не принял client_id/);

    const okFetch = avitoFetch([], (p) => (p === '/token' ? tokenOk : { id: USER, name: 'РФ-Двери' }));
    const v = await validateChannel({ kind: 'avito', clientId: 'cid', clientSecret: 'csecret-0123456789', userId: USER }, { fetch: okFetch });
    expect(v).toMatchObject({ kind: 'avito', title: 'РФ-Двери', externalId: String(USER), credentials: { clientId: 'cid', clientSecret: 'csecret-0123456789', userId: String(USER) } });
    expect(v.credentials.webhookSecret).toMatch(/^[0-9a-f]{48}$/);
    await expect(validateChannel({ kind: 'avito', clientId: 'cid', clientSecret: 'csecret-0123456789', userId: 1 }, { fetch: okFetch })).rejects.toThrow(`другому профилю Авито (id ${USER})`);
    await expect(validateChannel({ kind: 'avito', clientId: 'cid', clientSecret: 'csecret-0123456789', userId: 1 }, { fetch: avitoFetch([], () => new Response('{"error":"invalid_client"}', { status: 400 })) })).rejects.toThrow('Авито не принял client_id');
  });
});
