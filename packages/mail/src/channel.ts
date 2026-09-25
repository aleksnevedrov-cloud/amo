import type { AmoApiClient } from '@ai-door/amo';
import type { SettingsRepo } from '@ai-door/db';
import { ourAddress, serverConfig } from './poller.ts';
import type { MailRepo } from './repo.ts';
import { buildReply } from './reply.ts';
import type { Mailbox, MailSender, MailServerConfig } from './transport.ts';

/** Данные письма клиента, на которое отвечаем (pending_messages.meta). */
export interface EmailMeta {
  from: string;
  fromName?: string;
  subject?: string;
  messageId?: string | null;
  references?: string[];
}

export interface EmailChannelDeps {
  settings: SettingsRepo;
  mail: MailRepo;
  amo(accountId: number): Promise<AmoApiClient>;
  sender(cfg: MailServerConfig): MailSender;
  connect(cfg: MailServerConfig): Promise<Mailbox>;
}

/** Отправка ответов AI по почте: SMTP, копия в «Отправленные», примечание в сделку. */
export class EmailChannel {
  constructor(private readonly d: EmailChannelDeps) {}

  async reply(accountId: number, leadId: number, meta: EmailMeta, text: string): Promise<{ messageId: string }> {
    const { settings } = await this.d.settings.get(accountId);
    const e = settings.email;
    const password = await this.d.mail.getPassword(accountId);
    if (!e.enabled || !password) throw new Error('Почта не подключена');
    const cfg = serverConfig(e, password);
    const mail = buildReply(
      { name: e.fromName, address: ourAddress(e) },
      { to: meta.from, toName: meta.fromName, subject: meta.subject ?? '', inReplyTo: meta.messageId ?? null, references: meta.references ?? [] },
      text,
      e.signature,
    );
    const raw = await this.d.sender(cfg).send(mail);
    await this.d.mail.logOutbound(accountId, leadId, meta.from, mail.messageId);

    // Копия в «Отправленные» — чтобы ответ был виден в почте и в amo; сбой не отменяет отправку.
    if (e.saveToSent) {
      let box: Mailbox | null = null;
      try {
        box = await this.d.connect(cfg);
        const sent = e.sentFolder || (await box.findSentFolder());
        if (sent) await box.append(sent, raw);
      } catch {
        // ignore
      } finally {
        await box?.close().catch(() => undefined);
      }
    }
    // Если почта подключена к amo, ответ и так виден в сделке (из «Отправленных») — примечание по настройке.
    if (e.noteInLead) {
      const api = await this.d.amo(accountId);
      await api.addLeadNote(leadId, `[AI] Ответ по почте на ${meta.from} («${mail.subject}»):\n\n${text}`).catch(() => undefined);
    }
    return { messageId: mail.messageId };
  }

  managerRepliedSince(accountId: number, addresses: string[], since: Date): Promise<boolean> {
    return this.d.mail.managerRepliedSince(accountId, addresses, since);
  }
}
