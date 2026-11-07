import { setDefaultResultOrder } from 'node:dns';
import { Queue, QueueEvents } from 'bullmq';
import { buildApp } from './api/app.ts';
import { Bridge } from './bridge.ts';
import { loadEnv } from './config.ts';
import { migrate } from './db.ts';
import { createCore } from './deps.ts';
import { chatEventsChannel, parseChatEvent, type ChatEvent } from './events.ts';
import { JOB_OPTIONS, QUEUE_NAME, RedisPacer, START_JOB_OPTIONS, START_QUEUE_NAME, START_WAIT_MS, WEBHOOK_JOB_OPTIONS, WEBHOOK_QUEUE_NAME, type JobQueue, type WebhookJob } from './queue.ts';

// На сервере нет рабочего IPv6: без этого запросы к Telegram/WhatsApp периодически зависают на AAAA-адресах.
setDefaultResultOrder('ipv4first');

/** Процесс api: вебхук amo, API виджета, раздача файлов. Сообщения в каналы отправляет процесс connectors. */
const env = loadEnv();
const core = createCore(env);
await migrate(core.db);
const bull = new Queue(QUEUE_NAME, { connection: core.redis, defaultJobOptions: JOB_OPTIONS });
const queue: JobQueue = { add: async (name, data, opts) => void (await bull.add(name, data, opts)) };
const bridge = new Bridge({
  store: core.store,
  files: core.files,
  amojo: core.amojo,
  queue,
  pacer: new RedisPacer(core.redis, env.OUTBOUND_PAUSE_MIN_MS, env.OUTBOUND_PAUSE_MAX_MS),
  connector: () => undefined,
  amoDomains: env.AMO_ALLOWED_DOMAINS,
  log: { info: () => undefined, warn: () => undefined, error: () => undefined },
});
const startQueue = new Queue(START_QUEUE_NAME, { connection: core.redis, defaultJobOptions: START_JOB_OPTIONS });
const startEvents = new QueueEvents(START_QUEUE_NAME, { connection: core.redis.duplicate() });
const webhookQueue = new Queue<WebhookJob>(WEBHOOK_QUEUE_NAME, { connection: core.redis, defaultJobOptions: WEBHOOK_JOB_OPTIONS });

// События окна переписки: один подписчик Redis на процесс, раздача открытым SSE-соединениям по аккаунту.
const eventSub = core.redis.duplicate();
const listeners = new Map<number, Set<(ev: ChatEvent) => void>>();
await eventSub.psubscribe(chatEventsChannel(0).replace(/0$/, '*'));
eventSub.on('pmessage', (_p, channel: string, raw: string) => {
  const accountId = Number(channel.split(':').pop());
  const ev = parseChatEvent(raw);
  if (!ev) return;
  for (const fn of listeners.get(accountId) ?? []) fn(ev);
});

const app = await buildApp({
  ...core,
  env,
  bridge,
  queue,
  webhooks: { add: async (channelId, body) => void (await webhookQueue.add('avito', { channelId, body })) },
  startChat: async (input) => {
    const job = await startQueue.add('start-chat', input);
    return (await job.waitUntilFinished(startEvents, START_WAIT_MS)) as { chatId: number; messageId: number };
  },
  windowSend: async (input) => {
    const job = await startQueue.add('window-send', input);
    return (await job.waitUntilFinished(startEvents, START_WAIT_MS)) as { messageIds: number[] };
  },
  events: {
    subscribe: (accountId, fn) => {
      const set = listeners.get(accountId) ?? new Set();
      set.add(fn);
      listeners.set(accountId, set);
      return () => {
        set.delete(fn);
        if (!set.size) listeners.delete(accountId);
      };
    },
  },
});
await app.listen({ host: env.HOST, port: env.PORT });

const shutdown = async () => {
  await app.close();
  await bull.close();
  await startQueue.close();
  await webhookQueue.close();
  await eventSub.quit();
  await startEvents.close();
  await core.redis.quit();
  await core.db.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
