import { AmoApiClient } from '@core/amo';
import { analyzeDay, mmss, type DaySummary } from './day-analyze.ts';
import { amoActiveLeads, collectLeadTimeline } from './day-sources.ts';
import { countTimeline, hasHumanActivity, timelineText, type TimelineItem } from './day-timeline.ts';
import type { CallsDeps, CallsSettings } from './deps.ts';
import { errorText } from './errors.ts';
import { CALL_DAY_KIND, CALL_DAY_RUN_KIND, CALL_ERROR_KIND } from './kinds.ts';
import { amoRaw, type AmoRaw } from './notes.ts';
import type { CallRow } from './repo.ts';
import type { CallTranscript } from './stt.ts';
import { MAX_ATTEMPTS, onFailure, RETRY_FAILED_AFTER_MS, transcribeCalls } from './transcribe.ts';

/**
 * RFD-AI-AGENT-CALLS-DAY-FULL: итог дня по сделке — всё общение с клиентом за день (звонки, Wazzup, чаты amoCRM, диалог
 * AI-агента, примечания менеджеров, почта) одной лентой → один вызов модели → одно примечание «Итог дня по сделке».
 * Запуск раз в день (calls.daySummaryTime). Сделки воронки «Двери» на этапах из настроек; сделка попадает в итог, если за
 * день был звонок с записью, сообщение клиента или менеджера, письмо или примечание менеджера; только ответы AI-агента —
 * итога нет. Повторный запуск в тот же день — только по новому общению. Звонки без сделки — итог по контакту (только звонки);
 * звонки старше вчерашнего (догрузка) — отдельные итоги по своим дням.
 */

const MSK = 'Europe/Moscow';
const CLOSED_STATUSES = new Set([142, 143]);
const GROUP_CONCURRENCY = 2;
const WAIT_POLL_MS = 15_000;

