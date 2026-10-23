import { AmoApiClient } from '@core/amo';
import type { WidgetSettings } from '@core/db';
import { mmss } from './day-analyze.ts';
import { chatEvents, collectLeadTimeline } from './day-sources.ts';
import { dayLabel, mskDay } from './day-summary.ts';
import { countTimeline, formatItem, timelineText, type TimelineCounts, type TimelineItem } from './day-timeline.ts';
import type { CallsDeps, CallsSettings } from './deps.ts';
import { errorText } from './errors.ts';
import { downloadCall } from './job.ts';
import { CALL_ERROR_KIND, REFUSAL_KIND } from './kinds.ts';
import { amoRaw, fetchEntityCallNotes, leadContactIds, parseCallNote, type AmoCallNote, type AmoRaw, type CallEntity, type ParsedCallNote } from './notes.ts';
import { analyzeRefusal, type RefusalAnalysis } from './refusal-analyze.ts';
import type { CallRow, RefusalRow } from './repo.ts';
import type { CallStt, CallTranscript, SttProviderName } from './stt.ts';
import { transcribeCalls } from './transcribe.ts';

/**
 * RFD-AI-AGENT-REFUSAL-ANALYSIS: анализ сделки при переносе в «Отказ».
 *
 * П. 1. Переход ловится по событиям amoCRM lead_status_changed (GET /api/v4/events, фильтр по типу и времени) — опрос раз
 * в 5 минут в очереди calls с отметкой времени в calls_sync (entity refusal) и перекрытием окна в минуту; вебхук смены статуса
 * не используется: его надо регистрировать в amo на публичный адрес, при недоступности сервера он теряется, а события
 * хранятся в amo и дочитываются после сбоя. Срабатывает только на переход в refusal.statusId (143) воронок refusal.pipelineIds;
 * один раз на событие (refusal_analyses.event_id уникален) — повторный уход в «Отказ» после возврата даёт новое событие
 * и новый анализ.
 *
 * П. 2. Лента общения за всю жизнь сделки (с created_at сделки) тем же сбором, что итог дня (collectLeadTimeline): звонки
 * (нерасшифрованные — расшифровать с ожиданием), Wazzup с файлами, чаты amo, диалог агента, примечания менеджеров, почта;
 * ограничение входа как в итоге дня (timelineText). Модель — analyzeRefusal.
 *
 * П. 3. Примечание в сделку и 2–3 строки в открытую задачу администратора, созданную автоматизацией в 15 минут после перехода.
 */

export const REFUSAL_JOB = 'refusal-poll';
export const REFUSAL_EVERY_MS = 5 * 60_000;
export const REFUSAL_SYNC_ENTITY = 'refusal';
/** Перекрытие окон опроса событий: событие, записанное amo на границе окна, не теряется (дубли отсекает event_id). */
const EVENTS_OVERLAP_MS = 60_000;
/** Первый опрос без отметки: события за последний час (старые отказы не анализируем задним числом). */
const FIRST_RUN_BACK_MS = 60 * 60_000;
const EVENTS_PAGE = 100;
const MAX_EVENT_PAGES = 20;
/** Задача автоматизации ищется в этом окне после перехода (ТЗ: 15 минут) и чуть раньше — часы amo и наши могут расходиться. */
export const TASK_WINDOW_MS = 15 * 60_000;
const TASK_BEFORE_MS = 60_000;
const MAX_ATTEMPTS = 3;
const WAIT_POLL_MS = 15_000;
/** Звонок без записи старше этого ждать не будем (запись не придёт). */
const RECORD_WAIT_MS = 2 * 60 * 60_000;

export type RefusalSettings = WidgetSettings['refusal'];

export interface StatusEvent {
  id: string;
  leadId: number;
  createdAt: Date;
  statusId: number;
  pipelineId: number;
  beforeStatusId: number | null;
}

interface AmoEvent {
  id: string;
  type: string;
  entity_id: number;
  entity_type?: string;
  created_at: number;
  value_after?: { lead_status?: { id: number; pipeline_id: number } }[];
  value_before?: { lead_status?: { id: number; pipeline_id: number } }[];
}

/** События смены этапа сделок за окно, от старых к новым. */
export async function fetchStatusEvents(amo: AmoRaw, since: Date, until: Date): Promise<StatusEvent[]> {
  const out: StatusEvent[] = [];
  const from = Math.floor(since.getTime() / 1000);
  const to = Math.ceil(until.getTime() / 1000);
  for (let page = 1; page <= MAX_EVENT_PAGES; page++) {
    const q = `filter[type]=lead_status_changed&filter[created_at][from]=${from}&filter[created_at][to]=${to}&limit=${EVENTS_PAGE}&page=${page}`;
    const res = await amo.get<{ _embedded?: { events?: AmoEvent[] } }>(`/api/v4/events?${q}`);
    const rows = res?._embedded?.events ?? [];
    for (const e of rows) {
      const after = e.value_after?.[0]?.lead_status;
      if (!after) continue;
      out.push({ id: String(e.id), leadId: Number(e.entity_id), createdAt: new Date(e.created_at * 1000), statusId: Number(after.id), pipelineId: Number(after.pipeline_id), beforeStatusId: e.value_before?.[0]?.lead_status?.id ?? null });
    }
    if (rows.length < EVENTS_PAGE) break;
  }
  return out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
}

