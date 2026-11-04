/* eslint-disable @typescript-eslint/no-explicit-any -- в тестах разбираем произвольный JSON запросов к amo */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PermanentSendError } from '../src/connectors/types.ts';
import { event, setupBridge } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupBridge>>;
beforeEach(async () => {
  t = await setupBridge();
});
afterEach(async () => {
  await t.drop();
});

const hook = (conversationId: string, over: Record<string, unknown> = {}) => ({
  account_id: 'amojo-acc',
  time: 1,
  message: {
    receiver: { id: 'r', client_id: 'c' },
    sender: { id: 'manager', name: 'Менеджер' },
    conversation: { id: 'amo-conv', client_id: conversationId },
    timestamp: 1,
    msec_timestamp: 1000,
    message: { id: 'amo-out-1', type: 'text', text: 'Добрый день! Дверь стоит 15 000 ₽', ...over },
  },
});

describe('канал → amoCRM', () => {
  it('сохраняет входящее, отсекает повтор и передаёт в amo от имени клиента', async () => {
    await t.bridge.onInbound(t.channel, t.connector, event());
    await t.bridge.onInbound(t.channel, t.connector, event()); // повтор того же update
    expect(t.queue.jobs).toHaveLength(1);
    const job = t.queue.jobs[0]!;
    expect(job.name).toBe('to-amo');

    await t.bridge.deliverToAmo(job.data.messageId);
    await t.bridge.deliverToAmo(job.data.messageId); // повтор задачи — без второго вызова amo
    const sends = t.calls.filter((c) => c.path === '/v2/origin/custom/scope-xyz');
    expect(sends).toHaveLength(1);
    const p = sends[0]!.body.payload as Record<string, any>;
    expect(sends[0]!.body.event_type).toBe('new_message');
    expect(p.msgid).toBe(`rfm-m${job.data.messageId}`);
    expect(p.conversation_id).toMatch(/^rfm-\d+-[0-9a-f]{32}$/);
    expect(p.sender).toEqual({ id: `${p.conversation_id}-c`, name: 'Иван Петров', profile_link: 'https://t.me/ivan' });
    expect(p.receiver).toBeUndefined();
    expect(p.message).toEqual({ type: 'text', text: 'Здравствуйте, сколько стоит дверь?' });
    expect(p.silent).toBe(false);
    const msg = await t.store.messageById(job.data.messageId);
    expect(msg?.status).toBe('synced');
    expect(msg?.amojoMsgid).toBe(`amo-rfm-m${job.data.messageId}`);
  });

  it('фото: файл хранится у нас, в amo уходит подписанная ссылка', async () => {
    t.connector.files.set('big', Buffer.from('JPEGDATA'));
    await t.bridge.onInbound(t.channel, t.connector, event({ text: 'Вот такую', attachment: { kind: 'picture', ref: 'big', name: 'photo.jpg', mime: 'image/jpeg' } }));
    await t.bridge.deliverToAmo(t.queue.jobs[0]!.data.messageId);
    const p = t.calls.at(-1)!.body.payload as Record<string, any>;
    expect(p.message).toMatchObject({ type: 'picture', file_name: 'photo.jpg', file_size: 8, text: 'Вот такую' });
    const url = new URL(p.message.media);
    expect(url.origin).toBe('https://chat.example.ru');
    const [, , id] = url.pathname.split('/');
    expect(t.files.verify(id!, url.searchParams.get('e') ?? undefined, url.searchParams.get('s') ?? undefined)).toBe('ok');
    expect((await t.files.read(id!)).toString()).toBe('JPEGDATA');
  });

  it('группа: имя автора в тексте; цитата ссылается на наш msgid', async () => {
    const g = { externalChatId: '-100', isGroup: true, chatTitle: 'Объект', author: { id: '7', name: 'Ольга' } };
    await t.bridge.onInbound(t.channel, t.connector, event({ ...g, externalMessageId: '1', text: 'Первое' }));
    await t.bridge.deliverToAmo(t.queue.jobs[0]!.data.messageId);
    await t.bridge.onInbound(t.channel, t.connector, event({ ...g, externalMessageId: '2', text: 'Ответ', replyToExternalId: '1' }));
    await t.bridge.deliverToAmo(t.queue.jobs[1]!.data.messageId);
    const p = t.calls.at(-1)!.body.payload as Record<string, any>;
    expect(p.sender.name).toBe('Объект');
    expect(p.message).toEqual({ type: 'text', text: 'Ольга: Ответ', reply_to: { message: { msgid: `rfm-m${t.queue.jobs[0]!.data.messageId}` } } });
  });

  it('сообщение с телефона менеджера уходит исходящим: отправитель — менеджер, получатель — клиент', async () => {
    await t.bridge.onInbound(t.channel, t.connector, event({ fromMe: true, text: 'Перезвоню' }));
    await t.bridge.deliverToAmo(t.queue.jobs[0]!.data.messageId);
    const p = t.calls.at(-1)!.body.payload as Record<string, any>;
    expect(p.sender.name).toBe('Менеджер (с телефона)');
    expect(p.receiver.name).toBe('Иван Петров');
    expect(p.silent).toBe(true);
  });

  it('без подключения к amo задача падает и будет повторена', async () => {
    const u = await setupBridge({ connected: false });
    try {
      await u.bridge.onInbound(u.channel, u.connector, event());
      await expect(u.bridge.deliverToAmo(u.queue.jobs[0]!.data.messageId)).rejects.toThrow(/не подключён/);
    } finally {
      await u.drop();
    }
  });
});

