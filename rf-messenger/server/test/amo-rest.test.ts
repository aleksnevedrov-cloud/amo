import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmoRest, amoHost } from '../src/amo/rest.ts';
import { SecretBox } from '../src/crypto.ts';
import { freshDb } from './helpers.ts';

let db: Awaited<ReturnType<typeof freshDb>>;
let calls: { url: string; init?: RequestInit }[];
let tokenN: number;
const box = new SecretBox(randomBytes(32).toString('hex'));

/** Заглушка amo: выдача и обновление токенов, аккаунт, пользователь, контакт, привязка чатов. */
const amoFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  calls.push({ url, ...(init ? { init } : {}) });
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/oauth2/access_token')) {
    const body = JSON.parse(String(init?.body)) as { grant_type: string; refresh_token?: string };
    if (body.grant_type === 'refresh_token' && body.refresh_token === 'revoked') return json({}, 400);
    tokenN += 1;
    return json({ access_token: `access-${tokenN}`, refresh_token: `refresh-${tokenN}`, expires_in: tokenN === 1 ? 60 : 86400 });
  }
  if (url.endsWith('/api/v4/account')) return json({ id: 31337 });
  if (url.includes('/api/v4/users/7')) return json({ id: 7, amojo_id: 'amojo-user-7' });
  if (url.includes('/api/v4/leads/100')) return json({ id: 100, _embedded: { contacts: [{ id: 2, is_main: false }, { id: 1, is_main: true }] } });
  if (url.includes('/api/v4/contacts/chats?')) return json(url.includes('linked') ? { _embedded: { chats: [{ contact_id: 1 }] } } : {});
  if (url.endsWith('/api/v4/contacts/chats')) return json({ _total_items: 1 });
  const m = /\/api\/v4\/contacts\/(\d+)$/.exec(url);
  if (m) return json({ id: Number(m[1]), name: `Контакт ${m[1]}`, custom_fields_values: [{ field_code: 'PHONE', values: [{ value: '+7 936 147-23-24' }, { value: '+7 936 147-23-24' }] }] });
  return json({}, 404);
}) as typeof fetch;

const rest = () =>
  new AmoRest(db.db, box, { clientId: 'cid', clientSecret: 'secret', redirectUri: 'https://chat.example.ru/', allowedDomains: ['amocrm.ru'], fetch: amoFetch });

beforeEach(async () => {
  db = await freshDb();
  calls = [];
  tokenN = 0;
});
afterEach(async () => {
  await db.drop();
});

describe('REST amoCRM (OAuth интеграции)', () => {
  it('домен аккаунта — только из allowlist amo: секрет интеграции не уходит на чужой сервер', () => {
    expect(amoHost('rfdveri.amocrm.ru', ['amocrm.ru'])).toBe('rfdveri.amocrm.ru');
    expect(amoHost('https://RFDVERI.amocrm.ru/', ['amocrm.ru'])).toBe('rfdveri.amocrm.ru');
    expect(amoHost('evil.com', ['amocrm.ru'])).toBeNull();
    expect(amoHost('amocrm.ru.evil.com', ['amocrm.ru'])).toBeNull();
    expect(amoHost('a.amocrm.ru@evil.com', ['amocrm.ru'])).toBeNull();
  });

  it('код → токены зашифрованы в БД; аккаунт — из ответа amo; чужой аккаунт отклоняется', async () => {
    const r = rest();
    await expect(r.exchangeCode('evil.com', 'code', () => true)).rejects.toThrow(/домен/);
    await expect(r.exchangeCode('rfdveri.amocrm.ru', 'code', (id) => id === 1)).rejects.toThrow(/не подключён/);
    expect(await r.connected(31337)).toBe(false);
    expect(await r.exchangeCode('rfdveri.amocrm.ru', 'code', () => true)).toBe(31337);
    expect(await r.connected(31337)).toBe(true);
    const row = (await db.db.query('SELECT * FROM amo_oauth')).rows[0];
    expect(row.access_token).not.toContain('access-');
    expect(row.refresh_token).not.toContain('refresh-');
    const tokenCall = calls.find((c) => c.url.endsWith('/oauth2/access_token'))!;
    expect(JSON.parse(String(tokenCall.init?.body))).toMatchObject({ client_id: 'cid', grant_type: 'authorization_code', redirect_uri: 'https://chat.example.ru/' });
  });

  it('истекающий токен обновляется перед запросом; сотрудник, контакты сделки (основной первым), телефоны без повторов', async () => {
    const r = rest();
    await r.exchangeCode('rfdveri.amocrm.ru', 'code', () => true); // токен на 60 с — меньше запаса в 5 минут
    expect(await r.userAmojoId(31337, 7)).toBe('amojo-user-7');
    const refresh = calls.filter((c) => c.url.endsWith('/oauth2/access_token'));
    expect(refresh).toHaveLength(2);
    expect(JSON.parse(String(refresh[1]!.init?.body))).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'refresh-1' });
    const user = calls.find((c) => c.url.includes('/api/v4/users/7'))!;
    expect(new Headers(user.init?.headers).get('authorization')).toBe('Bearer access-2');

    const contacts = await r.leadContacts(31337, 100);
    expect(contacts.map((c) => c.id)).toEqual([1, 2]);
    expect(contacts[0]).toEqual({ id: 1, name: 'Контакт 1', phones: ['+7 936 147-23-24'] });
  });

  it('без авторизации и с отозванным доступом — понятная ошибка', async () => {
    await expect(rest().userAmojoId(31337, 7)).rejects.toThrow(/не авторизована/);
    await db.db.query(
      `INSERT INTO amo_oauth (account_id, base_domain, access_token, refresh_token, expires_at) VALUES (31337, 'rfdveri.amocrm.ru', $1, $2, now())`,
      [box.encrypt('old'), box.encrypt('revoked')],
    );
    await expect(rest().userAmojoId(31337, 7)).rejects.toThrow(/истёк/);
  });

  it('привязка чата к контакту: без повтора, если уже привязан', async () => {
    const r = rest();
    await r.exchangeCode('rfdveri.amocrm.ru', 'code', () => true);
    await r.linkChat(31337, 'chat-a', 1);
    expect(calls.filter((c) => c.url.endsWith('/api/v4/contacts/chats') && c.init?.method === 'POST')).toHaveLength(1);
    await r.linkChat(31337, 'linked', 1);
    expect(calls.filter((c) => c.url.endsWith('/api/v4/contacts/chats') && c.init?.method === 'POST')).toHaveLength(1);
    await expect(r.linkChat(31337, 'linked', 2)).rejects.toThrow(/другому контакту/);
  });
});
