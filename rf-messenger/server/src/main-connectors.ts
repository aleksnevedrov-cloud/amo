import { Queue, Worker } from 'bullmq';
import { CHANNELS_CHANGED } from './api/app.ts';
import { Bridge, type Logger } from './bridge.ts';
import { loadEnv } from './config.ts';
import { ConnectorHost } from './connectors/host.ts';
import { migrate } from './db.ts';
import { createCore } from './deps.ts';
import { JOB_OPTIONS, QUEUE_NAME, RedisPacer, type JobData, type JobName, type JobQueue } from './queue.ts';

/**
 * Процесс connectors: держит сессии каналов, принимает входящие, выполняет очередь отправки.
 * Отдельный от api процесс: зависание коннектора не роняет вебхук amo и наоборот.
 */
const env = loadEnv();
const core = createCore(env);
await migrate(core.db);

const levels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];
const write = (level: string) => (obj: object, msg?: string) => {
  if (levels.indexOf(level) <= levels.indexOf(env.LOG_LEVEL)) process.stdout.write(`${JSON.stringify({ level, time: new Date().toISOString(), msg, ...obj })}\n`);
};
const log: Logger = { info: write('info'), warn: write('warn'), error: write('error') };

const bull = new Queue(QUEUE_NAME, { connection: core.redis, defaultJobOptions: JOB_OPTIONS });
const queue: JobQueue = { add: async (name, data, opts) => void (await bull.add(name, data, opts)) };
// eslint-disable-next-line prefer-const -- host и bridge ссылаются друг на друга
let host: ConnectorHost;
const bridge = new Bridge({
  store: core.store,
  files: core.files,
  amojo: core.amojo,
  queue,
  pacer: new RedisPacer(core.redis, env.OUTBOUND_PAUSE_MIN_MS, env.OUTBOUND_PAUSE_MAX_MS),
  connector: (id) => host.get(id),
  amoDomains: env.AMO_ALLOWED_DOMAINS,
  log,
  typingMs: 1200,
});
host = new ConnectorHost(core.store, core.box, () => bridge, log);

const worker = new Worker<JobData, void, JobName>(
  QUEUE_NAME,
  async (job) => {
    if (job.name === 'to-amo') return bridge.deliverToAmo(job.data.messageId);
    const last = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    return bridge.deliverToChannel(job.data.messageId, last);
  },
  { connection: core.redis.duplicate(), concurrency: 4 },
);
worker.on('failed', (job, err) => log.warn({ job: job?.id, attempts: job?.attemptsMade, err: err.message }, 'задача не выполнена'));

await host.syncAll();
const sub = core.redis.duplicate();
await sub.subscribe(CHANNELS_CHANGED);
sub.on('message', () => void host.syncAll().catch((err: Error) => log.error({ err: err.message }, 'сверка каналов')));
// Подстраховка, если сообщение pub/sub потерялось.
const timer = setInterval(() => void host.syncAll().catch(() => undefined), 60_000);
log.info({}, 'connectors запущен');

const shutdown = async () => {
  clearInterval(timer);
  await worker.close();
  await host.stopAll();
  await bull.close();
  await sub.quit();
  await core.redis.quit();
  await core.db.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
