import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  type AnyMessageContent,
  type WAMessage,
  type WASocket,
  type proto,
} from 'baileys';
import type { ILogger } from 'baileys/lib/Utils/logger.js';
import { createDbAuthState, type SessionStorage } from './wa-auth.ts';
import { PermanentSendError, reconnectDelayMs, type Connector, type ConnectorSink, type InboundAttachment, type InboundEvent, type OutboundRequest } from './types.ts';

/** Сообщения старше суток при переподключении не переносим — это история, а не новая переписка. */
const MAX_AGE_SEC = 24 * 3600;

const isGroupJid = (jid: string) => jid.endsWith('@g.us');
const phoneOf = (jid: string | null | undefined): string | undefined => {
  const m = jid?.match(/^(\d{6,15})(?::\d+)?@s\.whatsapp\.net$/);
  return m ? `+${m[1]}` : undefined;
};

/** Снимает обёртки WhatsApp (исчезающие, «одноразовые», документ с подписью). */
function unwrap(m: proto.IMessage | null | undefined): proto.IMessage | null {
  let cur = m ?? null;
  for (let i = 0; i < 5 && cur; i++) {
    const inner =
      cur.ephemeralMessage?.message ??
      cur.viewOnceMessage?.message ??
      cur.viewOnceMessageV2?.message ??
      cur.viewOnceMessageV2Extension?.message ??
      cur.documentWithCaptionMessage?.message ??
      cur.editedMessage?.message;
    if (!inner) break;
    cur = inner;
  }
  return cur;
}

function contextOf(m: proto.IMessage): proto.IContextInfo | null | undefined {
  return (
    m.extendedTextMessage?.contextInfo ??
    m.imageMessage?.contextInfo ??
    m.videoMessage?.contextInfo ??
    m.audioMessage?.contextInfo ??
    m.documentMessage?.contextInfo ??
    m.stickerMessage?.contextInfo
  );
}

function attachmentOf(m: proto.IMessage, ref: string): InboundAttachment | null {
  const size = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));
  if (m.imageMessage) return { kind: 'picture', ref, name: 'photo.jpg', mime: m.imageMessage.mimetype ?? 'image/jpeg', size: size(m.imageMessage.fileLength) };
  if (m.videoMessage) return { kind: 'video', ref, name: 'video.mp4', mime: m.videoMessage.mimetype ?? 'video/mp4', size: size(m.videoMessage.fileLength) };
  if (m.audioMessage) {
    const voice = Boolean(m.audioMessage.ptt);
    return { kind: voice ? 'voice' : 'audio', ref, name: voice ? 'voice.ogg' : 'audio.mp3', mime: m.audioMessage.mimetype ?? 'audio/ogg', size: size(m.audioMessage.fileLength) };
  }
  if (m.stickerMessage) return { kind: 'sticker', ref, name: 'sticker.webp', mime: m.stickerMessage.mimetype ?? 'image/webp', size: size(m.stickerMessage.fileLength) };
  if (m.documentMessage)
    return { kind: 'file', ref, name: m.documentMessage.fileName || 'file', mime: m.documentMessage.mimetype ?? 'application/octet-stream', size: size(m.documentMessage.fileLength) };
  return null;
}

/**
 * Сообщение Baileys → общее событие канала. null — служебное (статусы, реакции, удаление и т. п.).
 * Чистая функция: проверяется тестами без сети.
 */
