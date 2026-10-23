import { AmoApiClient, fieldValues, type LeadMail } from '@core/amo';
import { normalizePhone } from '@core/db';
import { dedupeTimeline, stripEmailQuotes, type TimelineFile, type TimelineItem } from './day-timeline.ts';
import type { LocalMessage } from './deps.ts';
import type { CallsDeps, CallsSettings } from './deps.ts';
import type { AmoCallNote, AmoRaw, CallEntity } from './notes.ts';
import type { CallRow } from './repo.ts';
import type { CallTranscript } from './stt.ts';

/**
 * RFD-AI-AGENT-CALLS-DAY-FULL, п. 1: источники общения с клиентом за день по сделке и её контактам.
 * Звонки — расшифровки (calls). Wazzup — wazzup_messages по lead_id или телефонам контактов. Чаты amoCRM — текст входящих
 * есть только в dialog_messages (через Salesbot), исходящие ответы менеджера — события outgoing_chat_message без текста.
 * Диалог AI-агента — dialog_messages (ai). Примечания менеджеров — common сделки и контактов без примечаний агента.
 * Почта — письма карточки amo (amomail_message, оба направления) + входящие из IMAP в dialog_messages («Тема письма:»).
 */

/** Файл сообщения Wazzup → файл записи ленты: текст, либо пометка (аудио / видео / не разобран / ещё идёт). */
export function fileOf(m: LocalMessage): TimelineFile | null {
  const f = m.file;
  if (!f) return null;
  const mime = (f.mime ?? '').toLowerCase();
  const kind = /^audio\//.test(mime) || mime === 'audio' ? 'аудио' : /^video\//.test(mime) || mime === 'video' ? 'видео' : null;
  if (f.text) return { name: f.name, text: f.text };
  if (kind) return { name: f.name, text: null, note: kind };
  if (f.status === 'failed') return { name: f.name, text: null, note: `не разобран: ${f.error ?? 'ошибка'}` };
  if (f.status === 'skipped') return { name: f.name, text: null, note: f.error ?? 'не разбирается' };
  if (f.status === 'deferred') return { name: f.name, text: null, note: 'разбор отложен по дневному лимиту' };
  if (f.status === 'done') return { name: f.name, text: null, note: 'текста нет' };
  return { name: f.name, text: null, note: 'разбор ещё идёт' };
}

/** Примечания, которые пишет сам агент (и опт), — в итог не берутся. */
export const AGENT_NOTE_RE = /^\s*(\[AI\]|AI:|\[Агент опт\]|Черновик детализации \(AI\)|Итог разговоров за |Итог дня по )/;

export interface LeadContacts {
  contactIds: number[];
  phones: string[];
  emails: string[];
}

/** Контакты сделки: id, телефоны (нормализованные), e-mail. */
export async function leadContacts(amo: AmoApiClient, leadId: number): Promise<LeadContacts> {
  const lead = await amo.getLead(leadId);
  const ids = ((lead as { _embedded?: { contacts?: { id: number }[] } } | null)?._embedded?.contacts ?? []).map((c) => c.id).slice(0, 5);
  const phones = new Set<string>();
  const emails = new Set<string>();
  for (const id of ids) {
    const c = await amo.getContact(id).catch(() => null);
    if (!c) continue;
    for (const p of fieldValues(c.custom_fields_values, 'PHONE')) {
      const n = normalizePhone(p);
      if (n) phones.add(n);
    }
    for (const e of fieldValues(c.custom_fields_values, 'EMAIL')) if (e.includes('@')) emails.add(e.trim().toLowerCase());
  }
  return { contactIds: ids, phones: [...phones], emails: [...emails] };
}

const NOTES_PAGE = 250;

/** Примечания одной сущности за период (по created_at), страницами. */
async function entityNotes(amo: AmoRaw, entity: CallEntity, entityId: number, types: string[], since: Date, until: Date): Promise<AmoCallNote[]> {
  const base = `/api/v4/${entity === 'contact' ? 'contacts' : 'leads'}/${entityId}/notes`;
  const out: AmoCallNote[] = [];
  for (let page = 1; page <= 10; page++) {
    const q = `${types.map((t) => `filter[note_type][]=${t}`).join('&')}&filter[updated_at][from]=${Math.floor(since.getTime() / 1000)}&order[created_at]=asc&limit=${NOTES_PAGE}&page=${page}`;
    const res = await amo.get<{ _embedded?: { notes?: AmoCallNote[] } }>(`${base}?${q}`);
    const rows = res?._embedded?.notes ?? [];
    out.push(...rows);
    if (rows.length < NOTES_PAGE) break;
  }
  return out.filter((n) => n.created_at * 1000 >= since.getTime() && n.created_at * 1000 < until.getTime());
}

