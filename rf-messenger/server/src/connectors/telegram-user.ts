import { randomInt } from 'node:crypto';
import bigInt from 'big-integer';
import { Api, TelegramClient } from 'telegram';
import { CustomFile } from 'telegram/client/uploads.js';
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import { StringSession } from 'telegram/sessions/index.js';
import { PermanentSendError, type Connector, type ConnectorSink, type HistoryCursor, type InboundAttachment, type InboundEvent, type OutboundRequest } from './types.ts';

/** Сообщения старше суток при переподключении не переносим. */
const MAX_AGE_SEC = 24 * 3600;
/** Сколько ждать сканирования QR, прежде чем остановить вход. */
const QR_TIMEOUT_MS = 3 * 60_000;

/**
 * Ссылка на собеседника, по которой Telegram примет отправку без кэша сущностей:
 * u:<id>:<access_hash> — человек, c:<id> — обычная группа, ch:<id>:<access_hash> — супергруппа.
 */
export function peerRef(p: { className: string; userId?: unknown; chatId?: unknown; channelId?: unknown; accessHash?: unknown }): string | null {
  if (p.className === 'InputPeerUser') return `u:${String(p.userId)}:${String(p.accessHash)}`;
  if (p.className === 'InputPeerChat') return `c:${String(p.chatId)}`;
  if (p.className === 'InputPeerChannel') return `ch:${String(p.channelId)}:${String(p.accessHash)}`;
  return null;
}

export function inputPeer(ref: string): Api.TypeInputPeer {
  const [kind, id, hash] = ref.split(':');
  if (kind === 'u' && id && hash) return new Api.InputPeerUser({ userId: bigInt(id), accessHash: bigInt(hash) });
  if (kind === 'c' && id) return new Api.InputPeerChat({ chatId: bigInt(id) });
  if (kind === 'ch' && id && hash) return new Api.InputPeerChannel({ channelId: bigInt(id), accessHash: bigInt(hash) });
  throw new PermanentSendError('Неизвестный чат Telegram');
}

/** Минимум сообщения Telegram, нужный для разбора (проверяется тестами без сети). */
export interface TgMessageLike {
  id: number;
  date: number;
  out: boolean;
  text: string;
  replyToMsgId?: number | null;
  media: { kind: InboundAttachment['kind']; name: string; mime?: string; size?: number } | null;
}

export interface TgChatInfo {
  ref: string;
  isGroup: boolean;
  title: string;
  phone?: string;
  username?: string;
  authorName?: string;
  authorId?: string;
}

export function normalizeTgMessage(m: TgMessageLike, chat: TgChatInfo, now: number = Math.floor(Date.now() / 1000), ignoreAge = false): InboundEvent | null {
  if (!ignoreAge && m.date && now - m.date > MAX_AGE_SEC) return null;
  if (!m.text && !m.media) return null;
  return {
    externalChatId: chat.ref,
    chatTitle: chat.title,
    isGroup: chat.isGroup,
    contact: chat.isGroup ? {} : { ...(chat.phone ? { phone: chat.phone } : {}), ...(chat.username ? { username: chat.username, link: `https://t.me/${chat.username}` } : {}) },
    author: chat.isGroup && !m.out && chat.authorId ? { id: chat.authorId, name: chat.authorName ?? chat.authorId } : null,
    externalMessageId: String(m.id),
    text: m.text,
    attachment: m.media ? { ...m.media, ref: `${chat.ref}#${m.id}` } : null,
    replyToExternalId: m.replyToMsgId ? String(m.replyToMsgId) : null,
    timestamp: m.date || now,
    fromMe: m.out,
  };
}

