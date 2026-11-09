import { z } from 'zod';
import { AmojoError, type AmojoClient, type AmojoMessage, type AmojoMessageKind, type AmojoUser, type NewMessagePayload } from './amojo/client.ts';
import type { AmoRest } from './amo/rest.ts';
import { CHAT_START_KINDS } from './channels.ts';
import { normalizePhone, PermanentSendError, type Connector, type InboundEvent } from './connectors/types.ts';
import type { ChatEvents } from './events.ts';
import type { FileStore } from './files.ts';
import type { JobQueue, Pacer } from './queue.ts';
import { downloadFromAmo, type Resolver } from './safe-fetch.ts';
import type { Channel, Chat, Message, Store } from './store.ts';

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface BridgeDeps {
  store: Store;
  files: FileStore;
  amojo: AmojoClient | null;
  queue: JobQueue;
  pacer: Pacer;
  /** Запущенный коннектор канала (есть только в процессе коннекторов). */
  connector: (channelId: number) => Connector | undefined;
  amoDomains: readonly string[];
  log: Logger;
  /** Пауза «печатает…» перед отправкой, мс. */
  typingMs?: number;
  fetch?: typeof fetch;
  resolve?: Resolver;
  /** Сколько ждать скачивания вложения из канала (по умолчанию 90 с). Дольше — сообщение уходит в amo без файла. */
  mediaTimeoutMs?: number;
  /** REST API amoCRM (OAuth интеграции): нужен для «Написать первым». */
  rest?: AmoRest | null;
  /** События для окна переписки (SSE). */
  events?: ChatEvents;
}

/** Отправка из окна переписки в карточке: текст и/или файлы в существующий чат от имени сотрудника. */
export interface WindowSendInput {
  accountId: number;
  userId: number;
  chatId: number;
  text: string;
  replyToMessageId?: number | null;
  fileIds?: string[];
}

/** Вид сообщения по MIME загруженного файла. */
export function kindOfMime(mime: string, name = ''): Exclude<AmojoMessageKind, 'text'> {
  const m = mime.toLowerCase();
  if (m.startsWith('image/')) return m === 'image/webp' && /sticker/i.test(name) ? 'sticker' : 'picture';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return /ogg|opus|webm/.test(m) ? 'voice' : 'audio';
  return 'file';
}

/** Ошибка «Написать первым», которую показываем менеджеру как есть. */
export class StartChatError extends Error {}

export interface StartChatInput {
  accountId: number;
  /** Сотрудник amoCRM, нажавший «Написать первым» (из токена виджета). */
  userId: number;
  channelId: number;
  contactId: number;
  /** WhatsApp, Telegram личный: номер клиента. */
  phone?: string;
  /** VK, MAX: существующий чат с клиентом, который уже писал сообществу или боту. */
  chatId?: number;
  text: string;
}

/** Не больше стольких первых сообщений новым номерам в сутки на канал (раздел 6 ТЗ). */
export const NEW_CHATS_PER_DAY = 20;

