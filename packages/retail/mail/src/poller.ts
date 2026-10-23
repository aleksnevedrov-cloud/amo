import { saveMailAttachments, type SaveAttachmentsDeps } from './attachments.ts';
import type { AmoApiClient } from '@core/amo';
import type { DialogRepo, JournalRepo, SettingsRepo, WidgetSettings } from '@core/db';
import { linkEmailToLead } from './link.ts';
import { isIgnored, parseEmail, type IncomingEmail } from './parse.ts';
import type { MailRepo } from './repo.ts';
import { imapErrorText, isAuthFailure, type ImapError, type Mailbox, type MailboxHooks, type MailServerConfig } from './transport.ts';

export interface PollDeps {
  settings: SettingsRepo;
  mail: MailRepo;
  dialog: DialogRepo;
  journal: JournalRepo;
  amo(accountId: number): Promise<AmoApiClient>;
  connect(cfg: MailServerConfig, hooks?: MailboxHooks): Promise<Mailbox>;
  schedule(job: { accountId: number; leadId: number }, windowMs: number): Promise<void>;
  /** Журнал процесса (pino worker'а); пароль в записи не попадает никогда. */
  log?: PollLogger;
  /** Вложения письма на диск и в карточку сделки (тема RFD-AI-AGENT-KP, этап 1). */
  attachments?: SaveAttachmentsDeps;
  /** Разбор вложений письма (фаза 3). */
  documents?: {
    analyze(input: { accountId: number; leadId: number | null; source: 'email'; filename: string; mime: string; bytes: Uint8Array; settings: WidgetSettings; priority?: 'new' | 'backlog' | 'deferred' }): Promise<{
      id: number;
      kind: string;
      text: string;
      memoryOpenings: unknown[];
      costUsd: number;
      model: string;
    }>;
  };
}

export interface PollLogger {
  warn(obj: object, msg: string): void;
}

/** Вложения письма: сохранение на диск и загрузка в карточку сделки. */
export type PollAttachmentsDeps = SaveAttachmentsDeps;

/** Вложений из одного письма разбираем не больше. */
const MAX_ATTACHMENTS = 5;
/** Пометка в тексте письма для вложения, отложенного по дневному лимиту (по ней разбор допишется в историю). */
export const DEFERRED_MARK = 'разбор отложен по дневному лимиту';

export interface PollResult {
  accountId: number;
  received: number;
  queued: number;
  skipped: number;
  /** Ждут, пока почта amo создаст сделку. */
  waiting: number;
  managerReplies: number;
  error?: string;
  /** Отказов входа подряд (после этого прохода). */
  authFailures?: number;
  /** Ящик пропущен или отложен: раньше этого времени к серверу не подключаемся. */
  retryAt?: Date;
  /** Ящик помечен «ошибка входа»: опрос остановлен до смены пароля или настроек. */
  authLocked?: boolean;
  /** По ящикам (RFD-AI-AGENT-FIX-PACK-2410, ч. 2). */
  mailboxes?: { id: string; address: string; mode: 'read' | 'reply'; received: number; error?: string }[];
}

/** Писем за один проход — остальные в следующий. */
const BATCH = 30;

export function serverConfig(e: WidgetSettings['email'], password: string): MailServerConfig {
  return {
    imapHost: e.imapHost,
    imapPort: e.imapPort,
    imapSecure: e.imapSecure,
    smtpHost: e.smtpHost,
    smtpPort: e.smtpPort,
    smtpSecure: e.smtpSecure,
    username: e.username,
    password,
  };
}

export const ourAddress = (e: WidgetSettings['email']) => (e.fromAddress || e.username).toLowerCase();

/** Ящик из настроек (RFD-AI-AGENT-FIX-PACK-2410, ч. 2). */
export type MailboxCfg = WidgetSettings['email']['mailboxes'][number];

