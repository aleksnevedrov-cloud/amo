import type { Db } from './db.ts';
import type { AmojoMessageKind } from './amojo/client.ts';

export type ChannelKind = 'telegram_bot' | 'whatsapp' | 'telegram_user' | 'max' | 'vk' | 'avito' | 'max_phone';
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
  /** Сотрудник amoCRM (id в API чатов), последним писавший в этот чат из amo. */
  amoOperatorRef: string | null;
  /** Когда менеджер последний раз открывал чат в окне переписки. */
  readAt: Date | null;
  lastMessageAt: Date;
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
  /** Имя сотрудника amoCRM у исходящих (из окна или вебхука amo). */
  senderName: string | null;
  senderUserId: number | null;
  /** Загруженная история: в ленту amoCRM не передаётся. */
  fromHistory: boolean;
  createdAt: Date;
}

export interface Template {
  id: number;
  accountId: number;
  /** null — общий шаблон аккаунта. */
  ownerUserId: number | null;
  title: string;
  text: string;
  folder: string;
  attachments: { fileId: string; name: string; mime: string; size: number }[];
  useCount: number;
  updatedAt: Date;
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
  amoOperatorRef: r.amo_operator_ref ?? null,
  readAt: r.read_at ?? null,
  lastMessageAt: r.last_message_at,
});
const templateRow = (r: any): Template => ({
  id: Number(r.id),
  accountId: Number(r.account_id),
  ownerUserId: r.owner_user_id === null ? null : Number(r.owner_user_id),
  title: r.title,
  text: r.text,
  folder: r.folder,
  attachments: Array.isArray(r.attachments) ? r.attachments : [],
  useCount: Number(r.use_count),
  updatedAt: r.updated_at,
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
  senderName: r.sender_name ?? null,
  senderUserId: r.sender_user_id === null || r.sender_user_id === undefined ? null : Number(r.sender_user_id),
  fromHistory: Boolean(r.from_history),
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

  async getConnection(accountId: number): Promise<{ amojoAccountId: string; scopeId: string; amoOperatorRef: string | null } | null> {
    const r = await this.db.query('SELECT amojo_account_id, scope_id, amo_operator_ref FROM amojo_connections WHERE account_id = $1', [accountId]);
    return r.rows[0]
      ? { amojoAccountId: r.rows[0].amojo_account_id, scopeId: r.rows[0].scope_id, amoOperatorRef: r.rows[0].amo_operator_ref ?? null }
      : null;
  }

  /**
   * Запоминает сотрудника amoCRM, написавшего в чат из amo: для этого чата и как запасной для аккаунта.
   * Возвращает true, если у аккаунта до этого сотрудника не было.
   */
  async rememberAmoOperator(accountId: number, chatId: number, ref: string): Promise<boolean> {
    await this.db.query('UPDATE chats SET amo_operator_ref = $3 WHERE account_id = $1 AND id = $2', [accountId, chatId, ref]);
    const r = await this.db.query(
      `UPDATE amojo_connections c SET amo_operator_ref = $2
       FROM (SELECT amo_operator_ref AS prev FROM amojo_connections WHERE account_id = $1) old
       WHERE c.account_id = $1 RETURNING old.prev`,
      [accountId, ref],
    );
    return r.rows.length > 0 && !r.rows[0].prev;
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
       RETURNING *, (xmax = 0) AS inserted`,
      [channel.accountId, channel.id, c.externalChatId, c.isGroup, c.title, JSON.stringify(c.contact)],
    );
    const chat = chatRow(r.rows[0]) as Chat & { inserted: boolean };
    chat.inserted = Boolean(r.rows[0].inserted);
    return chat;
  }

  // --- Окно переписки ---

  /** Чаты аккаунта по id чатов API amo (привязка к контакту) и по телефонам контактов. */
  async chatsForContacts(accountId: number, amojoChatIds: readonly string[], phones: readonly string[]): Promise<Chat[]> {
    const r = await this.db.query(
      `SELECT * FROM chats WHERE account_id = $1 AND (amojo_chat_id = ANY($2::text[]) OR (NOT is_group AND contact->>'phone' = ANY($3::text[])))
       ORDER BY last_message_at DESC LIMIT 100`,
      [accountId, amojoChatIds, phones],
    );
    return r.rows.map(chatRow);
  }

  /** Сообщение канала по id в мессенджере — «не доставлено». */
  async failByExternal(chatId: number, externalId: string, error: string): Promise<Message | null> {
    const r = await this.db.query(
      `UPDATE messages SET status = 'failed', error = $3, updated_at = now()
       WHERE chat_id = $1 AND direction = 'out' AND external_id = $2 AND status <> 'failed' RETURNING *`,
      [chatId, externalId, error.slice(0, 500)],
    );
    return r.rows[0] ? messageRow(r.rows[0]) : null;
  }

  /** Служебное: чат канала по id чата в мессенджере. */
  async chatByExternal(channelId: number, externalChatId: string): Promise<Chat | null> {
    const r = await this.db.query('SELECT * FROM chats WHERE channel_id = $1 AND external_chat_id = $2', [channelId, externalChatId]);
    return r.rows[0] ? chatRow(r.rows[0]) : null;
  }

  /** Самое старое сообщение чата с id в мессенджере — точка отсчёта для истории. */
  async oldestExternalMessage(chatId: number): Promise<Message | null> {
    const r = await this.db.query('SELECT * FROM messages WHERE chat_id = $1 AND external_id IS NOT NULL ORDER BY created_at ASC, id ASC LIMIT 1', [chatId]);
    return r.rows[0] ? messageRow(r.rows[0]) : null;
  }

  /** Чат аккаунта (для API окна). */
  async chatOfAccount(accountId: number, id: number): Promise<Chat | null> {
    const r = await this.db.query('SELECT * FROM chats WHERE account_id = $1 AND id = $2', [accountId, id]);
    return r.rows[0] ? chatRow(r.rows[0]) : null;
  }

  /** Страница сообщений чата: новые снизу, порциями по limit, старше beforeId. */
  async messagesPage(chatId: number, beforeId: number | null, limit: number): Promise<{ messages: Message[]; hasMore: boolean }> {
    // Порядок — по времени сообщения (история загружается позже, но старше), затем по id.
    const r = await this.db.query(
      `SELECT * FROM messages WHERE chat_id = $1
         AND ($2::bigint IS NULL OR (created_at, id) < (SELECT created_at, id FROM messages WHERE id = $2))
       ORDER BY created_at DESC, id DESC LIMIT $3`,
      [chatId, beforeId, limit + 1],
    );
    const rows = r.rows.slice(0, limit).reverse().map(messageRow);
    return { messages: rows, hasMore: r.rows.length > limit };
  }

  async searchMessages(chatId: number, q: string, limit = 50): Promise<Message[]> {
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const r = await this.db.query('SELECT * FROM messages WHERE chat_id = $1 AND text ILIKE $2 ORDER BY created_at DESC, id DESC LIMIT $3', [chatId, pattern, limit]);
    return r.rows.map(messageRow);
  }

  async messagesByIds(chatId: number, ids: readonly number[]): Promise<Message[]> {
    if (!ids.length) return [];
    const r = await this.db.query('SELECT * FROM messages WHERE chat_id = $1 AND id = ANY($2::bigint[])', [chatId, ids]);
    return r.rows.map(messageRow);
  }

  /** Сводка по чатам для списка: последнее сообщение и число непрочитанных входящих. */
  async chatSummaries(chatIds: readonly number[]): Promise<Map<number, { last: Message | null; unread: number }>> {
    const out = new Map<number, { last: Message | null; unread: number }>();
    if (!chatIds.length) return out;
    const last = await this.db.query('SELECT DISTINCT ON (chat_id) * FROM messages WHERE chat_id = ANY($1::bigint[]) ORDER BY chat_id, created_at DESC, id DESC', [chatIds]);
    const unread = await this.db.query(
      `SELECT m.chat_id, count(*)::int AS n FROM messages m JOIN chats c ON c.id = m.chat_id
       WHERE m.chat_id = ANY($1::bigint[]) AND m.direction = 'in' AND (c.read_at IS NULL OR m.created_at > c.read_at) GROUP BY m.chat_id`,
      [chatIds],
    );
    for (const id of chatIds) out.set(id, { last: null, unread: 0 });
    for (const r of last.rows) {
      const e = out.get(Number(r.chat_id));
      if (e) e.last = messageRow(r);
    }
    for (const r of unread.rows) {
      const e = out.get(Number(r.chat_id));
      if (e) e.unread = Number(r.n);
    }
    return out;
  }

  async markChatRead(chatId: number): Promise<void> {
    await this.db.query('UPDATE chats SET read_at = now() WHERE id = $1', [chatId]);
  }

  /** Статус доставки от мессенджера (доставлено / прочитано) по id сообщения в канале. */
  async setStatusByExternal(chatId: number, externalId: string, status: 'delivered' | 'read'): Promise<Message | null> {
    const r = await this.db.query(
      `UPDATE messages SET status = $3, updated_at = now()
       WHERE chat_id = $1 AND direction = 'out' AND external_id = $2
         AND status IN ('sent', 'delivered', 'synced', 'received') AND NOT (status = 'delivered' AND $3 = 'delivered')
       RETURNING *`,
      [chatId, externalId, status],
    );
    return r.rows[0] ? messageRow(r.rows[0]) : null;
  }

  /** Чат канала по началу id без access_hash (u:<id> совпадает с u:<id>:<hash>). */
  async chatByPeerKey(channelId: number, peerKey: string): Promise<Chat | null> {
    const r = await this.db.query(
      "SELECT * FROM chats WHERE channel_id = $1 AND (external_chat_id = $2 OR external_chat_id LIKE $2 || ':%') ORDER BY id LIMIT 1",
      [channelId, peerKey],
    );
    return r.rows[0] ? chatRow(r.rows[0]) : null;
  }

  /** Все наши сообщения чата с числовым id в мессенджере не больше maxId — прочитаны. */
  async markReadUpTo(chatId: number, maxId: number): Promise<Message[]> {
    const r = await this.db.query(
      `UPDATE messages SET status = 'read', updated_at = now()
       WHERE chat_id = $1 AND direction = 'out' AND external_id ~ '^[0-9]{1,18}$' AND external_id::bigint <= $2
         AND status IN ('sent', 'delivered', 'synced', 'received')
       RETURNING *`,
      [chatId, maxId],
    );
    return r.rows.map(messageRow);
  }

  async requeueMessage(id: number): Promise<void> {
    await this.db.query("UPDATE messages SET status = 'queued', error = NULL, updated_at = now() WHERE id = $1", [id]);
  }

  // --- Шаблоны сообщений ---

  /** Общие шаблоны аккаунта и личные шаблоны сотрудника: частые — сверху. */
  async listTemplates(accountId: number, userId: number): Promise<Template[]> {
    const r = await this.db.query(
      'SELECT * FROM templates WHERE account_id = $1 AND (owner_user_id IS NULL OR owner_user_id = $2) ORDER BY use_count DESC, folder, title LIMIT 500',
      [accountId, userId],
    );
    return r.rows.map(templateRow);
  }

  async templateById(accountId: number, id: number): Promise<Template | null> {
    const r = await this.db.query('SELECT * FROM templates WHERE account_id = $1 AND id = $2', [accountId, id]);
    return r.rows[0] ? templateRow(r.rows[0]) : null;
  }

  async createTemplate(t: Omit<Template, 'id' | 'useCount' | 'updatedAt'>): Promise<Template> {
    const r = await this.db.query(
      'INSERT INTO templates (account_id, owner_user_id, title, text, folder, attachments) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [t.accountId, t.ownerUserId, t.title, t.text, t.folder, JSON.stringify(t.attachments)],
    );
    return templateRow(r.rows[0]);
  }

  async updateTemplate(accountId: number, id: number, t: Pick<Template, 'title' | 'text' | 'folder' | 'attachments'>): Promise<Template | null> {
    const r = await this.db.query(
      'UPDATE templates SET title = $3, text = $4, folder = $5, attachments = $6, updated_at = now() WHERE account_id = $1 AND id = $2 RETURNING *',
      [accountId, id, t.title, t.text, t.folder, JSON.stringify(t.attachments)],
    );
    return r.rows[0] ? templateRow(r.rows[0]) : null;
  }

  async deleteTemplate(accountId: number, id: number): Promise<boolean> {
    const r = await this.db.query('DELETE FROM templates WHERE account_id = $1 AND id = $2', [accountId, id]);
    return (r.rowCount ?? 0) > 0;
  }

  async bumpTemplate(accountId: number, id: number): Promise<void> {
    await this.db.query('UPDATE templates SET use_count = use_count + 1 WHERE account_id = $1 AND id = $2', [accountId, id]);
  }

  /** Служебное: личный чат канала с этим номером клиента (номер — в contact.phone). */
  async chatByPhone(channelId: number, phone: string): Promise<Chat | null> {
    const r = await this.db.query(
      `SELECT * FROM chats WHERE channel_id = $1 AND NOT is_group AND contact->>'phone' = $2 ORDER BY last_message_at DESC LIMIT 1`,
      [channelId, phone],
    );
    return r.rows[0] ? chatRow(r.rows[0]) : null;
  }

  /** Последние личные чаты канала (для «Написать» в VK и MAX: только тем, кто уже писал). */
  async recentChats(accountId: number, channelId: number, limit = 50): Promise<Chat[]> {
    const r = await this.db.query(
      'SELECT * FROM chats WHERE account_id = $1 AND channel_id = $2 AND NOT is_group ORDER BY last_message_at DESC LIMIT $3',
      [accountId, channelId, limit],
    );
    return r.rows.map(chatRow);
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

  /**
   * Служебное: входящие из канала, которые не переданы в amo дольше olderThanSec секунд
   * (за последние 7 суток — старше в amo уже не нужны как новая переписка).
   */
  /** Служебное: сообщения с телефона менеджера аккаунта, не переданные в amo (за последние 7 суток). */
  async pendingPhoneIds(accountId: number): Promise<number[]> {
    const r = await this.db.query(
      `SELECT id FROM messages
       WHERE account_id = $1 AND status = 'received' AND source = 'phone' AND amojo_msgid IS NULL AND NOT from_history
         AND created_at > now() - interval '7 days'
       ORDER BY id LIMIT 500`,
      [accountId],
    );
    return r.rows.map((x) => Number(x.id));
  }

  async stuckInboundIds(olderThanSec: number): Promise<number[]> {
    const r = await this.db.query(
      `SELECT id FROM messages
       WHERE status = 'received' AND source IN ('client', 'phone') AND amojo_msgid IS NULL AND NOT from_history
         AND created_at < now() - make_interval(secs => $1) AND created_at > now() - interval '7 days'
       ORDER BY id LIMIT 500`,
      [olderThanSec],
    );
    return r.rows.map((x) => Number(x.id));
  }

  /** Сообщение из канала (от клиента или с телефона менеджера). null — уже было (повтор события). */
  async insertFromChannel(m: {
    chat: Chat;
    source: 'client' | 'phone';
    kind: Message['kind'];
    text: string;
    author: Message['author'];
    externalId: string;
    replyToExternalId: string | null;
    /** Исходящее из окна: кто отправил. */
    senderName?: string | null;
    senderUserId?: number | null;
    /** Загруженная история: время сообщения в мессенджере, в amo не передаётся. */
    fromHistory?: boolean;
    createdAt?: Date;
  }): Promise<Message | null> {
    const r = await this.db.query(
      `INSERT INTO messages (account_id, chat_id, direction, source, kind, text, author, external_id, status, reply_to_message_id, sender_name, sender_user_id, from_history, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'received',
         (SELECT id FROM messages WHERE chat_id = $2 AND external_id = $9 ORDER BY id LIMIT 1), $10, $11, $12, COALESCE($13::timestamptz, now()))
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
        m.senderName ?? null,
        m.senderUserId ?? null,
        Boolean(m.fromHistory),
        m.createdAt ?? null,
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
    senderName?: string | null;
  }): Promise<Message | null> {
    const r = await this.db.query(
      `INSERT INTO messages (account_id, chat_id, direction, source, kind, text, media, amojo_msgid, status, reply_to_message_id, sender_name)
       VALUES ($1, $2, 'out', 'amo', $3, $4, $5, $6, 'queued',
         (SELECT id FROM messages WHERE account_id = $1 AND chat_id = $2 AND amojo_msgid = $7), $8)
       ON CONFLICT (account_id, amojo_msgid) WHERE amojo_msgid IS NOT NULL DO NOTHING RETURNING *`,
      [m.chat.accountId, m.chat.id, m.kind, m.text, m.media ? JSON.stringify(m.media) : null, m.amojoMsgid, m.replyToAmojoMsgid, m.senderName ?? null],
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