/** События чатов сделки за период (ответы менеджера в чатах amoCRM — только факт и время; created_by > 0 — человек). */
async function chatEvents(amo: AmoRaw, leadId: number, since: Date, until: Date): Promise<{ id: string; created_by: number; created_at: number; type: string }[]> {
  const q = `filter[entity]=lead&filter[entity_id]=${leadId}&filter[type][]=outgoing_chat_message&filter[type][]=incoming_chat_message&filter[created_at][from]=${Math.floor(since.getTime() / 1000)}&filter[created_at][to]=${Math.floor(until.getTime() / 1000)}&limit=100`;
  const res = await amo.get<{ _embedded?: { events?: { id: string; created_by: number; created_at: number; type: string }[] } }>(`/api/v4/events?${q}`).catch(() => null);
  return res?._embedded?.events ?? [];
}

export interface TimelineInput {
  accountId: number;
  leadId: number;
  since: Date;
  until: Date;
  /** Расшифрованные звонки сделки (любой даты — старые помечаются датой в ленте). */
  calls: CallRow[];
  settings: CallsSettings;
}

export interface CollectedTimeline {
  items: TimelineItem[];
  contacts: LeadContacts;
  /** Что не удалось прочитать (источник: причина) — в журнал, итог всё равно считается. */
  warnings: string[];
}

/** Лента общения по сделке за период из всех включённых источников, с дедупликацией. */
export async function collectLeadTimeline(deps: CallsDeps, amo: AmoRaw, client: AmoApiClient, input: TimelineInput): Promise<CollectedTimeline> {
  const src = input.settings.sources;
  const items: TimelineItem[] = [];
  const warnings: string[] = [];
  const contacts = await leadContacts(client, input.leadId).catch((err: Error) => {
    warnings.push(`контакты: ${err.message}`);
    return { contactIds: [], phones: [], emails: [] } as LeadContacts;
  });
  if (src.calls) {
    for (const c of input.calls) {
      const t = c.transcript as CallTranscript | null;
      if (!t || 'pending' in t) continue;
      items.push({ id: `call:${c.id}`, at: c.calledAt, source: 'call', direction: c.direction, author: c.direction === 'in' ? 'client' : 'manager', text: t.text, durationSec: c.durationSec, callId: c.id, transcript: t });
    }
  }
  if (src.wazzup && deps.sources?.wazzup) {
    try {
      for (const m of await deps.sources.wazzup(input.accountId, input.leadId, contacts.phones, input.since, input.until)) {
        const file = fileOf(m);
        items.push({ id: `wz:${m.id}`, at: m.at, source: 'wazzup', channel: m.channel, direction: m.direction, author: m.author, text: m.text, ...(file ? { files: [file] } : {}) });
      }
    } catch (err) {
      warnings.push(`Wazzup: ${(err as Error).message}`);
    }
  }
  if ((src.amoChats || src.agentDialog || src.email) && deps.sources?.dialog) {
    try {
      for (const m of await deps.sources.dialog(input.accountId, input.leadId, input.since, input.until)) {
        const isMail = m.author === 'client' && /^Тема письма:/.test(m.text);
        if (isMail) {
          if (!src.email) continue;
          const [first = '', ...rest] = m.text.split('\n');
          items.push({ id: `mail:d${m.id}`, at: m.at, source: 'email', direction: 'in', author: 'client', subject: first.replace(/^Тема письма:\s*/, ''), text: stripEmailQuotes(rest.join('\n')) });
          continue;
        }
        if (m.author === 'agent') {
          if (src.agentDialog) items.push({ id: `agent:${m.id}`, at: m.at, source: 'agent', direction: 'out', author: 'agent', text: m.text });
          continue;
        }
        if (src.amoChats) items.push({ id: `chat:${m.id}`, at: m.at, source: 'amo_chat', direction: m.direction, author: m.author, text: m.text });
      }
    } catch (err) {
      warnings.push(`диалог: ${(err as Error).message}`);
    }
  }
  if (src.amoChats) {
    // Ответы менеджера в чатах amoCRM: текст через API недоступен — учитываем как действие менеджера, если рядом нет сообщения с текстом.
    for (const e of await chatEvents(amo, input.leadId, input.since, input.until)) {
      if (e.type !== 'outgoing_chat_message' || !(e.created_by > 0)) continue;
      const at = new Date(e.created_at * 1000);
      const near = items.some((it) => it.direction === 'out' && it.source !== 'call' && Math.abs(it.at.getTime() - at.getTime()) <= 3 * 60_000);
      if (!near) items.push({ id: `chatev:${e.id}`, at, source: 'amo_chat', direction: 'out', author: 'manager', text: '(ответ менеджера в чате amoCRM — текст через API недоступен)' });
    }
  }
  if (src.managerNotes) {
    try {
      const notes = [...(await entityNotes(amo, 'lead', input.leadId, ['common'], input.since, input.until))];
      for (const cid of contacts.contactIds) notes.push(...(await entityNotes(amo, 'contact', cid, ['common'], input.since, input.until)));
      for (const n of notes) {
        const text = String(n.params?.text ?? '').trim();
        if (!text || AGENT_NOTE_RE.test(text) || !(n.created_by > 0)) continue;
        items.push({ id: `note:${n.id}`, at: new Date(n.created_at * 1000), source: 'note', direction: 'out', author: 'manager', text });
      }
    } catch (err) {
      warnings.push(`примечания: ${(err as Error).message}`);
    }
  }
  if (src.email) {
    const mails: LeadMail[] = await client.leadMailNotes(input.leadId, 50).catch(() => []);
    for (const m of mails) {
      if (m.createdAt < input.since || m.createdAt >= input.until) continue;
      items.push({ id: `mail:${m.id}`, at: m.createdAt, source: 'email', direction: m.income ? 'in' : 'out', author: m.income ? 'client' : 'manager', subject: m.subject, text: stripEmailQuotes(m.text), attachments: m.attachments });
    }
  }
  const deduped = dedupeTimeline(items);
  // Вложения входящих писем с извлечённым текстом (mail_attachments) — к письму того же времени (±10 мин), иначе отдельной записью.
  if (src.email && deps.sources?.mailFiles) {
    try {
      for (const f of await deps.sources.mailFiles(input.accountId, input.leadId, input.since, input.until)) {
        const file: TimelineFile = f.text ? { name: f.name, text: f.text } : { name: f.name, text: null, note: f.status === 'failed' ? 'не разобран' : f.status === 'pending' ? 'разбор ещё идёт' : 'текста нет' };
        const mail = deduped.find((it) => it.source === 'email' && it.direction === 'in' && Math.abs(it.at.getTime() - f.at.getTime()) <= 10 * 60_000 && !(it.files ?? []).some((x) => x.name === f.name));
        if (mail) mail.files = [...(mail.files ?? []), file];
        else deduped.push({ id: `mailfile:${f.id}`, at: f.at, source: 'email', direction: 'in', author: 'client', subject: `вложение ${f.name}`, text: '', files: [file] });
      }
      deduped.sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));
    } catch (err) {
      warnings.push(`вложения писем: ${(err as Error).message}`);
    }
  }
  return { items: deduped, contacts, warnings };
}

