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

  static async connect(cfg: MailServerConfig): Promise<ImapMailbox> {
    const client = new ImapFlow({
      host: cfg.imapHost,
      port: cfg.imapPort,
      secure: cfg.imapSecure,
      auth: { user: cfg.username, pass: cfg.password },
      logger: false,
      disableAutoIdle: true,
    });
    await client.connect();
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
