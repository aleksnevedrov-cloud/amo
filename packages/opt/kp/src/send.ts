import { randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import type { KpDraft } from './repo.ts';

/**
 * Отправка КП клиенту (ТЗ разделение, 6.6). Канал один — почта, SMTP ящика, подключённого к amoCRM:
 * amo подтянет письмо в переписку сделки из «Отправленных». Автоотправки нет: письмо уходит
 * только после нажатия в окне предпросмотра; один получатель за отправку.
 */

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
}

export interface KpMail {
  from: { name: string; address: string };
  to: string;
  cc?: string;
  subject: string;
  text: string;
  html: string;
  messageId: string;
  headers: Record<string, string>;
  attachments: { filename: string; content: Buffer }[];
}

/**
 * KP-SENT-COPY: итог отправки — messageId, ответ SMTP (кого принял / отверг, строка ответа) и сам MIME письма (raw):
 * тот же MIME уходит по SMTP, сохраняется .eml рядом с КП и кладётся копией в «Отправленные» по IMAP.
 */
export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  response: string;
  raw: Buffer;
}

/**
 * KP-SENT-COPY: что и как ушло клиенту — в payload черновика (sentMail) и в журнал kp_sent: адреса, тема, текст, вложение,
 * messageId, ответ SMTP, путь .eml (рядом с КП) и судьба копии в «Отправленные».
 */
export interface SentMailRecord {
  at: string;
  messageId: string;
  from: string;
  to: string;
  cc: string | null;
  subject: string;
  text: string;
  attachment: { name: string; bytes: number };
  smtp: { accepted: string[]; rejected: string[]; response: string };
  /** .eml относительно KP_FILES_ROOT; null — сохранить не удалось. */
  eml: string | null;
  copy: { status: 'saved' | 'failed'; folder: string | null; error: string | null };
}

export interface KpMailSender {
  send(cfg: SmtpConfig, mail: KpMail): Promise<SendResult>;
}

/** Получатели конверта SMTP: «Кому» и «Копия» (через запятую). */
export const recipientsOf = (mail: Pick<KpMail, 'to' | 'cc'>): string[] =>
  [mail.to, ...(mail.cc ?? '').split(/[,;]/)].map((x) => x.trim()).filter(Boolean);

/** MIME письма (RFC 822) из KpMail — один раз: его отправляет SMTP и его же кладёт IMAP APPEND. */
export async function buildRawMail(mail: KpMail, date = new Date()): Promise<Buffer> {
  const raw = await new MailComposer({
    from: mail.from,
    to: mail.to,
    ...(mail.cc ? { cc: mail.cc } : {}),
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    messageId: mail.messageId,
    date,
    headers: mail.headers,
    attachments: mail.attachments,
  })
    .compile()
    .build();
  // Переводы строк — CRLF везде: так письмо уходит по SMTP и так его требует IMAP APPEND (RFC 3501); иначе копия отличалась бы.
  return Buffer.from(raw.toString('latin1').replace(/\r?\n/g, '\r\n'), 'latin1');
}

const addressOf = (a: unknown): string => (typeof a === 'string' ? a : String((a as { address?: string } | null)?.address ?? ''));

/** Подстановка {kpNo} и {clientName} в тему и текст из настроек. */
export function renderMailTemplate(template: string, vars: { kpNo: string; clientName: string }): string {
  return template.replace(/\{kpNo\}/g, vars.kpNo).replace(/\{clientName\}/g, vars.clientName).replace(/ {2,}/g, ' ').trim();
}

export function composeKpMail(input: {
  from: { name: string; address: string };
  to: string;
  cc?: string;
  subject: string;
  text: string;
  signature: string;
  attachment: { filename: string; content: Buffer };
}): KpMail {
  const domain = input.from.address.split('@')[1] ?? 'localhost';
  const text = input.signature.trim() ? `${input.text.trim()}\n\n--\n${input.signature.trim()}` : input.text.trim();
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;white-space:pre-wrap">${escapeHtml(text)}</div>`;
  return {
    from: input.from,
    to: input.to.trim(),
    ...(input.cc?.trim() ? { cc: input.cc.trim() } : {}),
    subject: input.subject.trim(),
    text,
    html,
    // Без Auto-Submitted: письмо отправляет человек кнопкой, это не автоответ.
    messageId: `<ai-door-kp.${Date.now().toString(36)}.${randomBytes(6).toString('hex')}@${domain}>`,
    headers: { 'X-AI-Door': 'opt' },
    attachments: [input.attachment],
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Проверки перед отправкой (6.6): любая не прошла — кнопка неактивна, причина на экране.
 * Возвращает список причин; пустой список — отправлять можно.
 */
export function sendBlockers(args: {
  draft: Pick<KpDraft, 'status' | 'docxPath' | 'pdfPath' | 'sentAt'>;
  /** Размер файла КП на диске; null — файла нет. */
  fileBytes: number | null;
  to: string;
  resendConfirmed: boolean;
}): string[] {
  const reasons: string[] = [];
  const d = args.draft;
  if (d.status !== 'built' && d.status !== 'sent') reasons.push('документ ещё не собран');
  if (!(d.pdfPath ?? d.docxPath) || args.fileBytes === null) reasons.push('файл КП не найден на диске');
  if (!EMAIL_RE.test(args.to.trim())) reasons.push('адрес получателя пустой или не похож на e-mail');
  if (args.fileBytes !== null && args.fileBytes > MAX_ATTACHMENT_BYTES) reasons.push('вложение больше 25 МБ');
  if (d.status === 'sent' && !args.resendConfirmed) reasons.push('это КП уже отправлялось — нужно подтверждение повторной отправки');
  return reasons;
}

export class SmtpKpSender implements KpMailSender {
  async send(cfg: SmtpConfig, mail: KpMail): Promise<SendResult> {
    const raw = await buildRawMail(mail);
    const transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.username, pass: cfg.password },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
    try {
      // Готовый MIME (raw) с конвертом: по SMTP уходит ровно то, что потом лежит в .eml и в «Отправленных».
      const info = await transport.sendMail({ envelope: { from: mail.from.address, to: recipientsOf(mail) }, raw });
      return { messageId: mail.messageId, accepted: (info.accepted ?? []).map(addressOf), rejected: (info.rejected ?? []).map(addressOf), response: String(info.response ?? ''), raw };
    } finally {
      transport.close();
    }
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
