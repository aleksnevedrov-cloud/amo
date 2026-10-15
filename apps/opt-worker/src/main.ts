import { loadEnv } from '@core/shared';
import { KB_INDEX_JOB, KB_QUEUE, type KbIndexJob } from '@opt/kb';
import { createOptCore, DRAFT_JOB, DraftLockedError, KP_QUEUE, KP_RESEARCH_QUEUE, RESEARCH_JOB, researchJobId, runDraftJob, runResearchJob, type DraftJob, type ResearchJob } from '@opt/kp';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';

/**
 * Фоновый обработчик «Агента опт» (Redis база 1): очередь kp — задание «собрать черновик» по кнопке
 * менеджера; очередь kp-research (RFD-AI-AGENT-OPT-PRICE, этап 5) — поиск рыночной цены по одной позиции
 * черновика, по кнопке «Найти цены» или автоматически при сборке, если включено в настройках КП.
 * Плановых задач, опроса почты и вебхуков нет (ТЗ 6.5); токены amoCRM обновляются при обращении.
 */
const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL });
const core = createOptCore(env);
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

/** Параметры задания поиска: 1 повтор через 30 с только при сетевой/прочей ошибке; ошибки модели завершают задание статусом failed без повтора. */
export const RESEARCH_JOB_OPTIONS = { removeOnComplete: 500, removeOnFail: 500, attempts: 2, backoff: { type: 'fixed' as const, delay: 30_000 } };

const researchQueue = new Queue<ResearchJob>(KP_RESEARCH_QUEUE, { connection });
const enqueueResearch = async (jobs: ResearchJob[]) => {
  for (const j of jobs) {
    const id = researchJobId(j.accountId, j.draftId, j.requestIndex);
    const existing = await researchQueue.getJob(id);
    if (existing) {
      const st = await existing.getState();
      if (st === 'completed' || st === 'failed') await existing.remove();
      else continue;
    }
    await researchQueue.add(RESEARCH_JOB, j, { jobId: id, ...RESEARCH_JOB_OPTIONS });
  }
};

const worker = new Worker<DraftJob>(
  KP_QUEUE,
  async (job) => {
    if (job.name !== DRAFT_JOB) throw new Error(`Неизвестная задача ${job.name}`);
    const r = await runDraftJob(core, job.data, { onProgress: (line) => log.debug({ ...job.data }, `kp: ящик — ${line}`), enqueueResearch });
    log.info({ ...job.data, draftId: r.draftId }, 'kp: черновик собран');
    return r;
  },
  // Разбор файлов и модель — долгие вызовы, два задания параллельно достаточно и не выбивает лимиты провайдера.
  { connection, concurrency: 2 },
);
worker.on('failed', (job, err) => log.error({ err, job: job?.name, data: job?.data }, 'kp: задача упала'));

const researchWorker = new Worker<ResearchJob>(
  KP_RESEARCH_QUEUE,
  async (job) => {
    if (job.name !== RESEARCH_JOB) throw new Error(`Неизвестная задача ${job.name}`);
    try {
      const r = await runResearchJob(core, job.data);
      log.info({ ...job.data, researchId: r.researchId, status: r.status, cached: r.cached, price: r.price }, 'kp-research: позиция обработана');
      return r;
    } catch (err) {
      // КП уже собрано или позиции нет — повторять бессмысленно.
      if (err instanceof DraftLockedError || /не найден|нет позиции/.test((err as Error).message)) throw new UnrecoverableError((err as Error).message);
      throw err;
    }
  },
  { connection, concurrency: 2 },
);
researchWorker.on('failed', (job, err) => log.error({ err, job: job?.name, data: job?.data, attempts: job?.attemptsMade }, 'kp-research: задача упала'));

// База знаний (RFD-AI-AGENT-OPT-KB): индексация источника — извлечение текста, фрагменты, эмбеддинги; по одному заданию за раз.
const kbWorker = new Worker<KbIndexJob>(
  KB_QUEUE,
  async (job) => {
    if (job.name !== KB_INDEX_JOB) throw new Error(`Неизвестная задача ${job.name}`);
    const r = await core.kb.index(job.data);
    log.info({ ...job.data, status: r.status, chunks: r.chunks, embedded: r.embeddedChunks, ms: r.ms, error: r.error }, 'kb-index: источник обработан');
    return r;
  },
  { connection, concurrency: 1 },
);
kbWorker.on('failed', (job, err) => log.error({ err, job: job?.name, data: job?.data, attempts: job?.attemptsMade }, 'kb-index: задача упала'));
log.info('opt-worker запущен: очереди kp, kp-research и kb-index');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await Promise.all([worker.close(), researchWorker.close(), kbWorker.close(), researchQueue.close()]);
    await connection.quit();
    await core.close();
    process.exit(0);
  });
}
