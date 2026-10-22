import { analyzeDay, mmss, type DayCallInput, type DaySummary } from './day-analyze.ts';
import type { CallsDeps, CallsSettings } from './deps.ts';
import { CALL_DAY_KIND, CALL_DAY_RUN_KIND, CALL_ERROR_KIND } from './kinds.ts';
import { amoRaw, type AmoRaw } from './notes.ts';
import type { CallRow } from './repo.ts';
import type { CallTranscript } from './stt.ts';
import { MAX_ATTEMPTS, onFailure, RETRY_FAILED_AFTER_MS, transcribeCalls } from './transcribe.ts';

/**
 * RFD-AI-AGENT-CALLS-RETAIL, пп. 2–3: итог разговоров за день. Раз в день (calls.daySummaryTime, 19:30 МСК) все
 * расшифрованные звонки, ещё не вошедшие в итог, группируются по сделке (без сделки — по контакту) и дню; на группу — один
 * вызов модели и одно примечание «Итог разговоров за ДД.ММ.ГГГГ…» в сделку / контакт. Сделки только воронки «Двери» на
 * этапах из настроек (пусто — все, кроме 142 / 143). Нерасшифрованные ждут до daySummaryTimeoutSec, не успели — в итог
 * следующего дня с пометкой даты звонка. Повторный запуск в тот же день пишет отдельный итог только по новым звонкам.
 */

const MSK = 'Europe/Moscow';
/** Закрытые этапы amo: 142 — успешно реализовано, 143 — закрыто и не реализовано. */
const CLOSED_STATUSES = new Set([142, 143]);
const GROUP_CONCURRENCY = 2;
const WAIT_POLL_MS = 15_000;

/** День по Москве ГГГГ-ММ-ДД. */
export function mskDay(d: Date): string {
  const p = new Intl.DateTimeFormat('ru-RU', { timeZone: MSK, day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')}`;
}
/** ГГГГ-ММ-ДД → ДД.ММ.ГГГГ. */
export const dayLabel = (day: string): string => day.split('-').reverse().join('.');
const dayShort = (day: string): string => `${day.slice(8, 10)}.${day.slice(5, 7)}`;
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export interface DaySummaryOptions {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  amo?: AmoRaw;
  /** Параметры расшифровки (ожидание незавершённых) — для тестов. */
  transcribe?: Parameters<typeof transcribeCalls>[3];
  /** Не ждать нерасшифрованные (проверка раз в 5 минут между запусками). */
  noWait?: boolean;
}

export interface DaySummaryResult {
  accountId: number;
  enabled: boolean;
  /** Сделок / контактов с итогом (групп), звонков в итогах, примечаний, групп с ошибкой. */
  groups: number;
  calls: number;
  notes: number;
  noBusiness: number;
  skipped: number;
  errors: number;
  /** Нерасшифрованных звонков, которые не дождались, — уйдут в следующий итог. */
  waiting: number;
}

export interface Group {
  key: string;
  leadId: number | null;
  contactId: number | null;
  day: string;
  calls: CallRow[];
}

/** Текст примечания по формату ТЗ п. 3; даты звонков не того дня — в заголовке. */
export function formatDayNote(day: string, s: DaySummary, calls: Pick<CallRow, 'calledAt'>[]): string {
  const other = [...new Set(calls.map((c) => mskDay(c.calledAt)).filter((d) => d !== day))].sort();
  const agreements = s.agreements.map((x) => x.trim()).filter(Boolean);
  const n = s.callsCount;
  const word = n % 10 === 1 && n % 100 !== 11 ? 'звонок' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'звонка' : 'звонков';
  return [
    `Итог разговоров за ${dayLabel(day)}: ${n} ${word}, общая длительность ${mmss(s.totalDuration)}${other.length ? ` (в т. ч. звон${other.length === 1 && n === 1 ? 'ок' : 'ки'} от ${other.map(dayShort).join(', ')})` : ''}`,
    `Итог: ${s.summary.trim() || '—'}`,
    `Договорённости: ${agreements.length ? (agreements.length === 1 ? agreements[0] : agreements.map((x) => `\n— ${x}`).join('')) : 'нет'}`,
    `Следующий шаг: ${s.nextStep.trim() || 'не определён'}`,
    `Оценка менеджера: ${s.managerScore}/10 — ${s.managerComment.trim() || '—'}`,
  ].join('\n');
}

/** Группы: по сделке (иначе по контакту); день — звонки сегодня и вчера идут в сегодняшний итог, старше — по своему дню. */
export function groupCalls(calls: CallRow[], today: string): Group[] {
  const yesterday = addDays(today, -1);
  const out = new Map<string, Group>();
  for (const c of calls) {
    const d = mskDay(c.calledAt);
    const day = d >= yesterday ? today : d;
    const leadId = c.leadId ?? (c.entity === 'lead' ? c.entityId : null);
    const contactId = leadId === null ? c.entityId : null;
    const key = `${leadId !== null ? `lead:${leadId}` : `contact:${contactId}`}:${day}`;
    const g = out.get(key) ?? { key, leadId, contactId, day, calls: [] };
    g.calls.push(c);
    out.set(key, g);
  }
  return [...out.values()];
}

interface LeadBrief {
  id: number;
  status_id: number;
  pipeline_id: number;
}

/** Сделки по id (пачками по 50): воронка и этап для фильтра. Не найденные — null. */
async function fetchLeads(amo: AmoRaw, ids: number[]): Promise<Map<number, LeadBrief | null>> {
  const out = new Map<number, LeadBrief | null>();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const q = batch.map((id) => `filter[id][]=${id}`).join('&');
    const res = await amo.get<{ _embedded?: { leads?: LeadBrief[] } }>(`/api/v4/leads?${q}`);
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
      out.push({ accountId, enabled: true, groups: 0, calls: 0, notes: 0, noBusiness: 0, skipped: 0, errors: 1, waiting: 0 });
      await deps.journal.add({ accountId, kind: CALL_ERROR_KIND, summary: `Итог разговоров за день не выполнен — ${(err as Error).message}`, details: { error: (err as Error).message } }).catch(() => undefined);
    }
  }
  return out;
}

