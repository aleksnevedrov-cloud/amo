import { canCreateTask, fieldValues, taskBlockSummary, type AmoApiClient, type TaskScope } from '@core/amo';
import { maskPii } from '@core/shared';
import { memorySchema, mergeMemory, type ClientMemory, type MemoryPatch } from '@core/db';
import type { CrmPort, LeadContext, MemoryPort } from './types.ts';

/** Задачу ставить нельзя: сделка закрыта, чужая воронка или этап, либо задача уже есть. */
export class TaskNotAllowedError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'TaskNotAllowedError';
  }
}

/** CRM-порт поверх amo API. Телефоны и e-mail в LLM не передаются (152-ФЗ). */
export class AmoCrm implements CrmPort {
  constructor(
    private readonly api: AmoApiClient,
    private readonly leadId: number,
    /** Получатель задач (ответственный / администратор) — считает pipeline один раз на ход. */
    private readonly assignee?: () => Promise<{ userId: number | null } | null>,
    /** Где агенту разрешено ставить задачи; не задано — ограничений нет. */
    private readonly scope?: TaskScope,
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

  async createTask(t: { text: string; taskTypeId: number; deadlineMin: number }): Promise<void> {
    // Те же правила, что у обходов: своя воронка и этап, открытая сделка, второй задачи не плодим
    // (RFD-AI-AGENT-ZADACHI-ZAKRYTYE-SDELKI). Инструмент агента раньше ставил задачи без проверок.
    if (this.scope) {
      const lead = await this.api.getLead(this.leadId).catch(() => null);
      if (lead) {
        const gate = await canCreateTask(this.api, lead, this.scope);
        if (!gate.allowed) throw new TaskNotAllowedError(taskBlockSummary(gate), gate.reason ?? 'blocked');
      }
    }
    // Получателя выбирает код: ответственный по сделке, иначе администратор (см. resolveTaskAssignee).
    const a = this.assignee ? await this.assignee().catch(() => null) : null;
    await this.api.createTask({
      text: t.text,
      taskTypeId: t.taskTypeId,
      completeTill: new Date(Date.now() + t.deadlineMin * 60_000),
      leadId: this.leadId,
      ...(a?.userId ? { responsibleUserId: a.userId } : {}),
    });
  }

  /** Основной контакт сделки — ключ памяти клиента. */
  async mainContactId(): Promise<number | null> {
    const lead = await this.api.getLead(this.leadId);
    const ref = lead?._embedded?.contacts?.find((c) => c.is_main) ?? lead?._embedded?.contacts?.[0];
    return ref?.id ?? null;
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

  readonly tasks: { text: string; taskTypeId: number; deadlineMin: number }[] = [];

  async addNote(text: string): Promise<void> {
    this.notes.push(text);
  }

  async createTask(t: { text: string; taskTypeId: number; deadlineMin: number }): Promise<void> {
    this.tasks.push(t);
  }
}

/** Память в оперативной памяти — для песочницы и тестов. */
export class InMemoryMemory implements MemoryPort {
  private data: ClientMemory = memorySchema.parse({});
  async get() {
    return this.data;
  }
  async update(patch: MemoryPatch) {
    this.data = mergeMemory(this.data, patch);
    return this.data;
  }
}
