import { Queue, type ConnectionOptions } from 'bullmq';

export const INCOMING_QUEUE = 'incoming';

export interface IncomingJob {
  accountId: number;
  leadId: number;
  /** Отложенная проверка: клиент написал, агент не ответил. */
  unanswered?: { at: string; text: string };
}

/** Ключ задачи сделки: одна задача на сделку, пока идёт окно склейки. BullMQ не допускает «:» в id. */
export const leadJobId = (accountId: number, leadId: number) => `lead-${accountId}-${leadId}`;

/**
 * Планирует обработку сделки через windowMs. Если задача уже ждёт — окно продлевается,
 * чтобы серия сообщений клиента ушла в модель одной пачкой (шаг 3 раздела 5 ТЗ).
 */
export async function scheduleLead(queue: Queue<IncomingJob>, job: IncomingJob, windowMs: number): Promise<void> {
  const id = leadJobId(job.accountId, job.leadId);
  const existing = await queue.getJob(id);
  if (existing) {
    const state = await existing.getState();
    if (state === 'delayed') {
      await existing.changeDelay(windowMs);
      return;
    }
    // Задача уже выполняется: воркер после неё сам проверит новые сообщения.
    if (state === 'active' || state === 'waiting' || state === 'prioritized') return;
    await existing.remove().catch(() => undefined);
  }
  await queue.add('process', job, {
    jobId: id,
    delay: windowMs,
    removeOnComplete: true,
    removeOnFail: 1000,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  });
}

export function createIncomingQueue(connection: ConnectionOptions): Queue<IncomingJob> {
  return new Queue<IncomingJob>(INCOMING_QUEUE, { connection });
}

/** Через сколько проверяем, ответил ли менеджер клиенту вместо агента. */
export const UNANSWERED_DELAY_MS = 60 * 60 * 1000;

export const unansweredJobId = (accountId: number, leadId: number) => `unanswered-${accountId}-${leadId}`;

/**
 * Клиент написал, агент не ответил: ставим проверку через delayMs.
 * Задача на сделку всё равно одна, поэтому повторные сообщения не плодят проверок.
 */
export async function scheduleUnanswered(
  queue: Queue<IncomingJob>,
  job: IncomingJob,
  delayMs: number = UNANSWERED_DELAY_MS,
): Promise<void> {
  const id = unansweredJobId(job.accountId, job.leadId);
  if (await queue.getJob(id)) return;
  await queue.add('unanswered', job, {
    jobId: id,
    delay: delayMs,
    removeOnComplete: true,
    removeOnFail: 1000,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  });
}
