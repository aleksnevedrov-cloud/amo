import { randomBytes } from 'node:crypto';

export interface ReplyTarget {
  /** Адрес клиента. */
  to: string;
  toName?: string;
  subject: string;
  /** Message-ID письма клиента, на которое отвечаем. */
  inReplyTo: string | null;
  references: string[];
}

export interface OutgoingEmail {
  from: { name: string; address: string };
  to: { name: string; address: string };
  subject: string;
  text: string;
  html: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  headers: Record<string, string>;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** «Re: » один раз, без «Re: Re: Fwd:». */
export function replySubject(subject: string): string {
  const base = subject.replace(/^((re|fwd?|ответ|отв)\s*(\[\d+\])?\s*:\s*)+/i, '').trim();
  return `Re: ${base || 'Ваш запрос'}`;
}

/** Ответ клиенту в ту же цепочку писем. Помечается X-AI-Door — чтобы узнавать свои письма. */
export function buildReply(
  from: { name: string; address: string },
  target: ReplyTarget,
  body: string,
  signature: string,
): OutgoingEmail {
  const domain = from.address.split('@')[1] ?? 'localhost';
  const messageId = `<ai-door.${Date.now().toString(36)}.${randomBytes(6).toString('hex')}@${domain}>`;
  const text = signature.trim() ? `${body.trim()}\n\n--\n${signature.trim()}` : body.trim();
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;white-space:pre-wrap">${escapeHtml(text)}</div>`;
  const refs = [...target.references, ...(target.inReplyTo ? [target.inReplyTo] : [])].slice(-20);
  return {
    from,
    to: { name: target.toName ?? '', address: target.to },
    subject: replySubject(target.subject),
    text,
    html,
    messageId,
    ...(target.inReplyTo ? { inReplyTo: target.inReplyTo } : {}),
    ...(refs.length ? { references: refs } : {}),
    headers: { 'X-AI-Door': '1', 'Auto-Submitted': 'auto-replied' },
  };
}
