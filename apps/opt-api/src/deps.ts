import type { Env } from '@core/shared';
import { createOptCore, DRAFT_JOB, ImapSentCopier, type SentCopier, draftJobId, KP_QUEUE, KP_RESEARCH_QUEUE, RESEARCH_JOB, researchJobId, SmtpKpSender, type DraftJob, type KpMailSender, type OptCore, type OptCoreOverrides, type ResearchJob, draftCurrentKey, draftCancelKey, progressView, type DraftProgress, type DraftProgressView } from '@opt/kp';
import { KB_INDEX_JOB, KB_QUEUE, kbIndexJobId, type KbIndexJob } from '@opt/kb';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export type DraftJobState = { state: 'queued' | 'running'; progress?: DraftProgressView | null } | { state: 'failed'; error: string } | null;

/** Очередь черновиков: API только ставит задание и смотрит его состояние, работу делает opt-worker. */
export interface DraftQueue {
  enqueue(job: DraftJob): Promise<void>;
  state(accountId: number, leadId: number): Promise<DraftJobState>;
  /** DEAL-FILES-2, 2.5.9: «Перезапустить сборку» — прежнее задание отменяется (ключ отмены), ставится новое. */
  restart(job: DraftJob): Promise<void>;
  /** Запись kp_error о зависании сделана — не дублировать при следующих опросах. */
  markStuckReported(accountId: number, leadId: number): Promise<void>;
  close(): Promise<void>;
}

/** Очередь поиска цен (kp-research): задание на позицию черновика, состояние по позициям. */
export interface ResearchQueue {
  enqueue(jobs: ResearchJob[]): Promise<void>;
  states(accountId: number, draftId: number, requestIndexes: number[]): Promise<Record<number, DraftJobState>>;
  close(): Promise<void>;
}

/** Очередь индексации базы знаний (kb-index): задание на источник, состояние по источникам. */
export interface KbQueue {
  enqueue(job: KbIndexJob): Promise<void>;
  states(accountId: number, sourceIds: number[]): Promise<Record<number, DraftJobState>>;
  close(): Promise<void>;
}

export interface Deps extends OptCore {
  redis: Pick<Redis, 'ping'>;
  mailer: KpMailSender;
  /** KP-SENT-COPY: копия отправленного КП в «Отправленные» по IMAP (в тестах подменяется). */
  sentCopier: SentCopier;
  queue: DraftQueue;
  researchQueue: ResearchQueue;
  kbQueue: KbQueue;
}

export type DepsOverrides = OptCoreOverrides & Partial<Pick<Deps, 'redis' | 'mailer' | 'sentCopier' | 'queue' | 'researchQueue' | 'kbQueue'>>;

export function createDeps(env: Env, overrides: DepsOverrides = {}): Deps {
  const core = createOptCore(env, overrides);
  let redisConn: Redis | null = null;
  const redis = overrides.redis ?? (redisConn = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }));
  const bullConn = () => redisConn ?? (redisConn = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }));
  const queue = overrides.queue ?? bullQueue(bullConn());
  const researchQueue = overrides.researchQueue ?? bullResearchQueue(bullConn());
  const kbQueue = overrides.kbQueue ?? bullKbQueue(bullConn());
  return {
    ...core,
    redis,
    mailer: overrides.mailer ?? new SmtpKpSender(),
    sentCopier: overrides.sentCopier ?? new ImapSentCopier(),
    queue,
    researchQueue,
    kbQueue,
    async close() {
      await queue.close();
      await researchQueue.close();
      await kbQueue.close();
      if (redisConn) await redisConn.quit();
      await core.close();
    },
  };
}

