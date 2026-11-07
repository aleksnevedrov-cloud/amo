import type { Db } from '../db.ts';
import type { SecretBox } from '../crypto.ts';

/** Ошибка REST API amoCRM: status — HTTP-код ответа (0 — нет связи или нет доступа). */
export class AmoRestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface AmoContactInfo {
  id: number;
  name: string;
  phones: string[];
  responsibleUserId?: number;
}

export interface AmoLeadInfo {
  id: number;
  name: string;
  price: number;
  responsibleUserId: number;
  statusId: number;
  pipelineId: number;
  /** Пользовательские поля сделки: название → значение текстом (для переменных шаблонов). */
  fields: Record<string, string>;
  contactIds: number[];
}

const fieldText = (f: { values?: { value?: unknown; enum?: unknown }[] }): string =>
  (f.values ?? [])
    .map((v) => {
      const val = v.value;
      if (val === null || val === undefined) return '';
      if (typeof val === 'number' && val > 1_000_000_000 && val < 10_000_000_000) return new Date(val * 1000).toLocaleDateString('ru-RU');
      return String(val);
    })
    .filter(Boolean)
    .join(', ');

interface TokenRow {
  baseDomain: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

/** Домен аккаунта amo из allowlist (защита от подмены referer: секрет интеграции уходит только в amo). */
export function amoHost(raw: string, allowed: readonly string[]): string | null {
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  return allowed.some((d) => host.endsWith(`.${d}`)) ? host : null;
}

/**
 * REST API аккаунта amoCRM от имени интеграции «РФ-Мессенджер» (OAuth 2.0).
 * Токены хранятся в БД зашифрованными; обновление — под блокировкой строки,
 * чтобы процессы api и connectors не обменяли один refresh_token дважды.
 */
export class AmoRest {
  private readonly f: typeof fetch;

  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
    private readonly opts: { clientId: string; clientSecret: string; redirectUri: string; allowedDomains: readonly string[]; fetch?: typeof fetch },
  ) {
    this.f = opts.fetch ?? fetch;
  }