export const isRefusalEvent = (e: StatusEvent, s: RefusalSettings): boolean => e.statusId === s.statusId && s.pipelineIds.includes(e.pipelineId);

export interface RefusalOptions {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  amo?: AmoRaw;
  client?: AmoApiClient;
  stt?: (preferred: SttProviderName) => CallStt | null;
  /** Ждать расшифровки не дольше (мс); по умолчанию calls.daySummaryTimeoutSec. */
  waitMs?: number;
  /** П. 2: если у свежего звонка из amo ещё нет записи — не анализировать (результат postponed), опрос отложит строку. */
  abortIfAwaitingRecord?: boolean;
}

export interface RefusalPollResult {
  accountId: number;
  enabled: boolean;
  events: number;
  matched: number;
  analyzed: number;
  notes: number;
  tasks: number;
  noData: number;
  duplicates: number;
  retried: number;
  errors: number;
  /** Переходов, чей срок первого запуска (delayMin) ещё не наступил, и отложенных (ждём запись звонка). */
  waiting: number;
  postponed: number;
}

interface LeadRaw {
  id: number;
  created_at: number;
  closed_at?: number | null;
  status_id: number;
  pipeline_id: number;
  responsible_user_id?: number;
  custom_fields_values?: { field_id: number; values?: { value?: unknown }[] }[] | null;
}

/** Поля отказа, заполненные менеджером (п. 3 исправления): причина, этап отказа, комментарий. */
export interface ManagerRefusal {
  reason: string | null;
  stage: string | null;
  comment: string | null;
}

export function managerRefusal(lead: LeadRaw | null, f: RefusalSettings['fields']): ManagerRefusal | null {
  const val = (id: number | null): string | null => {
    if (!id || !lead?.custom_fields_values) return null;
    const cf = lead.custom_fields_values.find((x) => Number(x.field_id) === id);
    const v = (cf?.values ?? []).map((x) => String(x.value ?? '').trim()).filter(Boolean);
    return v.length ? v.join(', ') : null;
  };
  const m = { reason: val(f.reason), stage: val(f.stage), comment: val(f.comment) };
  return m.reason || m.stage || m.comment ? m : null;
}

export const managerLine = (m: ManagerRefusal): string => `Причина по данным менеджера: ${m.reason ?? 'не указана'}${m.comment ? ` — ${m.comment}` : ''}${m.stage ? ` (этап отказа: ${m.stage})` : ''}`;

const stamp = (d: Date): string => d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export interface CallSync {
  /** Примечания-звонки сделки и контактов с записью не короче minDurationSec — по ним звонки берутся из calls независимо от lead_id. */
  noteIds: number[];
  /** Факты общения без текста: короткие звонки, звонки без записи. */
  facts: string[];
  /** Звонков не короче minDurationSec, у которых записи в amo ещё нет (свежих) — анализ стоит отложить. */
  awaitingRecord: number;
  inserted: number;
  notes: number;
}

/**
 * П. 1 исправления: перед анализом точечно забрать примечания-звонки сделки и её контактов из amo (как calls-poll), новые —
 * в calls (скачивание и расшифровка — дальше в analyzeLeadRefusal); короткие и без записи — фактами общения.
 */
export async function syncLeadCalls(deps: CallsDeps, accountId: number, amo: AmoRaw, leadId: number, s: CallsSettings, now: Date): Promise<CallSync> {
  const contacts = await leadContactIds(amo, leadId).catch(() => [] as number[]);
  const notes: { n: AmoCallNote; entity: CallEntity }[] = [];
  for (const n of await fetchEntityCallNotes(amo, 'lead', leadId).catch(() => [] as AmoCallNote[])) notes.push({ n, entity: 'lead' });
  for (const cid of contacts) for (const n of await fetchEntityCallNotes(amo, 'contact', cid).catch(() => [] as AmoCallNote[])) notes.push({ n, entity: 'contact' });
  const seen = new Set<number>();
  const toInsert: (ParsedCallNote & { leadId: number | null })[] = [];
  const facts: string[] = [];
  let awaitingRecord = 0;
  for (const { n, entity } of notes.sort((a, b) => a.n.created_at - b.n.created_at)) {
    if (seen.has(n.id) || (n.note_type !== 'call_in' && n.note_type !== 'call_out')) continue;
    seen.add(n.id);
    const p = n.params ?? {};
    const duration = Math.max(0, Math.round(Number(p.duration ?? 0) || 0));
    const at = new Date(n.created_at * 1000);
    const label = `звонок ${n.note_type === 'call_in' ? 'вх.' : 'исх.'} ${stamp(at)} (${mmss(duration)})`;
    const parsed = parseCallNote(n, entity);
    if (parsed && duration >= s.minDurationSec) {
      toInsert.push({ ...parsed, leadId });
      continue;
    }
    if (duration < s.minDurationSec) {
      facts.push(`${label} — без анализа (короче ${s.minDurationSec} с)`);
      continue;
    }
    if (now.getTime() - at.getTime() < RECORD_WAIT_MS) awaitingRecord++;
    facts.push(`${label} — запись в amo не получена`);
  }
  const ids = toInsert.length ? await deps.calls.insertNew(accountId, toInsert, 'async') : [];
  return { noteIds: toInsert.map((c) => c.noteId), facts, awaitingRecord, inserted: ids.filter((x) => x !== null).length, notes: seen.size };
}