function bullQueue(connection: Redis): DraftQueue {
  const q = new Queue<DraftJob>(KP_QUEUE, { connection });
  // Текущее задание сделки: по умолчанию draft-<acc>-<lead>; после «Перезапустить сборку» — новый id в Redis (сутки).
  const currentId = async (accountId: number, leadId: number) => (await connection.get(draftCurrentKey(accountId, leadId))) ?? draftJobId(accountId, leadId);
  const add = (job: DraftJob, id: string) => q.add(DRAFT_JOB, job, { jobId: id, removeOnComplete: 200, removeOnFail: 200, attempts: 1 });
  return {
    async enqueue(job) {
      const id = await currentId(job.accountId, job.leadId);
      // Завершённое или упавшее задание с тем же id BullMQ не перезапустит — убираем его; активное не трогаем.
      const existing = await q.getJob(id);
      if (existing) {
        const st = await existing.getState();
        if (st === 'completed' || st === 'failed') await existing.remove();
        else return;
      }
      await add(job, id);
    },
    async state(accountId, leadId) {
      const job = await q.getJob(await currentId(accountId, leadId));
      if (!job) return null;
      const st = await job.getState();
      const progress = job.progress && typeof job.progress === 'object' ? progressView(job.progress as DraftProgress) : null;
      if (st === 'active') return { state: 'running', progress };
      if (st === 'failed') return { state: 'failed', error: job.failedReason || 'ошибка' };
      if (st === 'completed') return null;
      return { state: 'queued', progress: null };
    },
    async restart(job) {
      const oldId = await currentId(job.accountId, job.leadId);
      const existing = await q.getJob(oldId);
      if (existing) {
        const st = await existing.getState();
        if (st === 'completed' || st === 'failed') await existing.remove();
        else await connection.set(draftCancelKey(oldId), '1', 'EX', 24 * 3600);
      }
      const id = `${draftJobId(job.accountId, job.leadId)}-${Date.now()}`;
      await connection.set(draftCurrentKey(job.accountId, job.leadId), id, 'EX', 24 * 3600);
      await add(job, id);
    },
    async markStuckReported(accountId, leadId) {
      const job = await q.getJob(await currentId(accountId, leadId));
      if (job?.progress && typeof job.progress === 'object') await job.updateProgress({ ...(job.progress as DraftProgress), stuckReportedAt: new Date().toISOString() }).catch(() => undefined);
    },
    close: () => q.close(),
  };
}

/** Состояние задания BullMQ → состояние для виджета. */
async function jobState(job: { getState(): Promise<string>; failedReason?: string } | null | undefined): Promise<DraftJobState> {
  if (!job) return null;
  const st = await job.getState();
  if (st === 'active') return { state: 'running' };
  if (st === 'failed') return { state: 'failed', error: job.failedReason || 'ошибка' };
  if (st === 'completed') return null;
  return { state: 'queued' };
}

/** Повтор через 30 с только один раз (сеть, БД); ошибки модели завершают задание статусом failed в kp_price_research. */
const RESEARCH_JOB_OPTIONS = { removeOnComplete: 500, removeOnFail: 500, attempts: 2, backoff: { type: 'fixed' as const, delay: 30_000 } };

function bullResearchQueue(connection: Redis): ResearchQueue {
  const q = new Queue<ResearchJob>(KP_RESEARCH_QUEUE, { connection });
  return {
    async enqueue(jobs) {
      for (const j of jobs) {
        const id = researchJobId(j.accountId, j.draftId, j.requestIndex);
        const existing = await q.getJob(id);
        if (existing) {
          const st = await existing.getState();
          if (st === 'completed' || st === 'failed') await existing.remove();
          else continue;
        }
        await q.add(RESEARCH_JOB, j, { jobId: id, ...RESEARCH_JOB_OPTIONS });
      }
    },
    async states(accountId, draftId, requestIndexes) {
      const out: Record<number, DraftJobState> = {};
      for (const i of requestIndexes) out[i] = await jobState(await q.getJob(researchJobId(accountId, draftId, i)));
      return out;
    },
    close: () => q.close(),
  };
}

/** Индексация долгая (извлечение текста, эмбеддинги): один повтор через минуту при сетевой ошибке; ошибки разбора пишутся в источник без повтора. */
const KB_JOB_OPTIONS = { removeOnComplete: 500, removeOnFail: 500, attempts: 2, backoff: { type: 'fixed' as const, delay: 60_000 } };

function bullKbQueue(connection: Redis): KbQueue {
  const q = new Queue<KbIndexJob>(KB_QUEUE, { connection });
  return {
    async enqueue(job) {
      const id = kbIndexJobId(job.accountId, job.sourceId);
      const existing = await q.getJob(id);
      if (existing) {
        const st = await existing.getState();
        if (st === 'completed' || st === 'failed') await existing.remove();
        else return;
      }
      await q.add(KB_INDEX_JOB, job, { jobId: id, ...KB_JOB_OPTIONS });
    },
    async states(accountId, sourceIds) {
      const out: Record<number, DraftJobState> = {};
      for (const id of sourceIds) out[id] = await jobState(await q.getJob(kbIndexJobId(accountId, id)));
      return out;
    },
    close: () => q.close(),
  };
}
