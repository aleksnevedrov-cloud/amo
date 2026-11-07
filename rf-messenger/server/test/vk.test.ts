import { describe, expect, it } from 'vitest';
import { validateChannel } from '../src/channels.ts';
import { PermanentSendError, type ConnectorSink, type InboundEvent } from '../src/connectors/types.ts';
import { normalizeVkUpdate, VkConnector } from '../src/connectors/vk.ts';

const upd = (message: Record<string, unknown>) => ({ type: 'message_new', object: { message: { id: 15, date: 1_790_000_000, peer_id: 42, from_id: 42, text: '', conversation_message_id: 3, ...message }, client_info: {} }, group_id: 1 });

describe('VK: разбор событий Long Poll', () => {
  it('личное сообщение: имя из справочника, ссылка на профиль, id сообщения', () => {
    expect(normalizeVkUpdate(upd({ text: 'Привет' }), { userName: () => 'Иван Петров' })).toMatchObject({
      externalChatId: '42',
      chatTitle: 'Иван Петров',
      contact: { link: 'https://vk.com/id42' },
      externalMessageId: '15',
      text: 'Привет',
      timestamp: 1_790_000_000,
      fromMe: false,
    });
  });

  it('фото — самый крупный размер; документ; голосовое ogg; видео — ссылкой', () => {
    const photo = normalizeVkUpdate(upd({ attachments: [{ type: 'photo', photo: { sizes: [{ url: 'https://s/1.jpg', width: 10, height: 10 }, { url: 'https://s/2.jpg', width: 100, height: 100 }] } }] }));
    expect(photo?.attachment).toMatchObject({ kind: 'picture', ref: 'https://s/2.jpg' });
    const doc = normalizeVkUpdate(upd({ attachments: [{ type: 'doc', doc: { title: 'смета.pdf', url: 'https://d/x', size: 99 } }] }));
    expect(doc?.attachment).toMatchObject({ kind: 'file', name: 'смета.pdf', size: 99 });
    const voice = normalizeVkUpdate(upd({ attachments: [{ type: 'audio_message', audio_message: { link_ogg: 'https://v/x.ogg' } }] }));
    expect(voice?.attachment).toMatchObject({ kind: 'voice', mime: 'audio/ogg' });
    const video = normalizeVkUpdate(upd({ attachments: [{ type: 'video', video: { owner_id: 42, id: 7 } }] }));
    expect(video?.text).toBe('[Видео] https://vk.com/video42_7');
  });

  it('ответ с цитатой; беседа — автор; события не message_new и от сообщества пропускаются', () => {
    expect(normalizeVkUpdate(upd({ text: 'x', reply_message: { id: 12 } }))?.replyToExternalId).toBe('12');
    expect(normalizeVkUpdate(upd({ text: 'x', reply_message: { id: 0, conversation_message_id: 5 } }))?.replyToExternalId).toBe('cmid:5');
    const g = normalizeVkUpdate(upd({ peer_id: 2_000_000_001, text: 'x' }), { userName: () => 'Ольга', groupTitle: () => 'Объект' });
    expect(g).toMatchObject({ isGroup: true, chatTitle: 'Объект', author: { id: '42', name: 'Ольга' } });
    expect(normalizeVkUpdate({ type: 'message_reply', object: {} })).toBeNull();
    expect(normalizeVkUpdate(upd({ from_id: -1, text: 'x' }))).toBeNull();
    expect(normalizeVkUpdate(upd({}))).toBeNull();
  });
});

type Call = { url: string; params: Record<string, string> | Record<string, unknown> };
const vkJson = (response: unknown) => ({ response });
const vkErr = (code: number) => ({ error: { error_code: code, error_msg: `e${code}` } });
function vkFetch(calls: Call[], respond: (method: string, params: Record<string, string>, url: URL) => unknown | Promise<unknown>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const params = typeof init?.body === 'string' ? Object.fromEntries(new URLSearchParams(init.body)) : init?.body instanceof FormData ? Object.fromEntries(init.body.entries()) : {};
    calls.push({ url: u.toString(), params });
    const method = u.pathname.replace('/method/', '');
    const r = await respond(method, params as Record<string, string>, u);
    return r instanceof Response ? r : new Response(JSON.stringify(r), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
const noSleep = async () => undefined;
/** Пауза коннектора между попытками: короткая, но ненулевая, чтобы цикл не крутился вхолостую. */
const fastSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5)));

