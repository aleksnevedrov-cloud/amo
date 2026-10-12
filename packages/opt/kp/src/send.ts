import { randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';
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

export interface KpMailSender {
  send(cfg: SmtpConfig, mail: KpMail): Promise<void>;
}

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
  async send(cfg: SmtpConfig, mail: KpMail): Promise<void> {
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
      await transport.sendMail({ ...mail });
    } finally {
      transport.close();
    }
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
