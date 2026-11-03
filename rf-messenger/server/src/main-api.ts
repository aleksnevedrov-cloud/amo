import { Queue } from 'bullmq';
import { buildApp } from './api/app.ts';
import { Bridge } from './bridge.ts';
import { loadEnv } from './config.ts';
import { migrate } from './db.ts';
import { createCore } from './deps.ts';
import { JOB_OPTIONS, QUEUE_NAME, RedisPacer, type JobQueue } from './queue.ts';

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
const app = await buildApp({ ...core, env, bridge });
await app.listen({ host: env.HOST, port: env.PORT });

const shutdown = async () => {
  await app.close();
  await bull.close();
  await core.redis.quit();
  await core.db.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
