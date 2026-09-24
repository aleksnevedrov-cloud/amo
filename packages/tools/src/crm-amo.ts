import { fieldValues, type AmoApiClient } from '@ai-door/amo';
import { maskPii } from '@ai-door/shared';
import type { CrmPort, LeadContext } from './types.ts';

/** CRM-порт поверх amo API. Телефоны и e-mail в LLM не передаются (152-ФЗ). */
export class AmoCrm implements CrmPort {
  constructor(
    private readonly api: AmoApiClient,
    private readonly leadId: number,
  ) {}

  async getContext(): Promise<LeadContext | null> {
    const lead = await this.api.getLead(this.leadId);
    if (!lead) return null;
    const contactRef = lead._embedded?.contacts?.find((c) => c.is_main) ?? lead._embedded?.contacts?.[0];
    const [contact, notes] = await Promise.all([
      contactRef ? this.api.getContact(contactRef.id) : Promise.resolve(null),
      this.api.getLeadNotes(this.leadId, 5),
    ]);
    return {
      leadId: lead.id,
      name: maskPii(lead.name),
      budget: lead.price || null,
      statusId: lead.status_id,
      pipelineId: lead.pipeline_id,
      contactName: contact ? maskPii(contact.first_name || contact.name || '') || null : null,
      hasPhone: fieldValues(contact?.custom_fields_values, 'PHONE').length > 0,
      hasEmail: fieldValues(contact?.custom_fields_values, 'EMAIL').length > 0,
      tags: (lead._embedded?.tags ?? []).map((t) => t.name),
      recentNotes: notes.map((n) => maskPii(String(n.params?.text ?? ''))).filter(Boolean),
    };
  }

  async addNote(text: string): Promise<void> {
    await this.api.addLeadNote(this.leadId, text);
  }
}

/** CRM-порт песочницы: тестовая сделка, примечания копятся в памяти. */
export class SandboxCrm implements CrmPort {
  readonly notes: string[] = [];

  constructor(private readonly lead: Partial<LeadContext> = {}) {}

  async getContext(): Promise<LeadContext> {
    return {
      leadId: 0,
      name: 'Тестовая сделка (песочница)',
      budget: null,
      statusId: null,
      pipelineId: null,
      contactName: 'Тестовый клиент',
      hasPhone: false,
      hasEmail: false,
      tags: [],
      recentNotes: [],
      ...this.lead,
    };
  }

  async addNote(text: string): Promise<void> {
    this.notes.push(text);
  }
}
