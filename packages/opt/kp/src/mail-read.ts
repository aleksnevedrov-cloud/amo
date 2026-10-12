import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

/**
 * Чтение письма заявки из ящика, подключённого к amoCRM (RFD-AI-AGENT-OPT-MAIL-READ, вариант А, 12.10.2026).
 *
 * API amoCRM отдаёт из письма только тему и первую строку, а вложения письма в файлы сделки
 * не попадают. Поэтому по кнопке «Собрать КП» опт сам читает ящик по IMAP — ТОЛЬКО НА ЧТЕНИЕ:
 * папка открывается через EXAMINE (readOnly), тело берётся BODY.PEEK, флаги \Seen не ставятся,
 * письма не перемещаются и не удаляются. Фонового опроса нет: ящик читается только по кнопке.
 * Логин и пароль — те же, что для SMTP во вкладке «Письмо» (пароль приложения Яндекса).
 */

export interface MailReadConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
}

export interface MailSearch {
  /** Адрес отправителя (из последнего входящего письма сделки или email контакта). */
  from: string;
  /** Дата письма по карточке; ищем ±1 день. */
  around: Date;
  /** Тема, если известна: при совпадении берётся письмо с ней, иначе — самое свежее от отправителя. */
  subject?: string | null;
}

export interface MailAttachment {
  filename: string | null;
  contentType: string;
  size: number;
  content: Buffer;
  /** Встроенная картинка (cid / inline): мелкие пропускаем как подписи и логотипы. */
  inline: boolean;
}

export interface FetchedMail {
  uid: number;
  messageId: string | null;
  from: string;
  subject: string;
  date: Date | null;
  /** Полный текст без цитат прошлой переписки и подписи-разделителя. */
  text: string;
  attachments: MailAttachment[];
}

/** Лимиты вложений — те же, что у почты розницы. */
export const MAIL_MAX_FILES = 10;
export const MAIL_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAIL_MAX_TOTAL_BYTES = 60 * 1024 * 1024;
export const MAIL_MIN_INLINE_BYTES = 20 * 1024;

/** Пауза после ошибки входа: Яндекс блокирует IP при частых неверных входах (как в рознице). */
export const MAIL_AUTH_PAUSE_MS = 30 * 60_000;
const MAX_TEXT = 12_000;
const MAX_CANDIDATES = 50;

/** Ошибка входа в ящик; retryAt — когда можно пробовать снова. */
export class MailAuthError extends Error {
  constructor(
    message: string,
    public readonly retryAt: Date,
  ) {
    super(message);
    this.name = 'MailAuthError';
  }
}

const authPause = new Map<string, number>();
const pauseKey = (c: MailReadConfig) => `${c.username}@${c.host}:${c.port}`;

/** Сброс пауз после ошибок входа (для тестов). */
export function resetMailAuthPauses(): void {
  authPause.clear();
}

const moscowTime = (ms: number) => new Date(ms).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });

interface ImapError extends Error {
  authenticationFailed?: boolean;
  serverResponseCode?: string;
  responseText?: string;
}

const AUTH_RE = /AUTHENTICATIONFAILED|authentication failed|invalid credentials|Login denied|\b535\b/i;
const isAuthFailure = (err: unknown) => {
  const e = (err ?? {}) as ImapError;
  return e.authenticationFailed === true || AUTH_RE.test([e.message, e.serverResponseCode, e.responseText].filter(Boolean).join(' '));
};

/** Тема без префиксов ответа и пересылки, в нижнем регистре. */
export function normalizeSubject(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/^(\s*((re|fwd?|fw|ответ|отв|пересл|forward)\s*:)+)+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Какие вложения берём: встроенные картинки меньше 20 КБ — нет; не больше 10 файлов,
 * 25 МБ на файл и 60 МБ суммарно. Пропущенные — с причиной, для черновика и журнала.
 */
export function pickMailAttachments(files: MailAttachment[]): { take: MailAttachment[]; skipped: { name: string; reason: string }[] } {
  const take: MailAttachment[] = [];
  const skipped: { name: string; reason: string }[] = [];
  let total = 0;
  for (const f of files) {
    const name = f.filename ?? f.contentType;
    const size = f.size || f.content.byteLength;
    if (f.inline && size < MAIL_MIN_INLINE_BYTES) {
      skipped.push({ name, reason: 'встроенная картинка меньше 20 КБ' });
      continue;
    }
    if (size > MAIL_MAX_FILE_BYTES) {
      skipped.push({ name, reason: `файл больше ${MAIL_MAX_FILE_BYTES / 1024 / 1024} МБ` });
      continue;
    }
    if (take.length >= MAIL_MAX_FILES) {
      skipped.push({ name, reason: `больше ${MAIL_MAX_FILES} файлов из одного письма не берём` });
      continue;
    }
    if (total + size > MAIL_MAX_TOTAL_BYTES) {
      skipped.push({ name, reason: `суммарно больше ${MAIL_MAX_TOTAL_BYTES / 1024 / 1024} МБ` });
      continue;
    }
    total += size;
    take.push(f);
  }
  return { take, skipped };
}

/**
 * Убирает цитаты прошлой переписки: строки с «>», блок после «… пишет:» / «wrote:»,
 * «-----Original Message-----», подпись после «-- ».
 */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const next = lines[i + 1] ?? '';
    const t = line.trim();
    if (/^-{2,}\s*(Original Message|Исходное сообщение|Пересылаемое сообщение|Forwarded message)/i.test(t)) break;
    if (/^(--|—)\s*$/.test(line)) break;
    if (/(пишет|написал[а]?|wrote)\s*:\s*$/i.test(t)) break;
    if (/\d{1,2}:\d{2}/.test(t) && /(пишет|написал[а]?|wrote)\s*:\s*$/i.test(next.trim()) && `${t} ${next}`.includes('@')) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** HTML письма → текст, когда текстовой части нет. */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|div|h\d|tr|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&mdash;/g, '—')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Разбор сырого письма (MIME) в FetchedMail. */
