import { AmoOAuth, TokenService } from '@ai-door/amo';
import { createPool, PgTokenStore } from '@ai-door/db';
import { amoRedirectUri, loadEnv, SecretBox, TelegramAlerter } from '@ai-door/shared';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { MAINTENANCE_QUEUE, REFRESH_EVERY_MS, REFRESH_TOKENS_JOB, runRefreshTokens } from './jobs.ts';

const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL });
const db = createPool(env.DATABASE_URL);
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const alerter = new TelegramAlerter(env.TELEGRAM_ALERT_BOT_TOKEN, env.TELEGRAM_ALERT_CHAT_ID);
const tokenService = new TokenService(
  new PgTokenStore(db, new SecretBox(env.TOKEN_ENCRYPTION_KEY)),
  new AmoOAuth({ clientId: env.AMO_CLIENT_ID, clientSecret: env.AMO_CLIENT_SECRET, redirectUri: amoRedirectUri(env) }),
  env.TOKEN_REFRESH_MARGIN_SEC * 1000,
  alerter,
);

const queue = new Queue(MAINTENANCE_QUEUE, { connection });
await queue.upsertJobScheduler(REFRESH_TOKENS_JOB, { every: REFRESH_EVERY_MS }, { name: REFRESH_TOKENS_JOB });

const worker = new Worker(
  MAINTENANCE_QUEUE,
  async (job) => {
    if (job.name === REFRESH_TOKENS_JOB) return runRefreshTokens(tokenService, log);
    throw new Error(`Неизвестная задача ${job.name}`);
  },
  { connection, concurrency: 1 },
);
worker.on('failed', (job, err) => log.error({ err, job: job?.name }, 'задача упала'));
log.info('worker запущен');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await worker.close();
    await queue.close();
    await connection.quit();
    await db.end();
    process.exit(0);
  });
}