/** День по Москве ГГГГ-ММ-ДД. */
export function mskDay(d: Date): string {
  const p = new Intl.DateTimeFormat('ru-RU', { timeZone: MSK, day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')}`;
}
/** Начало дня по Москве (UTC+3, без перехода на летнее время). */
export const mskDayStart = (day: string): Date => new Date(Date.parse(`${day}T00:00:00+03:00`));
export const dayLabel = (day: string): string => day.split('-').reverse().join('.');
const dayShort = (day: string): string => `${day.slice(8, 10)}.${day.slice(5, 7)}`;
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export interface DaySummaryOptions {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  amo?: AmoRaw;
  client?: AmoApiClient;
  transcribe?: Parameters<typeof transcribeCalls>[3];
  /** Не ждать нерасшифрованные (проверка раз в 5 минут между запусками). */
  noWait?: boolean;
}

export interface DaySummaryResult {
  accountId: number;
  enabled: boolean;
  /** Сделок и контактов с итогом, звонков в итогах, примечаний. */
  groups: number;
  calls: number;
  notes: number;
  noBusiness: number;
  /** Сделок без общения людей (только AI-агент или ничего нового) — итог не считался. */
  noActivity: number;
  skipped: number;
  errors: number;
  waiting: number;
}

export interface Group {
  key: string;
  leadId: number | null;
  contactId: number | null;
  day: string;
  calls: CallRow[];
  items: TimelineItem[];
}

const pluralRu = (n: number, one: string, few: string, many: string): string => (n % 10 === 1 && n % 100 !== 11 ? one : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? few : many);

/** Текст примечания по формату ТЗ п. 4; звонки не того дня и сокращение ленты — в заголовке. */
export function formatDayNote(day: string, s: DaySummary, opts: { calls?: Pick<CallRow, 'calledAt'>[]; truncated?: string[]; byContact?: boolean } = {}): string {
  const other = [...new Set((opts.calls ?? []).map((c) => mskDay(c.calledAt)).filter((d) => d !== day))].sort();
  const agreements = s.agreements.map((x) => x.trim()).filter(Boolean);
  const c = s.counts;
  const parts: string[] = [];
  if (c.calls || (!c.messages && !c.emails)) parts.push(`${c.calls} ${pluralRu(c.calls, 'звонок', 'звонка', 'звонков')} (${mmss(s.totalCallDuration)})`);
  if (c.messages) parts.push(`${c.messages} ${pluralRu(c.messages, 'сообщение', 'сообщения', 'сообщений')}`);
  if (c.emails) parts.push(`${c.emails} ${pluralRu(c.emails, 'письмо', 'письма', 'писем')}`);
  if (c.notes) parts.push(`${c.notes} ${pluralRu(c.notes, 'примечание', 'примечания', 'примечаний')}`);
  const tail = [other.length ? `в т. ч. звонки от ${other.map(dayShort).join(', ')}` : '', opts.truncated?.length ? 'часть переписки сокращена' : ''].filter(Boolean);
  return [
    `Итог дня по ${opts.byContact ? 'контакту' : 'сделке'} за ${dayLabel(day)}: ${parts.join(', ')}${tail.length ? ` (${tail.join('; ')})` : ''}`,
    `Итог: ${s.summary.trim() || '—'}`,
    `Договорённости: ${agreements.length ? (agreements.length === 1 ? agreements[0] : agreements.map((x) => `\n— ${x}`).join('')) : 'нет'}`,
    `Следующий шаг: ${s.nextStep.trim() || 'не определён'}`,
    `Оценка менеджера: ${s.managerScore}/10 — ${s.managerComment.trim() || '—'}`,
  ].join('\n');
}

/** Звонок → запись ленты. */
export const callItem = (c: CallRow): TimelineItem => {
  const t = c.transcript as CallTranscript;
  return { id: `call:${c.id}`, at: c.calledAt, source: 'call', direction: c.direction, author: c.direction === 'in' ? 'client' : 'manager', text: t.text, durationSec: c.durationSec, callId: c.id, transcript: t };
};

interface LeadBrief {
  id: number;
  status_id: number;
  pipeline_id: number;
}

async function fetchLeads(amo: AmoRaw, ids: number[]): Promise<Map<number, LeadBrief | null>> {
  const out = new Map<number, LeadBrief | null>();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const res = await amo.get<{ _embedded?: { leads?: LeadBrief[] } }>(`/api/v4/leads?${batch.map((id) => `filter[id][]=${id}`).join('&')}`);
    for (const id of batch) out.set(id, null);
    for (const l of res?._embedded?.leads ?? []) out.set(l.id, l);
  }
  return out;
}

export function leadAllowed(lead: LeadBrief | null | undefined, s: CallsSettings): { ok: true } | { ok: false; reason: string } {
  if (!lead) return { ok: false, reason: 'сделка не найдена в amo' };
  if (lead.pipeline_id !== s.pipelineId) return { ok: false, reason: `сделка в другой воронке (${lead.pipeline_id}), итог только по воронке ${s.pipelineId}` };
  if (CLOSED_STATUSES.has(lead.status_id)) return { ok: false, reason: `сделка на закрытом этапе (${lead.status_id})` };
  if (s.statusIds.length && !s.statusIds.includes(lead.status_id)) return { ok: false, reason: `этап сделки (${lead.status_id}) не в списке для итога` };
  return { ok: true };
}

export async function runDaySummaryAll(deps: CallsDeps, opts: DaySummaryOptions = {}): Promise<DaySummaryResult[]> {
  const out: DaySummaryResult[] = [];
  for (const accountId of await deps.accountIds()) {
    try {
      out.push(await runDaySummary(deps, accountId, opts));
    } catch (err) {
      out.push({ accountId, enabled: true, groups: 0, calls: 0, notes: 0, noBusiness: 0, noActivity: 0, skipped: 0, errors: 1, waiting: 0 });
      await deps.journal.add({ accountId, kind: CALL_ERROR_KIND, summary: `Итог дня не выполнен — ${errorText(err)}`, details: { error: errorText(err) } }).catch(() => undefined);
    }
  }
  return out;
}

export async function runDaySummary(deps: CallsDeps, accountId: number, opts: DaySummaryOptions = {}): Promise<DaySummaryResult> {
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise((res) => setTimeout(res, ms)));
  const all = await deps.settingsFor(accountId);
  const s = all.calls;
  const r: DaySummaryResult = { accountId, enabled: s.callsEnabled, groups: 0, calls: 0, notes: 0, noBusiness: 0, noActivity: 0, skipped: 0, errors: 0, waiting: 0 };
  if (!s.callsEnabled) return r;
  const account = await deps.accounts.get(accountId);
  if (!account || account.uninstalledAt) throw new Error(`Аккаунт ${accountId} не подключён`);
  const token = () => deps.tokenService.getAccessToken(accountId);
  const amo = opts.amo ?? amoRaw(account.accountDomain, token, deps.fetch);
  const client = opts.client ?? new AmoApiClient(account.accountDomain, token, deps.fetch);
  const started = now();
  const today = mskDay(started);
  const since = mskDayStart(today);

  // Нерасшифрованные звонки: подтянуть результаты операций SpeechKit и подождать до daySummaryTimeoutSec.
  const deadline = started.getTime() + (opts.noWait ? 0 : s.daySummaryTimeoutSec * 1000);
  for (;;) {
    const left = await deps.calls.countNotTranscribed(accountId, started);
    if (!left) break;
    await transcribeCalls(deps, accountId, s, { now, sleep, ...opts.transcribe });
    const still = await deps.calls.countNotTranscribed(accountId, started);
    if (!still || now().getTime() >= deadline) {
      r.waiting = still;
      break;
    }
    await sleep(WAIT_POLL_MS);
  }

  // Кандидаты: звонки без итога + сделки с общением за день (локальные таблицы и amo).
  const calls = await deps.calls.listForDaySummary(accountId, { until: started, retryBefore: new Date(started.getTime() - RETRY_FAILED_AFTER_MS), maxAttempts: MAX_ATTEMPTS });
  const leadIds = new Set<number>(calls.map((c) => c.leadId ?? (c.entity === 'lead' ? c.entityId : null)).filter((x): x is number => x !== null));
  if (deps.sources?.activeLeads) for (const id of await deps.sources.activeLeads(accountId, since, started).catch(() => [])) leadIds.add(id);
  for (const id of await amoActiveLeads(amo, since, started, s).catch(() => new Set<number>())) leadIds.add(id);

  // Фильтр по сделке: воронка «Двери», этап не закрыт и в списке; звонки сделок вне — analyzed с причиной.
  const leads = leadIds.size ? await fetchLeads(amo, [...leadIds]) : new Map<number, LeadBrief | null>();
  const allowed = new Set<number>();
  const skipped = new Map<string, number[]>();
  for (const id of leadIds) {
    const v = leadAllowed(leads.get(id), s);
    if (v.ok) allowed.add(id);
    else skipped.set(v.reason, [...(skipped.get(v.reason) ?? []), ...calls.filter((c) => (c.leadId ?? (c.entity === 'lead' ? c.entityId : null)) === id).map((c) => c.id)]);
  }
  for (const [reason, ids] of skipped) {
    await deps.calls.setSkipped(ids, reason);
    r.skipped += ids.length;
  }

  // Группы: сделка за день общения (звонки этого дня + вся лента того дня; RFD-AI-AGENT-CALLS-DAY: итог датируется днём
  // общения, а не днём запуска — звонки вчерашнего дня, не вошедшие в итог, идут отдельным итогом за вчера); звонки без
  // сделки — по контакту и дню (только звонки).
  const groups = new Map<string, Group>();
  const group = (key: string, leadId: number | null, contactId: number | null, day: string): Group => {
    const g = groups.get(key) ?? { key, leadId, contactId, day, calls: [], items: [] };
    groups.set(key, g);
    return g;
  };
  for (const c of calls) {
    const leadId = c.leadId ?? (c.entity === 'lead' ? c.entityId : null);
    if (leadId !== null && !allowed.has(leadId)) continue;
    const day = mskDay(c.calledAt);
    if (leadId === null) group(`contact:${c.entityId}:${day}`, null, c.entityId, day).calls.push(c);
    else group(`lead:${leadId}:${day}`, leadId, null, day).calls.push(c);
  }
  for (const id of allowed) group(`lead:${id}:${today}`, id, null, today);

  const queue = [...groups.values()];
  await Promise.all(Array.from({ length: Math.min(GROUP_CONCURRENCY, queue.length) }, async () => {
    // Окно ленты — день группы: сегодня до текущего момента, прошлый день — целиком.
    for (let g = queue.shift(); g; g = queue.shift()) await summarizeGroup(deps, accountId, all, amo, client, g, r, mskDayStart(g.day), g.day === today ? started : mskDayStart(addDays(g.day, 1)));
  }));
  await journalRun(deps, accountId, r);
  return r;
}

