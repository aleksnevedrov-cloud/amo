import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import type { OutgoingEmail } from './reply.ts';

export interface MailServerConfig {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  username: string;
  password: string;
}

export interface FetchedMessage {
  uid: number;
  source: Buffer;
}

/** Ящик по IMAP. Папки открываются только на чтение: флаги писем не меняются. */
export interface Mailbox {
  /** Текущая UIDVALIDITY и максимальный UID папки. */
  folderState(folder: string): Promise<{ uidValidity: string; maxUid: number }>;
  /** Письма с UID > afterUid (не больше limit). */
  fetchAfter(folder: string, afterUid: number, limit: number): Promise<FetchedMessage[]>;
  /** Папка «Отправленные» по специальной метке \Sent. */
  findSentFolder(): Promise<string | null>;
  append(folder: string, raw: Buffer): Promise<void>;
  close(): Promise<void>;
}

/** Ошибка imapflow: поля, по которым отличаем отказ входа и причину закрытия соединения. */
export interface ImapError extends Error {
  code?: string;
  /** Сервер отверг логин и пароль (imapflow ставит при LOGIN/AUTHENTICATE, а также при «Already logged out»). */
  authenticationFailed?: boolean;
  serverResponseCode?: string;
  responseText?: string;
  /** Причина BYE от сервера при неожиданном закрытии, например «Too many connections». */
  reason?: string;
}

/** Обратные вызовы ящика; все необязательные. */
export interface MailboxHooks {
  /** Событие 'error' imapflow: соединение уже закрыто библиотекой, ящик дальше не используется. */
  onError?(err: ImapError): void;
}

const AUTH_ERROR_RE = /AUTHENTICATIONFAILED|authentication failed|invalid credentials|Login denied|\b535\b/i;

/** Отказ входа: по флагу imapflow или по тексту ответа сервера. */
export function isAuthFailure(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as ImapError;
  return e.authenticationFailed === true || AUTH_ERROR_RE.test(imapErrorText(e));
}

/** Текст ошибки для журнала и статуса: сообщение, код ответа сервера, причина BYE. */
export function imapErrorText(err: unknown): string {
  const e = (err ?? {}) as ImapError;
  return [e.message, e.serverResponseCode, e.responseText, e.reason ? `BYE: ${e.reason}` : null].filter(Boolean).join(' ');
}

export interface MailSender {
  /** Отправка готового письма; возвращает сырой MIME для «Отправленных». */
  send(mail: OutgoingEmail): Promise<Buffer>;
  verify(): Promise<void>;
}

/** Сборка MIME без отправки — тот же текст уходит по SMTP и в «Отправленные». */
export async function composeRaw(mail: OutgoingEmail): Promise<Buffer> {
  const t = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
  const info = await t.sendMail({ ...mail });
  return info.message as Buffer;
}

export class SmtpSender implements MailSender {
  private readonly transport;

  constructor(cfg: MailServerConfig) {
    this.transport = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort,
      secure: cfg.smtpSecure,
      auth: { user: cfg.username, pass: cfg.password },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
  }

  async send(mail: OutgoingEmail): Promise<Buffer> {
    const raw = await composeRaw(mail);
    await this.transport.sendMail({ envelope: { from: mail.from.address, to: [mail.to.address] }, raw });
    return raw;
  }

  async verify(): Promise<void> {
    await this.transport.verify();
  }
}

export class ImapMailbox implements Mailbox {
  private constructor(private readonly client: ImapFlow) {}

  /**
   * Подключение и вход. Обработчик 'error' вешается до connect(): imapflow выпускает это событие
   * и после отказа connect() — когда сервер закрыл сокет во время входа (BYE между CAPABILITY и LOGIN),
   * библиотека отклоняет connect() ошибкой «Unexpected close», а следом выпускает 'error'
   * с authenticationFailed («Already logged out»). Без обработчика Node роняет весь процесс —
   * так падал worker розницы 12.10.2026.
   */
  static async connect(cfg: MailServerConfig, hooks: MailboxHooks = {}): Promise<ImapMailbox> {
    const client = new ImapFlow({
      host: cfg.imapHost,
      port: cfg.imapPort,
      secure: cfg.imapSecure,
      auth: { user: cfg.username, pass: cfg.password },
      logger: false,
      disableAutoIdle: true,
    });
    let emitted: ImapError | null = null;
    client.on('error', (err: ImapError) => {
      emitted ??= err;
      hooks.onError?.(err);
    });
    try {
      await client.connect();
    } catch (err) {
      // Хвостовое событие 'error' приходит на следующем тике — ждём его, чтобы отказ входа не потерялся.
      await new Promise((resolve) => setImmediate(resolve));
      client.close();
      throw mergeEmitted(err as ImapError, emitted);
    }
    return new ImapMailbox(client);
  }

  async folderState(folder: string) {
    const box = await this.client.mailboxOpen(folder, { readOnly: true });
    return { uidValidity: String(box.uidValidity), maxUid: Math.max((box.uidNext ?? 1) - 1, 0) };
  }

  async fetchAfter(folder: string, afterUid: number, limit: number): Promise<FetchedMessage[]> {
    const lock = await this.client.getMailboxLock(folder, { readOnly: true });
    try {
      const out: FetchedMessage[] = [];
      // UID-диапазон «afterUid+1:*»; source — полный MIME без пометки \Seen (readOnly + BODY.PEEK).
      for await (const m of this.client.fetch(`${afterUid + 1}:*`, { uid: true, source: true }, { uid: true })) {
        // «N:*» при отсутствии новых писем возвращает последнее — отсекаем.
        if (m.uid > afterUid && m.source) out.push({ uid: m.uid, source: m.source });
        if (out.length >= limit) break;
      }
      return out.sort((a, b) => a.uid - b.uid);
    } finally {
      lock.release();
    }
  }

  async findSentFolder(): Promise<string | null> {
    const list = await this.client.list();
    return list.find((f) => f.specialUse === '\\Sent')?.path ?? null;
  }

  async append(folder: string, raw: Buffer): Promise<void> {
    await this.client.append(folder, raw, ['\\Seen']);
  }

  async close(): Promise<void> {
    await this.client.logout().catch(() => this.client.close());
  }
}

/** Ошибка connect() дополняется тем, что imapflow сообщил событием 'error' (флаг отказа входа и текст). */
function mergeEmitted(err: ImapError, emitted: ImapError | null): ImapError {
  if (!emitted || emitted === err) return err;
  if (emitted.authenticationFailed && !err.authenticationFailed) err.authenticationFailed = true;
  if (emitted.message && !err.message.includes(emitted.message)) err.message = `${err.message}; ${emitted.message}`;
  return err;
}
