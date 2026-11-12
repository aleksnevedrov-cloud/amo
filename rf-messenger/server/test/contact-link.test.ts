/* eslint-disable @typescript-eslint/no-explicit-any -- в тестах разбираем произвольный JSON запросов к amo */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chooseContact, exactPhoneMatches, phoneTail, phoneTail4, type ContactCandidate } from '../src/amo/contact-match.ts';
import { AmoRest, RateLimiter, type AmoRest as AmoRestType } from '../src/amo/rest.ts';
import { Bridge, type Logger } from '../src/bridge.ts';
import { ACCOUNT, event, setupBridge } from './helpers.ts';

const cand = (over: Partial<ContactCandidate>): ContactCandidate => ({ id: 1, name: 'Иван', phones: ['+7 936 147-23-24'], updatedAt: 100, leads: [], ...over });

describe('подбор контакта по номеру (чистые функции)', () => {
  it('точное совпадение последних 10 цифр; нечёткие совпадения query отбрасываются', () => {
    expect(phoneTail('+7 (936) 147-23-24')).toBe('9361472324');
    expect(phoneTail('8 936 147 23 24')).toBe('9361472324');
    expect(phoneTail('12345')).toBeNull();
    expect(phoneTail4('+79361472324')).toBe('…2324');
    const list = [cand({ id: 1, phones: ['+79361472324'] }), cand({ id: 2, phones: ['79361472325'] }), cand({ id: 3, phones: ['8 (936) 147-23-24', '+79990000000'] }), cand({ id: 4, phones: [] })];
    expect(exactPhoneMatches(list, '+7 936 147-23-24').map((c) => c.id)).toEqual([1, 3]);
    expect(exactPhoneMatches(list, '147-23')).toEqual([]);
  });

  it('выбор: один контакт; несколько — с самой свежей открытой сделкой; без открытых — самый свежий контакт', () => {
    expect(chooseContact([])).toBeNull();
    expect(chooseContact([cand({ id: 7 })])?.contact.id).toBe(7);
    const a = cand({ id: 1, updatedAt: 500, leads: [{ id: 11, statusId: 142, updatedAt: 900 }] }); // только закрытые
    const b = cand({ id: 2, updatedAt: 100, leads: [{ id: 22, statusId: 50, updatedAt: 300 }] });
    const c = cand({ id: 3, updatedAt: 200, leads: [{ id: 33, statusId: 51, updatedAt: 400 }, { id: 34, statusId: 143, updatedAt: 999 }] });
    const pick = chooseContact([a, b, c]);
    expect(pick?.contact.id).toBe(3);
    expect(pick?.reason).toContain('#33');
    const noOpen = chooseContact([a, cand({ id: 9, updatedAt: 450 })]);
    expect(noOpen?.contact.id).toBe(1);
    expect(noOpen?.reason).toContain('без открытых сделок');
  });

  it('ограничитель: не больше 7 запросов в секунду, очередь в порядке обращения', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const rl = new RateLimiter(7, () => now, async (ms) => void (sleeps.push(ms), (now += ms)));
    for (let i = 0; i < 7; i++) await rl.acquire();
    expect(sleeps).toEqual([]);
    await rl.acquire();
    expect(sleeps).toEqual([1000]);
    now += 2000;
    await rl.acquire();
    expect(sleeps).toEqual([1000]);
  });
});

/** REST amoCRM: поиск контактов по номеру, сделки, привязка. */
function restStub(contacts: ContactCandidate[], opts: { calls?: string[]; fail?: Error; delayMs?: number } = {}): AmoRestType {
  return {
    contactsByPhone: async (_a: number, phone: string) => {
      opts.calls?.push(`search:${phone}`);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.fail) throw opts.fail;
      return contacts;
    },
    linkChat: async (_a: number, chatId: string, contactId: number) => void opts.calls?.push(`link:${chatId}:${contactId}`),
    contact: async (_a: number, id: number) => ({ id, name: 'Из сделки', phones: [] }),
    userAmojoId: async () => 'op-1',
    userName: async () => 'Мария',
  } as unknown as AmoRestType;
}