async function journalRun(deps: CallsDeps, accountId: number, r: DaySummaryResult): Promise<void> {
  const parts = [`сделок и контактов ${r.groups}`, `звонков ${r.calls}`, `примечаний ${r.notes}`];
  if (r.noBusiness) parts.push(`без делового содержания ${r.noBusiness}`);
  if (r.noActivity) parts.push(`без общения людей ${r.noActivity}`);
  if (r.skipped) parts.push(`звонков вне воронки или этапа ${r.skipped}`);
  if (r.errors) parts.push(`ошибок ${r.errors}`);
  if (r.waiting) parts.push(`не дождались расшифровки ${r.waiting} — в следующий итог`);
  await deps.journal.add({ accountId, kind: CALL_DAY_RUN_KIND, summary: `Итог дня: ${parts.join(', ')}`, details: { ...r } });
}

export interface GroupAnalysis {
  group: Group;
  summary: DaySummary;
  /** Записи ленты, вошедшие во вход модели; business — с деловым содержанием (sourceIds). */
  used: TimelineItem[];
  business: TimelineItem[];
  truncated: string[];
  transcripts: Map<number, CallTranscript>;
  noteText: string | null;
  cost: { llmUsd: number; llmRub: number; llmInputTokens: number; llmOutputTokens: number; sttRub: number; sttUsd: number };
  provider: string;
  model: string;
  attempts: number;
  raw: string;
}

