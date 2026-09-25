import type { AmoApiClient } from '@ai-door/amo';
import type { DialogRepo, JournalRepo, SettingsRepo, WidgetSettings } from '@ai-door/db';
import { linkEmailToLead } from './link.ts';
import { isIgnored, parseEmail, type IncomingEmail } from './parse.ts';
import type { MailRepo } from './repo.ts';
import type { Mailbox, MailServerConfig } from './transport.ts';

export interface PollDeps {
  settings: SettingsRepo;
  mail: MailRepo;
  dialog: DialogRepo;
  journal: JournalRepo;
  amo(accountId: number): Promise<AmoApiClient>;
  connect(cfg: MailServerConfig): Promise<Mailbox>;
  schedule(job: { accountId: number; leadId: number }, windowMs: number): Promise<void>;
  /** Разбор вложений письма (фаза 3). */
  documents?: {
    analyze(input: { accountId: number; leadId: null; source: 'email'; filename: string; mime: string; bytes: Uint8Array; settings: WidgetSettings }): Promise<{
      id: number;
      kind: string;
      text: string;
      memoryOpenings: unknown[];
      costUsd: number;
      model: string;
    }>;
  };
}

/** Вложений из одного письма разбираем не больше. */
const MAX_ATTACHMENTS = 5;