let t: Awaited<ReturnType<typeof setupBridge>>;
let lines: { level: string; msg: string; obj: Record<string, unknown> }[];
let log: Logger;
beforeEach(async () => {
  t = await setupBridge();
  lines = [];
  log = {
    info: (o, m) => void lines.push({ level: 'info', msg: m ?? '', obj: o as Record<string, unknown> }),
    warn: (o, m) => void lines.push({ level: 'warn', msg: m ?? '', obj: o as Record<string, unknown> }),
    error: (o, m) => void lines.push({ level: 'error', msg: m ?? '', obj: o as Record<string, unknown> }),
  };
  await t.store.setChannelStatus(t.channel.id, 'connected');
  await t.store.saveConnection(ACCOUNT, '6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b', 'scope-xyz');
  await t.db.query('UPDATE amojo_connections SET amo_operator_ref = $1', ['amojo-op-9']);
});
afterEach(async () => {
  await t.drop();
});

const amoPaths = () => t.calls.map((c) => c.path.replace('/v2/origin/custom/scope-xyz', ''));
const PHONE = '+79361472324';

describe('привязка нового чата к контакту amoCRM по номеру', () => {
  it('один контакт: createChat → linkChat → сообщение; телефон в профиле; повторно не ищется', async () => {
    const calls: string[] = [];
    const bridge = new Bridge({ ...t.bridgeDeps, log, rest: restStub([cand({ id: 65167009 })], { calls }) });
    await bridge.onInbound(t.channel, t.connector, event({ externalMessageId: '1', contact: { phone: PHONE } }));
    await bridge.deliverToAmo(t.queue.jobs[0]!.data.messageId);
    expect(amoPaths()).toEqual(['/chats', '']);
    expect(calls).toEqual([`search:${PHONE}`, 'link:amo-chat-rfm-' + t.channel.id + '-' + (await t.store.chatById((await t.store.messageById(t.queue.jobs[0]!.data.messageId))!.chatId))!.conversationId.split('-').slice(2).join('-') + ':65167009']);
    const payload = t.calls.at(-1)!.body.payload as any;
    expect(payload.sender.profile).toEqual({ phone: PHONE });
    expect(lines.find((l) => l.msg.includes('привязан'))?.obj).toMatchObject({ contactId: 65167009, phone: '…2324' });
    expect(JSON.stringify(lines)).not.toContain('9361472324');
    // Второе сообщение того же чата — без поиска и без createChat.
    await bridge.onInbound(t.channel, t.connector, event({ externalMessageId: '2', contact: { phone: PHONE } }));
    await bridge.deliverToAmo(t.queue.jobs[1]!.data.messageId);
    expect(calls.filter((c) => c.startsWith('search:'))).toHaveLength(1);
    expect(amoPaths().filter((p) => p === '/chats')).toHaveLength(1);
  });

  it('несколько контактов: выбирается с открытой сделкой; выбор — в журнале', async () => {
    const calls: string[] = [];
    const list = [cand({ id: 1, updatedAt: 900, leads: [{ id: 11, statusId: 143, updatedAt: 999 }] }), cand({ id: 2, updatedAt: 100, leads: [{ id: 22, statusId: 50, updatedAt: 300 }] })];
    const bridge = new Bridge({ ...t.bridgeDeps, log, rest: restStub(list, { calls }) });
    await bridge.onInbound(t.channel, t.connector, event({ contact: { phone: PHONE } }));
    await bridge.deliverToAmo(t.queue.jobs[0]!.data.messageId);
    expect(calls.at(-1)).toMatch(/^link:.*:2$/);
    expect(lines.find((l) => l.msg.includes('привязан'))?.obj.reason).toContain('открытой сделкой #22');
  });

  it('контакт не найден или совпадение нечёткое → как сейчас: без createChat, телефон в профиле', async () => {
    const calls: string[] = [];
    const bridge = new Bridge({ ...t.bridgeDeps, log, rest: restStub([cand({ id: 5, phones: ['+79361472399'] })], { calls }) });
    await bridge.onInbound(t.channel, t.connector, event({ contact: { phone: PHONE } }));
    await bridge.deliverToAmo(t.queue.jobs[0]!.data.messageId);
    expect(amoPaths()).toEqual(['']);
    expect(calls).toEqual([`search:${PHONE}`]);
    expect((t.calls.at(-1)!.body.payload as any).sender.profile).toEqual({ phone: PHONE });
  });

  it('номер неизвестен или группа → поиска нет', async () => {
    const calls: string[] = [];
    const bridge = new Bridge({ ...t.bridgeDeps, log, rest: restStub([cand({})], { calls }) });
    await bridge.onInbound(t.channel, t.connector, event({ externalChatId: 'tg-1', contact: { username: 'ivan' } }));
    await bridge.onInbound(t.channel, t.connector, event({ externalChatId: '-100', isGroup: true, chatTitle: 'Объект', author: { id: '7', name: 'Ольга' }, contact: {} }));
    for (const j of t.queue.jobs) await bridge.deliverToAmo(j.data.messageId);
    expect(calls).toEqual([]);
    expect(amoPaths()).toEqual(['', '']);
  });

  it('сбой и таймаут поиска: сообщение доставлено, в журнале предупреждение', async () => {
    const failing = new Bridge({ ...t.bridgeDeps, log, rest: restStub([cand({})], { fail: new Error('amoCRM 502') }) });
    await failing.onInbound(t.channel, t.connector, event({ externalMessageId: '1', contact: { phone: PHONE } }));
    await failing.deliverToAmo(t.queue.jobs[0]!.data.messageId);
    expect(amoPaths()).toEqual(['']);
    expect(lines.some((l) => l.level === 'warn' && l.msg.includes('поиск контакта') && l.obj.err === 'amoCRM 502')).toBe(true);
    expect((await t.store.messageById(t.queue.jobs[0]!.data.messageId))?.status).toBe('synced');

    const slow = new Bridge({ ...t.bridgeDeps, log, rest: restStub([cand({})], { delayMs: 200 }), contactLookupTimeoutMs: 20 });
    await slow.onInbound(t.channel, t.connector, event({ externalChatId: '43', externalMessageId: '2', contact: { phone: '+79361472399' } }));
    await slow.deliverToAmo(t.queue.jobs[1]!.data.messageId);
    expect(amoPaths()).toEqual(['', '']);
    expect(lines.some((l) => l.level === 'warn' && String(l.obj.err).includes('поиск контакта: нет ответа'))).toBe(true);
  });

  it('гонка: исходящее с телефона и быстрый ответ клиента — привязка одна, порядок сохранён', async () => {
    const calls: string[] = [];
    const bridge = new Bridge({ ...t.bridgeDeps, log, rest: restStub([cand({ id: 65167009 })], { calls, delayMs: 30 }) });
    await bridge.onInbound(t.channel, t.connector, event({ externalMessageId: 'out-1', text: 'Здравствуйте, это РФ-Двери', fromMe: true, contact: { phone: PHONE } }));
    await bridge.onInbound(t.channel, t.connector, event({ externalMessageId: 'in-1', text: 'Да, слушаю', contact: { phone: PHONE } }));
    await Promise.all(t.queue.jobs.map((j) => bridge.deliverToAmo(j.data.messageId)));
    expect(calls.filter((c) => c.startsWith('search:'))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith('link:'))).toHaveLength(1);
    expect(amoPaths()).toEqual(['/chats', '', '']);
    const texts = t.calls.filter((c) => c.path === '/v2/origin/custom/scope-xyz').map((c) => (c.body.payload as any).message.text);
    expect(texts).toEqual(['Здравствуйте, это РФ-Двери', 'Да, слушаю']);
  });

  it('«Написать» из сделки: привязка к контакту сделки, поиска по номеру нет', async () => {
    const calls: string[] = [];
    const bridge = new Bridge({ ...t.bridgeDeps, log, rest: restStub([cand({ id: 65167009 })], { calls }) });
    t.connector.phones.set(PHONE, '42');
    await bridge.startChat({ accountId: ACCOUNT, userId: 5, channelId: t.channel.id, contactId: 777, phone: PHONE, text: 'Добрый день' });
    expect(calls.filter((c) => c.startsWith('search:'))).toEqual([]);
    expect(calls.find((c) => c.startsWith('link:'))).toMatch(/:777$/);
    // Ответ клиента в этот чат — повторной привязки нет.
    await bridge.onInbound(t.channel, t.connector, event({ externalMessageId: 'r1', contact: { phone: PHONE } }));
    await bridge.deliverToAmo(t.queue.jobs.at(-1)!.data.messageId);
    expect(calls.filter((c) => c.startsWith('search:'))).toEqual([]);
    expect(amoPaths().filter((p) => p === '/chats')).toHaveLength(1);
  });

  it('кэш: один номер в двух чатах за 10 минут — один поиск', async () => {
    const calls: string[] = [];
    const bridge = new Bridge({ ...t.bridgeDeps, log, rest: restStub([cand({ id: 1 })], { calls }) });
    await bridge.onInbound(t.channel, t.connector, event({ externalChatId: 'a', contact: { phone: PHONE } }));
    await bridge.onInbound(t.channel, t.connector, event({ externalChatId: 'b', contact: { phone: '8 936 147 23 24' } }));
    for (const j of t.queue.jobs) await bridge.deliverToAmo(j.data.messageId);
    expect(calls.filter((c) => c.startsWith('search:'))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith('link:'))).toHaveLength(2);
  });
});