/** Расчёт итога группы без записи куда-либо: лента → модель → роли, текст примечания, стоимость. */
export async function analyzeGroup(deps: CallsDeps, accountId: number, g: Group): Promise<GroupAnalysis> {
  const llm = await deps.llmFor(accountId);
  if (!llm) throw new Error('нет ключа модели (вкладка «Модель»)');
  const tl = timelineText(g.items);
  const counts = countTimeline(tl.used);
  const res = await analyzeDay(llm.llm, llm.route, { timeline: tl.text, ids: tl.used.map((i) => i.id), counts, dateLabel: dayLabel(g.day), truncated: tl.truncated, pricing: llm.pricing });
  const business = tl.used.filter((i) => res.summary.sourceIds.includes(i.id));
  const transcripts = new Map<number, CallTranscript>();
  for (const c of g.calls) {
    const t = c.transcript as CallTranscript;
    const roles = new Map(res.summary.speakers.filter((x) => x.callId === c.id).map((x) => [x.tag, x.role]));
    transcripts.set(c.id, roles.size ? { ...t, segments: t.segments.map((seg) => (seg.speaker && roles.has(seg.speaker) ? { ...seg, role: roles.get(seg.speaker) } : seg)) } : t);
  }
  const cost = { llmUsd: res.cost.usd, llmRub: res.cost.usd * llm.usdRubRate, llmInputTokens: res.cost.inputTokens, llmOutputTokens: res.cost.outputTokens, sttRub: g.calls.reduce((n, c) => n + Number((c.cost as { sttRub?: number } | null)?.sttRub ?? 0), 0), sttUsd: g.calls.reduce((n, c) => n + Number((c.cost as { sttUsd?: number } | null)?.sttUsd ?? 0), 0) };
  const noteText = business.length ? formatDayNote(g.day, res.summary, { calls: g.calls, truncated: tl.truncated, byContact: g.leadId === null }) : null;
  return { group: g, summary: res.summary, used: tl.used, business, truncated: tl.truncated, transcripts, noteText, cost, provider: res.provider, model: res.model, attempts: res.attempts, raw: res.raw };
}

