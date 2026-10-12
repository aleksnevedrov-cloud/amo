import { loadEnv } from '@core/shared';
import { createOptCore, DRAFT_JOB, KP_QUEUE, runDraftJob, type DraftJob } from '@opt/kp';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';

/**
 * Фоновый обработчик «Агента опт»: одна очередь kp (Redis база 1), задание «собрать черновик»
 * по кнопке менеджера. Плановых задач, опроса почты и вебхуков нет (ТЗ 6.5); токены amoCRM
 * обновляются при обращении.
 */
const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL });
const core = createOptCore(env);
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const worker = new Worker<DraftJob>(
  KP_QUEUE,
  async (job) => {
    if (job.name !== DRAFT_JOB) throw new Error(`Неизвестная задача ${job.name}`);
    const r = await runDraftJob(core, job.data);
    log.info({ ...job.data, draftId: r.draftId }, 'kp: черновик собран');
    return r;
  },
  // Разбор файлов и модель — долгие вызовы, два задания параллельно достаточно и не выбивает лимиты провайдера.
  { connection, concurrency: 2 },
);
worker.on('failed', (job, err) => log.error({ err, job: job?.name, data: job?.data }, 'kp: задача упала'));
log.info('opt-worker запущен');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await worker.close();
    await connection.quit();
    await core.close();
    process.exit(0);
  });
}
