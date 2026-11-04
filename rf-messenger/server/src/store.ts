import type { Db } from './db.ts';
import type { AmojoMessageKind } from './amojo/client.ts';

export type ChannelKind = 'telegram_bot' | 'whatsapp' | 'telegram_user' | 'max' | 'vk' | 'avito';
export type ChannelStatus = 'starting' | 'connected' | 'no_phone' | 'session_ended' | 'error';
export type MessageStatus = 'received' | 'synced' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed';

export interface Channel {
  id: number;
  accountId: number;
  kind: ChannelKind;
  title: string;
  externalId: string;
  status: ChannelStatus;
  statusDetail: string | null;
  credentials: string;
  createdAt: Date;
}

export interface Chat {
  id: number;
  accountId: number;
  channelId: number;
  externalChatId: string;
  conversationId: string;
  isGroup: boolean;
  title: string;
  contact: { username?: string; phone?: string; link?: string };
  amojoChatId: string | null;
}

export interface Message {
  id: number;
  accountId: number;
  chatId: number;
  direction: 'in' | 'out';
  source: 'client' | 'amo' | 'phone';
  kind: AmojoMessageKind;
  text: string;
  fileId: string | null;
  media: { url: string; name: string; size: number } | null;
  author: { id: string; name: string } | null;
  replyToMessageId: number | null;
  externalId: string | null;
  amojoMsgid: string | null;
  status: MessageStatus;
  error: string | null;
  createdAt: Date;
}