/** Сохранить итог: роли в расшифровки, строка в call_day_summaries, примечание в amo, статусы звонков, журнал. */
export async function persistGroup(deps: CallsDeps, accountId: number, s: CallsSettings, amo: AmoRaw, a: GroupAnalysis): Promise<{ summaryId: number; noteId: number | null }> {
  const g = a.group;
  const where = g.leadId !== null ? `сделка ${g.leadId}` : `контакт ${g.contactId}`;
  for (const [id, t] of a.transcripts) await deps.calls.setTranscript(id, t, 'transcribed');
  const businessCallIds = new Set(a.business.filter((i) => i.callId).map((i) => i.callId as number));
  const summaryId = await deps.days.insert({ accountId, leadId: g.leadId, contactId: g.contactId, day: g.day, business: a.business.length > 0, summary: a.summary, callIds: g.calls.map((c) => c.id), itemIds: a.used.map((i) => i.id), counts: a.summary.counts, callsCount: a.summary.counts.calls, totalDurationSec: a.summary.totalCallDuration, provider: a.provider, model: a.model, cost: a.cost });
  let noteId: number | null = null;
  if (a.noteText && s.postDayNote) {
    const entity = g.leadId !== null ? 'lead' : 'contact';
    const entityId = g.leadId ?? g.contactId ?? 0;
    const posted = await amo.post<{ _embedded?: { notes?: { id: number }[] } }>(`/api/v4/${entity === 'lead' ? 'leads' : 'contacts'}/${entityId}/notes`, [{ note_type: 'common', params: { text: a.noteText } }]);
    noteId = posted?._embedded?.notes?.[0]?.id ?? 0;
    if (!noteId) throw new Error(`amo не вернул id примечания (${where})`);
    await deps.days.setNote(summaryId, { noteId, entity, text: a.noteText });
  }
  await deps.calls.attachToSummary(g.calls.filter((c) => businessCallIds.has(c.id)).map((c) => c.id), summaryId, noteId ? 'posted' : 'analyzed');
  await deps.calls.attachToSummary(g.calls.filter((c) => !businessCallIds.has(c.id)).map((c) => c.id), summaryId, 'analyzed');
  const c = a.summary.counts;
  await deps.journal.add({
    accountId,
    ...(g.leadId !== null ? { leadId: g.leadId } : {}),
    kind: CALL_DAY_KIND,
    summary: a.business.length ? `Итог дня за ${dayLabel(g.day)} (${where}): звонков ${c.calls} (${mmss(a.summary.totalCallDuration)}), сообщений ${c.messages}, писем ${c.emails}, примечаний ${c.notes} — ${a.summary.summary.slice(0, 300)}; оценка ${a.summary.managerScore}/10${noteId ? `; примечание ${noteId}` : s.postDayNote ? '' : '; примечание выключено'}` : `Итог дня за ${dayLabel(g.day)} (${where}): делового общения нет — ${a.summary.summary.slice(0, 200)}; примечание не пишется`,
    details: { summaryId, day: g.day, leadId: g.leadId, contactId: g.contactId, itemIds: a.used.map((i) => i.id), businessIds: a.business.map((i) => i.id), truncated: a.truncated, noteId, noteText: a.noteText, provider: a.provider, model: a.model, attempts: a.attempts, raw: a.raw, cost: a.cost },
    inputTokens: a.cost.llmInputTokens,
    outputTokens: a.cost.llmOutputTokens,
    costUsd: a.cost.llmUsd,
    costRub: a.cost.llmRub,
  });
  return { summaryId, noteId };
}