/** Сделки с общением за период по источникам amo: примечания менеджеров, письма карточки, события чатов (аккаунт целиком). */
export async function amoActiveLeads(amo: AmoRaw, since: Date, until: Date, settings: CallsSettings): Promise<Set<number>> {
  const out = new Set<number>();
  const from = Math.floor(since.getTime() / 1000);
  const types: string[] = [];
  if (settings.sources.managerNotes) types.push('common');
  if (settings.sources.email) types.push('amomail_message');
  if (types.length) {
    for (let page = 1; page <= 20; page++) {
      const q = `${types.map((t) => `filter[note_type][]=${t}`).join('&')}&filter[updated_at][from]=${from}&order[updated_at]=asc&limit=${NOTES_PAGE}&page=${page}`;
      const res = await amo.get<{ _embedded?: { notes?: AmoCallNote[] } }>(`/api/v4/leads/notes?${q}`).catch(() => null);
      const rows = res?._embedded?.notes ?? [];
      for (const n of rows) {
        if (n.created_at * 1000 < since.getTime() || n.created_at * 1000 >= until.getTime()) continue;
        if (n.note_type === 'common' && (AGENT_NOTE_RE.test(String(n.params?.text ?? '')) || !(n.created_by > 0))) continue;
        out.add(n.entity_id);
      }
      if (rows.length < NOTES_PAGE) break;
    }
  }
  if (settings.sources.amoChats) {
    for (let page = 1; page <= 20; page++) {
      const q = `filter[entity]=lead&filter[type][]=incoming_chat_message&filter[type][]=outgoing_chat_message&filter[created_at][from]=${from}&limit=100&page=${page}`;
      const res = await amo.get<{ _embedded?: { events?: { entity_id: number; created_by: number; type: string }[] } }>(`/api/v4/events?${q}`).catch(() => null);
      const rows = res?._embedded?.events ?? [];
      for (const e of rows) if (e.type === 'incoming_chat_message' || e.created_by > 0) out.add(e.entity_id);
      if (rows.length < 100) break;
    }
  }
  return out;
}
