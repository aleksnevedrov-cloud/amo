import { describe, expect, it } from 'vitest';
import { normalizeTelegramUpdate, splitText, TelegramBotConnector } from '../src/connectors/telegram-bot.ts';
import { PermanentSendError, reconnectDelayMs, type ConnectorSink, type InboundEvent } from '../src/connectors/types.ts';

const from = { id: 42, is_bot: false, first_name: 'Иван', last_name: 'Петров', username: 'ivan' };

describe('разбор обновлений Telegram-бота', () => {
  it('личное текстовое сообщение', () => {
    const ev = normalizeTelegramUpdate({ update_id: 1, message: { message_id: 7, date: 100, chat: { id: 42, type: 'private' }, from, text: 'Привет' } });
    expect(ev).toMatchObject({
      externalChatId: '42',
      chatTitle: 'Иван Петров',
      isGroup: false,
      author: null,
      externalMessageId: '7',
      text: 'Привет',
      attachment: null,
      contact: { username: 'ivan', link: 'https://t.me/ivan' },
      fromMe: false,
    });
  });

  it('фото с подписью — самый крупный размер; ответ с цитатой', () => {
    const ev = normalizeTelegramUpdate({
      update_id: 2,
      message: {
        message_id: 8,
        date: 100,
        chat: { id: 42, type: 'private' },
        from,
        caption: 'Вот такую',
        photo: [{ file_id: 'small', file_size: 10 }, { file_id: 'big', file_size: 900 }],
        reply_to_message: { message_id: 5 },
      },
    });
    expect(ev?.attachment).toMatchObject({ kind: 'picture', ref: 'big' });
    expect(ev?.text).toBe('Вот такую');
    expect(ev?.replyToExternalId).toBe('5');
  });

  it('группа: чат — группа, автор — участник; голосовое', () => {
    const ev = normalizeTelegramUpdate({
      update_id: 3,
      message: { message_id: 9, date: 100, chat: { id: -100500, type: 'supergroup', title: 'Объект на Ленина' }, from, voice: { file_id: 'v1', mime_type: 'audio/ogg' } },
    });
    expect(ev).toMatchObject({ externalChatId: '-100500', chatTitle: 'Объект на Ленина', isGroup: true, author: { id: '42', name: 'Иван Петров' } });
    expect(ev?.attachment).toMatchObject({ kind: 'voice', ref: 'v1', mime: 'audio/ogg' });
  });

  it('пропускает ботов, каналы, правки и служебные события', () => {
    expect(normalizeTelegramUpdate({ update_id: 4, message: { message_id: 1, chat: { id: 1, type: 'private' }, from: { ...from, is_bot: true }, text: 'x' } })).toBeNull();
    expect(normalizeTelegramUpdate({ update_id: 5, message: { message_id: 1, chat: { id: 1, type: 'channel' }, from, text: 'x' } })).toBeNull();
    expect(normalizeTelegramUpdate({ update_id: 6, edited_message: { message_id: 1 } })).toBeNull();
    expect(normalizeTelegramUpdate({ update_id: 7, message: { message_id: 1, chat: { id: 1, type: 'private' }, from, new_chat_members: [] } })).toBeNull();
  });
});

describe('переподключение и длинные тексты', () => {
  it('пауза растёт экспоненциально, не меньше 30 с и не больше 10 мин', () => {
    expect(reconnectDelayMs(0)).toBe(30_000);
    expect(reconnectDelayMs(1)).toBe(30_000);
    expect(reconnectDelayMs(2)).toBe(60_000);
    expect(reconnectDelayMs(20)).toBe(600_000);
  });

  it('делит текст по лимиту, предпочитая перевод строки', () => {
    const t = `${'а'.repeat(60)}\n${'б'.repeat(60)}`;
    expect(splitText(t, 100)).toEqual(['а'.repeat(60), 'б'.repeat(60)]);
    expect(splitText('в'.repeat(250), 100).map((p) => p.length)).toEqual([100, 100, 50]);
    expect(splitText('коротко', 100)).toEqual(['коротко']);
  });
});

type Call = { method: string; body: unknown };
function botFetch(calls: Call[], respond: (method: string, body: unknown) => unknown): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const method = String(input).split('/').pop()!;
    const body = init?.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(String(init?.body ?? '{}'));
    calls.push({ method, body });
    return new Response(JSON.stringify(respond(method, body)), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('отправка через Bot API', () => {
  it('текст с цитатой → sendMessage с reply_parameters', async () => {
    const calls: Call[] = [];
    const c = new TelegramBotConnector('123:abc', { fetch: botFetch(calls, () => ({ ok: true, result: { message_id: 77 } })) });
    const r = await c.send({ externalChatId: '42', text: 'Цена 15 000 ₽', file: null, replyToExternalId: '5' });
    expect(r.externalMessageId).toBe('77');
    expect(calls[0]).toEqual({
      method: 'sendMessage',
      body: { chat_id: '42', text: 'Цена 15 000 ₽', reply_parameters: { message_id: 5, allow_sending_without_reply: true } },
    });
  });

  it('фото → sendPhoto multipart с подписью', async () => {
    const calls: Call[] = [];
    const c = new TelegramBotConnector('123:abc', { fetch: botFetch(calls, () => ({ ok: true, result: { message_id: 78 } })) });
    await c.send({ externalChatId: '42', text: 'Каталог', file: { data: Buffer.from('jpg'), name: 'a.jpg', mime: 'image/jpeg', kind: 'picture' }, replyToExternalId: null });
    expect(calls[0]?.method).toBe('sendPhoto');
    expect(calls[0]?.body).toMatchObject({ chat_id: '42', caption: 'Каталог' });
  });

  it('403 (клиент заблокировал бота) — ошибка без повторов', async () => {
    const c = new TelegramBotConnector('123:abc', {
      fetch: botFetch([], () => ({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' })),
    });
    await expect(c.send({ externalChatId: '42', text: 'x', file: null, replyToExternalId: null })).rejects.toBeInstanceOf(PermanentSendError);
  });

  it('polling: передаёт сообщения, при 401 ставит ошибку и останавливается', async () => {
    let n = 0;
    const calls: Call[] = [];
    const fetchFn = botFetch(calls, (method) => {
      if (method !== 'getUpdates') return { ok: true, result: true };
      n++;
      if (n === 1) return { ok: true, result: [{ update_id: 10, message: { message_id: 1, date: 1, chat: { id: 42, type: 'private' }, from, text: 'Добрый день' } }] };
      return { ok: false, error_code: 401, description: 'Unauthorized' };
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
    const c = new TelegramBotConnector('123:abc', { fetch: fetchFn });
    await c.start(sink);
    await finished;
    await c.stop();
    expect(got.map((e) => e.text)).toEqual(['Добрый день']);
    expect(statuses[0]).toBe('connected');
    expect(statuses[1]).toMatch(/^error:Токен бота недействителен/);
    // Второй запрос подтверждает первое обновление.
    expect((calls[1]?.body as { offset: number }).offset).toBe(11);
  });
});