/** Сообщение без задачи to-amo дольше этого срока считается зависшим и ставится в очередь заново. */
export const STUCK_INBOUND_AFTER_SEC = 300;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: нет ответа за ${Math.round(ms / 1000)} с`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const KINDS = new Set<AmojoMessageKind>(['text', 'picture', 'file', 'video', 'voice', 'audio', 'sticker']);

/** Вебхук amo (hook_api_version v2) об исходящем сообщении менеджера или Salesbot. */
const hookSchema = z.object({
  message: z.object({
    conversation: z.object({ client_id: z.string().optional(), id: z.string().optional() }),
    // Кто написал из amo: id сотрудника (или бота) в API чатов и его имя.
    sender: z.object({ id: z.string().min(1).max(100), name: z.string().max(200).optional() }).passthrough().optional(),
    message: z.object({
      id: z.string(),
      type: z.string(),
      text: z.string().optional().default(''),
      media: z.string().optional().default(''),
      file_name: z.string().optional().default(''),
      file_size: z.coerce.number().optional().default(0),
      reply_to: z.object({ message: z.object({ id: z.string().optional() }).passthrough() }).optional(),
    }),
  }),
});

export type HookResult = 'queued' | 'duplicate' | 'unknown_chat' | 'ignored';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ourMsgid = (id: number) => `rfm-m${id}`;

/** Мост: события каналов ↔ API чатов amoCRM. */
export class Bridge {
  constructor(private readonly d: BridgeDeps) {}

  // ---------- Канал → amoCRM ----------

  /** Событие коннектора: сохранить (с защитой от повторов), скачать вложение, поставить в очередь в amo. */
  async onInbound(channel: Channel, connector: Connector, ev: InboundEvent): Promise<void> {
    const chat = await this.d.store.upsertChat(channel, {
      externalChatId: ev.externalChatId,
      isGroup: ev.isGroup,
      title: ev.chatTitle,
      contact: ev.contact,
    });
    const msg = await this.d.store.insertFromChannel({
      chat,
      source: ev.fromMe ? 'phone' : 'client',
      kind: ev.attachment?.kind ?? 'text',
      text: ev.text,
      author: ev.author,
      externalId: ev.externalMessageId,
      replyToExternalId: ev.replyToExternalId,
    });
    if (!msg) return; // повтор события
    // Первое сообщение нового чата: подгрузить историю из мессенджера (WhatsApp, Telegram личный).
    if ((chat as Chat & { inserted?: boolean }).inserted && connector.history) {
      await this.d.queue.add('history', { messageId: 0, chatId: chat.id }, { jobId: `history-${chat.id}-first` }).catch(() => undefined);
    }
    if (ev.attachment) {
      try {
        // Без таймаута зависшее скачивание (прокси или сервер медиа не отвечает) держало сообщение
        // навсегда: задача to-amo не ставилась, и в amoCRM не приходило ничего.
        const { data, mime } = await withTimeout(
          connector.download(ev.attachment.ref, this.d.files.maxBytes),
          this.d.mediaTimeoutMs ?? 90_000,
          'скачивание вложения',
        );
        const file = await this.d.files.save({
          accountId: channel.accountId,
          channelId: channel.id,
          data,
          name: ev.attachment.name,
          mime: ev.attachment.mime ?? mime,
        });
        await this.d.store.setMessageFile(msg.id, file.id);
      } catch (err) {
        this.d.log.warn({ channelId: channel.id, messageId: msg.id, err: (err as Error).message }, 'вложение не скачано');
      }
    }
    await this.d.queue.add('to-amo', { messageId: msg.id }, { jobId: `to-amo-${msg.id}` });
    await this.d.events?.publish(chat.accountId, { type: 'message', chatId: chat.id, messageId: msg.id });
  }

  /** Мессенджер сообщил, что наше сообщение доставлено или прочитано. */
  async onDelivery(channel: Channel, externalChatId: string, externalMessageId: string, status: 'delivered' | 'read'): Promise<void> {
    const chat = await this.d.store.chatByExternal(channel.id, externalChatId);
    if (!chat) return;
    const msg = await this.d.store.setStatusByExternal(chat.id, externalMessageId, status);
    if (!msg) return;
    await this.d.events?.publish(chat.accountId, { type: 'status', chatId: chat.id, messageId: msg.id, status });
    if (status === 'read' && msg.source === 'amo') {
      const conn = await this.d.store.getConnection(chat.accountId);
      if (conn && this.d.amojo && msg.amojoMsgid) await this.d.amojo.deliveryStatus(conn.scopeId, msg.amojoMsgid, 2).catch(() => undefined);
    }
  }

  /** Собеседник прочитал наши сообщения до maxMessageId (Telegram). */
  async onReadUpTo(channel: Channel, peerKey: string, maxMessageId: number): Promise<void> {
    const chat = await this.d.store.chatByPeerKey(channel.id, peerKey);
    if (!chat) return;
    const read = await this.d.store.markReadUpTo(chat.id, maxMessageId);
    if (!read.length) return;
    const conn = read.some((m) => m.source === 'amo' && m.amojoMsgid) ? await this.d.store.getConnection(chat.accountId) : null;
    for (const msg of read) {
      await this.d.events?.publish(chat.accountId, { type: 'status', chatId: chat.id, messageId: msg.id, status: 'read' });
      if (conn && this.d.amojo && msg.source === 'amo' && msg.amojoMsgid) await this.d.amojo.deliveryStatus(conn.scopeId, msg.amojoMsgid, 2).catch(() => undefined);
    }
  }

  /** Мессенджер сообщил, что наше сообщение не доставлено: статус «ошибка» в окне и в amoCRM. */
  async onSendFailed(channel: Channel, externalChatId: string, externalMessageId: string, reason: string): Promise<void> {
    const chat = await this.d.store.chatByExternal(channel.id, externalChatId);
    if (!chat) return;
    const msg = await this.d.store.failByExternal(chat.id, externalMessageId, reason);
    if (!msg) return;
    await this.reportStatus(chat, msg, -1, reason);
    await this.d.events?.publish(chat.accountId, { type: 'status', chatId: chat.id, messageId: msg.id, status: 'failed', error: reason });
  }

  /**
   * История переписки из мессенджера в нашу БД (последние 100 или старше самого старого известного).
   * В окне видна вся история; в ленту amoCRM не передаётся (from_history).
   */
  async importHistory(chatId: number, limit = 100): Promise<number> {
    const chat = await this.d.store.chatById(chatId);
    if (!chat) return 0;
    const channel = await this.d.store.channelById(chat.channelId);
    const connector = channel ? this.d.connector(channel.id) : undefined;
    if (!channel || !connector?.history) throw new Error('История недоступна для этого канала');
    const oldest = await this.d.store.oldestExternalMessage(chatId);
    const before = oldest?.externalId ? { externalMessageId: oldest.externalId, timestamp: Math.floor(oldest.createdAt.getTime() / 1000), fromMe: oldest.direction === 'out' } : null;
    const list = await withTimeout(connector.history(chat.externalChatId, limit, before), 60_000, 'история');
    let count = 0;
    for (const ev of list) {
      const msg = await this.d.store.insertFromChannel({
        chat,
        source: ev.fromMe ? 'phone' : 'client',
        kind: ev.attachment?.kind ?? 'text',
        text: ev.text,
        author: ev.author,
        externalId: ev.externalMessageId,
        replyToExternalId: ev.replyToExternalId,
        fromHistory: true,
        createdAt: new Date(ev.timestamp * 1000),
      });
      if (!msg) continue;
      count++;
      if (ev.attachment) {
        try {
          const { data, mime } = await withTimeout(connector.download(ev.attachment.ref, this.d.files.maxBytes), this.d.mediaTimeoutMs ?? 90_000, 'скачивание вложения');
          const file = await this.d.files.save({ accountId: channel.accountId, channelId: channel.id, data, name: ev.attachment.name, mime: ev.attachment.mime ?? mime });
          await this.d.store.setMessageFile(msg.id, file.id);
        } catch (err) {
          this.d.log.warn({ channelId: channel.id, messageId: msg.id, err: (err as Error).message }, 'вложение истории не скачано');
        }
      }
    }
    await this.d.events?.publish(chat.accountId, { type: 'history', chatId: chat.id, count });
    return count;
  }

  /**
   * Отправка из окна переписки: клиенту — через коннектор, в amoCRM — как исходящее от этого сотрудника
   * (тем же путём, что сообщения с телефона). Текст уходит подписью к первому файлу.
   */
  async sendFromWindow(input: WindowSendInput): Promise<{ messageIds: number[] }> {
    const text = input.text.trim();
    const fileIds = input.fileIds ?? [];
    if (!text && !fileIds.length) throw new StartChatError('Пустое сообщение');
    const chat = await this.d.store.chatOfAccount(input.accountId, input.chatId);
    if (!chat) throw new StartChatError('Чат не найден');
    const channel = await this.d.store.channelById(chat.channelId);
    const connector = channel ? this.d.connector(channel.id) : undefined;
    if (!channel || !connector) throw new StartChatError('Канал сейчас не запущен — проверьте его в настройках виджета');
    if (channel.status !== 'connected') throw new StartChatError('Канал сейчас не подключён');
    const quoted = input.replyToMessageId ? await this.d.store.messageById(input.replyToMessageId) : null;
    const replyToExternalId = quoted && quoted.chatId === chat.id ? quoted.externalId : null;
    let senderName: string | null = null;
    if (this.d.rest) {
      senderName = await this.d.rest.userName(input.accountId, input.userId).catch(() => null);
      const ref = await this.d.rest.userAmojoId(input.accountId, input.userId).catch(() => null);
      if (ref) await this.d.store.rememberAmoOperator(input.accountId, chat.id, ref);
    }
    const parts: { text: string; file: { id: string; data: Buffer; name: string; mime: string; kind: Exclude<AmojoMessageKind, 'text'> } | null }[] = [];
    for (const fileId of fileIds.slice(0, 10)) {
      const rec = await this.d.store.fileById(fileId);
      if (!rec || rec.accountId !== input.accountId) throw new StartChatError('Файл не найден');
      parts.push({ text: parts.length === 0 ? text : '', file: { id: rec.id, data: await this.d.files.read(rec.id), name: rec.name, mime: rec.mime, kind: kindOfMime(rec.mime, rec.name) } });
    }
    if (!parts.length) parts.push({ text, file: null });
    const ids: number[] = [];
    for (const part of parts) {
      const sent = await connector.send({
        externalChatId: chat.externalChatId,
        text: part.text,
        file: part.file ? { data: part.file.data, name: part.file.name, mime: part.file.mime, kind: part.file.kind } : null,
        replyToExternalId: ids.length ? null : replyToExternalId,
      });
      const msg = await this.d.store.insertFromChannel({
        chat,
        source: 'phone',
        kind: part.file?.kind ?? 'text',
        text: part.text,
        author: null,
        externalId: sent.externalMessageId,
        replyToExternalId: ids.length ? null : replyToExternalId,
        senderName,
        senderUserId: input.userId,
      });
      if (!msg) continue;
      if (part.file) await this.d.store.setMessageFile(msg.id, part.file.id);
      ids.push(msg.id);
      try {
        await this.deliverToAmo(msg.id);
      } catch (err) {
        this.d.log.warn({ messageId: msg.id, err: (err as Error).message }, 'сообщение из окна не передано в amo сразу');
        await this.d.queue.add('to-amo', { messageId: msg.id }, { jobId: `to-amo-${msg.id}` });
      }
      await this.d.events?.publish(chat.accountId, { type: 'message', chatId: chat.id, messageId: msg.id });
    }
    return { messageIds: ids };
  }

  /** Повтор недоставленного сообщения из amoCRM (кнопка «Повторить» в окне). */
  async retryMessage(accountId: number, messageId: number): Promise<boolean> {
    const msg = await this.d.store.messageById(messageId);
    if (!msg || msg.accountId !== accountId || msg.source !== 'amo' || msg.status !== 'failed') return false;
    await this.d.store.requeueMessage(msg.id);
    await this.d.queue.add('to-channel', { messageId: msg.id }, { jobId: `to-channel-${msg.id}-retry-${Date.now()}` });
    await this.d.events?.publish(accountId, { type: 'status', chatId: msg.chatId, messageId: msg.id, status: 'queued' });
    return true;
  }

  /**
   * Подбирает входящие, которые сохранены, но не переданы в amo и остались без задачи
   * (процесс перезапустился между сохранением и постановкой в очередь). Повтор безопасен:
   * jobId тот же, а deliverToAmo не отправляет уже переданное.
   */
  async requeueStuckInbound(olderThanSec: number = STUCK_INBOUND_AFTER_SEC): Promise<number> {
    const ids = await this.d.store.stuckInboundIds(olderThanSec);
    for (const id of ids) await this.d.queue.add('to-amo', { messageId: id }, { jobId: `to-amo-${id}` });
    if (ids.length) this.d.log.warn({ count: ids.length }, 'входящие без передачи в amo поставлены в очередь заново');
    return ids.length;
  }

  private clientUser(chat: Chat): AmojoUser {
    return {
      id: `${chat.conversationId}-c`,
      name: chat.title.slice(0, 100),
      ...(chat.contact.phone ? { profile: { phone: chat.contact.phone } } : {}),
      ...(chat.contact.link ? { profile_link: chat.contact.link } : {}),
    };
  }

  private async amoMessage(msg: Message, chat: Chat): Promise<AmojoMessage> {
    const text = chat.isGroup && msg.author ? `${msg.author.name}: ${msg.text}` : msg.text;
    let message: AmojoMessage;
    const file = msg.fileId ? await this.d.store.fileById(msg.fileId) : null;
    if (msg.kind !== 'text' && file) {
      message = { type: msg.kind, media: this.d.files.signedUrl(file), file_name: file.name, file_size: file.size, ...(text ? { text } : {}) };
    } else if (msg.kind !== 'text') {
      message = { type: 'text', text: `[Вложение не получено]${text ? ` ${text}` : ''}` };
    } else {
      message = { type: 'text', text };
    }
    if (msg.replyToMessageId) {
      const quoted = await this.d.store.messageById(msg.replyToMessageId);
      if (quoted?.source === 'amo' && quoted.amojoMsgid) message.reply_to = { message: { id: quoted.amojoMsgid } };
      else if (quoted?.amojoMsgid) message.reply_to = { message: { msgid: ourMsgid(quoted.id) } };
    }
    return message;
  }

  /** Задача to-amo. Повторный запуск безопасен: уже переданное сообщение не отправляется снова. */
  async deliverToAmo(messageId: number): Promise<void> {
    const msg = await this.d.store.messageById(messageId);
    if (!msg || msg.source === 'amo' || msg.amojoMsgid) return;
    const chat = await this.d.store.chatById(msg.chatId);
    if (!chat) return;
    const conn = await this.d.store.getConnection(chat.accountId);
    if (!conn || !this.d.amojo) throw new Error('Канал чатов amoCRM не подключён к аккаунту');
    const client = this.clientUser(chat);
    const fromPhone = msg.source === 'phone';
    // Сообщение с телефона менеджера — исходящее: отправитель — сотрудник amoCRM (ref_id), получатель — клиент.
    // amo принимает исходящее, только если отправитель — его пользователь: без ref_id ответ 400
    // «receiver: exactly one origin user must be provided». Сотрудника узнаём из вебхука amo (onAmoHook).
    let sender: NewMessagePayload['sender'] = client;
    if (fromPhone) {
      const ref = chat.amoOperatorRef ?? conn.amoOperatorRef;
      if (!ref) throw new Error('Сообщение с телефона: неизвестен сотрудник amoCRM — он определится, когда менеджер напишет клиенту из amoCRM');
      sender = { ref_id: ref };
    }
    const ts = Math.floor(msg.createdAt.getTime() / 1000);
    const payload: NewMessagePayload = {
      timestamp: ts,
      msec_timestamp: msg.createdAt.getTime(),
      msgid: ourMsgid(msg.id),
      conversation_id: chat.conversationId,
      sender,
      ...(fromPhone ? { receiver: client } : {}),
      message: await this.amoMessage(msg, chat),
      silent: fromPhone,
    };
    let r;
    try {
      r = await this.d.amojo.sendMessage(conn.scopeId, payload);
    } catch (err) {
      // 403 — канал отключён на стороне amo (например, интеграцию переустановили).
      // Сбрасываем подключение, чтобы виджет снова показал кнопку «Подключить к amoCRM».
      if (err instanceof AmojoError && err.status === 403) {
        await this.d.store.deleteConnection(chat.accountId);
        this.d.log.warn({ accountId: chat.accountId }, 'amo вернул 403: канал чатов отключён от аккаунта, нужно подключить заново');
      }
      throw err;
    }
    await this.d.store.markSynced(msg.id, r.msgid);
    if (r.chatId) await this.d.store.setAmojoChatId(chat.id, r.chatId);
  }

  // ---------- Написать первым ----------

  /**
   * Новая переписка по инициативе менеджера: чат в мессенджере по номеру → чат API чатов amo →
   * привязка к контакту → первое сообщение клиенту → то же сообщение в amo как исходящее от сотрудника.
   * Выполняется в процессе коннекторов (нужен запущенный коннектор канала).
   */
  async startChat(input: StartChatInput): Promise<{ chatId: number; messageId: number }> {
    const text = input.text.trim();
    if (!text) throw new StartChatError('Введите текст первого сообщения');
    const channel = await this.d.store.channelOfAccount(input.accountId, input.channelId);
    if (!channel) throw new StartChatError('Канал не найден');
    const connector = this.d.connector(channel.id);
    if (!connector) throw new StartChatError('Канал сейчас не запущен — проверьте его в настройках виджета');
    if (channel.status !== 'connected') throw new StartChatError('Канал сейчас не подключён — проверьте его в настройках виджета');
    const conn = await this.d.store.getConnection(input.accountId);
    if (!conn || !this.d.amojo) throw new StartChatError('Канал чатов amoCRM не подключён к аккаунту');
    if (!this.d.rest) throw new StartChatError('Нет доступа к amoCRM: интеграция не авторизована');

    let chat: Chat | null;
    if (input.chatId) {
      // VK и MAX: написать можно только тому, кто уже писал сообществу или боту, — чат выбран из существующих.
      if (!CHAT_START_KINDS.has(channel.kind)) throw new StartChatError('Через этот канал можно написать только по номеру телефона');
      chat = await this.d.store.chatById(input.chatId);
      if (!chat || chat.accountId !== input.accountId || chat.channelId !== channel.id || chat.isGroup) throw new StartChatError('Чат не найден');
    } else {
      if (!connector.resolvePhone) throw new StartChatError('Через этот канал нельзя написать первым по номеру');
      const phone = normalizePhone(input.phone ?? '');
      if (!phone) throw new StartChatError('Некорректный номер телефона');
      // Чат с этим номером уже был (клиент писал раньше) — продолжаем его, а не заводим второй.
      chat = await this.d.store.chatByPhone(channel.id, phone);
      if (!chat) {
        // Раздел 6 ТЗ: не больше 20 первых сообщений новым номерам в сутки на номер — защита от блокировки.
        if ((await this.d.store.newChatsStartedToday(channel.id)) >= NEW_CHATS_PER_DAY) {
          throw new StartChatError(`Лимит первых сообщений новым номерам: ${NEW_CHATS_PER_DAY} в сутки на канал. Попробуйте завтра`);
        }
        const peer = await connector.resolvePhone(phone);
        if (!peer) throw new StartChatError(`Номер ${phone} не найден в мессенджере или скрыт настройками приватности`);
        const contact = await this.d.rest.contact(input.accountId, input.contactId);
        chat = await this.d.store.upsertChat(channel, { externalChatId: peer.externalChatId, isGroup: false, title: peer.title ?? contact.name, contact: { phone } });
      }
    }

    const { chatId: amojoChatId } = await this.d.amojo.createChat(conn.scopeId, chat.conversationId, this.clientUser(chat));
    await this.d.store.setAmojoChatId(chat.id, amojoChatId);
    await this.d.rest.linkChat(input.accountId, amojoChatId, input.contactId);
    const ref = await this.d.rest.userAmojoId(input.accountId, input.userId);
    if (ref) await this.d.store.rememberAmoOperator(input.accountId, chat.id, ref);

    const sent = await connector.send({ externalChatId: chat.externalChatId, text, file: null, replyToExternalId: null });
    const msg = await this.d.store.insertFromChannel({
      chat,
      source: 'phone',
      kind: 'text',
      text,
      author: null,
      externalId: sent.externalMessageId,
      replyToExternalId: null,
    });
    if (!msg) throw new Error('Сообщение уже было сохранено');
    try {
      await this.deliverToAmo(msg.id);
    } catch (err) {
      // Клиенту уже ушло: в amo догонит очередь.
      this.d.log.warn({ messageId: msg.id, err: (err as Error).message }, 'первое сообщение не передано в amo сразу');
      await this.d.queue.add('to-amo', { messageId: msg.id }, { jobId: `to-amo-${msg.id}` });
    }
    return { chatId: chat.id, messageId: msg.id };
  }

  // ---------- amoCRM → канал ----------

  /** Вебхук amo (подпись уже проверена, accountId найден по scope_id). */
  async onAmoHook(accountId: number, body: unknown): Promise<HookResult> {
    const parsed = hookSchema.safeParse(body);
    if (!parsed.success) return 'ignored';
    const { conversation, sender, message: m } = parsed.data.message;
    if (!conversation.client_id) return 'unknown_chat';
    const chat = await this.d.store.chatByConversation(accountId, conversation.client_id);
    if (!chat) return 'unknown_chat';
    if (sender && sender.id !== chat.amoOperatorRef) {
      const firstForAccount = await this.d.store.rememberAmoOperator(accountId, chat.id, sender.id);
      // Сообщения с телефона, отклонённые amo без сотрудника, — заново в очередь (отдельный jobId: прежние задачи уже упали).
      if (firstForAccount) {
        for (const id of await this.d.store.pendingPhoneIds(accountId)) {
          await this.d.queue.add('to-amo', { messageId: id }, { jobId: `to-amo-${id}-op` });
        }
      }
    }
    const kind = (KINDS.has(m.type as AmojoMessageKind) ? m.type : 'text') as AmojoMessageKind;
    const media = kind !== 'text' && m.media ? { url: m.media, name: m.file_name || 'file', size: m.file_size } : null;
    const msg = await this.d.store.insertFromAmo({
      chat,
      kind: media ? kind : 'text',
      text: m.text,
      media,
      amojoMsgid: m.id,
      replyToAmojoMsgid: m.reply_to?.message.id ?? null,
      senderName: sender?.name ?? null,
    });
    if (!msg) return 'duplicate';
    const delay = await this.d.pacer.reserve(chat.id);
    await this.d.queue.add('to-channel', { messageId: msg.id }, { jobId: `to-channel-${msg.id}`, delay });
    await this.d.events?.publish(accountId, { type: 'message', chatId: chat.id, messageId: msg.id });
    return 'queued';
  }

  private async reportStatus(chat: Chat, msg: Message, status: 1 | -1, error?: string): Promise<void> {
    const conn = await this.d.store.getConnection(chat.accountId);
    if (!conn || !this.d.amojo || !msg.amojoMsgid) return;
    await this.d.amojo.deliveryStatus(conn.scopeId, msg.amojoMsgid, status, error).catch((err: Error) => {
      this.d.log.warn({ messageId: msg.id, err: err.message }, 'статус доставки не передан в amo');
    });
  }

  private async fail(chat: Chat, msg: Message, error: string): Promise<void> {
    await this.d.store.markFailed(msg.id, error);
    await this.reportStatus(chat, msg, -1, error);
    await this.d.events?.publish(chat.accountId, { type: 'status', chatId: chat.id, messageId: msg.id, status: 'failed', error });
  }

  /** Задача to-channel. lastAttempt — последняя попытка очереди: при ошибке сообщение помечается недоставленным. */
  async deliverToChannel(messageId: number, lastAttempt: boolean): Promise<void> {
    const msg = await this.d.store.messageById(messageId);
    if (!msg || msg.source !== 'amo' || msg.status !== 'queued') return;
    const chat = await this.d.store.chatById(msg.chatId);
    if (!chat) return;
    const channel = await this.d.store.channelById(chat.channelId);
    if (!channel) return this.fail(chat, msg, 'Канал отключён');
    try {
      const connector = this.d.connector(channel.id);
      if (!connector) throw new Error('Коннектор канала не запущен');
      let file = null;
      if (msg.media) {
        const { data, mime } = await downloadFromAmo(msg.media.url, {
          allowedDomains: this.d.amoDomains,
          maxBytes: this.d.files.maxBytes,
          ...(this.d.fetch ? { fetch: this.d.fetch } : {}),
          ...(this.d.resolve ? { resolve: this.d.resolve } : {}),
        });
        const rec = msg.fileId
          ? await this.d.store.fileById(msg.fileId)
          : await this.d.files.save({ accountId: chat.accountId, channelId: channel.id, data, name: msg.media.name, mime });
        if (rec && !msg.fileId) await this.d.store.setMessageFile(msg.id, rec.id);
        file = { data, name: rec?.name ?? msg.media.name, mime, kind: msg.kind === 'text' ? ('file' as const) : msg.kind };
      }
      const quoted = msg.replyToMessageId ? await this.d.store.messageById(msg.replyToMessageId) : null;
      await connector.typing(chat.externalChatId);
      if (this.d.typingMs) await sleep(this.d.typingMs);
      const sent = await connector.send({
        externalChatId: chat.externalChatId,
        text: msg.text,
        file,
        replyToExternalId: quoted?.externalId ?? null,
      });
      await this.d.store.markSent(msg.id, sent.externalMessageId);
      await this.reportStatus(chat, msg, 1);
      await this.d.events?.publish(chat.accountId, { type: 'status', chatId: chat.id, messageId: msg.id, status: 'sent' });
    } catch (err) {
      const text = (err as Error).message;
      if (err instanceof PermanentSendError || lastAttempt) {
        this.d.log.warn({ messageId: msg.id, channelId: channel.id, err: text }, 'сообщение не доставлено');
        return this.fail(chat, msg, text);
      }
      throw err;
    }
  }
}