export async function runDaySummary(deps: CallsDeps, accountId: number, opts: DaySummaryOptions = {}): Promise<DaySummaryResult> {
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise((res) => setTimeout(res, ms)));
  const all = await deps.settingsFor(accountId);
  const s = all.calls;
  const r: DaySummaryResult = { accountId, enabled: s.callsEnabled, groups: 0, calls: 0, notes: 0, noBusiness: 0, skipped: 0, errors: 0, waiting: 0 };
  if (!s.callsEnabled) return r;
  const account = await deps.accounts.get(accountId);
  if (!account || account.uninstalledAt) throw new Error(`Аккаунт ${accountId} не подключён`);
  const amo = opts.amo ?? amoRaw(account.accountDomain, () => deps.tokenService.getAccessToken(accountId), deps.fetch);
  const started = now();
  const today = mskDay(started);

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

  const candidates = await deps.calls.listForDaySummary(accountId, { until: started, retryBefore: new Date(started.getTime() - RETRY_FAILED_AFTER_MS), maxAttempts: MAX_ATTEMPTS });
  if (!candidates.length) {
    if (r.waiting) await journalRun(deps, accountId, r);
    return r;
  }
  // Фильтр по сделке: воронка «Двери», этап не закрыт и в списке; вне — analyzed с причиной.
  const leadIds = [...new Set(candidates.map((c) => c.leadId ?? (c.entity === 'lead' ? c.entityId : null)).filter((x): x is number => x !== null))];
  const leads = leadIds.length ? await fetchLeads(amo, leadIds) : new Map<number, LeadBrief | null>();
  const allowed: CallRow[] = [];
  const skipped = new Map<string, number[]>();
  for (const c of candidates) {
    const leadId = c.leadId ?? (c.entity === 'lead' ? c.entityId : null);
    if (leadId === null) {
      allowed.push(c);
      continue;
    }
    const v = leadAllowed(leads.get(leadId), s);
    if (v.ok) allowed.push(c);
    else skipped.set(v.reason, [...(skipped.get(v.reason) ?? []), c.id]);
  }
  for (const [reason, ids] of skipped) {
    await deps.calls.setSkipped(ids, reason);
    r.skipped += ids.length;
  }

  const groups = groupCalls(allowed, today);
  const queue = [...groups];
  await Promise.all(Array.from({ length: Math.min(GROUP_CONCURRENCY, queue.length) }, async () => {
    for (let g = queue.shift(); g; g = queue.shift()) await summarizeGroup(deps, accountId, all, amo, g, r);
  }));
  await journalRun(deps, accountId, r);
  return r;
}

