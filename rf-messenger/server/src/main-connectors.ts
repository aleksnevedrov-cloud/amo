import { setDefaultResultOrder } from 'node:dns';
import { Queue, Worker } from 'bullmq';
import { CHANNELS_CHANGED, qrKey, tgPasswordKey } from './api/app.ts';
import { TelegramUserConnector } from './connectors/telegram-user.ts';
import { Bridge, type Logger } from './bridge.ts';
import { loadEnv } from './config.ts';
import { ConnectorHost, defaultFactory } from './connectors/host.ts';
import { AlertNotifier, collectProblems } from './alerts.ts';
import { TelegramBotApi, TelegramBotConnector } from './connectors/telegram-bot.ts';
import { WhatsAppConnector } from './connectors/whatsapp.ts';
import { migrate } from './db.ts';
import { createMessengerProxy, proxySecrets, ProxySwitch, redactSecrets } from './proxy.ts';
import { httpProbe, PROXY_CHECK_INTERVAL_MS, ProxyMonitor } from './proxy-monitor.ts';
import { createCore } from './deps.ts';
import { JOB_OPTIONS, QUEUE_NAME, RedisPacer, START_QUEUE_NAME, type JobData, type JobName, type JobQueue } from './queue.ts';
import type { StartChatInput } from './bridge.ts';

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
// Токен бота уведомлений — туда же.
const secrets = [...proxySecrets(env.MESSENGER_PROXY_URL), ...proxySecrets(env.MESSENGER_PROXY_URL_FALLBACK), ...(env.ALERT_TG_BOT_TOKEN ? [env.ALERT_TG_BOT_TOKEN] : [])].sort(
  (a, b) => b.length - a.length,
);
const levels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];
const write = (level: string) => (obj: object, msg?: string) => {
  if (levels.indexOf(level) <= levels.indexOf(env.LOG_LEVEL)) process.stdout.write(`${redactSecrets(JSON.stringify({ level, time: new Date().toISOString(), msg, ...obj }), secrets)}\n`);
};
const log: Logger = { info: write('info'), warn: write('warn'), error: write('error') };

// Прокси только для Telegram и WhatsApp; amoCRM (amojo, вложения), postgres, redis — напрямую.
// Основной и запасной; Telegram берёт текущий при каждом запросе, WhatsApp — при подключении.
const proxies = new ProxySwitch(createMessengerProxy(env.MESSENGER_PROXY_URL), createMessengerProxy(env.MESSENGER_PROXY_URL_FALLBACK));
const dispatcher = () => proxies.current()?.dispatcher;
const waProxy = () => proxies.current() ?? undefined;
// Адрес прокси в журнал не пишем — только задан ли он.
log.info({ proxy: proxies.primary ? 'задан' : 'нет', fallback: proxies.fallback ? 'задан' : 'нет', alerts: env.ALERT_TG_BOT_TOKEN ? 'включены' : 'нет' }, 'исходящий прокси мессенджеров');

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
  rest: core.rest,
});
const waQrKey = (id: number) => qrKey('whatsapp', id);
const sessionOf = (id: number) => ({
  load: async () => {
    const sealed = await core.store.getChannelSession(id);
    return sealed ? core.box.decrypt(sealed) : null;
  },
  save: (s: string) => core.store.setChannelSession(id, core.box.encrypt(s)),
  clear: () => core.store.setChannelSession(id, null),
});
/** Пароль 2FA Telegram из виджета: ждём до 5 минут, забираем один раз. */
const waitTgPassword = async (id: number): Promise<string | null> => {
  const until = Date.now() + 5 * 60_000;
  while (Date.now() < until) {
    const sealed = await core.redis.getdel(tgPasswordKey(id));
    if (sealed) return core.box.decrypt(sealed);
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
};
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
      ...(proxies.primary ? { proxy: waProxy } : {}),
    });
  }
  if (channel.kind === 'telegram_user') {
    if (!env.TELEGRAM_API_ID) return null;
    const key = qrKey('telegram_user', channel.id);
    return new TelegramUserConnector({
      apiId: env.TELEGRAM_API_ID,
      apiHash: env.TELEGRAM_API_HASH,
      session: sessionOf(channel.id),
      onQr: async (url) => void (url ? await core.redis.set(key, url, 'EX', 70) : await core.redis.del(key)),
      password: () => waitTgPassword(channel.id),
      onIdentity: (phone) => core.store.setChannelIdentity(channel.id, phone, `Telegram ${phone}`),
      log: (level, msg) => log[level]({ channelId: channel.id }, msg),
    });
  }
  if (channel.kind === 'telegram_bot' && creds.token) {
    return new TelegramBotConnector(creds.token, {
      ...(proxies.primary ? { dispatcher } : {}),
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
// «Написать первым»: по одной задаче за раз, без повторов (повтор отправил бы клиенту дубль).
const startWorker = new Worker<StartChatInput, { chatId: number; messageId: number }>(START_QUEUE_NAME, (job) => bridge.startChat(job.data), {
  connection: core.redis.duplicate(),
  concurrency: 1,
});
startWorker.on('failed', (job, err) => log.warn({ job: job?.id, channelId: job?.data.channelId, err: err.message }, 'написать первым: не выполнено'));

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

// Смена прокси: Telegram подхватит сам, WhatsApp переподключаем с той же сессией.
proxies.onChange(() => void host.restartKind('whatsapp').catch((err: Error) => log.error({ err: err.message }, 'переподключение WhatsApp после смены прокси')));

// Проверка прокси раз в минуту и уведомления о сбоях прокси и каналов.
const monitor = new ProxyMonitor({ sw: proxies, probe: httpProbe(), redis: core.redis, log });
const alertApi = env.ALERT_TG_BOT_TOKEN ? new TelegramBotApi(env.ALERT_TG_BOT_TOKEN, { dispatcher, retry: { retries: 2 } }) : null;
const alerts = alertApi
  ? new AlertNotifier({ send: async (text) => void (await alertApi.call('sendMessage', { chat_id: env.ALERT_TG_CHAT_ID, text }, 15_000)), log })
  : null;
const healthTick = async () => {
  const status = await monitor.tick();
  if (alerts) await alerts.observe(collectProblems(status, await core.store.activeChannels()));
};
void healthTick().catch((err: Error) => log.error({ err: err.message }, 'проверка прокси'));
const healthTimer = setInterval(() => void healthTick().catch((err: Error) => log.error({ err: err.message }, 'проверка прокси')), PROXY_CHECK_INTERVAL_MS);
// Входящие, оставшиеся без передачи в amo (сбой или перезапуск между сохранением и очередью), — заново в очередь.
const requeue = () => void bridge.requeueStuckInbound().catch((err: Error) => log.error({ err: err.message }, 'повтор зависших входящих'));
requeue();
const requeueTimer = setInterval(requeue, 5 * 60_000);
log.info({}, 'connectors запущен');

const shutdown = async () => {
  clearInterval(timer);
  clearInterval(healthTimer);
  clearInterval(requeueTimer);
  await worker.close();
  await startWorker.close();
  await host.stopAll();
  await bull.close();
  await sub.quit();
  await core.redis.quit();
  await core.db.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