export interface FileRecord {
  id: string;
  accountId: number;
  name: string;
  mime: string;
  size: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- строки pg приводятся к типам вручную */
const channelRow = (r: any): Channel => ({
  id: Number(r.id),
  accountId: Number(r.account_id),
  kind: r.kind,
  title: r.title,
  externalId: r.external_id,
  status: r.status,
  statusDetail: r.status_detail,
  credentials: r.credentials,
  createdAt: r.created_at,
});
const chatRow = (r: any): Chat => ({
  id: Number(r.id),
  accountId: Number(r.account_id),
  channelId: Number(r.channel_id),
  externalChatId: r.external_chat_id,
  conversationId: r.conversation_id,
  isGroup: r.is_group,
  title: r.title,
  contact: r.contact ?? {},
  amojoChatId: r.amojo_chat_id,
});
const messageRow = (r: any): Message => ({
  id: Number(r.id),
  accountId: Number(r.account_id),
  chatId: Number(r.chat_id),
  direction: r.direction,
  source: r.source,
  kind: r.kind,
  text: r.text,
  fileId: r.file_id,
  media: r.media,
  author: r.author,
  replyToMessageId: r.reply_to_message_id === null ? null : Number(r.reply_to_message_id),
  externalId: r.external_id,
  amojoMsgid: r.amojo_msgid,
  status: r.status,
  error: r.error,
  createdAt: r.created_at,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Доступ к БД. Методы с accountId — для запросов от имени аккаунта (account_id из токена виджета
 * или из подключения amo, найденного по подписанному scope_id). Методы без accountId — служебные,
 * для процесса коннекторов и очереди: работают по внутренним id, которые не приходят от пользователя.
 */
export class Store {
  constructor(readonly db: Db) {}

  // --- Подключение к API чатов amo ---

  async getConnection(accountId: number): Promise<{ amojoAccountId: string; scopeId: string } | null> {
    const r = await this.db.query('SELECT amojo_account_id, scope_id FROM amojo_connections WHERE account_id = $1', [accountId]);
    return r.rows[0] ? { amojoAccountId: r.rows[0].amojo_account_id, scopeId: r.rows[0].scope_id } : null;
  }

  async getConnectionByScope(scopeId: string): Promise<{ accountId: number } | null> {
    const r = await this.db.query('SELECT account_id FROM amojo_connections WHERE scope_id = $1', [scopeId]);
    return r.rows[0] ? { accountId: Number(r.rows[0].account_id) } : null;
  }

  async saveConnection(accountId: number, amojoAccountId: string, scopeId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO amojo_connections (account_id, amojo_account_id, scope_id) VALUES ($1, $2, $3)
       ON CONFLICT (account_id) DO UPDATE SET amojo_account_id = EXCLUDED.amojo_account_id, scope_id = EXCLUDED.scope_id, connected_at = now()`,
      [accountId, amojoAccountId, scopeId],
    );
  }

  async deleteConnection(accountId: number): Promise<void> {
    await this.db.query('DELETE FROM amojo_connections WHERE account_id = $1', [accountId]);
  }

  // --- Каналы ---

  async createChannel(c: { accountId: number; kind: ChannelKind; title: string; externalId: string; credentials: string }): Promise<Channel | null> {
    const r = await this.db.query(
      `INSERT INTO channels (account_id, kind, title, external_id, credentials) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (account_id, kind, external_id) WHERE deleted_at IS NULL DO NOTHING RETURNING *`,
      [c.accountId, c.kind, c.title, c.externalId, c.credentials],
    );
    return r.rows[0] ? channelRow(r.rows[0]) : null;
  }

  async listChannels(accountId: number): Promise<Channel[]> {
    const r = await this.db.query('SELECT * FROM channels WHERE account_id = $1 AND deleted_at IS NULL ORDER BY id', [accountId]);
    return r.rows.map(channelRow);
  }

  async deleteChannel(accountId: number, id: number): Promise<boolean> {
    const r = await this.db.query(
      'UPDATE channels SET deleted_at = now(), credentials = $3, session = NULL, updated_at = now() WHERE account_id = $1 AND id = $2 AND deleted_at IS NULL',
      [accountId, id, ''],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Служебное: каналы, которые должен держать процесс коннекторов. */
  async activeChannels(): Promise<Channel[]> {
    const r = await this.db.query('SELECT * FROM channels WHERE deleted_at IS NULL ORDER BY id');
    return r.rows.map(channelRow);
  }

  /** Служебное: канал по внутреннему id (null — удалён). */
  async channelById(id: number): Promise<Channel | null> {
    const r = await this.db.query('SELECT * FROM channels WHERE id = $1 AND deleted_at IS NULL', [id]);
    return r.rows[0] ? channelRow(r.rows[0]) : null;
  }

  async setChannelStatus(id: number, status: ChannelStatus, detail: string | null = null): Promise<void> {
    await this.db.query('UPDATE channels SET status = $2, status_detail = $3, updated_at = now() WHERE id = $1', [id, status, detail]);
  }

  /** Служебное: зашифрованная сессия канала (WhatsApp, Telegram личный). */
  async getChannelSession(id: number): Promise<string | null> {
    const r = await this.db.query('SELECT session FROM channels WHERE id = $1 AND deleted_at IS NULL', [id]);
    return r.rows[0]?.session ?? null;
  }

  async setChannelSession(id: number, sealed: string | null): Promise<void> {
    await this.db.query('UPDATE channels SET session = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL', [id, sealed]);
  }

  /** Служебное: после входа в WhatsApp — номер телефона как external_id и название канала. false — номер уже подключён другим каналом. */
  async setChannelIdentity(id: number, externalId: string, title: string): Promise<boolean> {
    try {
      await this.db.query('UPDATE channels SET external_id = $2, title = $3, updated_at = now() WHERE id = $1 AND deleted_at IS NULL', [id, externalId, title]);
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return false;
      throw err;
    }
  }

  /** Канал аккаунта (для API виджета). */
  async channelOfAccount(accountId: number, id: number): Promise<Channel | null> {
    const r = await this.db.query('SELECT * FROM channels WHERE account_id = $1 AND id = $2 AND deleted_at IS NULL', [accountId, id]);
    return r.rows[0] ? channelRow(r.rows[0]) : null;
  }

  // --- Чаты ---

  async upsertChat(
    channel: Pick<Channel, 'id' | 'accountId'>,
    c: { externalChatId: string; isGroup: boolean; title: string; contact: Chat['contact'] },
  ): Promise<Chat> {
    const r = await this.db.query(
      `INSERT INTO chats (account_id, channel_id, external_chat_id, conversation_id, is_group, title, contact)
       VALUES ($1, $2::bigint, $3::text, 'rfm-' || $2::bigint::text || '-' || md5($3::text), $4, $5, $6)
       ON CONFLICT (channel_id, external_chat_id) DO UPDATE SET title = EXCLUDED.title, contact = chats.contact || EXCLUDED.contact, last_message_at = now()
       RETURNING *`,
      [channel.accountId, channel.id, c.externalChatId, c.isGroup, c.title, JSON.stringify(c.contact)],
    );
    return chatRow(r.rows[0]);
  }

  async chatByConversation(accountId: number, conversationId: string): Promise<Chat | null> {
    const r = await this.db.query('SELECT * FROM chats WHERE account_id = $1 AND conversation_id = $2', [accountId, conversationId]);
    return r.rows[0] ? chatRow(r.rows[0]) : null;
  }

  async chatById(id: number): Promise<Chat | null> {
    const r = await this.db.query('SELECT * FROM chats WHERE id = $1', [id]);
    return r.rows[0] ? chatRow(r.rows[0]) : null;
  }

  async setAmojoChatId(chatId: number, amojoChatId: string): Promise<void> {
    await this.db.query('UPDATE chats SET amojo_chat_id = $2 WHERE id = $1 AND amojo_chat_id IS DISTINCT FROM $2', [chatId, amojoChatId]);
  }

  // --- Сообщения ---

  /** Сообщение из канала (от клиента или с телефона менеджера). null — уже было (повтор события). */
  async insertFromChannel(m: {
    chat: Chat;
    source: 'client' | 'phone';
    kind: Message['kind'];
    text: string;
    author: Message['author'];
    externalId: string;
    replyToExternalId: string | null;
  }): Promise<Message | null> {
    const r = await this.db.query(
      `INSERT INTO messages (account_id, chat_id, direction, source, kind, text, author, external_id, status, reply_to_message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'received',
         (SELECT id FROM messages WHERE chat_id = $2 AND external_id = $9 ORDER BY id LIMIT 1))
       ON CONFLICT (chat_id, direction, external_id) WHERE external_id IS NOT NULL DO NOTHING RETURNING *`,
      [
        m.chat.accountId,
        m.chat.id,
        m.source === 'client' ? 'in' : 'out',
        m.source,
        m.kind,
        m.text,
        m.author ? JSON.stringify(m.author) : null,
        m.externalId,
        m.replyToExternalId,
      ],
    );
    return r.rows[0] ? messageRow(r.rows[0]) : null;
  }

  /** Исходящее из amoCRM. null — amo повторил вебхук с тем же id. */
  async insertFromAmo(m: {
    chat: Chat;
    kind: Message['kind'];
    text: string;
    media: Message['media'];
    amojoMsgid: string;
    replyToAmojoMsgid: string | null;
  }): Promise<Message | null> {
    const r = await this.db.query(
      `INSERT INTO messages (account_id, chat_id, direction, source, kind, text, media, amojo_msgid, status, reply_to_message_id)
       VALUES ($1, $2, 'out', 'amo', $3, $4, $5, $6, 'queued',
         (SELECT id FROM messages WHERE account_id = $1 AND chat_id = $2 AND amojo_msgid = $7))
       ON CONFLICT (account_id, amojo_msgid) WHERE amojo_msgid IS NOT NULL DO NOTHING RETURNING *`,
      [m.chat.accountId, m.chat.id, m.kind, m.text, m.media ? JSON.stringify(m.media) : null, m.amojoMsgid, m.replyToAmojoMsgid],
    );
    return r.rows[0] ? messageRow(r.rows[0]) : null;
  }

  async messageById(id: number): Promise<Message | null> {
    const r = await this.db.query('SELECT * FROM messages WHERE id = $1', [id]);
    return r.rows[0] ? messageRow(r.rows[0]) : null;
  }

  async setMessageFile(id: number, fileId: string): Promise<void> {
    await this.db.query('UPDATE messages SET file_id = $2, updated_at = now() WHERE id = $1', [id, fileId]);
  }

  async markSynced(id: number, amojoMsgid: string): Promise<void> {
    await this.db.query("UPDATE messages SET amojo_msgid = $2, status = 'synced', updated_at = now() WHERE id = $1", [id, amojoMsgid]);
  }

  async markSent(id: number, externalId: string): Promise<void> {
    await this.db.query("UPDATE messages SET external_id = $2, status = 'sent', error = NULL, updated_at = now() WHERE id = $1", [id, externalId]);
  }

  async markFailed(id: number, error: string): Promise<void> {
    await this.db.query("UPDATE messages SET status = 'failed', error = $2, updated_at = now() WHERE id = $1", [id, error.slice(0, 500)]);
  }

  // --- Файлы ---

  async insertFile(f: FileRecord & { channelId: number | null; sha256: string }): Promise<void> {
    await this.db.query('INSERT INTO files (id, account_id, channel_id, name, mime, size, sha256) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      f.id,
      f.accountId,
      f.channelId,
      f.name,
      f.mime,
      f.size,
      f.sha256,
    ]);
  }

  /** Служебное: файл по id из подписанной ссылки. */
  async fileById(id: string): Promise<FileRecord | null> {
    const r = await this.db.query('SELECT id, account_id, name, mime, size FROM files WHERE id = $1', [id]);
    const row = r.rows[0];
    return row ? { id: row.id, accountId: Number(row.account_id), name: row.name, mime: row.mime, size: Number(row.size) } : null;
  }
}
