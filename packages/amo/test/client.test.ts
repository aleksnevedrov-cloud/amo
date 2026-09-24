import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { AmoApiClient, fieldValues } from '../src/client.ts';
import { continueBot, isSafeReturnUrl, verifyBotToken } from '../src/salesbot.ts';

function scripted(responses: { status: number; body?: unknown }[]) {
  const calls: { url: string; method: string; body: unknown; auth: string | null }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init?.headers).get('authorization'),
    });
    const r = responses.shift() ?? { status: 200, body: {} };
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status });
  }) as typeof fetch;
  return { fn, calls };
}

const client = (f: typeof fetch) => new AmoApiClient('acc.amocrm.ru', async () => 'TOKEN', f, async () => undefined);

describe('AmoApiClient', () => {
  it('получает сделку с контактами, 404 → null', async () => {
    const s = scripted([{ status: 200, body: { id: 5, name: 'Сделка' } }, { status: 404 }]);
    expect(await client(s.fn).getLead(5)).toMatchObject({ id: 5 });
    expect(await client(s.fn).getLead(6)).toBeNull();
    expect(s.calls[0]).toMatchObject({ url: 'https://acc.amocrm.ru/api/v4/leads/5?with=contacts', auth: 'Bearer TOKEN' });
  });

  it('повторяет запрос при 429', async () => {
    const s = scripted([{ status: 429 }, { status: 429 }, { status: 200, body: { id: 1, name: 'x', subdomain: 'acc' } }]);
    expect(await client(s.fn).getAccount()).toMatchObject({ id: 1 });
    expect(s.calls).toHaveLength(3);
  });

  it('204 на пустой список событий', async () => {
    const s = scripted([{ status: 204 }]);
    expect(await client(s.fn).getOutgoingChatEvents(5, new Date(1_700_000_000_000))).toEqual([]);
    const url = new URL(s.calls[0]!.url);
    expect(url.searchParams.get('filter[type]')).toBe('outgoing_chat_message');
    expect(url.searchParams.get('filter[created_at][from]')).toBe('1700000000');
  });

  it('создаёт примечание, задачу и меняет этап', async () => {
    const s = scripted([
      { status: 200, body: { _embedded: { notes: [{ id: 11 }] } } },
      { status: 200, body: { _embedded: { tasks: [{ id: 22 }] } } },
      { status: 200, body: {} },
    ]);
    const c = client(s.fn);
    expect(await c.addLeadNote(5, 'Резюме')).toBe(11);
    expect(await c.createTask({ text: 'Связаться', completeTill: new Date(1_700_000_000_000), leadId: 5, taskTypeId: 1 })).toBe(22);
    await c.setLeadStatus(5, 777);
    expect(s.calls[0]).toMatchObject({ method: 'POST', body: [{ note_type: 'common', params: { text: 'Резюме' } }] });
    expect(s.calls[1]?.body).toEqual([
      { text: 'Связаться', complete_till: 1_700_000_000, entity_id: 5, entity_type: 'leads', task_type_id: 1 },
    ]);
    expect(s.calls[2]).toMatchObject({ method: 'PATCH', body: { status_id: 777 } });
  });

  it('ошибка сервера пробрасывается', async () => {
    const s = scripted([{ status: 500 }]);
    await expect(client(s.fn).addLeadNote(1, 'x')).rejects.toThrow(/HTTP 500/);
  });

  it('fieldValues по коду поля', () => {
    const fields = [{ field_id: 1, field_code: 'PHONE', values: [{ value: '+79161234567' }] }];
    expect(fieldValues(fields, 'PHONE')).toEqual(['+79161234567']);
    expect(fieldValues(null, 'EMAIL')).toEqual([]);
  });
});

describe('Salesbot', () => {
  const secret = 'client-secret-0123456789abcdef';
  const sign = (alg: string, key = secret, claims: Record<string, unknown> = { account_id: 31337, subdomain: 'acc' }) =>
    new SignJWT(claims).setProtectedHeader({ alg }).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(key));

  it('принимает токен HS512 и отвергает остальные', async () => {
    await expect(verifyBotToken(await sign('HS512'), { clientSecret: secret })).resolves.toMatchObject({ accountId: 31337 });
    await expect(verifyBotToken(await sign('HS256'), { clientSecret: secret })).rejects.toThrow();
    await expect(verifyBotToken(await sign('HS512', 'x'.repeat(32)), { clientSecret: secret })).rejects.toThrow();
    await expect(verifyBotToken(await sign('HS512', secret, {}), { clientSecret: secret })).rejects.toThrow(/account_id/);
  });

  it('return_url только на домен аккаунта по https', () => {
    expect(isSafeReturnUrl('https://acc.amocrm.ru/api/v4/salesbot/1/continue/2', 'acc.amocrm.ru')).toBe(true);
    expect(isSafeReturnUrl('https://evil.com/continue', 'acc.amocrm.ru')).toBe(false);
    expect(isSafeReturnUrl('http://acc.amocrm.ru/x', 'acc.amocrm.ru')).toBe(false);
  });

  it('continue отправляет сообщения через show', async () => {
    const s = scripted([{ status: 200 }]);
    await continueBot('https://acc.amocrm.ru/c', 'TOKEN', ['Привет', 'Вот модели'], s.fn);
    expect(s.calls[0]).toMatchObject({
      auth: 'Bearer TOKEN',
      body: {
        data: { status: 'success' },
        execute_handlers: [
          { handler: 'show', params: { type: 'text', value: 'Привет' } },
          { handler: 'show', params: { type: 'text', value: 'Вот модели' } },
        ],
      },
    });
  });
});