/** Собрать ленту группы: звонки + источники дня (для сделок), без уже учтённых в итогах этого дня. */
export async function fillGroupItems(deps: CallsDeps, accountId: number, s: CallsSettings, amo: AmoRaw, client: AmoApiClient, g: Group, since: Date, until: Date): Promise<string[]> {
  const warnings: string[] = [];
  let items: TimelineItem[];
  // Лента по всем источникам — для группы «сделка за день», когда окно until заканчивается в этот день: у итога дня until = сейчас,
  // у показа за прошлую дату (calls-demo --date) — начало следующих суток, поэтому берём день последней миллисекунды окна
  // (RFD-AI-AGENT-CALLS-DEMO-SOURCES: раньше для прошлой даты оставались одни звонки). Группы старых звонков — только звонки.
  if (g.leadId !== null && g.day === mskDay(new Date(until.getTime() - 1))) {
    const col = await collectLeadTimeline(deps, amo, client, { accountId, leadId: g.leadId, since, until, calls: g.calls, settings: s });
    items = col.items;
    warnings.push(...col.warnings);
  } else {
    items = g.calls.map(callItem);
  }
  const done = await deps.days.summarizedItemIds(accountId, { leadId: g.leadId, contactId: g.contactId }, g.day);
  g.items = items.filter((i) => !done.has(i.id));
  // Звонки, уже вошедшие в итог, в calls не остаются (day_summary_id), но лента могла подтянуть их из прошлых итогов — не считаем.
  g.calls = g.calls.filter((c) => !done.has(`call:${c.id}`));
  return warnings;
}

async function summarizeGroup(deps: CallsDeps, accountId: number, all: Awaited<ReturnType<CallsDeps['settingsFor']>>, amo: AmoRaw, client: AmoApiClient, g: Group, r: DaySummaryResult, since: Date, until: Date): Promise<void> {
  const where = g.leadId !== null ? `сделка ${g.leadId}` : `контакт ${g.contactId}`;
  try {
    const warnings = await fillGroupItems(deps, accountId, all.calls, amo, client, g, since, until);
    if (warnings.length) await deps.journal.add({ accountId, ...(g.leadId !== null ? { leadId: g.leadId } : {}), kind: CALL_ERROR_KIND, summary: `Итог дня (${where}): часть источников не прочитана — ${warnings.join('; ')}`, details: { warnings } });
    if (!g.items.length || !hasHumanActivity(g.items)) {
      r.noActivity++;
      return;
    }
    const a = await analyzeGroup(deps, accountId, g);
    const { noteId } = await persistGroup(deps, accountId, all.calls, amo, a);
    r.groups++;
    r.calls += g.calls.length;
    if (noteId) r.notes++;
    if (!a.business.length) r.noBusiness++;
  } catch (err) {
    // Ошибка по одной сделке не останавливает остальные: звонки группы — failed / day, повтор через 30 мин, 3 попытки; без звонков — журнал.
    r.errors++;
    const message = `${where}: ${errorText(err)}`;
    if (g.calls.length) {
      const ctx = { deps, result: { failed: 0, alerts: 0 } };
      for (const c of g.calls) await onFailure(ctx, c, message, 'day');
    } else {
      await deps.journal.add({ accountId, ...(g.leadId !== null ? { leadId: g.leadId } : {}), kind: CALL_ERROR_KIND, summary: `Итог дня не посчитан — ${message}`, details: { error: message, day: g.day } });
    }
  }
}
