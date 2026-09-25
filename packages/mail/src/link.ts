import type { AmoApiClient } from '@ai-door/amo';
import type { WidgetSettings } from '@ai-door/db';

/** Этапы «Успешно реализовано» и «Закрыто и не реализовано» — одинаковые во всех воронках amo. */
const CLOSED_STATUSES = new Set([142, 143]);

export type LinkResult =
  | { leadId: number; created: 'none' | 'lead' | 'contact_and_lead' }
  | { skip: string }
  | { notFound: true };

/**
 * Сделка для письма: открытая сделка контакта с этим e-mail (самая свежая).
 * Если её нет: action=create — новая сделка (и контакт), action=skip — пропустить,
 * action=report — вернуть notFound (ждём, пока сделку создаст почта amo).
 */
export async function linkEmailToLead(
  api: AmoApiClient,
  from: { address: string; name: string },
  subject: string,
  s: WidgetSettings['email'],
  action: 'create' | 'skip' | 'report' = s.unknownSender === 'create_lead' ? 'create' : s.unknownSender === 'skip' ? 'skip' : 'report',
): Promise<LinkResult> {
  const contacts = await api.findContactsByEmail(from.address);
  const leadIds = contacts.flatMap((c) => c._embedded?.leads?.map((l) => l.id) ?? []);
  const leads = await api.getLeadsByIds(leadIds);
  // «Неразобранное» — ещё не сделка: туда amo кладёт письма от кого угодно (поставщики, рассылки).
  // AI отвечает только клиентам в сделках — после того как менеджер принял заявку.
  const unsorted = leads.length ? await unsortedStatuses(api) : new Set<number>();
  const open = leads
    .filter((l) => !CLOSED_STATUSES.has(l.status_id) && !unsorted.has(l.status_id))
    .sort((a, b) => b.id - a.id)[0];
  if (open) return { leadId: open.id, created: 'none' };
  if (action === 'report') return { notFound: true };
  if (action === 'skip') return { skip: contacts.length ? 'нет открытой сделки у контакта' : 'отправитель не найден в amo' };

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

async function unsortedStatuses(api: AmoApiClient): Promise<Set<number>> {
  const pipelines = await api.getPipelines();
  return new Set(pipelines.flatMap((p) => p.statuses.filter((st) => st.unsorted).map((st) => st.id)));
}
