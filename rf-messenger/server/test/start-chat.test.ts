/* eslint-disable @typescript-eslint/no-explicit-any -- в тестах разбираем произвольный JSON запросов к amo */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AmoRest } from '../src/amo/rest.ts';
import { StartChatError } from '../src/bridge.ts';
import { ACCOUNT, event, setupBridge } from './helpers.ts';

/** Заглушка REST amoCRM: контакт, amojo_id сотрудника, привязка чата. */
function fakeRest() {
  const links: { chatId: string; contactId: number }[] = [];
  const rest = {
    contact: async (_a: number, id: number) => ({ id, name: 'Иван', phones: ['+7 936 147-23-24'] }),
    userAmojoId: async (_a: number, userId: number) => `amo-user-${userId}`,
    linkChat: async (_a: number, chatId: string, contactId: number) => void links.push({ chatId, contactId }),
  };
  return { rest: rest as unknown as AmoRest, links };
}

let t: Awaited<ReturnType<typeof setupBridge>>;
let r: ReturnType<typeof fakeRest>;
beforeEach(async () => {
  t = await setupBridge();
  r = fakeRest();
  (t.bridgeDeps as { rest?: AmoRest }).rest = r.rest;
  await t.store.setChannelStatus(t.channel.id, 'connected', null);
});
afterEach(async () => {
  await t.drop();
});

const input = (over: Record<string, unknown> = {}) => ({ accountId: ACCOUNT, userId: 7, channelId: t.channel.id, contactId: 555, phone: '8 (936) 147-23-24', text: 'Добрый день!', ...over });

describe('написать первым', () => {
  it('новый номер: чат в мессенджере → чат amo → привязка к контакту → сообщение клиенту и в amo от сотрудника', async () => {
    t.connector.phones.set('+79361472324', 'u:42:99');
    const res = await t.bridge.startChat(input());
    expect(t.connector.sent).toEqual([{ externalChatId: 'u:42:99', text: 'Добрый день!', file: null, replyToExternalId: null }]);

    const chat = await t.store.chatById(res.chatId);
    expect(chat).toMatchObject({ externalChatId: 'u:42:99', title: 'Иван', contact: { phone: '+79361472324' }, amoOperatorRef: 'amo-user-7' });
    const create = t.calls.find((c) => c.path.endsWith('/chats'))!;
    expect(create.body).toMatchObject({ conversation_id: chat!.conversationId, user: { id: `${chat!.conversationId}-c`, name: 'Иван', profile: { phone: '+79361472324' } } });
    expect(r.links).toEqual([{ chatId: `amo-chat-${chat!.conversationId}`, contactId: 555 }]);

    const p = t.calls.at(-1)!.body.payload as Record<string, any>;
    expect(p.sender).toEqual({ ref_id: 'amo-user-7' });
    expect(p.receiver.id).toBe(`${chat!.conversationId}-c`);
    expect(p.message).toEqual({ type: 'text', text: 'Добрый день!' });
    expect(p.silent).toBe(true);
    expect((await t.store.messageById(res.messageId))?.status).toBe('synced');
  });

  it('клиент уже писал с этого номера — продолжает тот же чат, номер в мессенджере не ищет', async () => {
    await t.bridge.onInbound(t.channel, t.connector, event({ externalChatId: '79361472324@s.whatsapp.net', contact: { phone: '+79361472324' } }));
    const res = await t.bridge.startChat(input());
    const chat = await t.store.chatById(res.chatId);
    expect(chat?.externalChatId).toBe('79361472324@s.whatsapp.net');
    expect(t.connector.sent[0]?.externalChatId).toBe('79361472324@s.whatsapp.net');
  });

  it('понятные ошибки: номера нет в мессенджере, канал не подключён, пустой текст, неверный номер — клиенту ничего не уходит', async () => {
    await expect(t.bridge.startChat(input())).rejects.toThrow(/не найден в мессенджере/);
    await expect(t.bridge.startChat(input({ text: '  ' }))).rejects.toThrow(StartChatError);
    await expect(t.bridge.startChat(input({ phone: '12' }))).rejects.toThrow(/Некорректный номер/);
    await expect(t.bridge.startChat(input({ channelId: 99999 }))).rejects.toThrow(/Канал не найден/);
    await expect(t.bridge.startChat(input({ accountId: 1 }))).rejects.toThrow(/Канал не найден/);
    await t.store.setChannelStatus(t.channel.id, 'no_phone', null);
    t.connector.phones.set('+79361472324', 'u:42:99');
    await expect(t.bridge.startChat(input())).rejects.toThrow(/не подключён/);
    expect(t.connector.sent).toHaveLength(0);
  });
});
