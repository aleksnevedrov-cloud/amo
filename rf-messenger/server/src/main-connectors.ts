import { setDefaultResultOrder } from 'node:dns';
import { Queue, Worker } from 'bullmq';
import { CHANNELS_CHANGED } from './api/app.ts';
import { Bridge, type Logger } from './bridge.ts';
import { loadEnv } from './config.ts';
import { ConnectorHost, defaultFactory } from './connectors/host.ts';
import { TelegramBotConnector } from './connectors/telegram-bot.ts';
import { WhatsAppConnector } from './connectors/whatsapp.ts';
import { migrate } from './db.ts';
import { createMessengerProxy, proxySecrets, redactSecrets } from './proxy.ts';
import { createCore } from './deps.ts';
import { JOB_OPTIONS, QUEUE_NAME, RedisPacer, type JobData, type JobName, type JobQueue } from './queue.ts';

// На сервере нет рабочего IPv6: без этого запросы к Telegram/WhatsApp периодически зависают на AAAA-адресах.
setDefaultResultOrder('ipv4first');

/**
 * Процесс connectors: держит сессии каналов, принимает входящие, выполняет очередь отправки.
 * Отдельный от api процесс: зависание коннектора не роняет вебхук amo и наоборот.
 */
const env = loadEnv();
const core = createCore(env);
await migrate(core.db);

// Логин и пароль прокси не должны попасть в журнал, даже внутри текста ошибки.
const secrets = proxySecrets(env.MESSENGER_PROXY_URL);
const levels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];
const write = (level: string) => (obj: object, msg?: string) => {
  if (levels.indexOf(level) <= levels.indexOf(env.LOG_LEVEL)) process.stdout.write(`${redactSecrets(JSON.stringify({ level, time: new Date().toISOString(), msg, ...obj }), secrets)}\n`);
};
const log: Logger = { info: write('info'), warn: write('warn'), error: write('error') };

// Прокси только для Telegram и WhatsApp; amoCRM (amojo, вложения), postgres, redis — напрямую.
const proxy = createMessengerProxy(env.MESSENGER_PROXY_URL);
log.info({ proxy: proxy?.display ?? 'нет' }, 'исходящий прокси мессенджеров');

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
const waQrKey = (id: number) => `rfm:wa:qr:${id}`;
host = new ConnectorHost(core.store, core.box, () => bridge, log, (channel, creds) => {
  if (channel.kind === 'whatsapp') {
    return new WhatsAppConnector({
      session: {
        load: async () => {
          const sealed = await core.store.getChannelSession(channel.id);
          return sealed ? core.box.decrypt(sealed) : null;
        },
        save: (json) => core.store.setChannelSession(channel.id, core.box.encrypt(json)),
        clear: () => core.store.setChannelSession(channel.id, null),
      },
      onQr: async (qr) => void (qr ? await core.redis.set(waQrKey(channel.id), qr, 'EX', 70) : await core.redis.del(waQrKey(channel.id))),
      onIdentity: (phone) => core.store.setChannelIdentity(channel.id, phone, `WhatsApp ${phone}`),
      log: (level, msg) => log[level]({ channelId: channel.id }, msg),
      ...(proxy ? { proxy: { agent: proxy.agent, dispatcher: proxy.dispatcher } } : {}),
    });
  }
  if (channel.kind === 'telegram_bot' && creds.token) {
    return new TelegramBotConnector(creds.token, {
      ...(proxy ? { dispatcher: proxy.dispatcher } : {}),
      onError: (err) => log.warn({ channelId: channel.id, err: (err as Error).message }, 'telegram: ошибка опроса'),
    });
  }
  return defaultFactory(channel, creds);
});

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
sub.on('message', (_ch, payload: string) => {
  const restart = /^restart:(\d+)$/.exec(payload);
  const job = restart ? host.restart(Number(restart[1])) : host.syncAll();
  void job.catch((err: Error) => log.error({ err: err.message }, 'сверка каналов'));
});
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