describe('REST: contactsByPhone', () => {
  it('query по 10 цифрам, точная фильтрация по PHONE, сделки одним запросом', async () => {
    const urls: string[] = [];
    const f = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      urls.push(u.pathname + u.search);
      if (u.pathname === '/api/v4/contacts')
        return new Response(
          JSON.stringify({
            _embedded: {
              contacts: [
                { id: 1, name: 'Точный', updated_at: 10, custom_fields_values: [{ field_code: 'PHONE', values: [{ value: '+7 (936) 147-23-24' }] }], _embedded: { leads: [{ id: 11 }] } },
                { id: 2, name: 'Нечёткий', updated_at: 20, custom_fields_values: [{ field_code: 'PHONE', values: [{ value: '+79361472325' }] }], _embedded: { leads: [{ id: 22 }] } },
              ],
            },
          }),
        );
      if (u.pathname === '/api/v4/leads') return new Response(JSON.stringify({ _embedded: { leads: [{ id: 11, status_id: 142, updated_at: 500 }] } }));
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const rest = new AmoRest(t.db, t.box, { clientId: 'c', clientSecret: 's', redirectUri: 'https://x/', allowedDomains: ['amocrm.ru'], fetch: f });
    await t.db.query('INSERT INTO amo_oauth (account_id, base_domain, access_token, refresh_token, expires_at) VALUES ($1, $2, $3, $4, now() + interval \'1 day\')', [ACCOUNT, 'x.amocrm.ru', t.box.encrypt('a'), t.box.encrypt('r')]);
    const r = await rest.contactsByPhone(ACCOUNT, PHONE);
    expect(urls[0]).toBe('/api/v4/contacts?query=9361472324&with=leads&limit=50');
    expect(urls[1]).toBe('/api/v4/leads?filter[id][]=11&limit=50');
    expect(r).toEqual([{ id: 1, name: 'Точный', phones: ['+7 (936) 147-23-24'], updatedAt: 10, leads: [{ id: 11, statusId: 142, updatedAt: 500 }] }]);
    expect(AmoRest.isOpenLead(142)).toBe(false);
    expect(AmoRest.isOpenLead(50)).toBe(true);
  });
});
