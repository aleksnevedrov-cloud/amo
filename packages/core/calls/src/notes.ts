import { AmoError } from '@core/amo';

/**
 * RFD-AI-AGENT-OPT-CALLS, этап 1: примечания-звонки amoCRM (call_in / call_out) из карточек контактов и сделок.
 * Клиент amo из @core/amo метода для списка примечаний по всем сущностям не имеет, а его запросы приватные;
 * ядро не меняем — здесь свой короткий запрос с теми же правилами (bearer, повтор при 429, 204 — пусто).
 */

/** Примечание-звонок amo (поля из /api/v4/{contacts,leads}/notes с filter[note_type][]=call_in,call_out). */
export interface AmoCallNote {
  id: number;
  entity_id: number;
  created_by: number;
  updated_by?: number;
  created_at: number;
  updated_at: number;
  responsible_user_id?: number;
  note_type: string;
  params?: Record<string, unknown>;
}

export interface AmoRaw {
  get<T>(path: string): Promise<T | null>;
  post<T>(path: string, body: unknown): Promise<T | null>;
  patch<T>(path: string, body: unknown): Promise<T | null>;
}

/** GET / POST / PATCH на домене аккаунта: bearer, повтор при 429 до 3 раз, 204 → null, остальные ошибки — AmoError. */
export function amoRaw(accountDomain: string, getAccessToken: () => Promise<string>, fetchImpl: typeof fetch, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): AmoRaw {
  const request = async <T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T | null> => {
    for (let attempt = 0; ; attempt++) {
      const token = await getAccessToken();
      const res = await fetchImpl(`https://${accountDomain}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 429 && attempt < 3) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (res.status === 204) return null;
      if (!res.ok) throw new AmoError(`amo API ${method} ${path.split('?')[0]}: HTTP ${res.status}`, res.status, await res.text().catch(() => ''));
      return (await res.json()) as T;
    }
  };
  return { get: (path) => request('GET', path), post: (path, body) => request('POST', path, body), patch: (path, body) => request('PATCH', path, body) };
}

export type CallEntity = 'contact' | 'lead';

const NOTES_PAGE = 250;
/** Страниц за один опрос: 250 × 20 = 5 000 примечаний — хватает и на разовый догон истории. */
const MAX_PAGES = 20;

/**
 * Примечания-звонки с updated_at не раньше since, страницами по 250, от старых к новым. Возвращает примечания и
 * сколько страниц прочитано; если страниц больше MAX_PAGES — остаток придёт в следующий опрос (отметка — по последнему).
 */
export async function fetchCallNotes(amo: AmoRaw, entity: CallEntity, since: Date): Promise<{ notes: AmoCallNote[]; pages: number; truncated: boolean }> {
  const base = `/api/v4/${entity === 'contact' ? 'contacts' : 'leads'}/notes`;
  const from = Math.max(0, Math.floor(since.getTime() / 1000));
  const notes: AmoCallNote[] = [];
  let pages = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const q = `?filter[note_type][]=call_in&filter[note_type][]=call_out&filter[updated_at][from]=${from}&order[updated_at]=asc&limit=${NOTES_PAGE}&page=${page}`;
    const res = await amo.get<{ _embedded?: { notes?: AmoCallNote[] } }>(`${base}${q}`);
    pages = page;
    const rows = res?._embedded?.notes ?? [];
    notes.push(...rows);
    if (rows.length < NOTES_PAGE) return { notes, pages, truncated: false };
  }
  return { notes, pages, truncated: true };
}

/** Примечания-звонки одной сделки или контакта (все, без отметки), страницами по 250. */
export async function fetchEntityCallNotes(amo: AmoRaw, entity: CallEntity, entityId: number): Promise<AmoCallNote[]> {
  const base = `/api/v4/${entity === 'contact' ? 'contacts' : 'leads'}/${entityId}/notes`;
  const notes: AmoCallNote[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await amo.get<{ _embedded?: { notes?: AmoCallNote[] } }>(`${base}?filter[note_type][]=call_in&filter[note_type][]=call_out&order[created_at]=asc&limit=${NOTES_PAGE}&page=${page}`);
    const rows = res?._embedded?.notes ?? [];
    notes.push(...rows.map((n) => ({ ...n, entity_id: n.entity_id ?? entityId })));
    if (rows.length < NOTES_PAGE) break;
  }
  return notes;
}

/** Контакты сделки (id). */
export async function leadContactIds(amo: AmoRaw, leadId: number): Promise<number[]> {
  const lead = await amo.get<{ _embedded?: { contacts?: { id: number }[] } }>(`/api/v4/leads/${leadId}?with=contacts`);
  if (!lead) throw new Error(`сделка ${leadId} не найдена в amo`);
  return (lead._embedded?.contacts ?? []).map((c) => c.id);
}

/** Хосты записей, которые скачиваем: ВАТС МегаФон (текущая) и OnlinePBX (старые ссылки, пробуем). */
export function recordHostAllowed(link: string): boolean {
  try {
    const u = new URL(link);
    if (u.protocol !== 'https:') return false;
    return /(^|\.)(megapbx\.ru|onpbx\.ru)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/** Ключ записи: uuid из ссылки ВАТС (…/record/<дата>/<uuid>/<файл>), иначе имя файла без расширения, иначе вся ссылка. */
export function recordKeyOf(link: string): string {
  const m = /\/record\/\d{4}-\d{2}-\d{2}\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i.exec(link);
  if (m?.[1]) return m[1].toLowerCase();
  try {
    const last = new URL(link).pathname.split('/').filter(Boolean).pop() ?? '';
    const name = decodeURIComponent(last).replace(/\.[a-z0-9]{2,4}$/i, '');
    return (name || link).slice(0, 200);
  } catch {
    return link.slice(0, 200);
  }
}

export interface ParsedCallNote {
  noteId: number;
  entity: CallEntity;
  entityId: number;
  direction: 'in' | 'out';
  link: string;
  recordKey: string;
  phone: string;
  durationSec: number;
  callStatus: number | null;
  calledAt: Date;
  noteUpdatedAt: Date;
  managerId: number | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Примечание → звонок; null — не звонок или без ссылки на запись (разбирать нечего). */
export function parseCallNote(n: AmoCallNote, entity: CallEntity): ParsedCallNote | null {
  if (n.note_type !== 'call_in' && n.note_type !== 'call_out') return null;
  const p = n.params ?? {};
  const link = typeof p.link === 'string' ? p.link.trim() : '';
  if (!link) return null;
  return {
    noteId: n.id,
    entity,
    entityId: n.entity_id,
    direction: n.note_type === 'call_in' ? 'in' : 'out',
    link,
    recordKey: recordKeyOf(link),
    phone: typeof p.phone === 'string' ? p.phone : String(p.phone ?? ''),
    durationSec: Math.max(0, Math.round(num(p.duration) ?? 0)),
    callStatus: num(p.call_status),
    calledAt: new Date(n.created_at * 1000),
    noteUpdatedAt: new Date((n.updated_at || n.created_at) * 1000),
    managerId: num(n.responsible_user_id) ?? num(n.created_by),
  };
}
