import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AmojoClient } from '../src/amojo/client.ts';
import { signAmojoRequest, verifyAmojoHook } from '../src/amojo/signature.ts';
import { amojoFetch, type AmojoCall } from './helpers.ts';

describe('подпись API чатов amo', () => {
  it('строит X-Signature по METHOD, Content-MD5, Content-Type, Date, path', () => {
    const body = '{"a":1}';
    const date = 'Tue, 03 Nov 2026 10:00:00 GMT';
    const h = signAmojoRequest('secret', { method: 'post', path: '/v2/origin/custom/scope', body, date });
    const md5 = createHash('md5').update(body).digest('hex');
    expect(h['Content-MD5']).toBe(md5);
    const expected = createHmac('sha1', 'secret')
      .update(['POST', md5, 'application/json', date, '/v2/origin/custom/scope'].join('\n'))
      .digest('hex');
    expect(h['X-Signature']).toBe(expected);
    expect(h.Date).toBe(date);
  });

  it('проверяет подпись вебхука: верная, неверная, отсутствует, другой длины', () => {
    const raw = Buffer.from('{"message":{}}');
    const good = createHmac('sha1', 'secret').update(raw).digest('hex');
    expect(verifyAmojoHook('secret', raw, good)).toBe(true);
    expect(verifyAmojoHook('secret', raw, good.toUpperCase())).toBe(true);
    expect(verifyAmojoHook('other', raw, good)).toBe(false);
    expect(verifyAmojoHook('secret', raw, undefined)).toBe(false);
    expect(verifyAmojoHook('secret', raw, good.slice(0, 20))).toBe(false);
  });

  it('клиент подписывает запрос и передаёт scope_id при подключении', async () => {
    const calls: AmojoCall[] = [];
    const now = new Date('2026-11-03T10:00:00Z');
    const c = new AmojoClient({ baseUrl: 'https://amojo.amocrm.ru', channelId: 'chan-1', secret: 's3', fetch: amojoFetch(calls), now: () => now });
    expect(await c.connect('6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b', 'РФ-Мессенджер')).toEqual({ scopeId: 'scope-xyz' });
    const call = calls[0]!;
    expect(call.path).toBe('/v2/origin/custom/chan-1/connect');
    expect(call.body).toEqual({ account_id: '6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b', title: 'РФ-Мессенджер', hook_api_version: 'v2' });
    const raw = JSON.stringify(call.body);
    const expected = signAmojoRequest('s3', { method: 'POST', path: call.path, body: raw, date: now.toUTCString() });
    expect(call.headers.get('x-signature')).toBe(expected['X-Signature']);
    expect(call.headers.get('date')).toBe(now.toUTCString());
  });
});
