import { AmoError } from './errors.ts';

export interface AmoAccount {
  id: number;
  name: string;
  subdomain: string;
}

export interface CustomFieldValue {
  field_id: number;
  field_name?: string;
  field_code?: string | null;
  values: { value: unknown; enum_code?: string | null }[];
}

export interface AmoLead {
  id: number;
  name: string;
  price: number | null;
  status_id: number;
  pipeline_id: number;
  responsible_user_id: number;
  created_at: number;
  custom_fields_values: CustomFieldValue[] | null;
  _embedded?: { contacts?: { id: number; is_main?: boolean }[]; tags?: { name: string }[] };
}

export interface AmoContact {
  id: number;
  name: string;
  first_name?: string;
  last_name?: string;
  custom_fields_values: CustomFieldValue[] | null;
}

export interface AmoNote {
  id: number;
  note_type: string;
  created_at: number;
  created_by: number;
  params?: { text?: string } & Record<string, unknown>;
}

export interface AmoEvent {
  id: string;
  type: string;
  entity_id: number;
  created_by: number;
  created_at: number;
}

export interface NewTask {
  text: string;
  completeTill: Date;
  leadId: number;
  taskTypeId: number;
  responsibleUserId?: number;
}

/** Клиент amoCRM API v4 с повтором при 429 (лимит amo — 7 запросов в секунду). */
export class AmoApiClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly accountDomain: string,
    private readonly getAccessToken: () => Promise<string>,
    fetchImpl?: typeof fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  getAccount(): Promise<AmoAccount> {
    return this.request<AmoAccount>('GET', '/api/v4/account') as Promise<AmoAccount>;
  }

  /** Воронки и этапы — для выбора в настройках виджета. */
  async getPipelines(): Promise<{ id: number; name: string; statuses: { id: number; name: string; unsorted?: boolean }[] }[]> {
    const res = await this.request<{
      _embedded?: { pipelines?: { id: number; name: string; _embedded?: { statuses?: { id: number; name: string; type?: number }[] } }[] };
    }>('GET', '/api/v4/leads/pipelines');
    return (res?._embedded?.pipelines ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      // type = 1 — этап «Неразобранное».
      statuses: (p._embedded?.statuses ?? []).map((st) => ({ id: st.id, name: st.name, ...(st.type === 1 ? { unsorted: true } : {}) })),
    }));
  }

  /** Типы задач аккаунта. */
  async getTaskTypes(): Promise<{ id: number; name: string }[]> {
    const res = await this.request<{ _embedded?: { task_types?: { id: number; name: string }[] } }>(
      'GET',
      '/api/v4/account?with=task_types',
    );
    return (res?._embedded?.task_types ?? []).map((t) => ({ id: t.id, name: t.name }));
  }

  async getLead(id: number): Promise<AmoLead | null> {
    return this.request<AmoLead>('GET', `/api/v4/leads/${id}?with=contacts`, undefined, { allow404: true });
  }

  /** Контакты, у которых e-mail совпадает точно (поиск amo — полнотекстовый, поэтому фильтруем). */
  async findContactsByEmail(email: string): Promise<(AmoContact & { _embedded?: { leads?: { id: number }[] } })[]> {
    const q = new URLSearchParams({ query: email, with: 'leads', limit: '10' });
    const res = await this.request<{ _embedded?: { contacts?: (AmoContact & { _embedded?: { leads?: { id: number }[] } })[] } }>(
      'GET',
      `/api/v4/contacts?${q}`,
    );
    const target = email.toLowerCase();
    return (res?._embedded?.contacts ?? []).filter((c) => fieldValues(c.custom_fields_values, 'EMAIL').some((v) => v.toLowerCase() === target));
  }

  async getLeadsByIds(ids: number[]): Promise<AmoLead[]> {
    if (!ids.length) return [];
    const q = new URLSearchParams(ids.slice(0, 50).map((id): [string, string] => ['filter[id][]', String(id)]));
    const res = await this.request<{ _embedded?: { leads?: AmoLead[] } }>('GET', `/api/v4/leads?${q}`);
    return res?._embedded?.leads ?? [];
  }

  /** Новая сделка для существующего контакта. */
  async createLeadForContact(contactId: number, name: string, pipelineId?: number | null, statusId?: number | null): Promise<number> {
    const res = await this.request<{ _embedded: { leads: { id: number }[] } }>('POST', '/api/v4/leads', [
      {
        name,
        ...(pipelineId ? { pipeline_id: pipelineId } : {}),
        ...(statusId ? { status_id: statusId } : {}),
        _embedded: { contacts: [{ id: contactId }] },
      },
    ]);
    const id = res?._embedded.leads[0]?.id;
    if (!id) throw new AmoError('amo не вернул id сделки');
    return id;
  }

  /** Сделка и контакт одним запросом (комплексное добавление). */
  async createLeadWithContact(a: {
    leadName: string;
    contactName: string;
    email: string;
    pipelineId?: number | null;
    statusId?: number | null;
  }): Promise<{ leadId: number; contactId: number }> {
    const res = await this.request<{ id: number; contact_id: number }[]>('POST', '/api/v4/leads/complex', [
      {
        name: a.leadName,
        ...(a.pipelineId ? { pipeline_id: a.pipelineId } : {}),
        ...(a.statusId ? { status_id: a.statusId } : {}),
        _embedded: {
          contacts: [
            {
              name: a.contactName,
              custom_fields_values: [{ field_code: 'EMAIL', values: [{ value: a.email, enum_code: 'WORK' }] }],
            },
          ],
        },
      },
    ]);
    const r = res?.[0];
    if (!r?.id) throw new AmoError('amo не вернул id сделки');
    return { leadId: r.id, contactId: r.contact_id };
  }

  async getContact(id: number): Promise<AmoContact | null> {
    return this.request<AmoContact>('GET', `/api/v4/contacts/${id}`, undefined, { allow404: true });
  }

  /** Последние примечания сделки (без системных). */
  async getLeadNotes(leadId: number, limit = 10): Promise<AmoNote[]> {
    const res = await this.request<{ _embedded?: { notes?: AmoNote[] } }>(
      'GET',
      `/api/v4/leads/${leadId}/notes?limit=50&filter[note_type][]=common`,
    );
    return (res?._embedded?.notes ?? []).slice(-limit);
  }

  async addLeadNote(leadId: number, text: string): Promise<number> {
    const res = await this.request<{ _embedded: { notes: { id: number }[] } }>('POST', `/api/v4/leads/${leadId}/notes`, [
      { note_type: 'common', params: { text } },
    ]);
    return res?._embedded.notes[0]?.id ?? 0;
  }

  async createTask(t: NewTask): Promise<number> {
    const res = await this.request<{ _embedded: { tasks: { id: number }[] } }>('POST', '/api/v4/tasks', [
      {
        text: t.text,
        complete_till: Math.floor(t.completeTill.getTime() / 1000),
        entity_id: t.leadId,
        entity_type: 'leads',
        task_type_id: t.taskTypeId,
        ...(t.responsibleUserId ? { responsible_user_id: t.responsibleUserId } : {}),
      },
    ]);
    return res?._embedded.tasks[0]?.id ?? 0;
  }

  /**
   * Запуск бота Salesbot по сделке (API v2). Через бота-отправщика уходят одобренные черновики.
   * Формат запроса сверить с документацией amo при установке.
   */
  async runSalesbot(botId: number, leadId: number): Promise<void> {
    await this.request('POST', '/api/v2/salesbot/run', [{ bot_id: botId, entity_id: leadId, entity_type: 2 }]);
  }

  async setLeadStatus(leadId: number, statusId: number): Promise<void> {
    await this.request('PATCH', `/api/v4/leads/${leadId}`, { status_id: statusId });
  }

  /**
   * Исходящие сообщения чата по сделке после момента `since`.
   * created_by = 0 — робот/бот, иначе id пользователя amo (менеджер).
   */
  async getOutgoingChatEvents(leadId: number, since: Date): Promise<AmoEvent[]> {
    const q = new URLSearchParams({
      'filter[entity]': 'lead',
      'filter[entity_id]': String(leadId),
      'filter[type]': 'outgoing_chat_message',
      'filter[created_at][from]': String(Math.floor(since.getTime() / 1000)),
      limit: '50',
    });
    const res = await this.request<{ _embedded?: { events?: AmoEvent[] } }>('GET', `/api/v4/events?${q}`);
    return res?._embedded?.events ?? [];
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { allow404?: boolean } = {},
  ): Promise<T | null> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.getAccessToken();
      const res = await this.fetchImpl(`https://${this.accountDomain}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 429 && attempt < 3) {
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      // amo отвечает 204 на пустые списки.
      if (res.status === 204) return null;
      if (res.status === 404 && opts.allow404) return null;
      if (!res.ok) {
        throw new AmoError(`amo API ${method} ${path.split('?')[0]}: HTTP ${res.status}`, res.status, await res.text().catch(() => ''));
      }
      return (await res.json()) as T;
    }
  }
}

/** Значение поля по коду (PHONE, EMAIL) или имени. */
export function fieldValues(fields: CustomFieldValue[] | null | undefined, codeOrName: string): string[] {
  return (fields ?? [])
    .filter((f) => f.field_code === codeOrName || f.field_name === codeOrName)
    .flatMap((f) => f.values.map((v) => String(v.value)));
}