export async function parseMail(uid: number, source: Buffer): Promise<FetchedMail> {
  const m = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true });
  const raw = m.text?.trim() ? m.text : m.html ? htmlToPlain(m.html) : '';
  return {
    uid,
    messageId: m.messageId ?? null,
    from: (m.from?.value[0]?.address ?? '').toLowerCase(),
    subject: (m.subject ?? '').trim(),
    date: m.date ?? null,
    text: stripQuoted(raw).slice(0, MAX_TEXT),
    attachments: m.attachments.map((a) => ({
      filename: a.filename ?? null,
      contentType: a.contentType,
      size: a.size,
      content: a.content,
      inline: a.contentDisposition === 'inline' || a.related === true,
    })),
  };
}

interface Candidate {
  uid: number;
  subject: string;
  date: Date | null;
}

/** Среди писем отправителя за окно выбирает самое свежее; при известной теме — сначала с той же темой. */
export function chooseLatest(candidates: Candidate[], subject: string | null | undefined): Candidate | null {
  if (!candidates.length) return null;
  const want = normalizeSubject(subject);
  const same = want ? candidates.filter((c) => normalizeSubject(c.subject) === want || normalizeSubject(c.subject).includes(want)) : [];
  const pool = same.length ? same : candidates;
  return pool.reduce((best, c) => {
    const bt = best.date?.getTime() ?? 0;
    const ct = c.date?.getTime() ?? 0;
    return ct > bt || (ct === bt && c.uid > best.uid) ? c : best;
  });
}

const dayStart = (d: Date, shiftDays: number) => {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  x.setUTCDate(x.getUTCDate() + shiftDays);
  return x;
};

/** Ящик по IMAP, только чтение. */
export class ImapMailReader {
  constructor(private readonly cfg: MailReadConfig) {}

  /** Самое свежее письмо отправителя за окно ±1 день; readOnly — как открыта папка (всегда EXAMINE). */
  async findLatest(search: MailSearch, folder = 'INBOX'): Promise<{ mail: FetchedMail | null; readOnly: boolean }> {
    const key = pauseKey(this.cfg);
    const until = authPause.get(key);
    if (until && Date.now() < until) throw new MailAuthError(`вход в ящик ${this.cfg.username} не удался, следующая попытка не раньше ${moscowTime(until)} МСК`, new Date(until));

    const client = new ImapFlow({
      host: this.cfg.host,
      port: this.cfg.port,
      secure: this.cfg.secure,
      auth: { user: this.cfg.username, pass: this.cfg.password },
      logger: false,
      disableAutoIdle: true,
    });
    // Без обработчика 'error' событие imapflow роняет процесс (так падал worker розницы 12.10.2026).
    client.on('error', () => undefined);
    try {
      await client.connect();
    } catch (err) {
      await new Promise((resolve) => setImmediate(resolve));
      client.close();
      if (isAuthFailure(err)) {
        const retry = Date.now() + MAIL_AUTH_PAUSE_MS;
        authPause.set(key, retry);
        throw new MailAuthError(`вход в ящик ${this.cfg.username} не удался (${(err as Error).message}); проверьте логин и пароль во вкладке «Письмо», следующая попытка не раньше ${moscowTime(retry)} МСК`, new Date(retry));
      }
      throw err;
    }
    authPause.delete(key);
    try {
      const box = await client.mailboxOpen(folder, { readOnly: true });
      const readOnly = Boolean(box.readOnly);
      const uids = (await client.search({ from: search.from, since: dayStart(search.around, -1), before: dayStart(search.around, 2) }, { uid: true })) || [];
      const recent = uids.slice(-MAX_CANDIDATES);
      if (!recent.length) return { mail: null, readOnly };
      const candidates: Candidate[] = [];
      for await (const m of client.fetch(recent, { uid: true, envelope: true }, { uid: true })) {
        const d = m.envelope?.date;
        candidates.push({ uid: m.uid, subject: m.envelope?.subject ?? '', date: d instanceof Date ? d : d ? new Date(d) : null });
      }
      const chosen = chooseLatest(candidates, search.subject);
      if (!chosen) return { mail: null, readOnly };
      const one = await client.fetchOne(String(chosen.uid), { uid: true, source: true }, { uid: true });
      if (!one || !one.source) return { mail: null, readOnly };
      return { mail: await parseMail(chosen.uid, one.source), readOnly };
    } finally {
      await client.logout().catch(() => client.close());
    }
  }
}

/** Удобная обёртка для черновика: письмо или null. */
export async function readLatestMail(cfg: MailReadConfig, search: MailSearch): Promise<FetchedMail | null> {
  return (await new ImapMailReader(cfg).findLatest(search)).mail;
}
