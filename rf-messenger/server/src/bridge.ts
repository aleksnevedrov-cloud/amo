import { z } from 'zod';
import { AmojoError, type AmojoClient, type AmojoMessage, type AmojoMessageKind, type AmojoUser, type NewMessagePayload } from './amojo/client.ts';
import { PermanentSendError, type Connector, type InboundEvent } from './connectors/types.ts';
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
}

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
    const ts = Math.floor(msg.createdAt.getTime() / 1000);
    const payload: NewMessagePayload = {
      timestamp: ts,
      msec_timestamp: msg.createdAt.getTime(),
      msgid: ourMsgid(msg.id),
      conversation_id: chat.conversationId,
      // Сообщение с телефона менеджера — исходящее: отправитель — менеджер, получатель — клиент.
      sender: fromPhone ? { id: `rfm-op-${chat.channelId}`, name: 'Менеджер (с телефона)' } : client,
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

  // ---------- amoCRM → канал ----------

  /** Вебхук amo (подпись уже проверена, accountId найден по scope_id). */
  async onAmoHook(accountId: number, body: unknown): Promise<HookResult> {
    const parsed = hookSchema.safeParse(body);
    if (!parsed.success) return 'ignored';
    const { conversation, message: m } = parsed.data.message;
    if (!conversation.client_id) return 'unknown_chat';
    const chat = await this.d.store.chatByConversation(accountId, conversation.client_id);
    if (!chat) return 'unknown_chat';
    const kind = (KINDS.has(m.type as AmojoMessageKind) ? m.type : 'text') as AmojoMessageKind;
    const media = kind !== 'text' && m.media ? { url: m.media, name: m.file_name || 'file', size: m.file_size } : null;
    const msg = await this.d.store.insertFromAmo({
      chat,
      kind: media ? kind : 'text',
      text: m.text,
      media,
      amojoMsgid: m.id,
      replyToAmojoMsgid: m.reply_to?.message.id ?? null,
    });
    if (!msg) return 'duplicate';
    const delay = await this.d.pacer.reserve(chat.id);
    await this.d.queue.add('to-channel', { messageId: msg.id }, { jobId: `to-channel-${msg.id}`, delay });
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