/** Ящики аккаунта: email.mailboxes, а без них — один ящик main из прежних полей (ответы — из него). */
export function mailboxesOf(e: WidgetSettings['email']): MailboxCfg[] {
  if (e.mailboxes.length) return e.mailboxes;
  if (!e.imapHost || !e.username) return [];
  return [{ id: 'main', address: e.fromAddress || e.username, imapHost: e.imapHost, imapPort: e.imapPort, imapSecure: e.imapSecure, username: e.username, inboxFolder: e.inboxFolder, sentFolder: e.sentFolder, mode: 'reply', backfillDays: 0 }];
}

/** IMAP ящика + общий SMTP из настроек (ответы уходят только из ящика reply). */
export function mailboxConfig(e: WidgetSettings['email'], mb: MailboxCfg, password: string): MailServerConfig {
  return { imapHost: mb.imapHost, imapPort: mb.imapPort, imapSecure: mb.imapSecure, smtpHost: e.smtpHost, smtpPort: e.smtpPort, smtpSecure: e.smtpSecure, username: mb.username, password };
}

const mailboxLabel = (mb: MailboxCfg) => mb.address || mb.username || mb.id;
/** Дубль письма из Salesbot / карточки amo: та же тема у того же клиента в истории сделки в пределах ±10 минут. */
const DUPLICATE_WINDOW_MS = 10 * 60_000;
/** Дочитка при первом подключении ящика — не больше писем за проход. */
const BACKFILL_LIMIT = 200;

/**
 * Отказ входа (неверный пароль, «Already logged out», блокировка провайдером).
 *
 * Первая пауза — 30 минут: Яндекс блокирует IP после серии неудачных входов (RFD-AI-AGENT-DEPLOY-112).
 * Дальше пауза удваивается до потолка, после AUTH_MAX_FAILURES отказов подряд ящик помечается
 * «ошибка входа» и опрос останавливается — до смены пароля (вкладка «Почта») или настроек ящика.
 */
export const AUTH_BACKOFF_MIN_MS = 30 * 60_000;
export const AUTH_BACKOFF_MAX_MS = 4 * 60 * 60_000;
export const AUTH_MAX_FAILURES = 5;

/** Пауза перед следующей попыткой после n отказов подряд: 30, 60, 120, 240, 240 минут. */
export const authBackoffMs = (failures: number) => Math.min(AUTH_BACKOFF_MIN_MS * 2 ** Math.max(failures - 1, 0), AUTH_BACKOFF_MAX_MS);

interface AuthState {
  failures: number;
  /** Время последнего отказа. */
  at: number;
  /** Дата пароля на момент отказа: новый пароль снимает блокировку. */
  passwordAt: number;
}

/**
 * Счётчик отказов живёт в памяти процесса (worker — один процесс): без новой колонки в БД.
 * После перезапуска в базе остаётся текст и время последнего отказа — первая 30-минутная пауза
 * соблюдается и тогда. Ключ включает ящик и сервер: смена настроек начинает отсчёт заново.
 */
const authState = new Map<string, AuthState>();

/** Сброс счётчиков отказов (для тестов). */
export function resetAuthBackoff(): void {
  authState.clear();
}

const AUTH_LOCK_PREFIX = 'ошибка входа';
const moscowTime = (ms: number) => new Date(ms).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });

/** Состояние отказов по ящику: из памяти, а после перезапуска — из последней ошибки в базе. */
function authStateFor(key: string, st: { lastError: string | null; lastErrorAt: Date | null } | null, passwordAt: number): AuthState | null {
  const mem = authState.get(key);
  if (mem) {
    if (passwordAt > mem.passwordAt) {
      authState.delete(key);
      return null;
    }
    return mem;
  }
  if (!st?.lastError || !st.lastErrorAt) return null;
  const at = new Date(st.lastErrorAt).getTime();
  if (passwordAt > at) return null;
  if (st.lastError.startsWith(AUTH_LOCK_PREFIX) || isAuthFailure({ message: st.lastError })) return { failures: 1, at, passwordAt };
  return null;
}

/**
 * Один проход по ящику аккаунта. Первый запуск (или смена UIDVALIDITY) только запоминает
 * позицию — старая переписка не обрабатывается.
 */