async function journalRun(deps: CallsDeps, accountId: number, r: DaySummaryResult): Promise<void> {
  const parts = [`сделок и контактов ${r.groups}`, `звонков ${r.calls}`, `примечаний ${r.notes}`];
  if (r.noBusiness) parts.push(`без делового содержания ${r.noBusiness}`);
  if (r.skipped) parts.push(`вне воронки или этапа ${r.skipped}`);
  if (r.errors) parts.push(`ошибок ${r.errors}`);
  if (r.waiting) parts.push(`не дождались расшифровки ${r.waiting} — в следующий итог`);
  await deps.journal.add({ accountId, kind: CALL_DAY_RUN_KIND, summary: `Итог разговоров за день: ${parts.join(', ')}`, details: { ...r } });
}

/** Расчёт итога группы без записи куда-либо: разбор моделью, роли, текст примечания, стоимость. */
export interface GroupAnalysis {
  group: Group;
  summary: DaySummary;
  business: CallRow[];
  rest: CallRow[];
  /** Расшифровки с ролями говорящих (по id звонка). */
  transcripts: Map<number, CallTranscript>;
  noteText: string | null;
  cost: { llmUsd: number; llmRub: number; llmInputTokens: number; llmOutputTokens: number; sttRub: number; sttUsd: number };
  provider: string;
  model: string;
  attempts: number;
  raw: string;
}

export async function analyzeGroup(deps: CallsDeps, accountId: number, g: Group): Promise<GroupAnalysis> {
  const llm = await deps.llmFor(accountId);
  if (!llm) throw new Error('нет ключа модели (вкладка «Модель»)');
  const inputs: DayCallInput[] = g.calls.map((c) => ({ id: c.id, calledAt: c.calledAt, direction: c.direction, durationSec: c.durationSec, transcript: c.transcript as CallTranscript }));
  const res = await analyzeDay(llm.llm, llm.route, { calls: inputs, dateLabel: dayLabel(g.day), pricing: llm.pricing });
  const business = g.calls.filter((c) => res.summary.callIds.includes(c.id));
  const rest = g.calls.filter((c) => !res.summary.callIds.includes(c.id));
  const transcripts = new Map<number, CallTranscript>();
  for (const c of g.calls) {
    const t = c.transcript as CallTranscript;
    const roles = new Map(res.summary.speakers.filter((x) => x.callId === c.id).map((x) => [x.tag, x.role]));
    transcripts.set(c.id, roles.size ? { ...t, segments: t.segments.map((seg) => (seg.speaker && roles.has(seg.speaker) ? { ...seg, role: roles.get(seg.speaker) } : seg)) } : t);
  }
  const cost = { llmUsd: res.cost.usd, llmRub: res.cost.usd * llm.usdRubRate, llmInputTokens: res.cost.inputTokens, llmOutputTokens: res.cost.outputTokens, sttRub: g.calls.reduce((n, c) => n + Number((c.cost as { sttRub?: number } | null)?.sttRub ?? 0), 0), sttUsd: g.calls.reduce((n, c) => n + Number((c.cost as { sttUsd?: number } | null)?.sttUsd ?? 0), 0) };
  return { group: g, summary: res.summary, business, rest, transcripts, noteText: business.length ? formatDayNote(g.day, res.summary, business) : null, cost, provider: res.provider, model: res.model, attempts: res.attempts, raw: res.raw };
}

