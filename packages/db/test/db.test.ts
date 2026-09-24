import { randomBytes } from 'node:crypto';
import { AmoOAuth, TokenService } from '@ai-door/amo';
import { SecretBox } from '@ai-door/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountsRepo, migrate, PgTokenStore, SettingsRepo, type Db } from '../src/index.ts';
import { freshDb } from './setup.ts';

let db: Db;
let drop: () => Promise<void>;
const box = new SecretBox(randomBytes(32).toString('hex'));
const HOUR = 3600_000;

beforeAll(async () => {
  ({ db, drop } = await freshDb());
});
afterAll(async () => drop());

async function installAccount(id: number, expiresAt: Date) {
  await new AccountsRepo(db).upsertInstalled({ id, subdomain: `acc${id}`, accountDomain: `acc${id}.amocrm.ru` });
  await new PgTokenStore(db, box).put(id, { accessToken: 'A1', refreshToken: 'R1', expiresAt });
}

function countingOAuth(opts: { fail?: number; delayMs?: number } = {}) {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, opts.delayMs ?? 0));
    if (opts.fail) return new Response('{}', { status: opts.fail });
    return new Response(
      JSON.stringify({ token_type: 'Bearer', expires_in: 86400, access_token: `A${calls + 1}`, refresh_token: `R${calls + 1}` }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { oauth: new AmoOAuth({ clientId: 'c', clientSecret: 's', redirectUri: 'https://x.ru/cb', fetch: fetchImpl }), calls: () => calls };
}

describe('миграции', () => {
  it('повторный запуск ничего не применяет', async () => {
    await expect(migrate(db)).resolves.toEqual([]);
  });
});

describe('PgTokenStore', () => {
  it('хранит токены в зашифрованном виде', async () => {
    await installAccount(1, new Date(Date.now() + 20 * HOUR));
    const { rows } = await db.query('SELECT access_token_enc, refresh_token_enc FROM amo_tokens WHERE account_id = 1');
    expect(rows[0].access_token_enc).not.toContain('A1');
    expect(rows[0].refresh_token_enc).not.toContain('R1');
  });

  it('параллельные запросы из разных соединений обновляют токен один раз', async () => {
    await installAccount(2, new Date(Date.now() + 1 * HOUR));
    const o = countingOAuth({ delayMs: 50 });
    const svc = new TokenService(new PgTokenStore(db, box), o.oauth, 6 * HOUR);
    const tokens = await Promise.all(Array.from({ length: 5 }, () => svc.getAccessToken(2)));
    expect(new Set(tokens)).toEqual(new Set(['A2']));
    expect(o.calls()).toBe(1);
    const status = await new PgTokenStore(db, box).status(2);
    expect(status?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * HOUR);
  });

  it('ошибку обновления сохраняет без дедлока и не портит токены', async () => {
    await installAccount(3, new Date(Date.now() + 1 * HOUR));
    const store = new PgTokenStore(db, box);
    const svc = new TokenService(store, countingOAuth({ fail: 401 }).oauth, 6 * HOUR);
    await expect(svc.getAccessToken(3)).rejects.toThrow();
    const status = await store.status(3);
    expect(status?.lastError).toMatch(/401/);
    await store.withLock(3, async (cur) => expect(cur?.refreshToken).toBe('R1'));
  });

  it('listExpiring пропускает свежие и удалённые аккаунты', async () => {
    await installAccount(4, new Date(Date.now() + 1 * HOUR));
    await new AccountsRepo(db).markUninstalled(4);
    const ids = await new PgTokenStore(db, box).listExpiring(new Date(Date.now() + 6 * HOUR));
    expect(ids).not.toContain(1);
    expect(ids).not.toContain(4);
  });
});

describe('AccountsRepo', () => {
  it('деинсталляция удаляет токены, повторная установка снимает отметку', async () => {
    const repo = new AccountsRepo(db);
    await installAccount(5, new Date(Date.now() + 20 * HOUR));
    await repo.markUninstalled(5);
    expect((await repo.get(5))?.uninstalledAt).toBeInstanceOf(Date);
    expect(await new PgTokenStore(db, box).status(5)).toBeNull();
    await repo.upsertInstalled({ id: 5, subdomain: 'acc5', accountDomain: 'acc5.amocrm.ru' });
    expect((await repo.get(5))?.uninstalledAt).toBeNull();
  });
});

describe('SettingsRepo', () => {
  it('возвращает значения по умолчанию, сохраняет и пишет аудит', async () => {
    await installAccount(6, new Date(Date.now() + 20 * HOUR));
    const repo = new SettingsRepo(db);
    expect(await repo.get(6)).toEqual({ settings: { enabled: false, mode: 'off' }, version: 0 });

    await repo.save(6, 100, { enabled: true, mode: 'off' });
    const { version } = await repo.save(6, 101, { enabled: true, mode: 'auto' });
    expect(version).toBe(2);
    expect((await repo.get(6)).settings.mode).toBe('auto');

    const { rows } = await db.query('SELECT user_id, before, after FROM settings_audit WHERE account_id = 6 ORDER BY id');
    expect(rows).toHaveLength(2);
    expect(rows[0].before).toBeNull();
    expect(Number(rows[1].user_id)).toBe(101);
    expect(rows[1].before).toEqual({ enabled: true, mode: 'off' });
  });
});