interface AmoTask {
  id: number;
  text: string;
  created_at: number;
  responsible_user_id: number;
  is_completed?: boolean;
  entity_id?: number;
}

export interface RefusalAnalysisResult {
  leadId: number;
  changedAt: Date;
  since: Date;
  /** Факты общения без текста (короткие звонки, звонки без записи, чаты без текста). */
  facts: string[];
  manager: ManagerRefusal | null;
  /** Свежих звонков без записи в amo. */
  awaitingRecord: number;
  /** Анализ не делался: ждём запись звонка (abortIfAwaitingRecord). */
  postponed: boolean;
  items: TimelineItem[];
  used: TimelineItem[];
  truncated: string[];
  counts: TimelineCounts;
  analysis: RefusalAnalysis | null;
  transcripts: Map<number, CallTranscript>;
  noteText: string;
  warnings: string[];
  notReady: number;
  cost: { llmUsd: number; llmRub: number; llmInputTokens: number; llmOutputTokens: number; sttRub: number; sttUsd: number };
  provider: string | null;
  model: string | null;
  attempts: number;
  raw: string | null;
}

const pluralRu = (n: number, one: string, few: string, many: string): string => (n % 10 === 1 && n % 100 !== 11 ? one : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? few : many);

/** Текст примечания (п. 3 ТЗ; исправление: факты общения без текста и поля отказа менеджера). */
export function formatRefusalNote(changedAt: Date, a: RefusalAnalysis | null, c: TimelineCounts, truncated: string[] = [], x: { facts?: string[]; manager?: ManagerRefusal | null } = {}): string {
  const date = dayLabel(mskDay(changedAt));
  const facts = x.facts ?? [];
  if (!a) {
    return [
      `Анализ сделки при отказе (${date}): ${facts.length ? 'общение без текста для анализа' : 'общения в данных агента нет — звонков с записью, сообщений, писем и примечаний по сделке не найдено.'}`,
      ...(facts.length ? [`Факты общения: ${facts.join('; ')}`] : []),
      ...(x.manager ? [managerLine(x.manager)] : []),
      ...(facts.length || x.manager ? ['История: текста общения в данных агента нет — оценка менеджера и причина по словам клиента не определяются.'] : []),
    ].join('\n');
  }
  const parts = [`${c.calls} ${pluralRu(c.calls, 'звонок', 'звонка', 'звонков')} (${mmss(c.totalCallDuration)})`, `${c.messages} ${pluralRu(c.messages, 'сообщение', 'сообщения', 'сообщений')}`, `${c.emails} ${pluralRu(c.emails, 'письмо', 'письма', 'писем')}`];
  if (c.notes) parts.push(`${c.notes} ${pluralRu(c.notes, 'примечание', 'примечания', 'примечаний')}`);
  return [
    `Анализ сделки при отказе (${date}): ${parts.join(', ')} за весь период${truncated.length ? ' (часть переписки сокращена)' : ''}`,
    ...(facts.length ? [`Также без анализа: ${facts.join('; ')}`] : []),
    `История: ${a.summary.trim() || '—'}`,
    `Причина отказа: ${a.refusalReason.trim() || 'не названа'}`,
    ...(x.manager ? [managerLine(x.manager)] : []),
    `Где потеряли клиента: ${a.lostAt.trim() || '—'}`,
    `Можно ли вернуть: ${a.couldBeSaved.trim() || '—'}`,
    `Оценка менеджера: ${a.managerScore}/10 — ${a.managerComment.trim() || '—'}`,
  ].join('\n');
}

/** Строки в задачу администратора (п. 3 ТЗ): причина отказа (и по данным менеджера), где потеряли, ссылка на примечание. */
export const taskAppendix = (a: RefusalAnalysis | null, x: { facts?: string[]; manager?: ManagerRefusal | null } = {}): string =>
  [
    '',
    ...(a ? [`Причина отказа: ${a.refusalReason.trim() || 'не названа'}`] : [x.facts?.length ? `Общение без текста для анализа: ${x.facts.join('; ')}` : 'Общения в данных агента нет.']),
    ...(x.manager ? [managerLine(x.manager)] : []),
    ...(a ? [`Где потеряли клиента: ${a.lostAt.trim() || '—'}`] : []),
    'Анализ — в примечании сделки.',
  ].join('\n').replace(/^\n/, '\n\n');