export async function pollMailbox(accountId: number, d: PollDeps): Promise<PollResult> {
  const res: PollResult = { accountId, received: 0, queued: 0, skipped: 0, waiting: 0, managerReplies: 0, mailboxes: [] };
  const { settings } = await d.settings.get(accountId);
  const e = settings.email;
  if (!e.enabled) return res;
  const boxes = mailboxesOf(e);
  if (!boxes.length) return res;
  let waitingDone = false;
  for (const mb of boxes) {
    if (!mb.imapHost || !mb.username) continue;
    const one = await pollOneMailbox(accountId, mb, settings, d, async () => {
      // Письма, которые ждали сделку от amo (ящик reply), — один раз за проход.
      if (waitingDone) return;
      waitingDone = true;
      for (const r of await retryWaiting(accountId, settings, d)) res[r] += 1;
    });
    res.received += one.received;
    res.queued += one.queued;
    res.skipped += one.skipped;
    res.waiting += one.waiting;
    res.managerReplies += one.managerReplies;
    // Один ящик — текст ошибки как есть (статус на вкладке); несколько — с адресом ящика.
    if (one.error) res.error = boxes.length === 1 ? one.error : res.error ? `${res.error}; ${mailboxLabel(mb)}: ${one.error}` : `${mailboxLabel(mb)}: ${one.error}`;
    if (one.authFailures !== undefined) res.authFailures = Math.max(res.authFailures ?? 0, one.authFailures);
    if (one.authLocked) res.authLocked = true;
    if (one.retryAt && (!res.retryAt || one.retryAt < res.retryAt)) res.retryAt = one.retryAt;
    res.mailboxes?.push({ id: mb.id, address: mailboxLabel(mb), mode: mb.mode, received: one.received, ...(one.error ? { error: one.error } : {}) });
  }
  return res;
}

/** Один ящик: вход, ожидавшие письма (только для первого), входящие, «Отправленные». */
async function pollOneMailbox(accountId: number, mb: MailboxCfg, settings: WidgetSettings, d: PollDeps, beforeRead: () => Promise<void>): Promise<PollResult> {
  const res: PollResult = { accountId, received: 0, queued: 0, skipped: 0, waiting: 0, managerReplies: 0 };
  const e = settings.email;
  const cred = await d.mail.credentials(accountId, mb.id);
  if (!cred) return res;
  const mailbox = `${mb.username}@${mb.imapHost}:${mb.imapPort}`;
  const authKey = `${accountId}:${mb.id}:${mailbox}`;
  const passwordAt = new Date(cred.updatedAt).getTime();
  const st = await d.mail.folderState(accountId, mb.id, mb.inboxFolder);
  const auth = authStateFor(authKey, st, passwordAt);
  if (auth) {
    // Ошибка остаётся видна на вкладке «Почта»; к серверу не ходим, пока не истечёт пауза.
    if (auth.failures >= AUTH_MAX_FAILURES) {
      res.authFailures = auth.failures;
      res.authLocked = true;
      return res;
    }
    const retryAt = auth.at + authBackoffMs(auth.failures);
    if (Date.now() < retryAt) {
      res.authFailures = auth.failures;
      res.retryAt = new Date(retryAt);
      return res;
    }
  }

  let box: Mailbox | null = null;
  try {
    box = await d.connect(mailboxConfig(e, mb, cred.password), {
      // Соединение уже закрыто imapflow; процесс жив, запись в журнал без пароля.
      onError: (err) => d.log?.warn({ accountId, mailbox, err: err.message, code: err.code, authenticationFailed: err.authenticationFailed === true }, 'mail: ошибка IMAP-соединения'),
    });
    authState.delete(authKey);
    await beforeRead();
    await readFolder(box, accountId, mb, mb.inboxFolder, d, async (msg) => {
      res.received += 1;
      res[await handleIncoming(accountId, msg, settings, d, mb)] += 1;
    });
    const sent = mb.sentFolder || (await box.findSentFolder());
    if (sent) {
      await readFolder(box, accountId, mb, sent, d, async (msg) => {
        if (msg.fromAiDoor || (msg.messageId && (await d.mail.isOurMessage(accountId, msg.messageId)))) return;
        for (const to of msg.to) {
          await d.mail.managerWrote(accountId, to, msg.date ?? new Date());
          res.managerReplies += 1;
        }
      });
    }
  } catch (err) {
    // imapflow: текст ответа сервера (например «[AUTHENTICATIONFAILED] LOGIN invalid credentials») лежит не в message.
    res.error = imapErrorText(err) || String(err);
    const text = isAuthFailure(err) ? await noteAuthFailure(accountId, mailbox, authKey, auth, passwordAt, err as ImapError, res, d) : res.error;
    await d.mail.markError(accountId, mb.id, mb.inboxFolder, text);
  } finally {
    await box?.close().catch(() => undefined);
  }
  return res;
}