/** Сохранить итог: роли в расшифровки, строка в call_day_summaries, примечание в amo (если есть деловые и включено), статусы звонков, журнал. */
export async function persistGroup(deps: CallsDeps, accountId: number, s: CallsSettings, amo: AmoRaw, a: GroupAnalysis): Promise<{ summaryId: number; noteId: number | null }> {
  const g = a.group;
  const where = g.leadId !== null ? `сделка ${g.leadId}` : `контакт ${g.contactId}`;
  for (const [id, t] of a.transcripts) await deps.calls.setTranscript(id, t, 'transcribed');
  const summaryId = await deps.days.insert({ accountId, leadId: g.leadId, contactId: g.contactId, day: g.day, business: a.business.length > 0, summary: a.summary, callIds: g.calls.map((c) => c.id), callsCount: a.summary.callsCount, totalDurationSec: a.summary.totalDuration, provider: a.provider, model: a.model, cost: a.cost });
  let noteId: number | null = null;
  if (a.noteText && s.postDayNote) {
    const entity = g.leadId !== null ? 'lead' : 'contact';
    const entityId = g.leadId ?? g.contactId ?? 0;
    const posted = await amo.post<{ _embedded?: { notes?: { id: number }[] } }>(`/api/v4/${entity === 'lead' ? 'leads' : 'contacts'}/${entityId}/notes`, [{ note_type: 'common', params: { text: a.noteText } }]);
    noteId = posted?._embedded?.notes?.[0]?.id ?? 0;
    if (!noteId) throw new Error(`amo не вернул id примечания (${where})`);
    await deps.days.setNote(summaryId, { noteId, entity, text: a.noteText });
  }
  await deps.calls.attachToSummary(a.business.map((c) => c.id), summaryId, noteId ? 'posted' : 'analyzed');
  await deps.calls.attachToSummary(a.rest.map((c) => c.id), summaryId, 'analyzed');
  await deps.journal.add({
    accountId,
    ...(g.leadId !== null ? { leadId: g.leadId } : {}),
    kind: CALL_DAY_KIND,
    summary: a.business.length ? `Итог разговоров за ${dayLabel(g.day)} (${where}): ${a.summary.callsCount} зв., ${mmss(a.summary.totalDuration)} — ${a.summary.summary.slice(0, 300)}; оценка ${a.summary.managerScore}/10${noteId ? `; примечание ${noteId}` : s.postDayNote ? '' : '; примечание выключено'}` : `Итог разговоров за ${dayLabel(g.day)} (${where}): деловых звонков нет — ${a.summary.summary.slice(0, 200)}; примечание не пишется`,
    details: { summaryId, day: g.day, leadId: g.leadId, contactId: g.contactId, callIds: g.calls.map((c) => c.id), businessCallIds: a.business.map((c) => c.id), noteId, noteText: a.noteText, provider: a.provider, model: a.model, attempts: a.attempts, raw: a.raw, cost: a.cost },
    inputTokens: a.cost.llmInputTokens,
    outputTokens: a.cost.llmOutputTokens,
    costUsd: a.cost.llmUsd,
    costRub: a.cost.llmRub,
  });
  return { summaryId, noteId };
}

async function summarizeGroup(deps: CallsDeps, accountId: number, all: Awaited<ReturnType<CallsDeps['settingsFor']>>, amo: AmoRaw, g: Group, r: DaySummaryResult): Promise<void> {
  try {
    const a = await analyzeGroup(deps, accountId, g);
    const { noteId } = await persistGroup(deps, accountId, all.calls, amo, a);
    r.groups++;
    r.calls += g.calls.length;
    if (noteId) r.notes++;
    if (!a.business.length) r.noBusiness++;
  } catch (err) {
    // Ошибка по одной сделке не останавливает остальные: звонки группы — failed / day, повтор через 30 мин, 3 попытки.
    r.errors++;
    const where = g.leadId !== null ? `сделка ${g.leadId}` : `контакт ${g.contactId}`;
    const ctx = { deps, result: { failed: 0, alerts: 0 } };
    for (const c of g.calls) await onFailure(ctx, c, `${where}: ${(err as Error).message}`, 'day');
  }
}
