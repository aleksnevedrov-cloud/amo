import { htmlToText } from '@ai-door/knowledge';
import { simpleParser, type AddressObject, type HeaderValue } from 'mailparser';

export interface IncomingEmail {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: { address: string; name: string } | null;
  to: string[];
  subject: string;
  /** Текст без цитат прошлой переписки и подписи-разделителя. */
  text: string;
  date: Date | null;
  /** Автоответ, рассылка, bounce — отвечать нельзя. */
  automated: boolean;
  /** Письмо отправлено нашим AI (заголовок X-AI-Door). */
  fromAiDoor: boolean;
  attachments: { filename: string | null; contentType: string; size: number; content: Buffer }[];
}

const MAX_TEXT = 8000;

const addresses = (a: AddressObject | AddressObject[] | undefined) =>
  (Array.isArray(a) ? a : a ? [a] : []).flatMap((x) => x.value.map((v) => (v.address ?? '').toLowerCase())).filter(Boolean);

function header(h: Map<string, HeaderValue>, name: string): string {
  const v = h.get(name);
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'value' in (v as object)) return String((v as { value: unknown }).value);
  return String(v);
}

/** Признаки автоматического письма (RFC 3834 и распространённые заголовки). */
export function isAutomated(h: Map<string, HeaderValue>, fromAddress: string): boolean {
  const auto = header(h, 'auto-submitted').toLowerCase();
  if (auto && auto !== 'no') return true;
  if (/^(bulk|junk|list|auto_reply)$/i.test(header(h, 'precedence').trim())) return true;
  // mailparser складывает List-* в общий заголовок «list».
  if (h.has('list') || h.has('list-id') || h.has('list-unsubscribe')) return true;
  if (h.has('x-autoreply') || h.has('x-autorespond') || h.has('x-auto-response-suppress') && /all|oof|autoreply/i.test(header(h, 'x-auto-response-suppress'))) return true;
  return isNoReply(fromAddress);
}

export function isNoReply(address: string): boolean {
  return /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce[s]?|notifications?)([+._-].*)?@/i.test(address);
}

/**
 * Убирает цитаты прошлой переписки: строки с «>», блок после «… пишет:» / «wrote:»,
 * «-----Original Message-----», «-- » (подпись).
 */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const next = lines[i + 1] ?? '';
    if (/^-{2,}\s*(Original Message|Исходное сообщение|Пересылаемое сообщение|Forwarded message)/i.test(line.trim())) break;
    if (/^(--|—)\s*$/.test(line)) break;
    // «24 сент. 2026 г., в 10:00, Иван <ivan@x.ru>:» / «On Mon, ... wrote:» — может переноситься на 2 строки.
    const intro = `${line} ${next}`;
    if (/(пишет|написал[а]?|wrote)\s*:\s*$/i.test(line.trim()) || (/^\S.*\d{1,2}:\d{2}.*$/.test(line) && /(пишет|написал[а]?|wrote)\s*:\s*$/i.test(next.trim()) && intro.includes('@'))) break;
    // Gmail по-русски: «24 сент. 2026 г., в 10:00, Имя <адрес>:» (иногда с переносом строки).
    if (/\d{1,2}:\d{2}/.test(intro) && /<[^>]+@[^>]+>\s*:?\s*$/.test(`${line}`.trim() + (line.trim().endsWith(':') ? '' : ` ${next.trim()}`)) && /:\s*$/.test(intro.trim())) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function parseEmail(source: Buffer | string): Promise<IncomingEmail> {
  const m = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true });
  const fromValue = m.from?.value[0];
  const fromAddress = (fromValue?.address ?? '').toLowerCase();
  const rawText = m.text?.trim() ? m.text : m.html ? htmlToText(m.html).text : '';
  const refs = m.references ? (Array.isArray(m.references) ? m.references : [m.references]) : [];
  return {
    messageId: m.messageId ?? null,
    inReplyTo: m.inReplyTo ?? null,
    references: refs,
    from: fromAddress ? { address: fromAddress, name: fromValue?.name ?? '' } : null,
    to: [...addresses(m.to), ...addresses(m.cc)],
    subject: (m.subject ?? '').trim(),
    text: stripQuoted(rawText).slice(0, MAX_TEXT),
    date: m.date ?? null,
    automated: isAutomated(m.headers, fromAddress),
    fromAiDoor: m.headers.has('x-ai-door'),
    attachments: m.attachments.map((a) => ({ filename: a.filename ?? null, contentType: a.contentType, size: a.size, content: a.content })),
  };
}

/** Адрес или домен в списке исключений (`ivan@x.ru`, `@supplier.ru`, `supplier.ru`). */
export function isIgnored(address: string, ignore: readonly string[]): boolean {
  const a = address.toLowerCase();
  const domain = a.split('@')[1] ?? '';
  return ignore.some((raw) => {
    const x = raw.trim().toLowerCase();
    if (!x) return false;
    if (x.includes('@') && !x.startsWith('@')) return a === x;
    const d = x.replace(/^@/, '');
    return domain === d || domain.endsWith(`.${d}`);
  });
}