/** Сделка из amo: дата создания, этап, воронка, closed_at. */
export async function fetchLeadRaw(amo: AmoRaw, leadId: number): Promise<LeadRaw | null> {
  return amo.get<LeadRaw>(`/api/v4/leads/${leadId}`);
}

/**
 * Собрать и разобрать сделку: расшифровать звонки без расшифровки (ожидание до waitMs), лента за всю жизнь сделки, модель.
 * Ничего не пишет в amo и refusal_analyses (это делает persistRefusal).
 */
export async function analyzeLeadRefusal(deps: CallsDeps, accountId: number, input: { leadId: number; changedAt: Date; lead: LeadRaw | null }, o: RefusalOptions = {}): Promise<RefusalAnalysisResult> {
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const all = await deps.settingsFor(accountId);
  const account = await deps.accounts.get(accountId);
  if (!account || account.uninstalledAt) throw new Error(`Аккаунт ${accountId} не подключён`);
  const token = () => deps.tokenService.getAccessToken(accountId);
  const amo = o.amo ?? amoRaw(account.accountDomain, token, deps.fetch);
  const client = o.client ?? new AmoApiClient(account.accountDomain, token, deps.fetch);
  const since = input.lead?.created_at ? new Date(input.lead.created_at * 1000) : new Date(input.changedAt.getTime() - 365 * 86_400_000);
  const until = now();

  // П. 1 исправления: примечания-звонки сделки и контактов — из amo сейчас (таблица calls отстаёт на опрос до 10 минут).
  const sync = await syncLeadCalls(deps, accountId, amo, input.leadId, all.calls, until);
  const manager = managerRefusal(input.lead, all.refusal.fields);
  const empty = { leadId: input.leadId, changedAt: input.changedAt, since, items: [] as TimelineItem[], used: [] as TimelineItem[], truncated: [] as string[], counts: { calls: 0, messages: 0, emails: 0, notes: 0, totalCallDuration: 0 }, warnings: [] as string[], notReady: 0, transcripts: new Map<number, CallTranscript>(), facts: sync.facts, manager, awaitingRecord: sync.awaitingRecord, analysis: null, noteText: '', cost: { llmUsd: 0, llmRub: 0, llmInputTokens: 0, llmOutputTokens: 0, sttRub: 0, sttUsd: 0 }, provider: null, model: null, attempts: 0, raw: null };
  if (o.abortIfAwaitingRecord && sync.awaitingRecord) return { ...empty, postponed: true };

  // Звонки сделки: по lead_id и по примечаниям amo (звонок контакта мог попасть в calls опросом раньше, чем появилась сделка, —
  // «90209»: lead_id пуст или другая сделка контакта; привязываем к этой сделке). Скачать и расшифровать те, что без расшифровки.
  const loadCalls = async (): Promise<CallRow[]> => {
    const byLead = await deps.calls.list(accountId, { leadId: input.leadId, limit: 500 });
    const byNotes = await deps.calls.byNoteIds(accountId, sync.noteIds);
    const seen = new Set<number>();
    return [...byLead, ...byNotes].filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true))).sort((a, b) => a.calledAt.getTime() - b.calledAt.getTime() || a.id - b.id);
  };
  let calls = await loadCalls();
  await deps.calls.setLeadId(calls.filter((c) => c.leadId !== input.leadId).map((c) => c.id), input.leadId);
  const ids = calls.map((c) => c.id);
  for (const c of calls) if (c.status === 'new' || (c.status === 'failed' && c.stage === 'download')) await downloadCall(deps, c, { sleep });
  const deadline = now().getTime() + (o.waitMs ?? all.calls.daySummaryTimeoutSec * 1000);
  const pending = (rows: CallRow[]) => rows.filter((r) => r.status === 'downloaded' || (r.status === 'failed' && r.stage === 'transcribe'));
  calls = await loadCalls();
  while (pending(calls).length) {
    await transcribeCalls(deps, accountId, all.calls, { now, sleep, ids, inlineWaitMs: 60_000, ...(o.stt ? { stt: o.stt } : {}) });
    calls = await loadCalls();
    if (!calls.some((r) => r.status === 'downloaded') || now().getTime() >= deadline) break;
    await sleep(WAIT_POLL_MS);
  }
  const ready = calls.filter((r) => r.transcript && !('pending' in r.transcript));
  const notReady = calls.filter((r) => !r.transcript || 'pending' in r.transcript).length;

  const col = await collectLeadTimeline(deps, amo, client, { accountId, leadId: input.leadId, since, until, calls: ready, settings: all.calls });
  const tl = timelineText(col.items);
  const counts = countTimeline(tl.used);
  // П. 4: чаты без текста (Jivo и подобные каналы — события amo есть, текста в данных агента нет) — фактом общения.
  const facts = [...sync.facts];
  const events = await chatEvents(amo, input.leadId, since, until).catch(() => []);
  const textual = col.items.filter((i) => i.source === 'amo_chat' || i.source === 'agent' || i.source === 'wazzup').length;
  if (events.length > textual) facts.push(`чат amoCRM — ${events.length - textual} сообщ., текст недоступен (Jivo и подобные каналы)`);
  const sttCost = { sttRub: ready.reduce((n, c) => n + Number((c.cost as { sttRub?: number } | null)?.sttRub ?? 0), 0), sttUsd: ready.reduce((n, c) => n + Number((c.cost as { sttUsd?: number } | null)?.sttUsd ?? 0), 0) };
  const base = { ...empty, items: col.items, used: tl.used, truncated: tl.truncated, counts, warnings: col.warnings, notReady, facts, postponed: false };
  if (!tl.used.length) return { ...base, analysis: null, noteText: formatRefusalNote(input.changedAt, null, counts, [], { facts, manager }), cost: { llmUsd: 0, llmRub: 0, llmInputTokens: 0, llmOutputTokens: 0, ...sttCost } };

  const llm = await deps.llmFor(accountId);
  if (!llm) throw new Error('нет ключа модели (вкладка «Модель»)');
  const periodLabel = `${dayLabel(mskDay(since))} — ${dayLabel(mskDay(input.changedAt))}`;
  const extra = [
    ...(manager ? [`Причина отказа по данным менеджера (поля сделки): причина «${manager.reason ?? '—'}», этап отказа «${manager.stage ?? '—'}», комментарий «${manager.comment ?? '—'}».`] : []),
    ...(facts.length ? [`Общение без текста (в ленте его нет): ${facts.join('; ')}.`] : []),
  ];
  const res = await analyzeRefusal(llm.llm, llm.route, { timeline: tl.text, counts, periodLabel, truncated: tl.truncated, pricing: llm.pricing, extra });
  for (const c of ready) {
    const t = c.transcript as CallTranscript;
    const roles = new Map(res.analysis.speakers.filter((x) => x.callId === c.id).map((x) => [x.tag, x.role]));
    if (roles.size) base.transcripts.set(c.id, { ...t, segments: t.segments.map((seg) => (seg.speaker && roles.has(seg.speaker) ? { ...seg, role: roles.get(seg.speaker) } : seg)) });
  }
  return { ...base, analysis: res.analysis, noteText: formatRefusalNote(input.changedAt, res.analysis, counts, tl.truncated, { facts, manager }), cost: { llmUsd: res.cost.usd, llmRub: res.cost.usd * llm.usdRubRate, llmInputTokens: res.cost.inputTokens, llmOutputTokens: res.cost.outputTokens, ...sttCost }, provider: res.provider, model: res.model, attempts: res.attempts, raw: res.raw };
}

