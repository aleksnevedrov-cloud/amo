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
 * Поиск (RFD-AI-AGENT-OPT-MAIL-READ-2): все папки кроме Отправленных/Черновиков/Корзины, окно ±2 дня и
 * запасной поиск без даты; при «не найдено» — диагностика без содержимого писем.
 * Отправитель (RFD-AI-AGENT-OPT-MAIL-READ-4): IMAP SEARCH FROM у Яндекса не находит письмо по полному адресу
 * (сделка 30013995: письмо во «Входящих», byFrom=0 во всех 26 папках), поэтому SEARCH идёт только по дате,
 * а отправитель сверяется на клиенте по ENVELOPE: адрес в нижнем регистре равен искомому, для корпоративного
 * домена — оканчивается на @domain.
 * Таймауты (RFD-AI-AGENT-OPT-MAIL-READ-5): mail-check на сервере висел 7+ минут без ответа. Подключение и вход
 * 20 с, каждая команда IMAP 30 с, весь поиск 90 с; по истечении — MailTimeoutError «чтение ящика прервано по
 * таймауту на …», черновик собирается по карточке. INBOX первым: если письмо отправителя найдено там — остальные
 * папки не обходятся; запасной проход по последним письмам — только INBOX и Спам; ENVELOPE одной командой по
 * UID-диапазону; зависший SEARCH — переподключение и проход по номерам сообщений.
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

/** Диагностика поиска (без содержимого писем) — в mail_fetch при «не найдено». */
export interface MailSearchDiag {
  /** domain — null, если домен публичный (поиск только по точному адресу). */
  criteria: { from: string; domain: string | null; since: string; before: string; subject: string | null };
  /**
   * Папки в порядке просмотра: inWindow — писем в окне дат (SEARCH SINCE/BEFORE), bySender — из них прошло
   * фильтр отправителя по ENVELOPE; scannedWithoutDate / bySenderWithoutDate — то же для запасного прохода
   * по последним письмам папки без даты (0, если он не понадобился).
   */
  folders: { path: string; specialUse: string | null; inWindow: number; bySender: number; scannedWithoutDate: number; bySenderWithoutDate: number; envelopes: number; ms: number }[];
  /** Папки, которые не смотрели (Отправленные, Черновики, Корзина, несёлектируемые). */
  skippedFolders: string[];
  /** Запасной проход без даты нашёл письмо отправителя хотя бы в одной папке. */
  fallbackWithoutDate: boolean;
  /** Письмо отправителя найдено во «Входящих» — остальные папки не обходились. */
  stoppedAfterInbox?: boolean;
  /** Сбои SEARCH по дате по папкам (сервер ответил NO/BAD) — иначе ноль совпадений выглядел бы как «писем нет». */
  errors: string[];
}

export interface MailReadResult {
  mail: FetchedMail | null;
  diag: MailSearchDiag;
}

/** Таймауты и прогресс чтения ящика; значения по умолчанию — из ТЗ MAIL-READ-5. */
export interface MailReadOptions {
  /** Подключение, приветствие и вход, мс (20 с). */
  connectMs?: number;
  /** Одна команда IMAP: LIST, EXAMINE, SEARCH, FETCH, мс (30 с). */
  commandMs?: number;
  /** Весь поиск по ящику, мс (90 с). */
  totalMs?: number;
  /** Строка прогресса на каждую папку — в консоль mail-check и в debug-лог задания. */
  onProgress?: (line: string) => void;
}

export const MAIL_CONNECT_MS = 20_000;
export const MAIL_COMMAND_MS = 30_000;
export const MAIL_TOTAL_MS = 90_000;

/** Ящик не ответил вовремя; where — папка/команда, на которой остановились. */
export class MailTimeoutError extends Error {
  override name = 'MailTimeoutError';
  constructor(public readonly where: string) {
    super(`чтение ящика прервано по таймауту на ${where}`);
  }
}

