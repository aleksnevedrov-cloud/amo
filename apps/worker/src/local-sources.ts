import type { LocalSources } from '@core/calls';
import { DialogRepo, MailAttachmentsRepo, WazzupRepo, type Db } from '@core/db';
import { wazzupFileName, wazzupMimeOf } from '@retail/agent';

/**
 * Локальные источники общения для итога дня и показа по сделке (RFD-AI-AGENT-CALLS-DAY-FULL, WA-FILES): Wazzup по сделке и
 * телефонам контактов (с файлами и извлечённым текстом), диалог агента (dialog_messages), сделки с перепиской за период,
 * вложения входящих писем с текстом. Одна сборка для воркера (calls-day-summary) и консольных команд (calls-demo) —
 * RFD-AI-AGENT-CALLS-DEMO-SOURCES.
 */
export function buildLocalSources(db: Db): LocalSources {
  const wazzup = new WazzupRepo(db);
  const dialog = new DialogRepo(db);
  const mailAttachments = new MailAttachmentsRepo(db);
  return {
    wazzup: async (accountId, leadId, phones, since, until) =>
      (await wazzup.chatForLeadBetween(accountId, leadId, phones, since, until)).map((m) => ({
        id: m.messageId,
        direction: m.direction,
        author: m.direction === 'in' ? ('client' as const) : ('manager' as const),
        text: m.text,
        at: m.sentAt,
        channel: m.chatType ?? undefined,
        ...(m.file ? { file: { name: m.file.name ?? wazzupFileName({ contentUri: m.file.uri, contentType: m.file.type, raw: null }), mime: wazzupMimeOf(m.file.type, null), text: m.file.text, status: m.file.status, error: m.file.error } } : {}),
      })),
    dialog: async (accountId, leadId, since, until) =>
      (await dialog.betweenByLead(accountId, leadId, since, until)).map((m) => ({
        id: String(m.id),
        direction: m.role === 'client' ? ('in' as const) : ('out' as const),
        author: m.role === 'client' ? ('client' as const) : m.role === 'ai' ? ('agent' as const) : ('manager' as const),
        text: m.text,
        at: m.createdAt,
      })),
    activeLeads: async (accountId, since, until) => [...new Set([...(await wazzup.leadsActiveBetween(accountId, since, until)), ...(await dialog.leadsActiveBetween(accountId, since, until))])],
    mailFiles: async (accountId, leadId, since, until) => (await mailAttachments.listByLeadBetween(accountId, leadId, since, until)).map((a) => ({ id: String(a.id), at: a.createdAt, messageId: a.messageId, name: a.filename, text: a.extractedText, status: a.extractStatus })),
  };
}
