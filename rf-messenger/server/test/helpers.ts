import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { AmojoClient } from '../src/amojo/client.ts';
import { Bridge, type Logger } from '../src/bridge.ts';
import { loadEnv } from '../src/config.ts';
import type { Connector, InboundEvent, OutboundRequest } from '../src/connectors/types.ts';
import { SecretBox } from '../src/crypto.ts';
import { createPool, migrate, type Db } from '../src/db.ts';
import { FileStore } from '../src/files.ts';
import type { JobData, JobName, JobQueue, Pacer } from '../src/queue.ts';
import { Store } from '../src/store.ts';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://aidoor:aidoor@localhost:5432/aidoor_test';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';
export const CLIENT_ID = '0c9f1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
export const CLIENT_SECRET = 'test-widget-secret-0123456789abcdef';
export const CHANNEL_SECRET = 'test-amojo-channel-secret';
export const PUBLIC_URL = 'https://chat.example.ru';
export const ACCOUNT = 31337;

/** Отдельная схема на каждый тестовый файл. */
export async function freshDb(): Promise<{ db: Db; drop: () => Promise<void> }> {
  const schema = `rfm_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const url = new URL(TEST_DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const db = createPool(url.toString());
  await migrate(db);
  return {
    db,
    drop: async () => {
      await db.end();
      const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await c.connect();
      await c.query(`DROP SCHEMA ${schema} CASCADE`);
      await c.end();
    },
  };
}

export function testEnv(extra: Record<string, string> = {}) {
  return loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    PUBLIC_URL,
    DATABASE_URL: 'postgres://unused:unused@localhost/unused',
    REDIS_URL: TEST_REDIS_URL,
    AMO_CLIENT_ID: CLIENT_ID,
    AMO_CLIENT_SECRET: CLIENT_SECRET,
    AMOJO_CHANNEL_ID: 'chan-1',
    AMOJO_CHANNEL_SECRET: CHANNEL_SECRET,
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    FILE_URL_SECRET: randomBytes(32).toString('hex'),
    ...extra,
  });
}

export const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export class MemoryQueue implements JobQueue {
  jobs: { name: JobName; data: JobData; jobId: string; delay?: number }[] = [];
  async add(name: JobName, data: JobData, opts: { jobId: string; delay?: number }) {
    if (this.jobs.some((j) => j.jobId === opts.jobId)) return; // как BullMQ: jobId уникален
    this.jobs.push({ name, data, ...opts });
  }
}

export class FakeConnector implements Connector {
  sent: OutboundRequest[] = [];
  typed: string[] = [];
  failWith: Error | null = null;
  files = new Map<string, Buffer>();
  async start() {}
  async stop() {}
  async typing(id: string) {
    this.typed.push(id);
  }
  async send(req: OutboundRequest) {
    if (this.failWith) throw this.failWith;
    this.sent.push(req);
    return { externalMessageId: String(1000 + this.sent.length) };
  }
  async download(ref: string) {
    const data = this.files.get(ref);
    if (!data) throw new Error('нет файла');
    return { data, mime: 'image/jpeg' };
  }
}

export interface AmojoCall {
  path: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/** Заглушка API чатов amo: записывает вызовы, отвечает как amojo. */
export function amojoFetch(calls: AmojoCall[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ path: url.pathname, headers: new Headers(init?.headers), body });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('/connect')) return json({ account_id: body.account_id, scope_id: 'scope-xyz', title: body.title });
    if (url.pathname.endsWith('/delivery_status')) return json({});
    const payload = body.payload as { msgid: string };
    return json({ new_message: { msgid: `amo-${payload.msgid}`, chat_id: 'amo-chat-1', conversation_id: 'x' } });
  }) as typeof fetch;
}

export async function setupBridge(opts: { amoFetch?: typeof fetch; connected?: boolean } = {}) {
  const { db, drop } = await freshDb();
  const store = new Store(db);
  const env = testEnv();
  const files = new FileStore(store, {
    dir: await mkdtemp(join(tmpdir(), 'rfm-files-')),
    secret: env.FILE_URL_SECRET,
    publicUrl: PUBLIC_URL,
    ttlDays: 30,
    maxBytes: 1024 * 1024,
  });
  const calls: AmojoCall[] = [];
  const amojo = new AmojoClient({ baseUrl: 'https://amojo.amocrm.ru', channelId: 'chan-1', secret: CHANNEL_SECRET, fetch: amojoFetch(calls) });
  const queue = new MemoryQueue();
  const pacer: Pacer = { reserve: async () => 1500 };
  const connector = new FakeConnector();
  const box = new SecretBox(env.ENCRYPTION_KEY);
  const channel = (await store.createChannel({
    accountId: ACCOUNT,
    kind: 'telegram_bot',
    title: '@door_bot',
    externalId: '555',
    credentials: box.encrypt(JSON.stringify({ token: 'x' })),
  }))!;
  if (opts.connected !== false) await store.saveConnection(ACCOUNT, '6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b', 'scope-xyz');
  const bridge = new Bridge({
    store,
    files,
    amojo,
    queue,
    pacer,
    connector: (id) => (id === channel.id ? connector : undefined),
    amoDomains: ['amocrm.ru'],
    log: silent,
    ...(opts.amoFetch ? { fetch: opts.amoFetch, resolve: async () => ['93.184.216.34'] } : {}),
  });
  return { db, drop, store, env, files, calls, amojo, queue, connector, channel, bridge, box };
}

export function event(over: Partial<InboundEvent> = {}): InboundEvent {
  return {
    externalChatId: '42',
    chatTitle: 'Иван Петров',
    isGroup: false,
    contact: { username: 'ivan', link: 'https://t.me/ivan' },
    author: null,
    externalMessageId: '1',
    text: 'Здравствуйте, сколько стоит дверь?',
    attachment: null,
    replyToExternalId: null,
    timestamp: 1_790_000_000,
    fromMe: false,
    ...over,
  };
}