/** Отказ входа: счётчик, пауза или блокировка, запись в журнал процесса; возвращает текст для статуса ящика. */
async function noteAuthFailure(
  accountId: number,
  mailbox: string,
  authKey: string,
  prev: AuthState | null,
  passwordAt: number,
  err: ImapError,
  res: PollResult,
  d: PollDeps,
): Promise<string> {
  const failures = (prev?.failures ?? 0) + 1;
  const now = Date.now();
  authState.set(authKey, { failures, at: now, passwordAt });
  res.authFailures = failures;
  const base = { accountId, mailbox, failures, err: res.error, code: err.code };
  if (failures >= AUTH_MAX_FAILURES) {
    res.authLocked = true;
    d.log?.warn(base, 'mail: ошибка входа, опрос ящика остановлен');
    await d.journal.add({
      accountId,
      kind: 'error',
      summary: `Почта ${mailbox}: ${failures} отказов входа подряд, опрос остановлен — проверьте логин и пароль ящика`,
      details: { error: res.error },
    });
    return `${AUTH_LOCK_PREFIX}: ${res.error} — ${failures} отказов подряд, опрос остановлен; проверьте логин и пароль на вкладке «Почта»`;
  }
  const retryAt = now + authBackoffMs(failures);
  res.retryAt = new Date(retryAt);
  d.log?.warn({ ...base, retryAt: new Date(retryAt).toISOString() }, 'mail: ошибка входа, повтор отложен');
  return `${AUTH_LOCK_PREFIX} (${failures} из ${AUTH_MAX_FAILURES}, следующая попытка в ${moscowTime(retryAt)} МСК): ${res.error}`;
}

async function readFolder(box: Mailbox, accountId: number, mb: MailboxCfg, folder: string, d: PollDeps, onMessage: (m: IncomingEmail) => Promise<void>) {
  const cur = await box.folderState(folder);
  const st = await d.mail.folderState(accountId, mb.id, folder);
  if (!st || !st.uidValidity || st.uidValidity !== cur.uidValidity) {
    // Первое подключение ящика: дочитать письма за backfillDays (ч. 2, п. 7; ответы по ним не готовятся — читаем в историю).
    // Смена UIDVALIDITY или ящик без дочитки — только запомнить позицию.
    if (!st && mb.backfillDays > 0 && folder === mb.inboxFolder) {
      const since = new Date(Date.now() - mb.backfillDays * 86_400_000);
      for (const m of await box.fetchSince(folder, since, BACKFILL_LIMIT)) await onMessage(await parseEmail(m.source));
    }
    await d.mail.saveFolderState(accountId, mb.id, folder, cur.uidValidity, cur.maxUid);
    return;
  }
  if (cur.maxUid <= st.lastUid) {
    await d.mail.saveFolderState(accountId, mb.id, folder, cur.uidValidity, st.lastUid);
    return;
  }
  for (const m of await box.fetchAfter(folder, st.lastUid, BATCH)) {
    await onMessage(await parseEmail(m.source));
    // Позиция сохраняется после каждого письма: при сбое следующий проход продолжит с него.
    await d.mail.saveFolderState(accountId, mb.id, folder, cur.uidValidity, m.uid);
  }
}

type Outcome = 'queued' | 'skipped' | 'waiting';

