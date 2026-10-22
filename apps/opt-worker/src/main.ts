import { loadEnv } from '@core/shared';
import { KB_INDEX_JOB, KB_QUEUE, kbIndexJobId, type KbIndexJob } from '@opt/kb';
import { CALLS_POLL_EVERY_MS, CALLS_POLL_JOB, CALLS_QUEUE, createOptCore, DRAFT_JOB, DraftLockedError, KP_QUEUE, KP_RESEARCH_QUEUE, RESEARCH_JOB, researchJobId, runCallsPollAll, runDraftJob, runResearchJob, type DraftJob, type ResearchJob } from '@opt/kp';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';

/**
 * Фоновый обработчик «Агента опт» (Redis база 1): очередь kp — задание «собрать черновик» по кнопке
 * менеджера; очередь kp-research (RFD-AI-AGENT-OPT-PRICE, этап 5) — поиск рыночной цены по одной позиции
 * черновика, по кнопке «Найти цены» или автоматически при сборке, если включено в настройках КП.
 * Опроса почты и вебхуков нет (ТЗ 6.5); токены amoCRM обновляются при обращении. Плановые задачи: переиндексация
 * ссылок базы знаний по сроку (kb-maintenance, раз в час; RFD-AI-AGENT-OPT-KB, этап 2) и сбор записей разговоров из
 * примечаний amo (calls-poll, раз в 10 минут; RFD-AI-AGENT-OPT-CALLS, этап 1) — только у аккаунтов, где разбор включён.
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

// База знаний (RFD-AI-AGENT-OPT-KB): индексация источника — скачивание ссылки, извлечение текста, фрагменты, эмбеддинги; по одному заданию за раз.
const KB_JOB_OPTIONS = { removeOnComplete: 500, removeOnFail: 500, attempts: 2, backoff: { type: 'fixed' as const, delay: 60_000 } };
const kbQueue = new Queue<KbIndexJob>(KB_QUEUE, { connection });
const enqueueKb = async (j: KbIndexJob) => {
  const id = kbIndexJobId(j.accountId, j.sourceId);
  const existing = await kbQueue.getJob(id);
  if (existing) {
    const st = await existing.getState();
    if (st === 'completed' || st === 'failed') await existing.remove();
    else return;
  }
  await kbQueue.add(KB_INDEX_JOB, j, { jobId: id, ...KB_JOB_OPTIONS });
};
const kbWorker = new Worker<KbIndexJob>(
  KB_QUEUE,
  async (job) => {
    if (job.name !== KB_INDEX_JOB) throw new Error(`Неизвестная задача ${job.name}`);
    // Страницы раздела (обход) ставятся в эту же очередь по одной.
    const r = await core.kb.index(job.data, { enqueue: enqueueKb });
    log.info({ ...job.data, status: r.status, chunks: r.chunks, embedded: r.embeddedChunks, ms: r.ms, error: r.error }, 'kb-index: источник обработан');
    return r;
  },
  { connection, concurrency: 1 },
);
kbWorker.on('failed', (job, err) => log.error({ err, job: job?.name, data: job?.data, attempts: job?.attemptsMade }, 'kb-index: задача упала'));

// Плановое обновление ссылок: раз в час берём до 20 ссылок с подошедшим next_refresh_at и ставим их в kb-index.
const KB_MAINTENANCE_QUEUE = 'kb-maintenance';
const KB_REFRESH_JOB = 'refresh-urls';
const KB_REFRESH_EVERY_MS = 3600_000;
const kbMaintenance = new Queue(KB_MAINTENANCE_QUEUE, { connection });
await kbMaintenance.upsertJobScheduler(KB_REFRESH_JOB, { every: KB_REFRESH_EVERY_MS }, { name: KB_REFRESH_JOB, opts: { removeOnComplete: 50, removeOnFail: 50 } });
const kbMaintenanceWorker = new Worker(
  KB_MAINTENANCE_QUEUE,
  async (job) => {
    if (job.name !== KB_REFRESH_JOB) throw new Error(`Неизвестная задача ${job.name}`);
    const n = await core.kb.refreshDue(enqueueKb);
    if (n) log.info({ n }, 'kb-maintenance: ссылки поставлены на переиндексацию');
    return { n };
  },
  { connection, concurrency: 1 },
);
kbMaintenanceWorker.on('failed', (job, err) => log.error({ err, job: job?.name }, 'kb-maintenance: задача упала'));

// Звонки (RFD-AI-AGENT-OPT-CALLS): раз в 10 минут — примечания call_in / call_out с отметки, скачивание MP3, удаление по сроку.
// Один обработчик, без параллельных опросов: второй запуск при незавершённом первом задание планировщика не создаёт.
const callsQueue = new Queue(CALLS_QUEUE, { connection });
await callsQueue.upsertJobScheduler(CALLS_POLL_JOB, { every: CALLS_POLL_EVERY_MS }, { name: CALLS_POLL_JOB, opts: { removeOnComplete: 50, removeOnFail: 50 } });
const callsWorker = new Worker(
  CALLS_QUEUE,
  async (job) => {
    if (job.name !== CALLS_POLL_JOB) throw new Error(`Неизвестная задача ${job.name}`);
    const results = await runCallsPollAll(core);
    for (const r of results) {
      if (!r.enabled) continue;
      if (r.inserted || r.downloaded || r.unavailable || r.failed || r.errors.length) log.info({ ...r }, 'calls-poll: аккаунт опрошен');
    }
    return { accounts: results.filter((r) => r.enabled).length, inserted: results.reduce((n, r) => n + r.inserted, 0) };
  },
  { connection, concurrency: 1 },
);
callsWorker.on('failed', (job, err) => log.error({ err, job: job?.name }, 'calls-poll: задача упала'));
log.info('opt-worker запущен: очереди kp, kp-research, kb-index, kb-maintenance (ссылки раз в час) и calls-poll (звонки раз в 10 минут)');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await Promise.all([worker.close(), researchWorker.close(), kbWorker.close(), kbMaintenanceWorker.close(), callsWorker.close(), researchQueue.close(), kbQueue.close(), kbMaintenance.close(), callsQueue.close()]);
    await connection.quit();
    await core.close();
    process.exit(0);
  });
}
