import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { disposableTokenAudience, verifyDisposableToken } from '../src/disposable-token.ts';

const secret = 'client-secret-0123456789';
const clientId = '8b4f5e3a-2c1d-4e5f-9a8b-7c6d5e4f3a2b';
const audience = disposableTokenAudience('https://ai.example.ru/oauth/amo/callback');

function sign(claims: Record<string, unknown>, opts: { key?: string; aud?: string; exp?: string; alg?: string } = {}) {
  return new SignJWT({
    subdomain: 'aleksnevedrov',
    account_id: 123,
    user_id: 45,
    client_uuid: clientId,
    is_admin: true,
    ...claims,
  })
    .setProtectedHeader({ alg: opts.alg ?? 'HS256' })
    .setJti('jti-1')
    .setIssuer('https://aleksnevedrov.amocrm.ru')
    .setAudience(opts.aud ?? audience)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '30m')
    .sign(new TextEncoder().encode(opts.key ?? secret));
}

const verify = (t: string) => verifyDisposableToken(t, { clientSecret: secret, clientId, audience });

describe('verifyDisposableToken', () => {
  it('принимает корректный токен', async () => {
    expect(audience).toBe('https://ai.example.ru');
    await expect(verify(await sign({}))).resolves.toEqual({
      tokenId: 'jti-1',
      accountId: 123,
      userId: 45,
      subdomain: 'aleksnevedrov',
      accountDomain: 'aleksnevedrov.amocrm.ru',
      isAdmin: true,
    });
  });

  it('отклоняет чужую подпись', async () => {
    await expect(verify(await sign({}, { key: 'another-secret-xxxxxxxx' }))).rejects.toThrow();
  });

  it('отклоняет другого адресата', async () => {
    await expect(verify(await sign({}, { aud: 'https://evil.example' }))).rejects.toThrow();
  });

  it('отклоняет истёкший токен', async () => {
    await expect(verify(await sign({}, { exp: '-5m' }))).rejects.toThrow();
  });

  it('отклоняет токен другой интеграции', async () => {
    await expect(verify(await sign({ client_uuid: 'other' }))).rejects.toThrow(/другой интеграции/);
  });

  it('отклоняет другой алгоритм', async () => {
    await expect(verify(await sign({}, { alg: 'HS512' }))).rejects.toThrow();
  });
});
