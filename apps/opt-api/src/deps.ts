import type { Env } from '@core/shared';
import { createOptCore, DRAFT_JOB, draftJobId, KP_QUEUE, KP_RESEARCH_QUEUE, RESEARCH_JOB, researchJobId, SmtpKpSender, type DraftJob, type KpMailSender, type OptCore, type OptCoreOverrides, type ResearchJob } from '@opt/kp';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export type DraftJobState = { state: 'queued' | 'running' } | { state: 'failed'; error: string } | null;

/** Очередь черновиков: API только ставит задание и смотрит его состояние, работу делает opt-worker. */
export interface DraftQueue {
  enqueue(job: DraftJob): Promise<void>;
  state(accountId: number, leadId: number): Promise<DraftJobState>;
  close(): Promise<void>;
}

/** Очередь поиска цен (kp-research): задание на позицию черновика, состояние по позициям. */
export interface ResearchQueue {
  enqueue(jobs: ResearchJob[]): Promise<void>;
  states(accountId: number, draftId: number, requestIndexes: number[]): Promise<Record<number, DraftJobState>>;
  close(): Promise<void>;
}

export interface Deps extends OptCore {
  redis: Pick<Redis, 'ping'>;
  mailer: KpMailSender;
  queue: DraftQueue;
  researchQueue: ResearchQueue;
}

export type DepsOverrides = OptCoreOverrides & Partial<Pick<Deps, 'redis' | 'mailer' | 'queue' | 'researchQueue'>>;

export function createDeps(env: Env, overrides: DepsOverrides = {}): Deps {
  const core = createOptCore(env, overrides);
  let redisConn: Redis | null = null;
  const redis = overrides.redis ?? (redisConn = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }));
  const bullConn = () => redisConn ?? (redisConn = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }));
  const queue = overrides.queue ?? bullQueue(bullConn());
  const researchQueue = overrides.researchQueue ?? bullResearchQueue(bullConn());
  return {
    ...core,
    redis,
    mailer: overrides.mailer ?? new SmtpKpSender(),
    queue,
    researchQueue,
    async close() {
      await queue.close();
      await researchQueue.close();
      if (redisConn) await redisConn.quit();
      await core.close();
    },
  };
}

function bullQueue(connection: Redis): DraftQueue {
  const q = new Queue<DraftJob>(KP_QUEUE, { connection });
  return {
    async enqueue(job) {
      const id = draftJobId(job.accountId, job.leadId);
      // Завершённое или упавшее задание с тем же id BullMQ не перезапустит — убираем его; активное не трогаем.
      const existing = await q.getJob(id);
      if (existing) {
        const st = await existing.getState();
        if (st === 'completed' || st === 'failed') await existing.remove();
        else return;
      }
      await q.add(DRAFT_JOB, job, { jobId: id, removeOnComplete: 200, removeOnFail: 200, attempts: 1 });
    },
    async state(accountId, leadId) {
      const job = await q.getJob(draftJobId(accountId, leadId));
      if (!job) return null;
      const st = await job.getState();
      if (st === 'active') return { state: 'running' };
      if (st === 'failed') return { state: 'failed', error: job.failedReason || 'ошибка' };
      if (st === 'completed') return null;
      return { state: 'queued' };
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
