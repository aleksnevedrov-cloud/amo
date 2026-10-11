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
  /** Unix-секунды закрытия сделки; 0 или null — сделка открыта. */
  closed_at?: number | null;
  custom_fields_values: CustomFieldValue[] | null;
  _embedded?: { contacts?: { id: number; is_main?: boolean }[]; tags?: { name: string }[] };
}

/** Пользователь аккаунта amo (для выбора получателя задач). */
export interface AmoUser {
  id: number;
  name: string;
  email: string | null;
  isActive: boolean;
  isAdmin: boolean;
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
  async getPipelines(): Promise<{ id: number; name: string; statuses: { id: number; name: string; sort: number; unsorted?: boolean }[] }[]> {
    const res = await this.request<{
      _embedded?: { pipelines?: { id: number; name: string; _embedded?: { statuses?: { id: number; name: string; sort?: number; type?: number }[] } }[] };
    }>('GET', '/api/v4/leads/pipelines');
    return (res?._embedded?.pipelines ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      // type = 1 — этап «Неразобранное»; sort — порядок этапа в воронке (для аналитики: «ушла вперёд»).
      statuses: (p._embedded?.statuses ?? []).map((st, i) => ({ id: st.id, name: st.name, sort: st.sort ?? (i + 1) * 10, ...(st.type === 1 ? { unsorted: true } : {}) })),
    }));
  }

  /** Типы задач аккаунта. */
  /** Домен аккаунта — ключ кэшей (список пользователей). */
  get domain(): string {
    return this.accountDomain;
  }

  /** Пользователи аккаунта: активность и права администратора. */
  async listUsers(): Promise<AmoUser[]> {
    const res = await this.request<{ _embedded?: { users?: { id: number; name: string; email?: string; rights?: { is_active?: boolean; is_admin?: boolean } }[] } }>(
      'GET',
      '/api/v4/users?limit=250',
    );
    return (res?._embedded?.users ?? []).map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email ?? null,
      isActive: u.rights?.is_active !== false,
      isAdmin: Boolean(u.rights?.is_admin),
    }));
  }

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

  /**
   * Письма сделки из самой amoCRM (примечания типа amomail_message).
   * Почту опрашивает amo, агенту отдельный заход в ящик не нужен: читаем то,
   * что уже лежит в карточке и что видит менеджер (тема RFD-AI-AGENT-KP).
   */
  async leadMailNotes(leadId: number, limit = 20): Promise<LeadMail[]> {
    const q = `?filter[note_type][]=amomail_message&order[created_at]=desc&limit=${Math.min(limit, 250)}`;
    const res = await this.request<{ _embedded?: { notes?: Record<string, unknown>[] } }>(
      'GET',
      `/api/v4/leads/${leadId}/notes${q}`,
    ).catch(() => null);
    const rows = res?._embedded?.notes ?? [];
    return rows.map(toLeadMail).filter((m): m is LeadMail => m !== null);
  }

  /** Сделки по фильтру: воронка, этапы, интервал создания. */
  async listLeads(f: {
    pipelineId?: number;
    statusIds?: number[];
    createdFrom?: Date;
    createdTo?: Date;
    page?: number;
    limit?: number;
  }): Promise<
    {
      id: number;
      name: string;
      status_id: number;
      pipeline_id: number;
      responsible_user_id: number;
      created_at: number;
      updated_at?: number;
      closed_at?: number | null;
    }[]
  > {
    const q: string[] = [`limit=${f.limit ?? 250}`, `page=${f.page ?? 1}`];
    if (f.pipelineId) q.push(`filter[pipeline_id]=${f.pipelineId}`);
    (f.statusIds ?? []).forEach((s, i) => {
      if (f.pipelineId) q.push(`filter[statuses][${i}][pipeline_id]=${f.pipelineId}`);
      q.push(`filter[statuses][${i}][status_id]=${s}`);
    });
    if (f.createdFrom) q.push(`filter[created_at][from]=${Math.floor(f.createdFrom.getTime() / 1000)}`);
    if (f.createdTo) q.push(`filter[created_at][to]=${Math.floor(f.createdTo.getTime() / 1000)}`);
    const res = await this.request<{
      _embedded?: {
        leads?: {
          id: number;
          name: string;
          status_id: number;
          pipeline_id: number;
          responsible_user_id: number;
          created_at: number;
          updated_at?: number;
          closed_at?: number | null;
        }[];
      };
    }>('GET', `/api/v4/leads?${q.join('&')}`);
    return res?._embedded?.leads ?? [];
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

  /** Незакрытые задачи сделки: по ним решаем, нужна ли ещё одна. */
  async openLeadTasks(leadId: number): Promise<{ id: number; text: string }[]> {
    const res = await this.request<{ _embedded?: { tasks?: { id: number; text: string }[] } }>(
      'GET',
      `/api/v4/tasks?filter[entity_type]=leads&filter[entity_id]=${leadId}&filter[is_completed]=0&limit=50`,
    );
    return res?._embedded?.tasks ?? [];
  }

  /**
   * Запуск бота Salesbot по сделке (API v2). Через бота-отправщика уходят одобренные черновики.
   * Формат запроса сверить с документацией amo при установке.
   */
  async runSalesbot(botId: number, leadId: number): Promise<void> {
    await this.request('POST', '/api/v2/salesbot/run', [{ bot_id: botId, entity_id: leadId, entity_type: 2 }]);
  }

  /** Остановить бота по сделке: пока он ждёт на шаге виджета, amo не запускает его на новые сообщения клиента. */
  async stopBot(botId: number, leadId: number): Promise<void> {
    await this.request('POST', `/api/v4/bots/${botId}/stop`, { entity_id: leadId, entity_type: 'leads' });
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

  /** Задачи по сделке, закрытые после `since`. */
  async completedLeadTasksSince(
    leadId: number,
    since: Date,
  ): Promise<{ id: number; text: string }[]> {
    const q = new URLSearchParams({
      'filter[entity_type]': 'leads',
      'filter[entity_id]': String(leadId),
      'filter[is_completed]': '1',
      'filter[updated_at][from]': String(Math.floor(since.getTime() / 1000)),
      limit: '50',
    });
    const res = await this.request<{ _embedded?: { tasks?: { id: number; text: string }[] } }>(
      'GET',
      `/api/v4/tasks?${q}`,
    );
    return res?._embedded?.tasks ?? [];
  }

  /**
   * Загрузка файла в карточку сделки через Files API amoCRM: сессия загрузки,
   * заливка частями, привязка к сделке. Возвращает uuid файла или null,
   * если amo не принял файл (вызывающий сам решает про запасной путь).
   */
  async uploadFileToLead(
    leadId: number,
    file: { filename: string; mime: string; bytes: Uint8Array },
  ): Promise<string | null> {
    const session = await this.request<{ upload_url?: string; max_part_size?: number }>(
      'POST',
      '/api/v4/files/sessions',
      {
        file_name: file.filename,
        file_size: file.bytes.byteLength,
        content_type: file.mime || 'application/octet-stream',
        with_preview: false,
      },
    );
    const first = session?.upload_url;
    if (!first) return null;

    const partSize = Math.max(1, Number(session?.max_part_size ?? file.bytes.byteLength));
    let url = first;
    let uuid: string | null = null;
    for (let offset = 0; offset < file.bytes.byteLength; ) {
      const chunk = file.bytes.subarray(offset, offset + partSize);
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        // ArrayBuffer, а не Uint8Array: типы fetch в сборке виджета строже.
        body: chunk.slice().buffer as ArrayBuffer,
      });
      if (!res.ok) {
        throw new Error(`amo upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const body = (await res.json().catch(() => null)) as
        | { uuid?: string; next_url?: string }
        | null;
      offset += chunk.byteLength;
      if (body?.uuid) uuid = body.uuid;
      if (body?.next_url) url = body.next_url;
    }
    if (!uuid) return null;

    await this.request('POST', `/api/v4/leads/${leadId}/files`, [{ file_uuid: uuid }]);
    return uuid;
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
        if (res.status === 202) return null; // 202 Accepted без тела: запуск/остановка бота.
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

/** Письмо в карточке сделки amoCRM. */
export interface LeadMail {
  id: number;
  createdAt: Date;
  /** true — входящее от клиента, false — наш ответ. */
  income: boolean;
  subject: string;
  text: string;
  from: string;
  to: string;
  attachments: string[];
}

const mailText = (p: Record<string, unknown>): string => {
  for (const k of ['text', 'content', 'body', 'message']) {
    const v = p[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
};

const mailAddress = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(mailAddress).filter(Boolean).join(', ');
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const mail = typeof o.email === 'string' ? o.email : '';
    const name = typeof o.name === 'string' ? o.name : '';
    return [name, mail].filter(Boolean).join(' ');
  }
  return '';
};

/** Разбор примечания-письма: формат params у amo отличается между версиями почты. */
function toLeadMail(row: Record<string, unknown>): LeadMail | null {
  const p = (row.params ?? {}) as Record<string, unknown>;
  const text = mailText(p);
  const subject = typeof p.subject === 'string' ? p.subject : '';
  if (!text && !subject) return null;
  const att = p.attachments;
  return {
    id: Number(row.id ?? 0),
    createdAt: new Date(Number(row.created_at ?? 0) * 1000),
    income: p.income === true || p.income === 1 || p.income === '1',
    subject,
    text,
    from: mailAddress(p.from),
    to: mailAddress(p.to),
    attachments: Array.isArray(att)
      ? att.map((a) => (typeof a === 'string' ? a : String((a as Record<string, unknown>)?.name ?? ''))).filter(Boolean)
      : [],
  };
}

