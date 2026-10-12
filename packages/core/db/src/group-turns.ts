import type { Db } from './pool.ts';

/** Строка нити группового чата (RFD-AI-AGENT-GRUPPOVYE-CHATY). */
export interface GroupTurnRow {
  role: 'client' | 'assistant';
  author: string | null;
  text: string;
  createdAt: Date;
}

export class GroupTurnsRepo {
  constructor(private readonly db: Db) {}

  /** Последние сообщения чата в прямом порядке (старые сначала). */
  async history(accountId: number, chatId: string, limit = 20): Promise<GroupTurnRow[]> {
    const { rows } = await this.db.query(
      `SELECT role, author, text, created_at FROM group_turns
         WHERE account_id = $1 AND chat_id = $2
         ORDER BY created_at DESC, id DESC
         LIMIT $3`,
      [accountId, chatId, limit],
    );
    return rows
      .map((r: Record<string, unknown>) => ({
        role: r.role as 'client' | 'assistant',
        author: (r.author as string | null) ?? null,
        text: String(r.text ?? ''),
        createdAt: r.created_at as Date,
      }))
      .reverse();
  }

  /** Запись одного сообщения нити. */
  async add(
    accountId: number,
    chatId: string,
    role: 'client' | 'assistant',
    text: string,
    opts: { chatType?: string | null; author?: string | null } = {},
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO group_turns (account_id, chat_id, chat_type, role, author, text)
         VALUES ($1, $2, $3, $4, $5, $6)`,
      [accountId, chatId, opts.chatType ?? null, role, opts.author ?? null, text.slice(0, 8000)],
    );
  }

  /** Сколько ответов агент дал в чате за последние minutes минут — защита от зацикливания. */
  async repliesSince(accountId: number, chatId: string, minutes: number): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT count(*)::int AS n FROM group_turns
         WHERE account_id = $1 AND chat_id = $2 AND role = 'assistant'
           AND created_at > now() - make_interval(mins => $3)`,
      [accountId, chatId, minutes],
    );
    return Number((rows[0] as { n?: number } | undefined)?.n ?? 0);
  }

  /** Эхо нашего ответа: такой текст агент уже отправлял в этот чат недавно. Исходящее без такого совпадения — человек с номера канала. */
  async isOwnReply(accountId: number, chatId: string, text: string, minutes = 10): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT 1 FROM group_turns
         WHERE account_id = $1 AND chat_id = $2 AND role = 'assistant'
           AND created_at > now() - make_interval(mins => $4)
           AND left(text, 300) = left($3, 300)
         LIMIT 1`,
      [accountId, chatId, text.trim(), minutes],
    );
    return rows.length > 0;
  }

  /** Сводка для вкладки «Где работает»: сколько чатов и ответов. */
  async stats(accountId: number): Promise<{ chats: number; replies: number }> {
    const { rows } = await this.db.query(
      `SELECT count(DISTINCT chat_id)::int AS chats,
              count(*) FILTER (WHERE role = 'assistant')::int AS replies
         FROM group_turns WHERE account_id = $1`,
      [accountId],
    );
    const r = (rows[0] ?? {}) as { chats?: number; replies?: number };
    return { chats: Number(r.chats ?? 0), replies: Number(r.replies ?? 0) };
  }
}