const fullName = (u: { firstName?: string | null; lastName?: string | null; username?: string | null; phone?: string | null }) =>
  [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || (u.username ? `@${u.username}` : u.phone ? `+${u.phone}` : 'Telegram');

/** Вложение сообщения gramjs → вид, имя, тип. */
function mediaOf(msg: Api.Message): TgMessageLike['media'] {
  const f = msg.file;
  const size = f?.size ? Number(f.size) : undefined;
  if (msg.photo) return { kind: 'picture', name: 'photo.jpg', mime: 'image/jpeg', ...(size ? { size } : {}) };
  if (!msg.document) return null;
  const mime = f?.mimeType || 'application/octet-stream';
  const base = { mime, ...(size ? { size } : {}) };
  if (msg.voice) return { kind: 'voice', name: 'voice.ogg', ...base };
  if (msg.sticker) return { kind: 'sticker', name: 'sticker.webp', ...base };
  if (msg.videoNote || msg.video || msg.gif) return { kind: 'video', name: f?.name || 'video.mp4', ...base };
  if (msg.audio) return { kind: 'audio', name: f?.name || 'audio.mp3', ...base };
  return { kind: 'file', name: f?.name || 'file', ...base };
}

export interface TelegramUserDeps {
  apiId: number;
  apiHash: string;
  session: { load(): Promise<string | null>; save(s: string): Promise<void>; clear(): Promise<void> };
  /** Ссылка tg://login для QR в виджете; null — убрать. */
  onQr(url: string | null): Promise<void>;
  /** Пароль двухэтапной проверки из виджета; ждёт, пока его введут. null — вход отменён. */
  password(): Promise<string | null>;
  /** После входа: номер аккаунта. false — уже подключён другим каналом. */
  onIdentity(phone: string): Promise<boolean>;
  log?: (level: 'warn' | 'error', msg: string) => void;
}

/**
 * Личный аккаунт Telegram (MTProto, gramjs): вход по QR, как «Устройства» в Telegram.
 * Сессия хранится зашифрованной в БД. Пишет и принимает от имени аккаунта; можно написать первым по номеру.
 */
export class TelegramUserConnector implements Connector {
  private client: TelegramClient | null = null;
  private sink: ConnectorSink | null = null;
  private stopped = false;
  private health: NodeJS.Timeout | null = null;
  private readonly media = new Map<string, Api.Message>();
  private readonly sentIds = new Set<string>();

  constructor(private readonly d: TelegramUserDeps) {}

  private remember<K, V>(map: Map<K, V> | Set<K>, key: K, value?: V, max = 300): void {
    if (map instanceof Set) map.add(key);
    else map.set(key, value as V);
    if (map.size > max) map.delete(map.keys().next().value as K);
  }

  async start(sink: ConnectorSink): Promise<void> {
    this.sink = sink;
    const saved = await this.d.session.load();
    const session = new StringSession(saved ?? '');
    const client = new TelegramClient(session, this.d.apiId, this.d.apiHash, {
      connectionRetries: 1_000_000,
      retryDelay: 5000,
      autoReconnect: true,
      deviceModel: 'RF Messenger',
      appVersion: '1.0',
      baseLogger: new Logger(LogLevel.ERROR),
    });
    this.client = client;
    await sink.status('starting', 'Подключение к Telegram…');
    await client.connect();
    if (!(await client.checkAuthorization())) {
      if (saved) await this.d.session.clear();
      // Вход идёт в фоне: start() не должен ждать сканирования QR.
      void this.login(client, sink).catch((err: Error) => this.d.log?.('error', `telegram: вход: ${err.message}`));
      return;
    }
    await this.ready(client, sink);
  }

  private async login(client: TelegramClient, sink: ConnectorSink): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('QR_TIMEOUT')), QR_TIMEOUT_MS);
    });
    try {
      await Promise.race([
        client.signInUserWithQrCode(
          { apiId: this.d.apiId, apiHash: this.d.apiHash },
          {
            qrCode: async ({ token }) => {
              await this.d.onQr(`tg://login?token=${Buffer.from(token).toString('base64url')}`);
              await sink.status('starting', 'Отсканируйте QR-код в настройках виджета');
            },
            password: async () => {
              await this.d.onQr(null);
              await sink.status('starting', 'Введите пароль двухэтапной проверки Telegram в настройках виджета');
              const p = await this.d.password();
              if (!p) throw new Error('AUTH_USER_CANCEL');
              return p;
            },
            onError: async (err: Error) => {
              if ((err as { errorMessage?: string }).errorMessage === 'PASSWORD_HASH_INVALID') {
                await sink.status('starting', 'Неверный пароль двухэтапной проверки — введите ещё раз');
                return false;
              }
              return true;
            },
          },
        ),
        timeout,
      ]);
    } catch (err) {
      await this.d.onQr(null);
      if (this.stopped) return;
      const qr = (err as Error).message === 'QR_TIMEOUT';
      await sink.status('session_ended', qr ? 'QR-код не отсканирован вовремя — нажмите «Новый QR»' : 'Вход в Telegram не выполнен — нажмите «Новый QR»');
      await client.disconnect().catch(() => undefined);
      return;
    } finally {
      clearTimeout(timer);
    }
    await this.d.onQr(null);
    await this.d.session.save((client.session as StringSession).save());
    await this.ready(client, sink);
  }

  private async ready(client: TelegramClient, sink: ConnectorSink): Promise<void> {
    const me = await client.getMe();
    const phone = me.phone ? `+${me.phone}` : null;
    if (phone && !(await this.d.onIdentity(phone))) {
      await sink.status('error', `Аккаунт ${phone} уже подключён другим каналом — удалите один из них`);
      await this.stop();
      return;
    }
    client.addEventHandler((ev: NewMessageEvent) => void this.onMessage(ev).catch((err: Error) => this.d.log?.('error', `telegram: входящее: ${err.message}`)), new NewMessage({}));
    // Новое сообщение из Telegram придёт только после первого запроса обновлений.
    await client.getDialogs({ limit: 1 }).catch(() => undefined);
    await sink.status('connected');
    this.health = setInterval(() => void this.checkHealth(), 60_000);
    this.health.unref?.();
  }

  /** Раз в минуту: сессия жива? Отключение на телефоне — «Сессия завершена», обрыв связи — «Нет связи». */
  private async checkHealth(): Promise<void> {
    const client = this.client;
    const sink = this.sink;
    if (!client || !sink || this.stopped) return;
    try {
      await client.invoke(new Api.updates.GetState());
      await sink.status('connected');
    } catch (err) {
      const code = (err as { errorMessage?: string }).errorMessage ?? '';
      if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED|AUTH_KEY_DUPLICATED/.test(code)) {
        await this.d.session.clear();
        await sink.status('session_ended', 'Устройство отключено в Telegram — нажмите «Новый QR» и отсканируйте снова');
        await this.stop();
        return;
      }
      await sink.status('no_phone', 'Нет связи с Telegram, повторное подключение');
    }
  }

  private async chatInfo(msg: Api.Message): Promise<TgChatInfo | null> {
    const input = await msg.getInputChat();
    const ref = input ? peerRef(input as unknown as Parameters<typeof peerRef>[0]) : null;
    if (!ref) return null;
    const chat = await msg.getChat();
    if (chat instanceof Api.User) {
      return { ref, isGroup: false, title: fullName(chat), ...(chat.phone ? { phone: `+${chat.phone}` } : {}), ...(chat.username ? { username: chat.username } : {}) };
    }
    if (chat instanceof Api.Channel && chat.broadcast) return null; // каналы-ленты — не переписка
    const sender = await msg.getSender().catch(() => undefined);
    return {
      ref,
      isGroup: true,
      title: (chat as { title?: string } | undefined)?.title || 'Группа Telegram',
      ...(sender instanceof Api.User ? { authorId: String(sender.id), authorName: fullName(sender) } : {}),
    };
  }

  private async onMessage(ev: NewMessageEvent): Promise<void> {
    const msg = ev.message;
    const sink = this.sink;
    if (!sink || !(msg instanceof Api.Message)) return;
    const info = await this.chatInfo(msg);
    if (!info) return;
    if (msg.out && this.sentIds.has(`${info.ref}#${msg.id}`)) return;
    const reply = msg.replyTo instanceof Api.MessageReplyHeader ? msg.replyTo.replyToMsgId : null;
    const e = normalizeTgMessage({ id: msg.id, date: msg.date, out: Boolean(msg.out), text: msg.message ?? '', replyToMsgId: reply ?? null, media: mediaOf(msg) }, info);
    if (!e) return;
    if (e.attachment) this.remember(this.media, e.attachment.ref, msg);
    await sink.inbound(e);
  }

  private connected(): TelegramClient {
    if (!this.client || this.stopped) throw new Error('Telegram не подключён');
    return this.client;
  }

  async typing(externalChatId: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    await client.invoke(new Api.messages.SetTyping({ peer: inputPeer(externalChatId), action: new Api.SendMessageTypingAction() })).catch(() => undefined);
  }

  async send(req: OutboundRequest): Promise<{ externalMessageId: string }> {
    const client = this.connected();
    const peer = inputPeer(req.externalChatId);
    const replyTo = req.replyToExternalId ? Number(req.replyToExternalId) : undefined;
    try {
      let sent: Api.Message;
      const f = req.file;
      if (!f) sent = await client.sendMessage(peer, { message: req.text, ...(replyTo ? { replyTo } : {}) });
      else {
        sent = await client.sendFile(peer, {
          file: new CustomFile(f.name, f.data.length, '', f.data),
          caption: req.text || '',
          voiceNote: f.kind === 'voice',
          forceDocument: f.kind === 'file',
          supportsStreaming: f.kind === 'video',
          workers: 1,
          ...(replyTo ? { replyTo } : {}),
        });
      }
      this.remember(this.sentIds, `${req.externalChatId}#${sent.id}`);
      return { externalMessageId: String(sent.id) };
    } catch (err) {
      const code = (err as { errorMessage?: string }).errorMessage ?? '';
      if (/USER_IS_BLOCKED|PEER_ID_INVALID|INPUT_USER_DEACTIVATED|USER_PRIVACY_RESTRICTED|CHAT_WRITE_FORBIDDEN|CHANNEL_PRIVATE/.test(code))
        throw new PermanentSendError(`Telegram отклонил сообщение: ${code}`);
      throw err;
    }
  }

  async download(ref: string, maxBytes: number): Promise<{ data: Buffer; mime: string }> {
    const msg = this.media.get(ref);
    const client = this.connected();
    if (!msg) throw new Error('Вложение Telegram уже недоступно');
    const size = msg.file?.size ? Number(msg.file.size) : 0;
    if (size > maxBytes) throw new Error('Вложение больше допустимого размера');
    const data = await client.downloadMedia(msg, {});
    if (!Buffer.isBuffer(data)) throw new Error('Telegram не отдал вложение');
    if (data.length > maxBytes) throw new Error('Вложение больше допустимого размера');
    return { data, mime: mediaOf(msg)?.mime ?? 'application/octet-stream' };
  }

  /** История чата: до limit сообщений старше before (или последних), от старых к новым. */
  async history(externalChatId: string, limit: number, before: HistoryCursor | null): Promise<InboundEvent[]> {
    const client = this.connected();
    const peer = inputPeer(externalChatId);
    const list = await client.getMessages(peer, { limit: Math.min(limit, 100), ...(before ? { offsetId: Number(before.externalMessageId) || 0 } : {}) });
    const out: InboundEvent[] = [];
    for (const msg of list) {
      if (!(msg instanceof Api.Message)) continue;
      const info = await this.chatInfo(msg).catch(() => null);
      if (!info) continue;
      const reply = msg.replyTo instanceof Api.MessageReplyHeader ? msg.replyTo.replyToMsgId : null;
      const e = normalizeTgMessage({ id: msg.id, date: msg.date, out: Boolean(msg.out), text: msg.message ?? '', replyToMsgId: reply ?? null, media: mediaOf(msg) }, info, undefined, true);
      if (!e) continue;
      if (e.attachment) this.remember(this.media, e.attachment.ref, msg);
      out.push(e);
    }
    return out.sort((a, b) => a.timestamp - b.timestamp);
  }

  /** Написать первым: клиент по номеру добавляется в контакты аккаунта (иначе Telegram не даёт написать). */
  async resolvePhone(phone: string): Promise<{ externalChatId: string; title?: string } | null> {
    const client = this.connected();
    const digits = phone.replace(/\D/g, '');
    const r = await client.invoke(
      new Api.contacts.ImportContacts({
        contacts: [new Api.InputPhoneContact({ clientId: bigInt(randomInt(1, 2 ** 31)), phone: digits, firstName: `+${digits}`, lastName: '' })],
      }),
    );
    const user = r.users.find((u): u is Api.User => u instanceof Api.User);
    if (!user || !user.accessHash) return null;
    return { externalChatId: `u:${String(user.id)}:${String(user.accessHash)}`, title: fullName(user) };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.health) clearInterval(this.health);
    this.health = null;
    const client = this.client;
    this.client = null;
    await client?.destroy().catch(() => undefined);
  }

  /** Канал удалён в виджете: завершить сессию на стороне Telegram. */
  async logout(): Promise<void> {
    const client = this.client;
    if (client && !this.stopped) await client.invoke(new Api.auth.LogOut()).catch(() => undefined);
    await this.stop();
    await this.d.session.clear().catch(() => undefined);
  }
}
