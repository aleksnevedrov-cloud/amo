import { Redis } from 'ioredis';
import { AmoRest } from './amo/rest.ts';
import { AmojoClient } from './amojo/client.ts';
import type { Env } from './config.ts';
import { SecretBox } from './crypto.ts';
import { createPool } from './db.ts';
import { FileStore } from './files.ts';
import { Store } from './store.ts';

/** Общие зависимости обоих процессов. */
export function createCore(env: Env) {
  const db = createPool(env.DATABASE_URL);
  const store = new Store(db);
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const files = new FileStore(store, {
    dir: env.FILES_DIR,
    secret: env.FILE_URL_SECRET,
    publicUrl: env.PUBLIC_URL,
    ttlDays: env.FILE_URL_TTL_DAYS,
    maxBytes: env.MAX_FILE_MB * 1024 * 1024,
  });
  const amojo =
    env.AMOJO_CHANNEL_ID && env.AMOJO_CHANNEL_SECRET
      ? new AmojoClient({ baseUrl: env.AMOJO_BASE_URL, channelId: env.AMOJO_CHANNEL_ID, secret: env.AMOJO_CHANNEL_SECRET })
      : null;
  const box = new SecretBox(env.ENCRYPTION_KEY);
  const rest = new AmoRest(db, box, {
    clientId: env.AMO_CLIENT_ID,
    clientSecret: env.AMO_CLIENT_SECRET,
    // Адрес перенаправления интеграции — корень сайта (https://chat.rf-dveri.ru/).
    redirectUri: new URL('/', env.PUBLIC_URL).toString(),
    allowedDomains: env.AMO_ALLOWED_DOMAINS,
  });
  return { db, store, redis, files, amojo, box, rest };
}