describe('VK: отправка и подключение', () => {
  it('messages.send с random_id, reply_to и ключом в теле; ключ не в адресе', async () => {
    const calls: Call[] = [];
    const c = new VkConnector('vk-secret-key', 1, { fetch: vkFetch(calls, () => vkJson(501)), sleep: noSleep, random: () => 0.5 });
    const r = await c.send({ externalChatId: '42', text: 'Цена 15 000 ₽', file: null, replyToExternalId: '15' });
    expect(r.externalMessageId).toBe('501');
    expect(calls[0]!.url).toBe('https://api.vk.com/method/messages.send');
    expect(calls[0]!.params).toMatchObject({ v: '5.199', access_token: 'vk-secret-key', peer_id: '42', message: 'Цена 15 000 ₽', reply_to: '15', random_id: String(Math.floor(0.5 * 2_147_483_647)) });
  });

  it('фото: сервер загрузки → multipart → saveMessagesPhoto → attachment', async () => {
    const calls: Call[] = [];
    const f = vkFetch(calls, (method, params, url) => {
      if (method === 'photos.getMessagesUploadServer') return vkJson({ upload_url: 'https://pu.vk.com/upload' });
      if (url.hostname === 'pu.vk.com') return { server: 1, photo: '[{"x":1}]', hash: 'h' };
      if (method === 'photos.saveMessagesPhoto') return vkJson([{ id: 9, owner_id: 42, access_key: 'ak' }]);
      if (method === 'messages.send') {
        expect(params.attachment).toBe('photo42_9_ak');
        return vkJson(600);
      }
      throw new Error(method);
    });
    const c = new VkConnector('t', 1, { fetch: f, sleep: noSleep });
    await c.send({ externalChatId: '42', text: 'Каталог', file: { data: Buffer.from('jpg'), name: 'a.jpg', mime: 'image/jpeg', kind: 'picture' }, replyToExternalId: null });
    expect(calls.map((x) => new URL(x.url).pathname)).toEqual(['/method/photos.getMessagesUploadServer', '/upload', '/method/photos.saveMessagesPhoto', '/method/messages.send']);
  });

  it('901 (клиент запретил сообщения) — постоянная ошибка; 6 и 10 — повтор', async () => {
    const denied = new VkConnector('t', 1, { fetch: vkFetch([], () => vkErr(901)), sleep: noSleep });
    await expect(denied.send({ externalChatId: '42', text: 'x', file: null, replyToExternalId: null })).rejects.toBeInstanceOf(PermanentSendError);
    let n = 0;
    const calls: Call[] = [];
    const flaky = new VkConnector('t', 1, { fetch: vkFetch(calls, () => (n++ === 0 ? vkErr(6) : n === 2 ? vkErr(10) : vkJson(7))), retry: { sleep: noSleep }, sleep: noSleep });
    expect((await flaky.send({ externalChatId: '42', text: 'x', file: null, replyToExternalId: null })).externalMessageId).toBe('7');
    expect(calls).toHaveLength(3);
    // random_id одинаков во всех попытках: VK не создаст дубль.
    expect(new Set(calls.map((x) => (x.params as Record<string, string>).random_id)).size).toBe(1);
  });

  it('Long Poll: ключ и сервер, обработка событий, failed=2 — новый сервер; код 5 — ошибка ключа', async () => {
    let poll = 0;
    const calls: Call[] = [];
    const f = vkFetch(calls, (method, _p, url) => {
      if (method === 'groups.setLongPollSettings') return vkJson(1);
      if (method === 'groups.getLongPollServer') return vkJson({ server: 'https://lp.vk.com/wh1', key: 'k', ts: '10' });
      if (method === 'users.get') return vkJson([{ id: 42, first_name: 'Иван', last_name: 'Петров' }]);
      if (url.hostname === 'lp.vk.com') {
        poll++;
        if (poll === 1) return { ts: '11', updates: [upd({ text: 'Добрый день' })] };
        if (poll === 2) return { failed: 2 };
        // Как настоящий Long Poll: ждём, пока нет событий.
        return new Promise((r) => setTimeout(() => r({ ts: '12', updates: [] }), 20));
      }
      throw new Error(method);
    });
    const got: InboundEvent[] = [];
    let after = 0;
    const sink: ConnectorSink = { inbound: async (ev) => void got.push(ev), status: async () => undefined };
    const c = new VkConnector('t', 1, { fetch: f, sleep: noSleep });
    await c.start(sink);
    await new Promise<void>((r) => {
      const t = setInterval(() => {
        if (calls.filter((x) => x.url.includes('getLongPollServer')).length >= 2 && ++after > 1) {
          clearInterval(t);
          r();
        }
      }, 5);
    });
    await c.stop();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ chatTitle: 'Иван Петров', text: 'Добрый день' });
    const lp = calls.filter((x) => x.url.includes('lp.vk.com'));
    expect(new URL(lp[1]!.url).searchParams.get('ts')).toBe('11');

    const statuses: string[] = [];
    const bad = new VkConnector('t', 1, { fetch: vkFetch([], () => vkErr(5)), sleep: fastSleep });
    await bad.start({ inbound: async () => undefined, status: async (s, d) => void statuses.push(`${s}:${d}`) });
    await new Promise((r) => setTimeout(r, 20));
    await bad.stop();
    expect(statuses.at(-1)).toMatch(/^error:VK не принял ключ/);
  });

  it('подключение из виджета: ключ сверяется с id сообщества, нет прав — подсказка', async () => {
    const ok = await validateChannel({ kind: 'vk', token: 'v'.repeat(40), groupId: 123 }, { fetch: vkFetch([], () => vkJson({ groups: [{ id: 123, name: 'РФ-Двери', screen_name: 'rfdveri' }] })) });
    expect(ok).toEqual({ kind: 'vk', title: 'РФ-Двери', externalId: '123', credentials: { token: 'v'.repeat(40), groupId: '123' } });
    await expect(validateChannel({ kind: 'vk', token: 'v'.repeat(40), groupId: 5 }, { fetch: vkFetch([], () => vkJson([{ id: 123, name: 'x' }])) })).rejects.toThrow('другому сообществу (id 123)');
    await expect(validateChannel({ kind: 'vk', token: 'v'.repeat(40), groupId: 5 }, { fetch: vkFetch([], () => vkErr(27)) })).rejects.toThrow('VK не принял ключ');
    await expect(validateChannel({ kind: 'vk', token: 'v'.repeat(40), groupId: 5 }, { fetch: vkFetch([], () => vkErr(15)) })).rejects.toThrow(/нужен ключ сообщества с правами/);
  });
});