/** Открытая задача сделки, созданная автоматизацией в окне после перехода; ответственный — из adminUserIds (если заданы). Берётся самая новая. */
export async function findAdminTask(amo: AmoRaw, leadId: number, changedAt: Date, s: RefusalSettings): Promise<AmoTask | null> {
  const res = await amo.get<{ _embedded?: { tasks?: AmoTask[] } }>(`/api/v4/tasks?filter[entity_type]=leads&filter[entity_id]=${leadId}&filter[is_completed]=0&limit=50`);
  const from = changedAt.getTime() - TASK_BEFORE_MS;
  const to = changedAt.getTime() + TASK_WINDOW_MS;
  const fit = (res?._embedded?.tasks ?? []).filter((t) => {
    const at = t.created_at * 1000;
    return at >= from && at <= to && (!s.adminUserIds.length || s.adminUserIds.includes(t.responsible_user_id));
  });
  return fit.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
}

/** Записать результат: роли в расшифровки, примечание в сделку, строки в задачу администратора, строка refusal_analyses, журнал. */
export async function persistRefusal(deps: CallsDeps, accountId: number, s: RefusalSettings, amo: AmoRaw, rowId: number, a: RefusalAnalysisResult, opts: { /** Дописать в задачу даже если уже дописывали (пересчёт по команде). */ forceTask?: boolean } = {}): Promise<{ noteId: number; taskId: number | null; taskUpdated: boolean }> {
  for (const [id, t] of a.transcripts) await deps.calls.setTranscript(id, t, 'transcribed');
  const posted = await amo.post<{ _embedded?: { notes?: { id: number }[] } }>(`/api/v4/leads/${a.leadId}/notes`, [{ note_type: 'common', params: { text: a.noteText } }]);
  const noteId = posted?._embedded?.notes?.[0]?.id ?? 0;
  if (!noteId) throw new Error(`amo не вернул id примечания (сделка ${a.leadId})`);
  let taskId: number | null = null;
  let taskUpdated = false;
  let taskNote = 'задача администратора не найдена — только примечание';
  if (s.updateTask) {
    try {
      const task = await findAdminTask(amo, a.leadId, a.changedAt, s);
      if (task) {
        taskId = task.id;
        const marker = 'Анализ — в примечании сделки.';
        if (opts.forceTask || !task.text.includes(marker)) {
          await amo.patch(`/api/v4/tasks/${task.id}`, { text: `${task.text.trimEnd()}${taskAppendix(a.analysis, { facts: a.facts, manager: a.manager })}` });
          taskUpdated = true;
          taskNote = `задача ${task.id} дополнена`;
        } else taskNote = `задача ${task.id} уже дополнена`;
      }
    } catch (err) {
      taskNote = `задача не обновлена: ${errorText(err)}`;
      await deps.journal.add({ accountId, leadId: a.leadId, kind: CALL_ERROR_KIND, summary: `Анализ при отказе: задача администратора не обновлена — ${errorText(err)}`, details: { rowId, taskId } });
    }
  } else taskNote = 'правка задачи выключена';
  await deps.refusals.setResult(rowId, { analysis: a.analysis, counts: { calls: a.counts.calls, messages: a.counts.messages, emails: a.counts.emails, notes: a.counts.notes }, itemIds: a.used.map((i) => i.id), facts: a.facts, noteId, noteText: a.noteText, taskId, taskUpdated, provider: a.provider, model: a.model, cost: a.cost });
  await deps.journal.add({
    accountId,
    leadId: a.leadId,
    kind: REFUSAL_KIND,
    summary: a.analysis ? `Анализ при отказе (${dayLabel(mskDay(a.changedAt))}): ${a.analysis.refusalReason.slice(0, 200)}; оценка ${a.analysis.managerScore}/10${a.facts.length ? `; без анализа: ${a.facts.length}` : ''}; примечание ${noteId}; ${taskNote}` : `Анализ при отказе (${dayLabel(mskDay(a.changedAt))}): ${a.facts.length ? `общение без текста для анализа (${a.facts.join('; ')})` : 'общения в данных агента нет'}${a.manager ? `; ${managerLine(a.manager)}` : ''}; примечание ${noteId}; ${taskNote}`,
    details: { rowId, leadId: a.leadId, changedAt: a.changedAt.toISOString(), since: a.since.toISOString(), itemIds: a.used.map((i) => i.id), facts: a.facts, manager: a.manager, truncated: a.truncated, warnings: a.warnings, notReady: a.notReady, noteId, noteText: a.noteText, taskId, taskUpdated, provider: a.provider, model: a.model, attempts: a.attempts, raw: a.raw, cost: a.cost },
    inputTokens: a.cost.llmInputTokens,
    outputTokens: a.cost.llmOutputTokens,
    costUsd: a.cost.llmUsd,
    costRub: a.cost.llmRub,
  });
  return { noteId, taskId, taskUpdated };
}

