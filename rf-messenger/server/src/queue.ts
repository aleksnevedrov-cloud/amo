import type { Redis } from 'ioredis';

export type JobName = 'to-amo' | 'to-channel' | 'history';
export interface JobData {
  /** to-amo, to-channel — id сообщения; history — 0. */
  messageId: number;
  /** history: загрузка истории чата из мессенджера. */
  chatId?: number;
}

/** Очередь задач: to-amo — сообщение из канала в amoCRM, to-channel — из amoCRM в канал. */
export interface JobQueue {
  add(name: JobName, data: JobData, opts: { jobId: string; delay?: number }): Promise<void>;
}

export const QUEUE_NAME = 'rfm-messages';
export const JOB_OPTIONS = {
  attempts: 10,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 86_400, count: 10_000 },
  removeOnFail: { age: 7 * 86_400 },
} as const;

/** Очередь «Написать первым»: api ставит задачу и ждёт результат, connectors выполняет. Без повторов — иначе клиенту уйдёт дубль. */
export const START_QUEUE_NAME = 'rfm-start-chat';
export const START_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: { age: 3600 },
  removeOnFail: { age: 86_400 },
} as const;
/** Сколько api ждёт выполнения (поиск номера, amo, отправка). */
export const START_WAIT_MS = 60_000;

/** Вебхуки мессенджеров (Авито): api принимает и ставит в очередь, connectors разбирает коннектором канала. */
export const WEBHOOK_QUEUE_NAME = 'rfm-webhooks';
export const WEBHOOK_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 3_000 },
  removeOnComplete: { age: 3600, count: 5000 },
  removeOnFail: { age: 86_400 },
} as const;
export interface WebhookJob {
  channelId: number;
  body: unknown;
}

/** Распределение исходящих по времени: в один чат не чаще, чем раз в min–max мс (раздел 6 ТЗ). */
export interface Pacer {
  /** Резервирует слот отправки в чат; возвращает задержку в мс до слота. */
  reserve(chatId: number): Promise<number>;
}

// Атомарно: слот = max(сейчас, предыдущий слот + пауза). Слоты одного чата идут по возрастанию — порядок сохраняется.
const RESERVE_LUA = `
local prev = tonumber(redis.call('GET', KEYS[1]) or '0')
local slot = math.max(tonumber(ARGV[1]), prev + tonumber(ARGV[2]))
redis.call('SET', KEYS[1], slot, 'PX', 600000)
return slot
`;

export class RedisPacer implements Pacer {
  constructor(
    private readonly redis: Redis,
    private readonly minMs: number,
    private readonly maxMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async reserve(chatId: number): Promise<number> {
    const pause = this.minMs + Math.floor(Math.random() * (this.maxMs - this.minMs + 1));
    const now = this.now();
    const slot = Number(await this.redis.eval(RESERVE_LUA, 1, `rfm:pace:${chatId}`, String(now), String(pause)));
    return Math.max(0, slot - now);
  }
}
