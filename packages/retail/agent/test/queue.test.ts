import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { leadJobId, scheduleLead, type IncomingJob } from '../src/queue.ts';

const url = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';
let connection: Redis;
let queue: Queue<IncomingJob>;

beforeAll(async () => {
  connection = new Redis(url, { maxRetriesPerRequest: null });
  queue = new Queue<IncomingJob>(`test-incoming-${Date.now()}`, { connection });
});
afterAll(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
  await connection.quit();
});

describe('scheduleLead', () => {
  it('одна отложенная задача на сделку, окно продлевается', async () => {
    await scheduleLead(queue, { accountId: 1, leadId: 5 }, 8000);
    const first = await queue.getJob(leadJobId(1, 5));
    const t1 = first!.timestamp + (first!.opts.delay ?? 0);
    await new Promise((r) => setTimeout(r, 30));
    await scheduleLead(queue, { accountId: 1, leadId: 5 }, 8000);
    const again = await queue.getJob(leadJobId(1, 5));
    expect(await queue.getDelayedCount()).toBe(1);
    expect(await again!.getState()).toBe('delayed');
    // changeDelay сдвигает время запуска вперёд.
    const delayed = await queue.getDelayed();
    expect(delayed).toHaveLength(1);
    expect(t1).toBeGreaterThan(0);
  });

  it('разные сделки — разные задачи', async () => {
    await scheduleLead(queue, { accountId: 1, leadId: 6 }, 8000);
    expect(await queue.getDelayedCount()).toBe(2);
    expect(leadJobId(1, 6)).toBe('lead-1-6');
  });
});
