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
}

export interface PollResult {
  accountId: number;
  received: number;
  queued: number;
  skipped: number;
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
  const res: PollResult = { accountId, received: 0, queued: 0, skipped: 0, managerReplies: 0 };
  const { settings } = await d.settings.get(accountId);
  const e = settings.email;
  if (!e.enabled || !e.imapHost || !e.username) return res;
  const password = await d.mail.getPassword(accountId);
  if (!password) return res;

  let box: Mailbox | null = null;
  try {
    box = await d.connect(serverConfig(e, password));
    await readFolder(box, accountId, e.inboxFolder, d, async (msg) => {
      res.received += 1;
      const r = await handleIncoming(accountId, msg, settings, d);
      if (r === 'queued') res.queued += 1;
      else res.skipped += 1;
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

async function handleIncoming(accountId: number, msg: IncomingEmail, settings: WidgetSettings, d: PollDeps): Promise<'queued' | 'skipped'> {
  const e = settings.email;
  const from = msg.from;
  if (!from || msg.automated || msg.fromAiDoor) return 'skipped';
  if (from.address === ourAddress(e) || isIgnored(from.address, e.ignore)) return 'skipped';
  if ((await d.mail.repliesToday(accountId, from.address)) >= e.maxRepliesPerAddressPerDay) {
    await d.journal.add({ accountId, kind: 'skipped', summary: `Письмо от ${from.address}: достигнут лимит ответов на адрес за сутки` });
    return 'skipped';
  }
  const api = await d.amo(accountId);
  const link = await linkEmailToLead(api, from, msg.subject, e);
  if ('skip' in link) {
    await d.journal.add({ accountId, kind: 'skipped', summary: `Письмо от ${from.address} не обработано: ${link.skip}` });
    return 'skipped';
  }
  const parts = [`Тема письма: ${msg.subject || '(без темы)'}`, msg.text || '(пустое письмо)'];
  if (msg.attachments.length) {
    parts.push(`(во вложении: ${msg.attachments.map((a) => a.filename ?? a.contentType).join(', ')} — разбор вложений появится позже)`);
  }
  await d.dialog.enqueue(accountId, link.leadId, parts.join('\n'), null, null, {
    channel: 'email',
    meta: {
      from: from.address,
      fromName: from.name,
      subject: msg.subject,
      messageId: msg.messageId,
      references: msg.references,
    },
  });
  await d.journal.add({
    accountId,
    leadId: link.leadId,
    kind: 'note',
    summary: `Письмо от ${from.address}: «${msg.subject}»${link.created === 'none' ? '' : link.created === 'lead' ? ' — создана сделка' : ' — созданы контакт и сделка'}`,
  });
  await d.schedule({ accountId, leadId: link.leadId }, settings.where.batchWindowSec * 1000);
  return 'queued';
}