/** Один переход: разбор и запись; ошибка — в строку (attempts), повтор при следующем опросе до MAX_ATTEMPTS. */
async function processRow(deps: CallsDeps, accountId: number, s: RefusalSettings, amo: AmoRaw, row: Pick<RefusalRow, 'id' | 'leadId' | 'changedAt'>, r: RefusalPollResult, o: RefusalOptions): Promise<void> {
  const now = (o.now ?? (() => new Date()))();
  try {
    const lead = await fetchLeadRaw(amo, row.leadId);
    // П. 2: у свежего звонка нет записи — отложить на delayMin, но не дольше maxDelayMin от перехода.
    const canWait = now.getTime() < row.changedAt.getTime() + s.maxDelayMin * 60_000;
    const a = await analyzeLeadRefusal(deps, accountId, { leadId: row.leadId, changedAt: row.changedAt, lead }, { ...o, amo, abortIfAwaitingRecord: canWait });
    if (a.postponed) {
      const until = new Date(now.getTime() + Math.max(1, s.delayMin) * 60_000);
      await deps.refusals.postpone(row.id, until, `ждём запись звонка в amo (${a.awaitingRecord})`);
      r.postponed++;
      return;
    }
    const p = await persistRefusal(deps, accountId, s, amo, row.id, a);
    r.analyzed++;
    r.notes++;
    if (p.taskUpdated) r.tasks++;
    if (!a.analysis) r.noData++;
  } catch (err) {
    r.errors++;
    await deps.refusals.setError(row.id, errorText(err), new Date(now.getTime() + Math.max(1, s.delayMin) * 60_000));
    await deps.journal.add({ accountId, leadId: row.leadId, kind: CALL_ERROR_KIND, summary: `Анализ при отказе не выполнен (сделка ${row.leadId}) — ${errorText(err)}`, details: { rowId: row.id, error: errorText(err) } }).catch(() => undefined);
  }
}