async function handleIncoming(accountId: number, msg: IncomingEmail, settings: WidgetSettings, d: PollDeps, mb: MailboxCfg): Promise<Outcome> {
  const e = settings.email;
  const from = msg.from;
  const readOnly = mb.mode === 'read';
  const boxLabel = mailboxLabel(mb);
  if (!from || msg.automated || msg.fromAiDoor) return 'skipped';
  if (from.address === ourAddress(e) || isIgnored(from.address, e.ignore)) return 'skipped';
  if (!readOnly && (await d.mail.repliesToday(accountId, from.address)) >= e.maxRepliesPerAddressPerDay) {
    await d.journal.add({ accountId, kind: 'skipped', summary: `Письмо от ${from.address}: достигнут лимит ответов на адрес за сутки` });
    return 'skipped';
  }
  // Ящик read: только существующая сделка по отправителю — сделки не создаём, amo не ждём, не отвечаем.
  const api = await d.amo(accountId);
  const link = await linkEmailToLead(api, from, msg.subject, e, readOnly ? 'skip' : undefined);
  if ('skip' in link) {
    await d.journal.add({ accountId, kind: 'skipped', summary: `Письмо от ${from.address} (${boxLabel}) не обработано: ${link.skip}` });
    return 'skipped';
  }
  // Дубль с письмом из Salesbot / карточки amo: та же тема у этого клиента уже в истории сделки в пределах ±10 минут (ч. 2, п. 5).
  if (!('notFound' in link) && msg.subject.trim().length >= 3 && (await d.dialog.hasClientMessageNear(accountId, link.leadId, msg.subject.trim(), msg.date ?? new Date(), DUPLICATE_WINDOW_MS))) {
    await d.journal.add({ accountId, leadId: link.leadId, kind: 'skipped', summary: `Письмо от ${from.address} «${msg.subject}» (${boxLabel}): уже есть в истории сделки из amo — дубль не добавлен` });
    return 'skipped';
  }
  // Письмо старше суток (дочитка) — разбор вложений как догрузка, не в ущерб новым файлам.
  const priority = msg.date && Date.now() - msg.date.getTime() > 24 * 60 * 60_000 ? ('backlog' as const) : ('new' as const);
  const parts = [`Тема письма: ${msg.subject || '(без темы)'}`, msg.text || '(пустое письмо)'];
  const openings: unknown[] = [];
  // Раздел КП из розницы убран (решение заказчика 12.10.2026): вложения разбираются только по настройке авторазбора.
  const extracts = new Map<string, { text?: string; error?: string; deferred?: boolean }>();
  if (msg.attachments.length) {
    const docs = d.documents && settings.vision.autoParse ? d.documents : null;
    for (const a of msg.attachments.slice(0, MAX_ATTACHMENTS)) {
      const name = a.filename ?? a.contentType;
      if (!docs) {
        parts.push(`(во вложении файл «${name}» — разбор вложений выключен)`);
        continue;
      }
      try {
        const r = await docs.analyze({ accountId, leadId: 'notFound' in link ? null : link.leadId, source: 'email', filename: name, mime: a.contentType, bytes: new Uint8Array(a.content), settings, priority });
        parts.push(r.text);
        extracts.set(name, { text: r.text });
        openings.push(...r.memoryOpenings);
        await d.journal.add({ accountId, kind: 'document', summary: `Разобрано вложение «${name}» из письма от ${from.address} (${r.kind})`, details: { documentId: r.id, model: r.model }, costUsd: r.costUsd, costRub: r.costUsd * settings.billing.usdRubRate });
      } catch (err) {
        // RFD-AI-AGENT-FILES-PRIORITY: дневной лимит — не ошибка файла: вложение «отложено по лимиту», разберётся автоматически
        // (runDeferredMailFiles), разбор допишется в историю сделки и в задачу, если менеджеру её поставили из-за лимита.
        if ((err as { stage?: string }).stage === 'limit') {
          parts.push(`(во вложении файл «${name}» — ${DEFERRED_MARK}, будет разобран автоматически)`);
          extracts.set(name, { error: (err as Error).message, deferred: true });
          await d.journal.add({ accountId, kind: 'skipped', summary: `Вложение «${name}» из письма от ${from.address} отложено по дневному лимиту — разберётся автоматически`, details: { error: (err as Error).message } });
          continue;
        }
        parts.push(`(во вложении файл «${name}», разобрать не удалось: ${(err as Error).message})`);
        extracts.set(name, { error: (err as Error).message });
        await d.journal.add({ accountId, kind: 'error', summary: `Вложение «${name}» из письма от ${from.address}: ${(err as Error).message}` });
      }
    }
    if (msg.attachments.length > MAX_ATTACHMENTS) parts.push(`(ещё ${msg.attachments.length - MAX_ATTACHMENTS} вложений не разобрано)`);
  }
  const letter: Letter = {
    from: from.address,
    fromName: from.name,
    subject: msg.subject,
    text: parts.join('\n'),
    meta: { from: from.address, fromName: from.name, subject: msg.subject, messageId: msg.messageId, references: msg.references, ...(openings.length ? { openings } : {}) },
  };
  if ('notFound' in link) {
    // Почта подключена к amo: сделку создаст amo — ответим, когда она появится.
    await d.mail.addWaiting(accountId, letter);
    await d.journal.add({ accountId, kind: 'note', summary: `Письмо от ${from.address}: ждём, пока amo создаст сделку` });
    return 'waiting';
  }
  if (d.attachments && msg.attachments.length) {
    // Файлы кладём в сделку всегда, даже когда разбор текста выключен.
    await saveMailAttachments(
      {
        accountId,
        leadId: link.leadId,
        messageId: msg.messageId || `${from.address}:${msg.subject}`,
        messageUid: null,
        files: msg.attachments,
        api,
        extracts,
      },
      d.attachments,
    ).catch(async (err) => {
      await d.journal.add({
        accountId,
        leadId: link.leadId,
        kind: 'mail_attachment',
        summary: `Вложения письма не сохранены: ${(err as Error).message}`,
      });
      return undefined;
    });
  }
  await enqueueLetter(accountId, link.leadId, letter, link.created, d);
  return 'queued';
}