export interface FetchedMail {
  uid: number;
  folder: string;
  /** Чем совпал отправитель: точный адрес или только корпоративный домен (тогда письмо нужно проверить). */
  matchedBy: 'address' | 'domain';
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
/** Писем из папки на проверку отправителя: последние N в окне дат и последние N папки при запасном проходе без даты. */
const MAX_CANDIDATES = 200;
/** Окно даты: ±2 дня (SINCE/BEFORE в IMAP — по дате сервера, без времени и пояса). */
const DATE_WINDOW_DAYS = 2;
/** Папки, где письма заявок не ищем, по special-use. */
const SKIP_SPECIAL_USE = new Set(['\\Sent', '\\Drafts', '\\Trash']);
/** Запасной проход по последним письмам без даты — только Входящие и Спам (не по всем папкам ящика). */
const isInbox = (path: string) => path.toUpperCase() === 'INBOX';
const fallbackFolder = (f: { path: string; specialUse: string | null }) => isInbox(f.path) || f.specialUse === '\\Junk' || /spam|junk|спам/i.test(f.path);

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
export async function parseMail(uid: number, source: Buffer, folder = 'INBOX'): Promise<FetchedMail> {
  const m = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true });
  const raw = m.text?.trim() ? m.text : m.html ? htmlToPlain(m.html) : '';
  return {
    uid,
    folder,
    matchedBy: 'address',
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

export interface Candidate {
  uid: number;
  folder: string;
  subject: string;
  date: Date | null;
  /** Адрес отправителя совпал точно (иначе — только домен). */
  exact: boolean;
}

/**
 * Выбор письма: сначала письма с точным адресом отправителя (совпадение только по домену — запасной
 * вариант), среди них — с той же темой, если тема известна, затем самое свежее по дате.
 */
export function chooseLatest(candidates: Candidate[], subject: string | null | undefined): Candidate | null {
  if (!candidates.length) return null;
  const exact = candidates.filter((c) => c.exact);
  const tier = exact.length ? exact : candidates;
  const want = normalizeSubject(subject);
  const same = want ? tier.filter((c) => normalizeSubject(c.subject) === want || normalizeSubject(c.subject).includes(want)) : [];
  const pool = same.length ? same : tier;
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

export const domainOf = (address: string) => address.split('@')[1]?.toLowerCase() ?? '';

/** UID-список в диапазоны одной командой FETCH: [1,2,3,7,9,10] → «1:3,7,9:10». */
export function compressUids(uids: number[]): string {
  const xs = [...new Set(uids)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < xs.length; ) {
    let j = i;
    while (j + 1 < xs.length && xs[j + 1] === (xs[j] as number) + 1) j += 1;
    parts.push(i === j ? String(xs[i]) : `${xs[i]}:${xs[j]}`);
    i = j + 1;
  }
  return parts.join(',');
}

/**
 * Публичные почтовые домены: поиск по домену здесь опасен — нашлось бы письмо другого клиента
 * с @yandex.ru, и КП ушло бы по чужой заявке. Для них — только точный адрес.
 */
export const PUBLIC_MAIL_DOMAINS = new Set([
  'yandex.ru', 'ya.ru', 'yandex.com', 'mail.ru', 'inbox.ru', 'list.ru', 'bk.ru', 'internet.ru',
  'gmail.com', 'rambler.ru', 'lenta.ru', 'outlook.com', 'hotmail.com', 'icloud.com', 'me.com',
  'yahoo.com', 'vk.com', 'proton.me',
]);
export const isPublicDomain = (domain: string) => PUBLIC_MAIL_DOMAINS.has(domain.toLowerCase());

/** Папки для поиска: всё из LIST, кроме Отправленных, Черновиков, Корзины и несёлектируемых; INBOX первой. */
export function searchableFolders(list: { path: string; specialUse?: string | null; flags?: Set<string> | string[] }[]): { use: { path: string; specialUse: string | null }[]; skipped: string[] } {
  const use: { path: string; specialUse: string | null }[] = [];
  const skipped: string[] = [];
  for (const f of list) {
    const flags = new Set(f.flags instanceof Set ? [...f.flags] : (f.flags ?? []));
    const su = f.specialUse ?? null;
    if ((su && SKIP_SPECIAL_USE.has(su)) || flags.has('\\Noselect') || flags.has('\\NonExistent')) {
      skipped.push(f.path);
      continue;
    }
    use.push({ path: f.path, specialUse: su });
  }
  use.sort((a, b) => (a.path.toUpperCase() === 'INBOX' ? -1 : b.path.toUpperCase() === 'INBOX' ? 1 : a.path.localeCompare(b.path)));
  return { use, skipped };
}

/** Ящик по IMAP, только чтение. */
export class ImapMailReader {
  constructor(private readonly cfg: MailReadConfig) {}

  /**
   * Самое свежее письмо отправителя: все папки ящика кроме Отправленных/Черновиков/Корзины, каждая через
   * EXAMINE; SEARCH только по дате (окно ±2 дня), отправитель сверяется на клиенте по ENVELOPE; если в окне
   * от него ничего нет — последние 200 писем папки без даты через тот же фильтр.
   * readOnly — как открывались папки (всегда EXAMINE), diag — что просмотрено, без содержимого писем.
   */
  async findLatest(search: MailSearch, opts: MailReadOptions = {}): Promise<MailReadResult & { readOnly: boolean }> {
    const key = pauseKey(this.cfg);
    const until = authPause.get(key);
    if (until && Date.now() < until) throw new MailAuthError(`вход в ящик ${this.cfg.username} не удался, следующая попытка не раньше ${moscowTime(until)} МСК`, new Date(until));

    const connectMs = opts.connectMs ?? MAIL_CONNECT_MS;
    const commandMs = opts.commandMs ?? MAIL_COMMAND_MS;
    const deadline = Date.now() + (opts.totalMs ?? MAIL_TOTAL_MS);
    const progress = opts.onProgress ?? (() => undefined);
    let client: ImapFlow | null = null;

    /** Команда с таймаутом: не дольше limitMs и не дольше остатка общего бюджета; по истечении соединение закрывается. */
    const run = async <T>(where: string, limitMs: number, p: () => Promise<T>): Promise<T> => {
      const left = deadline - Date.now();
      if (left <= 0) {
        client?.close();
        throw new MailTimeoutError(`${where} (весь поиск дольше ${Math.round((opts.totalMs ?? MAIL_TOTAL_MS) / 1000)} с)`);
      }
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          client?.close();
          reject(new MailTimeoutError(where));
        }, Math.min(limitMs, left));
      });
      try {
        return await Promise.race([p(), timeout]);
      } finally {
        clearTimeout(timer);
      }
    };

    const connect = async (): Promise<ImapFlow> => {
      const c = new ImapFlow({
        host: this.cfg.host,
        port: this.cfg.port,
        secure: this.cfg.secure,
        auth: { user: this.cfg.username, pass: this.cfg.password },
        logger: false,
        disableAutoIdle: true,
        connectionTimeout: connectMs,
        greetingTimeout: connectMs,
        // Простой сокета дольше одной команды — обрыв, а не ожидание 5 минут по умолчанию.
        socketTimeout: commandMs,
      });
      // Без обработчика 'error' событие imapflow роняет процесс (так падал worker розницы 12.10.2026).
      c.on('error', () => undefined);
      client = c;
      try {
        await run('подключение и вход', connectMs, () => c.connect());
      } catch (err) {
        await new Promise((resolve) => setImmediate(resolve));
        c.close();
        if (err instanceof MailTimeoutError) throw err;
        if (isAuthFailure(err)) {
          const retry = Date.now() + MAIL_AUTH_PAUSE_MS;
          authPause.set(key, retry);
          throw new MailAuthError(`вход в ящик ${this.cfg.username} не удался (${(err as Error).message}); проверьте логин и пароль во вкладке «Письмо», следующая попытка не раньше ${moscowTime(retry)} МСК`, new Date(retry));
        }
        throw err;
      }
      authPause.delete(key);
      return c;
    };

    const from = search.from.trim().toLowerCase();
    // Отправитель и тема в IMAP SEARCH не уходят: сравниваются на клиенте по ENVELOPE. Адрес всё равно должен
    // быть одним e-mail без имени — иначе сравнивать не с чем (строка amo «Имя addr» сюда попадать не должна).
    if (!/^[\x21-\x7e]+@[\x21-\x7e]+$/.test(from)) throw new Error(`адрес отправителя для поиска должен быть e-mail в ASCII, получено «${search.from}»`);
    // По домену сверяем только корпоративные домены; публичные (yandex.ru, mail.ru, gmail.com…) — только точный адрес.
    const domainRaw = domainOf(from);
    const domain = domainRaw && !isPublicDomain(domainRaw) ? domainRaw : null;
    const since = dayStart(search.around, -DATE_WINDOW_DAYS);
    const before = dayStart(search.around, DATE_WINDOW_DAYS + 1);
    const diag: MailSearchDiag = {
      criteria: { from, domain, since: since.toISOString().slice(0, 10), before: before.toISOString().slice(0, 10), subject: search.subject ?? null },
      folders: [],
      skippedFolders: [],
      fallbackWithoutDate: false,
      stoppedAfterInbox: false,
      errors: [],
    };
    const matchSender = (sender: string): 'address' | 'domain' | null => (sender === from ? 'address' : domain && sender.endsWith(`@${domain}`) ? 'domain' : null);
    const wantSubject = normalizeSubject(search.subject);
    /** «Найдено во Входящих»: точный адрес и, если тема известна, совпадение по теме — иначе смотрим остальные папки. */
    const foundHere = (found: Candidate[]) => found.some((c) => c.exact && (!wantSubject || normalizeSubject(c.subject) === wantSubject || normalizeSubject(c.subject).includes(wantSubject)));

    let readOnly = true;
    let c = await connect();
    try {
      const listed = await run('LIST', commandMs, () => c.list());
      const { use, skipped } = searchableFolders(listed);
      diag.skippedFolders = skipped;
      const candidates: Candidate[] = [];

      /** ENVELOPE пачкой одной командой FETCH по диапазону; фильтр отправителя на клиенте. */
      const scan = async (folder: string, range: string, byUid: boolean, where: string): Promise<{ scanned: number; found: Candidate[] }> => {
        const found: Candidate[] = [];
        let scanned = 0;
        await run(where, commandMs, async () => {
          for await (const m of c.fetch(range, { uid: true, envelope: true }, byUid ? { uid: true } : {})) {
            scanned += 1;
            const sender = (m.envelope?.from?.[0]?.address ?? '').trim().toLowerCase();
            const matched = matchSender(sender);
            if (!matched) continue;
            const d = m.envelope?.date;
            found.push({ uid: m.uid, folder, subject: m.envelope?.subject ?? '', date: d instanceof Date ? d : d ? new Date(d) : null, exact: matched === 'address' });
          }
        });
        return { scanned, found };
      };

      for (const folder of use) {
        const t0 = Date.now();
        let box;
        try {
          box = await run(`EXAMINE ${folder.path}`, commandMs, () => c.mailboxOpen(folder.path, { readOnly: true }));
        } catch (err) {
          if (err instanceof MailTimeoutError) throw err;
          diag.skippedFolders.push(folder.path);
          continue;
        }
        readOnly = readOnly && Boolean(box.readOnly);
        const stat = { path: folder.path, specialUse: folder.specialUse, inWindow: 0, bySender: 0, scannedWithoutDate: 0, bySenderWithoutDate: 0, envelopes: 0, ms: 0 };
        // SEARCH только по дате. false — сервер отверг; таймаут — переподключение и проход по номерам сообщений (Входящие и Спам).
        let searchTimedOut = false;
        let inWindow: number[] = [];
        try {
          const raw = await run(`SEARCH ${folder.path}`, commandMs, () => c.search({ since, before }, { uid: true }));
          if (raw === false) diag.errors.push(`${folder.path}: сервер отверг SEARCH по дате`);
          inWindow = (raw || []) as number[];
        } catch (err) {
          if (!(err instanceof MailTimeoutError)) throw err;
          searchTimedOut = true;
          diag.errors.push(`${folder.path}: SEARCH по дате прерван по таймауту (${Math.round(commandMs / 1000)} с), переподключение`);
          c = await connect();
          box = await run(`EXAMINE ${folder.path}`, commandMs, () => c.mailboxOpen(folder.path, { readOnly: true }));
        }
        stat.inWindow = inWindow.length;
        if (inWindow.length) {
          const r = await scan(folder.path, compressUids(inWindow.slice(-MAX_CANDIDATES)), true, `FETCH ENVELOPE ${folder.path}`);
          stat.envelopes += r.scanned;
          stat.bySender = r.found.length;
          candidates.push(...r.found);
        }
        // В окне дат от отправителя ничего (или SEARCH завис) — последние письма Входящих/Спама по номерам сообщений.
        if (!stat.bySender && box.exists > 0 && (fallbackFolder(folder) || searchTimedOut)) {
          const r = await scan(folder.path, `${Math.max(1, box.exists - MAX_CANDIDATES + 1)}:*`, false, `FETCH ENVELOPE ${folder.path} (без даты)`);
          stat.envelopes += r.scanned;
          stat.scannedWithoutDate = r.scanned;
          stat.bySenderWithoutDate = r.found.length;
          if (r.found.length) diag.fallbackWithoutDate = true;
          candidates.push(...r.found);
        }
        stat.ms = Date.now() - t0;
        diag.folders.push(stat);
        progress(`${folder.path}: в окне дат ${stat.inWindow}, ENVELOPE загружено ${stat.envelopes}, от отправителя ${stat.bySender + stat.bySenderWithoutDate}${searchTimedOut ? ', SEARCH по таймауту' : ''}, ${(stat.ms / 1000).toFixed(1)} с`);
        if (isInbox(folder.path) && foundHere(candidates)) {
          diag.stoppedAfterInbox = true;
          progress('письмо отправителя найдено во Входящих — остальные папки не смотрим');
          break;
        }
      }
      const chosen = chooseLatest(candidates, search.subject);
      if (!chosen) return { mail: null, diag, readOnly };
      await run(`EXAMINE ${chosen.folder}`, commandMs, () => c.mailboxOpen(chosen.folder, { readOnly: true }));
      const one = await run(`FETCH BODY ${chosen.folder}/${chosen.uid}`, commandMs, () => c.fetchOne(String(chosen.uid), { uid: true, source: true }, { uid: true }));
      if (!one || !one.source) return { mail: null, diag, readOnly };
      const mail = await parseMail(chosen.uid, one.source, chosen.folder);
      return { mail: { ...mail, matchedBy: chosen.exact ? 'address' : 'domain' }, diag, readOnly };
    } finally {
      // LOGOUT тоже может повиснуть: ждём не дольше 3 с, затем просто закрываем сокет.
      const cc = c;
      await Promise.race([cc.logout().catch(() => undefined), new Promise((r) => setTimeout(r, 3000))]);
      cc.close();
    }
  }
}

/** Удобная обёртка для черновика: письмо (или null) и диагностика поиска. */
export async function readLatestMail(cfg: MailReadConfig, search: MailSearch, opts: MailReadOptions = {}): Promise<MailReadResult> {
  const { mail, diag } = await new ImapMailReader(cfg).findLatest(search, opts);
  return { mail, diag };
}
