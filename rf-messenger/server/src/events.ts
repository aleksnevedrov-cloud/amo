import type { Redis } from 'ioredis';
import type { MessageStatus } from './store.ts';

/** Событие для окна переписки: новое сообщение, смена статуса, загружена история. */
export type ChatEvent =
  | { type: 'message'; chatId: number; messageId: number }
  | { type: 'status'; chatId: number; messageId: number; status: MessageStatus; error?: string | null }
  | { type: 'history'; chatId: number; count: number };

export interface ChatEvents {
  publish(accountId: number, ev: ChatEvent): Promise<void>;
}

export const chatEventsChannel = (accountId: number) => `rfm:chat:events:${accountId}`;

/** Процесс connectors публикует события в Redis, процесс api раздаёт их открытым окнам по SSE. */
export class RedisChatEvents implements ChatEvents {
  constructor(private readonly redis: Redis) {}

  async publish(accountId: number, ev: ChatEvent): Promise<void> {
    await this.redis.publish(chatEventsChannel(accountId), JSON.stringify(ev)).catch(() => undefined);
  }
}

/** Разбор события из Redis; мусор — null. */
export function parseChatEvent(raw: string): ChatEvent | null {
  try {
    const ev = JSON.parse(raw) as ChatEvent;
    return ev && typeof ev === 'object' && typeof ev.chatId === 'number' && typeof ev.type === 'string' ? ev : null;
  } catch {
    return null;
  }
}