export function normalizeWaMessage(msg: WAMessage, opts: { now?: number; groupTitle?: (jid: string) => string | undefined } = {}): InboundEvent | null {
  const key = msg.key as WAMessage['key'] & { remoteJidAlt?: string; participantAlt?: string };
  const jid = key.remoteJid;
  if (!jid || !key.id || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return null;
  const m = unwrap(msg.message);
  if (!m || m.protocolMessage || m.reactionMessage || m.senderKeyDistributionMessage && Object.keys(m).length === 1) return null;
  const ts = Number(msg.messageTimestamp ?? 0);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (ts && now - ts > MAX_AGE_SEC) return null;

  const attachment = attachmentOf(m, key.id);
  const text =
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    (m.contactMessage ? `[Контакт] ${m.contactMessage.displayName ?? ''}`.trim() : null) ??
    (m.locationMessage ? `[Геопозиция] https://maps.google.com/?q=${m.locationMessage.degreesLatitude},${m.locationMessage.degreesLongitude}` : null) ??
    '';
  if (!text && !attachment) return null;

  const group = isGroupJid(jid);
  const fromMe = Boolean(key.fromMe);
  const name = msg.pushName?.trim() || undefined;
  const phone = phoneOf(jid) ?? phoneOf(key.remoteJidAlt);
  const authorJid = group ? (key.participant ?? undefined) : undefined;
  const local = jid.split('@')[0] ?? jid;
  const replyTo = contextOf(m)?.stanzaId ?? null;

  return {
    externalChatId: jid,
    chatTitle: group ? (opts.groupTitle?.(jid) ?? 'Группа WhatsApp') : fromMe ? (phone ?? local) : (name ?? phone ?? local),
    isGroup: group,
    contact: group ? {} : { ...(phone ? { phone } : {}) },
    author: group && !fromMe && authorJid ? { id: authorJid, name: name ?? phoneOf(authorJid) ?? phoneOf(key.participantAlt) ?? (authorJid.split('@')[0] ?? authorJid) } : null,
    externalMessageId: key.id,
    text,
    attachment,
    replyToExternalId: replyTo,
    timestamp: ts || now,
    fromMe,
  };
}

/** Тихий логгер для Baileys: предупреждения и ошибки — в наш журнал, остальное отбрасываем. */
function quietLogger(log?: (level: 'warn' | 'error', msg: string) => void): ILogger {
  const noop = () => undefined;
  const l: ILogger = {
    level: 'warn',
    child: () => l,
    trace: noop,
    debug: noop,
    info: noop,
    warn: (obj, msg) => log?.('warn', msg ?? (typeof obj === 'string' ? obj : 'baileys warn')),
    error: (obj, msg) => log?.('error', msg ?? (typeof obj === 'string' ? obj : 'baileys error')),
  };
  return l;
}

export interface WhatsAppDeps {
  session: SessionStorage & { clear(): Promise<void> };
  /** QR для виджета: строка — показать, null — убрать. */
  onQr(qr: string | null): Promise<void>;
  /** После входа: номер телефона. false — номер уже подключён другим каналом. */
  onIdentity(phone: string): Promise<boolean>;
  log?: (level: 'warn' | 'error', msg: string) => void;
  /** Для тестов: подмена makeWASocket. */
  makeSocket?: typeof makeWASocket;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * WhatsApp по QR (связанное устройство) на Baileys — без браузера.
 * Сессия хранится зашифрованной в БД, переподключение — с растущей паузой (раздел 6 ТЗ).
 */
export class WhatsAppConnector implements Connector {
  private sock: WASocket | null = null;
  private readonly abort = new AbortController();
  /** Последние входящие с медиа — для скачивания вложения по ref (id сообщения). */
  private readonly media = new Map<string, WAMessage>();
  /** id отправленных нами сообщений: WhatsApp присылает их обратно, это не «сообщение с телефона». */
  private readonly sentIds = new Set<string>();
  private readonly groupTitles = new Map<string, string>();
  private failures = 0;
  private sink: ConnectorSink | null = null;
  private auth: Awaited<ReturnType<typeof createDbAuthState>> | null = null;

  constructor(private readonly d: WhatsAppDeps) {}

  async start(sink: ConnectorSink): Promise<void> {
    this.sink = sink;
    await this.connect();
  }

  private remember<K, V>(map: Map<K, V> | Set<K>, key: K, value?: V, max = 300): void {
    if (map instanceof Set) map.add(key);
    else map.set(key, value as V);
    if (map.size > max) {
      const first = map.keys().next().value as K;
      map.delete(first);
    }
  }

  private async connect(): Promise<void> {
    if (this.abort.signal.aborted || !this.sink) return;
    const sink = this.sink;
    this.auth = await createDbAuthState(this.d.session);
    const auth = this.auth;
    const make = this.d.makeSocket ?? makeWASocket;
    const sock = make({
      auth: auth.state,
      logger: quietLogger(this.d.log),
      browser: Browsers.ubuntu('RF Messenger'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined,
    });
    this.sock = sock;
    let qrShown = false;
    if (!auth.registered) await sink.status('starting', 'Подключение к WhatsApp…');

    sock.ev.on('creds.update', () => void auth.saveCreds());

    sock.ev.on('connection.update', (u) => {
      void (async () => {
        if (u.qr) {
          qrShown = true;
          await this.d.onQr(u.qr);
          await sink.status('starting', 'Отсканируйте QR-код в настройках виджета');
        }
        if (u.connection === 'open') {
          this.failures = 0;
          await this.d.onQr(null);
          const phone = sock.user?.id ? (phoneOf(sock.user.id) ?? `+${sock.user.id.split(/[:@]/)[0]}`) : null;
          if (phone && !(await this.d.onIdentity(phone))) {
            await sink.status('error', `Номер ${phone} уже подключён другим каналом — удалите один из них`);
            await this.shutdown(true);
            return;
          }
          await auth.flush();
          await sink.status('connected');
        }
        if (u.connection === 'close') {
          const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
          this.sock = null;
          if (this.abort.signal.aborted) return;
          if (code === DisconnectReason.loggedOut) {
            await this.d.session.clear();
            await this.d.onQr(null);
            await sink.status('session_ended', 'Устройство отключено в WhatsApp на телефоне — нажмите «Новый QR» и отсканируйте снова');
            return;
          }
          if (code === DisconnectReason.connectionReplaced) {
            await sink.status('error', 'Сессия открыта в другом месте — проверьте «Связанные устройства» на телефоне');
            return;
          }
          // QR показывали, но его не отсканировали. Если QR так и не пришёл — это обрыв связи, переподключаемся.
          if (!auth.registered && qrShown && code === DisconnectReason.timedOut) {
            await this.d.onQr(null);
            await sink.status('session_ended', 'QR-код не отсканирован вовремя — нажмите «Новый QR»');
            return;
          }
          // Обычный обрыв или «restartRequired» после первого входа — переподключаемся.
          this.failures = code === DisconnectReason.restartRequired ? 0 : this.failures + 1;
          if (this.failures > 0) await sink.status('no_phone', 'Нет связи с WhatsApp, повторное подключение');
          await sleep(this.failures === 0 ? 500 : reconnectDelayMs(this.failures), this.abort.signal);
          await this.connect();
        }
      })().catch((err: Error) => this.d.log?.('error', `whatsapp connection.update: ${err.message}`));
    });

    sock.ev.on('messages.upsert', ({ messages }) => {
      void (async () => {
        for (const msg of messages) {
          const id = msg.key.id;
          if (!id || (msg.key.fromMe && this.sentIds.has(id))) continue;
          const jid = msg.key.remoteJid ?? '';
          if (isGroupJid(jid) && !this.groupTitles.has(jid)) {
            const meta = await sock.groupMetadata(jid).catch(() => null);
            if (meta?.subject) this.remember(this.groupTitles, jid, meta.subject);
          }
          const ev = normalizeWaMessage(msg, { groupTitle: (j) => this.groupTitles.get(j) });
          if (!ev) continue;
          if (ev.attachment) this.remember(this.media, id, msg);
          await sink.inbound(ev);
        }
      })().catch((err: Error) => this.d.log?.('error', `whatsapp messages.upsert: ${err.message}`));
    });
  }

  private async shutdown(logout: boolean): Promise<void> {
    this.abort.abort();
    const sock = this.sock;
    this.sock = null;
    await this.auth?.flush().catch(() => undefined);
    if (!sock) return;
    if (logout) await sock.logout().catch(() => undefined);
    else sock.end(undefined);
  }

  async stop(): Promise<void> {
    await this.shutdown(false);
  }

  /** Канал удалён в виджете: отвязать устройство на телефоне. */
  async logout(): Promise<void> {
    await this.shutdown(true);
    await this.d.session.clear().catch(() => undefined);
  }

  async typing(externalChatId: string): Promise<void> {
    await this.sock?.sendPresenceUpdate('composing', externalChatId).catch(() => undefined);
  }

  async send(req: OutboundRequest): Promise<{ externalMessageId: string }> {
    const sock = this.sock;
    if (!sock) throw new Error('WhatsApp не подключён');
    let content: AnyMessageContent;
    const f = req.file;
    if (!f) content = { text: req.text };
    else if (f.kind === 'picture') content = { image: f.data, caption: req.text || undefined, mimetype: f.mime };
    else if (f.kind === 'video') content = { video: f.data, caption: req.text || undefined, mimetype: f.mime };
    else if (f.kind === 'voice') content = { audio: f.data, ptt: true, mimetype: 'audio/ogg; codecs=opus' };
    else if (f.kind === 'audio') content = { audio: f.data, mimetype: f.mime || 'audio/mpeg' };
    else if (f.kind === 'sticker') content = { sticker: f.data };
    else content = { document: f.data, mimetype: f.mime || 'application/octet-stream', fileName: f.name, caption: req.text || undefined };

    const quoted = req.replyToExternalId
      ? ({ key: { remoteJid: req.externalChatId, id: req.replyToExternalId, fromMe: false }, message: { conversation: '' } } as WAMessage)
      : undefined;
    try {
      const sent = await sock.sendMessage(req.externalChatId, content, quoted ? { quoted } : {});
      const id = sent?.key.id;
      if (!id) throw new Error('WhatsApp не вернул id сообщения');
      this.remember(this.sentIds, id);
      // Голосовое/аудио без подписи: текст менеджера отправляем отдельным сообщением.
      if (f && (f.kind === 'voice' || f.kind === 'audio' || f.kind === 'sticker') && req.text) {
        const extra = await sock.sendMessage(req.externalChatId, { text: req.text });
        if (extra?.key.id) this.remember(this.sentIds, extra.key.id);
      }
      return { externalMessageId: id };
    } catch (err) {
      const status = (err as { output?: { statusCode?: number } }).output?.statusCode;
      if (status === 400 || status === 404) throw new PermanentSendError('WhatsApp отклонил сообщение: номер не найден или чат недоступен');
      throw err;
    }
  }

  async download(ref: string, maxBytes: number): Promise<{ data: Buffer; mime: string }> {
    const msg = this.media.get(ref);
    if (!msg || !this.sock) throw new Error('Вложение WhatsApp уже недоступно');
    const sock = this.sock;
    const data = await downloadMediaMessage(msg, 'buffer', {}, { logger: quietLogger(this.d.log), reuploadRequest: sock.updateMediaMessage });
    if (data.length > maxBytes) throw new Error('Вложение больше допустимого размера');
    const m = unwrap(msg.message);
    const mime = m ? (attachmentOf(m, ref)?.mime ?? 'application/octet-stream') : 'application/octet-stream';
    return { data, mime };
  }
}