interface Letter {
  from: string;
  fromName: string;
  subject: string;
  text: string;
  meta: Record<string, unknown>;
}

/**
 * Почта в режиме «только читать» (решение заказчика 11.10.2026, тема RFD-AI-AGENT-KP).
 *
 * Письмо ложится в историю сделки — оттуда его берёт черновик КП, — вложения уже сохранены
 * выше. Ответ клиенту агент не готовит и в очередь ничего не ставит: по почте пишет менеджер,
 * а готовое КП уходит только по кнопке.
 */
async function enqueueLetter(
  accountId: number,
  leadId: number,
  l: Letter,
  created: 'none' | 'lead' | 'contact_and_lead',
  d: PollDeps,
) {
  await d.dialog.addMessage(accountId, leadId, 'client', l.text);
  await d.journal.add({
    accountId,
    leadId,
    kind: 'note',
    summary: `Письмо от ${l.from}: «${l.subject}»${created === 'none' ? '' : created === 'lead' ? ' — создана сделка' : ' — созданы контакт и сделка'} — прочитано, ответ не готовится`,
  });
}

/** Повторный поиск сделки для ожидающих писем; по истечении ожидания — действие из настроек. */
async function retryWaiting(accountId: number, settings: WidgetSettings, d: PollDeps): Promise<Outcome[]> {
  const e = settings.email;
  const waiting = await d.mail.listWaiting(accountId);
  if (!waiting.length) return [];
  const api = await d.amo(accountId);
  const out: Outcome[] = [];
  for (const w of waiting) {
    const expired = Date.now() - w.receivedAt.getTime() > e.waitForAmoMin * 60_000;
    const action = expired ? (e.afterWait === 'create_lead' ? 'create' : 'skip') : 'report';
    const link = await linkEmailToLead(api, { address: w.from, name: w.fromName }, w.subject, e, action);
    if ('notFound' in link) continue;
    await d.mail.removeWaiting(accountId, w.id);
    if ('skip' in link) {
      await d.journal.add({ accountId, kind: 'skipped', summary: `Письмо от ${w.from}: amo не создал сделку за ${e.waitForAmoMin} мин — AI не отвечает` });
      out.push('skipped');
      continue;
    }
    await enqueueLetter(accountId, link.leadId, w, link.created, d);
    out.push('queued');
  }
  return out;
}