export interface PollResult {
  accountId: number;
  received: number;
  queued: number;
  skipped: number;
  /** Ждут, пока почта amo создаст сделку. */
  waiting: number;
  managerReplies: number;
  error?: string;
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

/**
 * Один проход по ящику аккаунта. Первый запуск (или смена UIDVALIDITY) только запоминает
 * позицию — старая переписка не обрабатывается.
 */
export async function pollMailbox(accountId: number, d: PollDeps): Promise<PollResult> {
  const res: PollResult = { accountId, received: 0, queued: 0, skipped: 0, waiting: 0, managerReplies: 0 };
  const { settings } = await d.settings.get(accountId);
  const e = settings.email;
  if (!e.enabled || !e.imapHost || !e.username) return res;
  const password = await d.mail.getPassword(accountId);
  if (!password) return res;

  let box: Mailbox | null = null;
  try {
    box = await d.connect(serverConfig(e, password));
    // Сначала — письма, которые ждали сделку от amo.
    for (const r of await retryWaiting(accountId, settings, d)) res[r] += 1;
    await readFolder(box, accountId, e.inboxFolder, d, async (msg) => {
      res.received += 1;
      res[await handleIncoming(accountId, msg, settings, d)] += 1;
    });
    const sent = e.sentFolder || (await box.findSentFolder());
    if (sent) {
      await readFolder(box, accountId, sent, d, async (msg) => {
        if (msg.fromAiDoor || (msg.messageId && (await d.mail.isOurMessage(accountId, msg.messageId)))) return;
        for (const to of msg.to) {
          await d.mail.managerWrote(accountId, to, msg.date ?? new Date());
          res.managerReplies += 1;
        }
      });
    }
  } catch (err) {
    res.error = (err as Error).message;
    await d.mail.markError(accountId, e.inboxFolder, res.error);
  } finally {
    await box?.close().catch(() => undefined);
  }
  return res;
}

async function readFolder(box: Mailbox, accountId: number, folder: string, d: PollDeps, onMessage: (m: IncomingEmail) => Promise<void>) {
  const cur = await box.folderState(folder);
  const st = await d.mail.folderState(accountId, folder);
  if (!st || !st.uidValidity || st.uidValidity !== cur.uidValidity) {
    await d.mail.saveFolderState(accountId, folder, cur.uidValidity, cur.maxUid);
    return;
  }
  if (cur.maxUid <= st.lastUid) {
    await d.mail.saveFolderState(accountId, folder, cur.uidValidity, st.lastUid);
    return;
  }
  for (const m of await box.fetchAfter(folder, st.lastUid, BATCH)) {
    await onMessage(await parseEmail(m.source));
    // Позиция сохраняется после каждого письма: при сбое следующий проход продолжит с него.
    await d.mail.saveFolderState(accountId, folder, cur.uidValidity, m.uid);
  }
}

type Outcome = 'queued' | 'skipped' | 'waiting';

async function handleIncoming(accountId: number, msg: IncomingEmail, settings: WidgetSettings, d: PollDeps): Promise<Outcome> {
  const e = settings.email;
  const from = msg.from;
  if (!from || msg.automated || msg.fromAiDoor) return 'skipped';
  if (from.address === ourAddress(e) || isIgnored(from.address, e.ignore)) return 'skipped';
  if ((await d.mail.repliesToday(accountId, from.address)) >= e.maxRepliesPerAddressPerDay) {
    await d.journal.add({ accountId, kind: 'skipped', summary: `Письмо от ${from.address}: достигнут лимит ответов на адрес за сутки` });
    return 'skipped';
  }
  const parts = [`Тема письма: ${msg.subject || '(без темы)'}`, msg.text || '(пустое письмо)'];
  const openings: unknown[] = [];
  if (msg.attachments.length) {
    const docs = d.documents && settings.vision.autoParse ? d.documents : null;
    for (const a of msg.attachments.slice(0, MAX_ATTACHMENTS)) {
      const name = a.filename ?? a.contentType;
      if (!docs) {
        parts.push(`(во вложении файл «${name}» — разбор вложений выключен)`);
        continue;
      }
      try {
        const r = await docs.analyze({ accountId, leadId: null, source: 'email', filename: name, mime: a.contentType, bytes: new Uint8Array(a.content), settings });
        parts.push(r.text);
        openings.push(...r.memoryOpenings);
        await d.journal.add({ accountId, kind: 'document', summary: `Разобрано вложение «${name}» из письма от ${from.address} (${r.kind})`, details: { documentId: r.id, model: r.model }, costUsd: r.costUsd, costRub: r.costUsd * settings.billing.usdRubRate });
      } catch (err) {
        parts.push(`(во вложении файл «${name}», разобрать не удалось: ${(err as Error).message})`);
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
  const api = await d.amo(accountId);
  const link = await linkEmailToLead(api, from, msg.subject, e);
  if ('notFound' in link) {
    // Почта подключена к amo: сделку создаст amo — ответим, когда она появится.
    await d.mail.addWaiting(accountId, letter);
    await d.journal.add({ accountId, kind: 'note', summary: `Письмо от ${from.address}: ждём, пока amo создаст сделку` });
    return 'waiting';
  }
  if ('skip' in link) {
    await d.journal.add({ accountId, kind: 'skipped', summary: `Письмо от ${from.address} не обработано: ${link.skip}` });
    return 'skipped';
  }
  await enqueueLetter(accountId, link.leadId, letter, link.created, settings, d);
  return 'queued';
}

interface Letter {
  from: string;
  fromName: string;
  subject: string;
  text: string;
  meta: Record<string, unknown>;
}

async function enqueueLetter(
  accountId: number,
  leadId: number,
  l: Letter,
  created: 'none' | 'lead' | 'contact_and_lead',
  settings: WidgetSettings,
  d: PollDeps,
) {
  await d.dialog.enqueue(accountId, leadId, l.text, null, null, { channel: 'email', meta: l.meta });
  await d.journal.add({
    accountId,
    leadId,
    kind: 'note',
    summary: `Письмо от ${l.from}: «${l.subject}»${created === 'none' ? '' : created === 'lead' ? ' — создана сделка' : ' — созданы контакт и сделка'}`,
  });
  await d.schedule({ accountId, leadId }, settings.where.batchWindowSec * 1000);
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
    await enqueueLetter(accountId, link.leadId, w, link.created, settings, d);
    out.push('queued');
  }
  return out;
}