  private async tokenRequest(host: string, body: Record<string, string>): Promise<Required<TokenResponse>> {
    const res = await this.f(`https://${host}/oauth2/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: this.opts.clientId, client_secret: this.opts.clientSecret, redirect_uri: this.opts.redirectUri, ...body }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || !j.access_token || !j.refresh_token || !j.expires_in) throw new AmoRestError(`amoCRM не выдал токен (HTTP ${res.status})`, res.status);
    return j as Required<TokenResponse>;
  }

  private async save(accountId: number, host: string, t: Required<TokenResponse>, c: Pick<Db, 'query'> = this.db): Promise<TokenRow> {
    const row = { baseDomain: host, accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: new Date(Date.now() + t.expires_in * 1000) };
    await c.query(
      `INSERT INTO amo_oauth (account_id, base_domain, access_token, refresh_token, expires_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (account_id) DO UPDATE SET base_domain = EXCLUDED.base_domain, access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token, expires_at = EXCLUDED.expires_at, updated_at = now()`,
      [accountId, host, this.box.encrypt(row.accessToken), this.box.encrypt(row.refreshToken), row.expiresAt],
    );
    return row;
  }

  /**
   * Код авторизации из перенаправления amo → токены. Аккаунт берётся из ответа amo (/api/v4/account),
   * а не из запроса. Возвращает id аккаунта; isAllowed — проверка по AMO_ACCOUNT_IDS.
   */
  async exchangeCode(referer: string, code: string, isAllowed: (accountId: number) => boolean): Promise<number> {
    const host = amoHost(referer, this.opts.allowedDomains);
    if (!host) throw new AmoRestError('Неизвестный домен amoCRM', 400);
    const t = await this.tokenRequest(host, { grant_type: 'authorization_code', code });
    const res = await this.f(`https://${host}/api/v4/account`, { headers: { authorization: `Bearer ${t.access_token}` }, signal: AbortSignal.timeout(15_000) });
    const acc = (await res.json().catch(() => ({}))) as { id?: number };
    if (!res.ok || !acc.id) throw new AmoRestError(`amoCRM не вернул аккаунт (HTTP ${res.status})`, res.status);
    if (!isAllowed(acc.id)) throw new AmoRestError('Аккаунт не подключён к сервису', 403);
    await this.save(acc.id, host, t);
    return acc.id;
  }

  async connected(accountId: number): Promise<boolean> {
    const r = await this.db.query('SELECT 1 FROM amo_oauth WHERE account_id = $1', [accountId]);
    return r.rows.length > 0;
  }

  /** Действующий токен; за 5 минут до истечения — обновление под блокировкой строки. */
  private async token(accountId: number): Promise<TokenRow> {
    const c = await this.db.connect();
    try {
      await c.query('BEGIN');
      const r = await c.query('SELECT base_domain, access_token, refresh_token, expires_at FROM amo_oauth WHERE account_id = $1 FOR UPDATE', [accountId]);
      const row = r.rows[0];
      if (!row) throw new AmoRestError('Интеграция не авторизована в amoCRM: администратору нужно нажать «Авторизовать» в настройках виджета', 0);
      let t: TokenRow = {
        baseDomain: row.base_domain,
        accessToken: this.box.decrypt(row.access_token),
        refreshToken: this.box.decrypt(row.refresh_token),
        expiresAt: row.expires_at,
      };
      if (t.expiresAt.getTime() - Date.now() < 5 * 60_000) {
        const fresh = await this.tokenRequest(t.baseDomain, { grant_type: 'refresh_token', refresh_token: t.refreshToken }).catch((err: AmoRestError) => {
          throw new AmoRestError(
            err.status === 400 || err.status === 401 ? 'Доступ интеграции к amoCRM истёк: администратору нужно нажать «Авторизовать» в настройках виджета' : err.message,
            err.status,
          );
        });
        t = await this.save(accountId, t.baseDomain, fresh, c);
      }
      await c.query('COMMIT');
      return t;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  private async request<T>(accountId: number, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const t = await this.token(accountId);
    const res = await this.f(`https://${t.baseDomain}${path}`, {
      method,
      headers: { authorization: `Bearer ${t.accessToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 204) return {} as T;
    const text = await res.text();
    if (!res.ok) throw new AmoRestError(`amoCRM ${method} ${path.replace(/\?.*$/, '')}: HTTP ${res.status}`, res.status);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** id сотрудника в API чатов (для исходящих от его имени). */
  async userAmojoId(accountId: number, userId: number): Promise<string | null> {
    const u = await this.request<{ amojo_id?: string }>(accountId, 'GET', `/api/v4/users/${userId}?with=amojo_id`);
    return typeof u.amojo_id === 'string' && u.amojo_id ? u.amojo_id : null;
  }

  /** Контакты сделки с телефонами (основной контакт — первым). */
  async leadContacts(accountId: number, leadId: number): Promise<AmoContactInfo[]> {
    const lead = await this.request<{ _embedded?: { contacts?: { id: number; is_main?: boolean }[] } }>(accountId, 'GET', `/api/v4/leads/${leadId}?with=contacts`);
    const ids = (lead._embedded?.contacts ?? []).sort((a, b) => Number(Boolean(b.is_main)) - Number(Boolean(a.is_main))).map((c) => c.id);
    const out: AmoContactInfo[] = [];
    for (const id of ids.slice(0, 10)) out.push(await this.contact(accountId, id));
    return out;
  }

  async contact(accountId: number, contactId: number): Promise<AmoContactInfo> {
    const c = await this.request<{ id: number; name?: string; responsible_user_id?: number; custom_fields_values?: { field_code?: string; values?: { value?: unknown }[] }[] | null }>(
      accountId,
      'GET',
      `/api/v4/contacts/${contactId}`,
    );
    const phones = (c.custom_fields_values ?? [])
      .filter((f) => f.field_code === 'PHONE')
      .flatMap((f) => f.values ?? [])
      .map((v) => String(v.value ?? '').trim())
      .filter(Boolean);
    return { id: c.id, name: c.name || 'Без имени', phones: [...new Set(phones)], ...(c.responsible_user_id ? { responsibleUserId: c.responsible_user_id } : {}) };
  }

  /** Сделка с ответственным, бюджетом и полями (переменные шаблонов, права менеджера). */
  async lead(accountId: number, leadId: number): Promise<AmoLeadInfo> {
    const l = await this.request<{
      id: number;
      name?: string;
      price?: number;
      responsible_user_id?: number;
      status_id?: number;
      pipeline_id?: number;
      custom_fields_values?: { field_name?: string; values?: { value?: unknown }[] }[] | null;
      _embedded?: { contacts?: { id: number; is_main?: boolean }[] };
    }>(accountId, 'GET', `/api/v4/leads/${leadId}?with=contacts`);
    const fields: Record<string, string> = {};
    for (const f of l.custom_fields_values ?? []) if (f.field_name) fields[f.field_name] = fieldText(f);
    return {
      id: l.id,
      name: l.name ?? '',
      price: Number(l.price ?? 0),
      responsibleUserId: Number(l.responsible_user_id ?? 0),
      statusId: Number(l.status_id ?? 0),
      pipelineId: Number(l.pipeline_id ?? 0),
      fields,
      contactIds: (l._embedded?.contacts ?? []).sort((a, b) => Number(Boolean(b.is_main)) - Number(Boolean(a.is_main))).map((c) => c.id),
    };
  }

  /** Сделки контакта (для «Сделки» в шапке окна). */
  async contactLeads(accountId: number, contactId: number): Promise<{ id: number; name: string; price: number; statusId: number; pipelineId: number }[]> {
    const c = await this.request<{ _embedded?: { leads?: { id: number }[] } }>(accountId, 'GET', `/api/v4/contacts/${contactId}?with=leads`);
    const ids = (c._embedded?.leads ?? []).map((l) => l.id).slice(0, 20);
    if (!ids.length) return [];
    const r = await this.request<{ _embedded?: { leads?: { id: number; name?: string; price?: number; status_id?: number; pipeline_id?: number }[] } }>(
      accountId,
      'GET',
      `/api/v4/leads?${ids.map((id) => `filter[id][]=${id}`).join('&')}`,
    );
    return (r._embedded?.leads ?? []).map((l) => ({ id: l.id, name: l.name ?? `Сделка #${l.id}`, price: Number(l.price ?? 0), statusId: Number(l.status_id ?? 0), pipelineId: Number(l.pipeline_id ?? 0) }));
  }

  /** Имя сотрудника amoCRM (переменная {имя_менеджера}, подпись исходящих в окне). */
  async userName(accountId: number, userId: number): Promise<string> {
    const u = await this.request<{ name?: string }>(accountId, 'GET', `/api/v4/users/${userId}`);
    return u.name ?? `Сотрудник ${userId}`;
  }

  /** Чаты API чатов, привязанные к контактам: id чата amo → id контакта. */
  async contactChats(accountId: number, contactIds: readonly number[]): Promise<{ chatId: string; contactId: number }[]> {
    if (!contactIds.length) return [];
    const r = await this.request<{ _embedded?: { chats?: { chat_id: string; contact_id: number }[] } }>(
      accountId,
      'GET',
      `/api/v4/contacts/chats?${contactIds.map((id) => `contact_id[]=${id}`).join('&')}`,
    );
    return (r._embedded?.chats ?? []).map((c) => ({ chatId: c.chat_id, contactId: c.contact_id }));
  }

  /** Привязка чата API чатов к контакту — чат появляется в карточке контакта и его сделок. Уже привязанный к нему — без повтора. */
  async linkChat(accountId: number, amojoChatId: string, contactId: number): Promise<void> {
    const linked = await this.request<{ _embedded?: { chats?: { contact_id: number }[] } }>(
      accountId,
      'GET',
      `/api/v4/contacts/chats?chat_id[]=${encodeURIComponent(amojoChatId)}`,
    );
    const contacts = (linked._embedded?.chats ?? []).map((c) => c.contact_id);
    if (contacts.includes(contactId)) return;
    if (contacts.length) throw new AmoRestError('Этот чат мессенджера уже привязан к другому контакту в amoCRM', 409);
    await this.request(accountId, 'POST', '/api/v4/contacts/chats', [{ chat_id: amojoChatId, contact_id: contactId }]);
  }
}