/** Опрос событий смены этапа по аккаунту (раз в 5 минут): новые переходы в «Отказ» + повтор незавершённых. */
export async function runRefusalPoll(deps: CallsDeps, accountId: number, o: RefusalOptions = {}): Promise<RefusalPollResult> {
  const now = o.now ?? (() => new Date());
  const all = await deps.settingsFor(accountId);
  const s = all.refusal;
  const r: RefusalPollResult = { accountId, enabled: s.enabled, events: 0, matched: 0, analyzed: 0, notes: 0, tasks: 0, noData: 0, duplicates: 0, retried: 0, errors: 0, waiting: 0, postponed: 0 };
  if (!s.enabled) return r;
  const account = await deps.accounts.get(accountId);
  if (!account || account.uninstalledAt) throw new Error(`Аккаунт ${accountId} не подключён`);
  const token = () => deps.tokenService.getAccessToken(accountId);
  const amo = o.amo ?? amoRaw(account.accountDomain, token, deps.fetch);
  const started = now();
  const sync = await deps.calls.getSync(accountId, REFUSAL_SYNC_ENTITY);
  const since = new Date((sync?.lastUpdatedAt ?? new Date(started.getTime() - FIRST_RUN_BACK_MS)).getTime() - EVENTS_OVERLAP_MS);
  let events: StatusEvent[];
  try {
    events = await fetchStatusEvents(amo, since, started);
  } catch (err) {
    await deps.calls.setSync(accountId, REFUSAL_SYNC_ENTITY, { lastUpdatedAt: sync?.lastUpdatedAt ?? started, lastError: errorText(err) });
    throw err;
  }
  r.events = events.length;
  for (const e of events) {
    if (!isRefusalEvent(e, s)) continue;
    r.matched++;
    // Первый запуск — через delayMin после перехода: запись звонка приходит в amo с задержкой (п. 2 исправления).
    const id = await deps.refusals.claim({ accountId, leadId: e.leadId, eventId: e.id, changedAt: e.createdAt, statusId: e.statusId, pipelineId: e.pipelineId, nextTryAt: new Date(e.createdAt.getTime() + s.delayMin * 60_000) });
    if (id === null) r.duplicates++;
  }
  // Отметка — до разбора: событие уже занято строкой, повтор при сбое идёт через attempts, а не через повторное чтение событий.
  await deps.calls.setSync(accountId, REFUSAL_SYNC_ENTITY, { lastUpdatedAt: started, lastError: null });
  const due = await deps.refusals.listDue(accountId, started, MAX_ATTEMPTS);
  r.retried = due.filter((x) => x.attempts > 0).length;
  for (const row of due) await processRow(deps, accountId, s, amo, row, r, o);
  r.waiting = await deps.refusals.countWaiting(accountId, started, MAX_ATTEMPTS);
  if (r.matched || due.length || r.errors) await deps.journal.add({ accountId, kind: REFUSAL_KIND, summary: `Опрос отказов: событий ${r.events}, переходов в «Отказ» ${r.matched}, разобрано ${r.analyzed} (без текста ${r.noData}), задач дополнено ${r.tasks}, отложено ${r.postponed}, ждут срока ${r.waiting}, повторов ${r.retried}, дублей ${r.duplicates}, ошибок ${r.errors}`, details: { ...r } }).catch(() => undefined);
  return r;
}

export async function runRefusalPollAll(deps: CallsDeps, o: RefusalOptions = {}): Promise<RefusalPollResult[]> {
  const out: RefusalPollResult[] = [];
  for (const accountId of await deps.accountIds()) {
    try {
      out.push(await runRefusalPoll(deps, accountId, o));
    } catch (err) {
      out.push({ accountId, enabled: true, events: 0, matched: 0, analyzed: 0, notes: 0, tasks: 0, noData: 0, duplicates: 0, retried: 0, errors: 1, waiting: 0, postponed: 0 });
      await deps.journal.add({ accountId, kind: CALL_ERROR_KIND, summary: `Опрос отказов не выполнен — ${errorText(err)}`, details: { error: errorText(err) } }).catch(() => undefined);
    }
  }
  return out;
}

export interface RefusalDemoOptions extends RefusalOptions {
  accountId: number;
  leadId: number;
  post?: boolean;
  out?: (line: string) => void;
}

export interface RefusalDemoResult {
  leadId: number;
  changedAt: Date;
  items: number;
  used: number;
  calls: number;
  notReady: number;
  noteText: string;
  posted: { noteId: number; taskId: number | null; taskUpdated: boolean } | null;
  already: boolean;
  cost: RefusalAnalysisResult['cost'];
}

const SHOW_ITEMS = 30;

/**
 * Показ анализа при отказе по одной сделке (calls-demo --lead <id> --refusal): без post — только вывод (лента, примечание,
 * стоимость); с post — примечание и правка задачи, с защитой от дублей (event_id demo:<сделка>:<момент перехода>).
 * Момент перехода — closed_at сделки (amo ставит при закрытом этапе), иначе сейчас.
 */
