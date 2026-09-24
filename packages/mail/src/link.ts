import type { AmoApiClient } from '@ai-door/amo';
import type { WidgetSettings } from '@ai-door/db';

/** Этапы «Успешно реализовано» и «Закрыто и не реализовано» — одинаковые во всех воронках amo. */
const CLOSED_STATUSES = new Set([142, 143]);

export type LinkResult = { leadId: number; created: 'none' | 'lead' | 'contact_and_lead' } | { skip: string };

/**
 * Сделка для письма: открытая сделка контакта с этим e-mail (самая свежая);
 * если её нет — новая сделка (и контакт) по настройкам.
 */
export async function linkEmailToLead(
  api: AmoApiClient,
  from: { address: string; name: string },
  subject: string,
  s: WidgetSettings['email'],
): Promise<LinkResult> {
  const contacts = await api.findContactsByEmail(from.address);
  const leadIds = contacts.flatMap((c) => c._embedded?.leads?.map((l) => l.id) ?? []);
  const leads = await api.getLeadsByIds(leadIds);
  const open = leads.filter((l) => !CLOSED_STATUSES.has(l.status_id)).sort((a, b) => b.id - a.id)[0];
  if (open) return { leadId: open.id, created: 'none' };
  if (s.unknownSender === 'skip') return { skip: contacts.length ? 'нет открытой сделки у контакта' : 'отправитель не найден в amo' };

  const leadName = `Письмо: ${subject || from.address}`.slice(0, 250);
  const contact = contacts[0];
  if (contact) {
    return { leadId: await api.createLeadForContact(contact.id, leadName, s.newLeadPipelineId, s.newLeadStatusId), created: 'lead' };
  }
  const r = await api.createLeadWithContact({
    leadName,
    contactName: from.name || from.address,
    email: from.address,
    pipelineId: s.newLeadPipelineId,
    statusId: s.newLeadStatusId,
  });
  return { leadId: r.leadId, created: 'contact_and_lead' };
}