describe('amoCRM → канал', () => {
  async function chatConversation() {
    await t.bridge.onInbound(t.channel, t.connector, event());
    await t.bridge.deliverToAmo(t.queue.jobs[0]!.data.messageId);
    return (t.calls.at(-1)!.body.payload as { conversation_id: string }).conversation_id;
  }

  it('ставит в очередь с паузой, отправляет в канал и сообщает «доставлено»', async () => {
    const conv = await chatConversation();
    expect(await t.bridge.onAmoHook(31337, hook(conv))).toBe('queued');
    expect(await t.bridge.onAmoHook(31337, hook(conv))).toBe('duplicate');
    const job = t.queue.jobs.find((j) => j.name === 'to-channel')!;
    expect(job.delay).toBe(1500);
    await t.bridge.deliverToChannel(job.data.messageId, false);
    expect(t.connector.typed).toEqual(['42']);
    expect(t.connector.sent).toEqual([{ externalChatId: '42', text: 'Добрый день! Дверь стоит 15 000 ₽', file: null, replyToExternalId: null }]);
    const st = t.calls.at(-1)!;
    expect(st.path).toBe('/v2/origin/custom/scope-xyz/amo-out-1/delivery_status');
    expect(st.body).toEqual({ msgid: 'amo-out-1', delivery_status: 1 });
    // Повтор задачи не отправляет второй раз.
    await t.bridge.deliverToChannel(job.data.messageId, false);
    expect(t.connector.sent).toHaveLength(1);
  });

  it('чужой аккаунт и неизвестная беседа не обрабатываются', async () => {
    const conv = await chatConversation();
    expect(await t.bridge.onAmoHook(999, hook(conv))).toBe('unknown_chat');
    expect(await t.bridge.onAmoHook(31337, hook('rfm-nope'))).toBe('unknown_chat');
    expect(await t.bridge.onAmoHook(31337, { garbage: true })).toBe('ignored');
  });

  it('ответ с цитатой: id сообщения клиента в канале', async () => {
    const conv = await chatConversation();
    await t.bridge.onAmoHook(31337, hook(conv, { reply_to: { message: { id: `amo-rfm-m${t.queue.jobs[0]!.data.messageId}` } } }));
    await t.bridge.deliverToChannel(t.queue.jobs.at(-1)!.data.messageId, false);
    expect(t.connector.sent[0]?.replyToExternalId).toBe('1');
  });

  it('фото из amo: скачивается только с домена amo и уходит файлом', async () => {
    const amoFetch = (async (input: string | URL | Request) => {
      expect(new URL(String(input)).hostname).toBe('drive-b.amocrm.ru');
      return new Response(Buffer.from('PNG'), { headers: { 'content-type': 'image/png', 'content-length': '3' } });
    }) as typeof fetch;
    const u = await setupBridge({ amoFetch });
    try {
      await u.bridge.onInbound(u.channel, u.connector, event());
      await u.bridge.deliverToAmo(u.queue.jobs[0]!.data.messageId);
      const conv = (u.calls.at(-1)!.body.payload as { conversation_id: string }).conversation_id;
      await u.bridge.onAmoHook(31337, hook(conv, { type: 'picture', text: '', media: 'https://drive-b.amocrm.ru/f/1.png', file_name: 'door.png', file_size: 3 }));
      await u.bridge.deliverToChannel(u.queue.jobs.at(-1)!.data.messageId, false);
      expect(u.connector.sent[0]?.file).toMatchObject({ name: 'door.png', mime: 'image/png', kind: 'picture' });
      expect(u.connector.sent[0]?.file?.data.toString()).toBe('PNG');

      await u.bridge.onAmoHook(31337, hook(conv, { id: 'amo-out-2', type: 'file', media: 'https://evil.example.com/x', file_name: 'x' }));
      await u.bridge.deliverToChannel(u.queue.jobs.at(-1)!.data.messageId, true);
      const failed = await u.store.messageById(u.queue.jobs.at(-1)!.data.messageId);
      expect(failed?.status).toBe('failed');
      expect(failed?.error).toMatch(/не с домена amoCRM/);
    } finally {
      await u.drop();
    }
  });

  it('клиент заблокировал бота — «ошибка» в amo без повторов', async () => {
    const conv = await chatConversation();
    await t.bridge.onAmoHook(31337, hook(conv));
    t.connector.failWith = new PermanentSendError('Клиент заблокировал бота или удалил чат');
    await t.bridge.deliverToChannel(t.queue.jobs.at(-1)!.data.messageId, false);
    const st = t.calls.at(-1)!;
    expect(st.body).toMatchObject({ delivery_status: -1, error_code: 905, error: 'Клиент заблокировал бота или удалил чат' });
  });

  it('временная ошибка — повтор очереди; на последней попытке — «ошибка»', async () => {
    const conv = await chatConversation();
    await t.bridge.onAmoHook(31337, hook(conv));
    const id = t.queue.jobs.at(-1)!.data.messageId;
    t.connector.failWith = new Error('timeout');
    await expect(t.bridge.deliverToChannel(id, false)).rejects.toThrow('timeout');
    expect((await t.store.messageById(id))?.status).toBe('queued');
    await t.bridge.deliverToChannel(id, true);
    expect((await t.store.messageById(id))?.status).toBe('failed');
  });

  it('удалённый канал — сообщение не доставлено', async () => {
    const conv = await chatConversation();
    await t.bridge.onAmoHook(31337, hook(conv));
    await t.store.deleteChannel(31337, t.channel.id);
    await t.bridge.deliverToChannel(t.queue.jobs.at(-1)!.data.messageId, false);
    expect(t.calls.at(-1)!.body).toMatchObject({ delivery_status: -1, error: 'Канал отключён' });
  });

  it('amo вернул 403 — подключение канала сбрасывается, чтобы виджет предложил подключить заново', async () => {
    const { AmojoClient } = await import('../src/amojo/client.ts');
    const { Bridge } = await import('../src/bridge.ts');
    const forbidden = (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch;
    const amojo = new AmojoClient({ baseUrl: 'https://amojo.amocrm.ru', channelId: 'chan-1', secret: 'x', fetch: forbidden });
    const b = new Bridge({ store: t.store, files: t.files, amojo, queue: t.queue, pacer: { reserve: async () => 0 }, connector: () => t.connector, amoDomains: ['amocrm.ru'], log: { info: () => undefined, warn: () => undefined, error: () => undefined } });
    await b.onInbound(t.channel, t.connector, event());
    await expect(b.deliverToAmo(t.queue.jobs[0]!.data.messageId)).rejects.toThrow(/403/);
    expect(await t.store.getConnection(t.channel.accountId)).toBeNull();
  });
});
