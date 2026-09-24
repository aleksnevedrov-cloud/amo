import { describe, expect, it, vi } from 'vitest';
import { AmoOAuth, type TokenPair } from '../src/oauth.ts';
import { TokenService, type StoredTokens, type TokenStore } from '../src/token-service.ts';
import { mockFetch } from './helpers.ts';

const HOUR = 3600_000;
const now = new Date('2026-09-24T10:00:00Z');

function memoryStore(initial: StoredTokens | null) {
  let current = initial;
  let chain = Promise.resolve();
  const errors: string[] = [];
  const store: TokenStore = {
    // Сериализация, как у SELECT ... FOR UPDATE.
    withLock(_id, fn) {
      const run = chain.then(() =>
        fn(current, async (t: TokenPair) => {
          current = current && { ...current, ...t };
        }),
      );
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    markError: async (_id, e) => {
      errors.push(e);
    },
    listExpiring: async (before) => (current && current.expiresAt < before ? [current.accountId] : []),
  };
  return { store, errors, get: () => current };
}

const stored = (expiresInMs: number): StoredTokens => ({
  accountId: 1,
  accountDomain: 'acc.amocrm.ru',
  accessToken: 'A1',
  refreshToken: 'R1',
  expiresAt: new Date(now.getTime() + expiresInMs),
});

function oauthReturning(n = { i: 0 }) {
  return mockFetch(() => {
    n.i += 1;
    return { status: 200, body: { token_type: 'Bearer', expires_in: 86400, access_token: `A${n.i + 1}`, refresh_token: `R${n.i + 1}` } };
  });
}

const oauthCfg = { clientId: 'c', clientSecret: 's', redirectUri: 'https://x.ru/cb' };

describe('TokenService', () => {
  it('отдаёт текущий токен, если он ещё свежий', async () => {
    const m = memoryStore(stored(20 * HOUR));
    const f = oauthReturning();
    const svc = new TokenService(m.store, new AmoOAuth({ ...oauthCfg, fetch: f.fn }), 6 * HOUR, undefined, () => now);
    await expect(svc.getAccessToken(1)).resolves.toBe('A1');
    expect(f.calls).toHaveLength(0);
  });

  it('обновляет токен, близкий к истечению, и сохраняет новую пару', async () => {
    const m = memoryStore(stored(1 * HOUR));
    const f = oauthReturning();
    const svc = new TokenService(m.store, new AmoOAuth({ ...oauthCfg, fetch: f.fn }), 6 * HOUR, undefined, () => now);
    await expect(svc.getAccessToken(1)).resolves.toBe('A2');
    expect(m.get()?.refreshToken).toBe('R2');
  });

  it('параллельные запросы обновляют токен ровно один раз', async () => {
    const m = memoryStore(stored(1 * HOUR));
    const f = oauthReturning();
    const svc = new TokenService(m.store, new AmoOAuth({ ...oauthCfg, fetch: f.fn }), 6 * HOUR, undefined, () => now);
    const tokens = await Promise.all([svc.getAccessToken(1), svc.getAccessToken(1), svc.getAccessToken(1)]);
    expect(tokens).toEqual(['A2', 'A2', 'A2']);
    expect(f.calls).toHaveLength(1);
  });

  it('при отзыве токена пишет ошибку и шлёт алерт', async () => {
    const m = memoryStore(stored(1 * HOUR));
    const f = mockFetch(() => ({ status: 401, body: {} }));
    const alerter = { alert: vi.fn(async () => undefined) };
    const svc = new TokenService(m.store, new AmoOAuth({ ...oauthCfg, fetch: f.fn }), 6 * HOUR, alerter, () => now);
    await expect(svc.getAccessToken(1)).rejects.toThrow();
    expect(m.errors).toHaveLength(1);
    expect(alerter.alert).toHaveBeenCalledWith(expect.stringContaining('повторная авторизация'));
  });

  it('плановое обновление берёт только истекающие токены', async () => {
    const m = memoryStore(stored(1 * HOUR));
    const svc = new TokenService(m.store, new AmoOAuth({ ...oauthCfg, fetch: oauthReturning().fn }), 6 * HOUR, undefined, () => now);
    await expect(svc.refreshExpiring()).resolves.toEqual({ refreshed: [1], failed: [] });
  });
});
