import { describe, expect, it } from 'vitest';
import { AmoAuthRevokedError, AmoError } from '../src/errors.ts';
import { AmoOAuth } from '../src/oauth.ts';
import { mockFetch } from './helpers.ts';

const cfg = { clientId: 'cid', clientSecret: 'secret', redirectUri: 'https://ai.example.ru/oauth/amo/callback' };
const ok = { token_type: 'Bearer', expires_in: 86400, access_token: 'A1', refresh_token: 'R1' };
const now = new Date('2026-09-24T10:00:00Z');

describe('AmoOAuth', () => {
  it('обменивает код на токены', async () => {
    const f = mockFetch(() => ({ status: 200, body: ok }));
    const oauth = new AmoOAuth({ ...cfg, fetch: f.fn });
    const pair = await oauth.exchangeCode('acc.amocrm.ru', 'CODE', now);

    expect(pair).toEqual({ accessToken: 'A1', refreshToken: 'R1', expiresAt: new Date('2026-09-25T10:00:00Z') });
    expect(f.calls[0]?.url).toBe('https://acc.amocrm.ru/oauth2/access_token');
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({
      client_id: 'cid',
      client_secret: 'secret',
      redirect_uri: cfg.redirectUri,
      grant_type: 'authorization_code',
      code: 'CODE',
    });
  });

  it('обновляет токен', async () => {
    const f = mockFetch(() => ({ status: 200, body: { ...ok, access_token: 'A2', refresh_token: 'R2' } }));
    const pair = await new AmoOAuth({ ...cfg, fetch: f.fn }).refresh('acc.amocrm.ru', 'R1', now);
    expect(pair.refreshToken).toBe('R2');
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'R1' });
  });

  it('отличает отозванный refresh-токен', async () => {
    const f = mockFetch(() => ({ status: 400, body: { hint: 'Token has been revoked' } }));
    await expect(new AmoOAuth({ ...cfg, fetch: f.fn }).refresh('acc.amocrm.ru', 'R1')).rejects.toBeInstanceOf(
      AmoAuthRevokedError,
    );
  });

  it('падает на ошибке сервера и кривом ответе', async () => {
    const f500 = mockFetch(() => ({ status: 502, body: null }));
    await expect(new AmoOAuth({ ...cfg, fetch: f500.fn }).exchangeCode('acc.amocrm.ru', 'C')).rejects.toBeInstanceOf(
      AmoError,
    );
    const bad = mockFetch(() => ({ status: 200, body: { foo: 1 } }));
    await expect(new AmoOAuth({ ...cfg, fetch: bad.fn }).exchangeCode('acc.amocrm.ru', 'C')).rejects.toThrow(
      /формат/,
    );
  });
});