export async function runRefusalDemo(deps: CallsDeps, o: RefusalDemoOptions): Promise<RefusalDemoResult> {
  const out = o.out ?? (() => undefined);
  const now = o.now ?? (() => new Date());
  const all = await deps.settingsFor(o.accountId);
  const account = await deps.accounts.get(o.accountId);
  if (!account || account.uninstalledAt) throw new Error(`Аккаунт ${o.accountId} не подключён`);
  const token = () => deps.tokenService.getAccessToken(o.accountId);
  const amo = o.amo ?? amoRaw(account.accountDomain, token, deps.fetch);
  const lead = await fetchLeadRaw(amo, o.leadId);
  if (!lead) throw new Error(`сделка ${o.leadId} не найдена в amo`);
  const changedAt = lead.closed_at ? new Date(lead.closed_at * 1000) : now();
  const inRefusal = lead.status_id === all.refusal.statusId;
  out(`Сделка ${o.leadId}: воронка ${lead.pipeline_id}, этап ${lead.status_id}${inRefusal ? ' («Отказ»)' : ' (не «Отказ» — анализ как при переносе)'}, создана ${dayLabel(mskDay(new Date(lead.created_at * 1000)))}, момент перехода ${changedAt.toISOString()}`);
  const prior = await deps.refusals.forLead(o.accountId, o.leadId);
  for (const p of prior) if (p.noteId) out(`Анализ ${p.id} от ${dayLabel(mskDay(p.changedAt))} уже есть (примечание ${p.noteId}${p.taskUpdated ? `, задача ${p.taskId}` : ''})`);

  const a = await analyzeLeadRefusal(deps, o.accountId, { leadId: o.leadId, changedAt, lead }, { ...o, amo });
  for (const w of a.warnings) out(`  источник не прочитан: ${w}`);
  if (a.notReady) out(`  звонков без расшифровки: ${a.notReady} (не дождались)`);
  out(`\nЛента за ${dayLabel(mskDay(a.since))} — ${dayLabel(mskDay(changedAt))}: записей ${a.items.length}, в разбор вошло ${a.used.length}${a.truncated.length ? ` (сокращено: ${a.truncated.join('; ')})` : ''}; показаны первые ${Math.min(SHOW_ITEMS, a.used.length)}:`);
  for (const it of a.used.slice(0, SHOW_ITEMS)) out(formatItem(it.callId && a.transcripts.has(it.callId) ? { ...it, transcript: a.transcripts.get(it.callId) } : it));
  if (a.facts.length) out(`Без анализа (факты общения): ${a.facts.join('; ')}`);
  if (a.manager) out(managerLine(a.manager));
  out(`\n${a.noteText}`);
  const cost = { ...a.cost, llmUsd: Math.round(a.cost.llmUsd * 10_000) / 10_000, llmRub: Math.round(a.cost.llmRub * 100) / 100, sttRub: Math.round(a.cost.sttRub * 100) / 100 };
  out(`\nСтоимость: расшифровка ${cost.sttRub} ₽${cost.sttUsd ? ` + $${cost.sttUsd}` : ''}, разбор моделью ${a.provider ?? '—'}:${a.model ?? '—'} $${cost.llmUsd} ≈ ${cost.llmRub} ₽ (вход ${a.cost.llmInputTokens} / выход ${a.cost.llmOutputTokens} токенов, попыток ${a.attempts})`);
  const base: RefusalDemoResult = { leadId: o.leadId, changedAt, items: a.items.length, used: a.used.length, calls: a.counts.calls, notReady: a.notReady, noteText: a.noteText, posted: null, already: false, cost };
  if (!o.post) {
    out('\nБез --post: в amoCRM и refusal_analyses ничего не записано.');
    return base;
  }
  const rowId = await deps.refusals.claim({ accountId: o.accountId, leadId: o.leadId, eventId: `demo:${o.leadId}:${Math.floor(changedAt.getTime() / 1000)}`, changedAt, statusId: lead.status_id, pipelineId: lead.pipeline_id });
  if (rowId === null) {
    out('\nАнализ этого перехода уже записан — повторно не публикуем.');
    return { ...base, already: true };
  }
  try {
    // Пересчёт по команде: задача дополняется даже если прежний анализ в неё уже писал.
    const posted = await persistRefusal(deps, o.accountId, all.refusal, amo, rowId, a, { forceTask: true });
    out(`\nПримечание ${posted.noteId} записано в сделку ${o.leadId}; ${posted.taskUpdated ? `задача ${posted.taskId} дополнена` : posted.taskId ? `задача ${posted.taskId} уже дополнена` : 'задача администратора не найдена'}.`);
    return { ...base, posted };
  } catch (err) {
    await deps.refusals.setError(rowId, errorText(err));
    throw err;
  }
}
