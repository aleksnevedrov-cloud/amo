import { AmoApiClient } from '@core/amo';
import { mmss } from './day-analyze.ts';
import { analyzeGroup, dayLabel, fillGroupItems, formatDayNote, mskDay, mskDayStart, persistGroup, type Group } from './day-summary.ts';
import { formatItem } from './day-timeline.ts';
import type { CallsDeps } from './deps.ts';
import { downloadCall } from './job.ts';
import { amoRaw, fetchEntityCallNotes, leadContactIds, parseCallNote, type AmoRaw, type ParsedCallNote } from './notes.ts';
import type { CallStt, SttProviderName } from './stt.ts';
import { transcribeCalls } from './transcribe.ts';

/**
 * RFD-AI-AGENT-CALLS-DEMO + DAY-FULL: итог по одной сделке в консоль. Звонки сделки и её контактов за день (по умолчанию —
 * день последнего звонка с записью), скачивание, расшифровка асинхронным SpeechKit с ожиданием до 5 минут, лента дня из всех
 * источников и итог тем же кодом, что calls-day-summary. Без post ничего не пишет в amo и в таблицы итогов (звонки и
 * расшифровки — в calls, чтобы не расшифровывать повторно); с post — публикует примечание и сохраняет итог с защитой от дублей.
 */

export interface DemoOptions {
  accountId: number;
  leadId: number;
  /** ГГГГ-ММ-ДД по Москве; нет — день последнего звонка с записью (нет звонков — сегодня). */
  date?: string;
  post?: boolean;
  waitMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  amo?: AmoRaw;
  client?: AmoApiClient;
  stt?: (preferred: SttProviderName) => CallStt | null;
  out?: (line: string) => void;
}

export interface DemoResult {
  day: string;
  calls: number;
  transcribed: number;
  notReady: number;
  /** Записей ленты всего и новых (не вошедших в прежние итоги дня). */
  items: number;
  newItems: number;
  noteText: string | null;
  posted: { summaryId: number; noteId: number | null } | null;
  cost: { sttRub: number; sttUsd: number; llmUsd: number; llmRub: number } | null;
}

const DEFAULT_WAIT_MS = 5 * 60_000;
const POLL_MS = 10_000;
const SHOW_ITEMS = 30;

export async function runCallsDemo(deps: CallsDeps, o: DemoOptions): Promise<DemoResult> {
  const out = o.out ?? (() => undefined);
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const all = await deps.settingsFor(o.accountId);
  const s = all.calls;
  const account = await deps.accounts.get(o.accountId);
  if (!account || account.uninstalledAt) throw new Error(`Аккаунт ${o.accountId} не подключён`);
  const token = () => deps.tokenService.getAccessToken(o.accountId);
  const amo = o.amo ?? amoRaw(account.accountDomain, token, deps.fetch);
  const client = o.client ?? new AmoApiClient(account.accountDomain, token, deps.fetch);

  // Примечания-звонки сделки и её контактов; все — к этой сделке.
  const contacts = await leadContactIds(amo, o.leadId);
  const parsed: ParsedCallNote[] = [];
  for (const n of await fetchEntityCallNotes(amo, 'lead', o.leadId)) {
    const c = parseCallNote(n, 'lead');
    if (c) parsed.push(c);
  }
  for (const cid of contacts) {
    for (const n of await fetchEntityCallNotes(amo, 'contact', cid)) {
      const c = parseCallNote(n, 'contact');
      if (c) parsed.push(c);
    }
  }
  const day = o.date ?? (parsed.length ? mskDay(parsed.reduce((m, c) => (c.calledAt > m.calledAt ? c : m)).calledAt) : mskDay(now()));
  const since = mskDayStart(day);
  const until = day === mskDay(now()) ? now() : new Date(since.getTime() + 86_400_000);
  const dayCalls = parsed.filter((c) => mskDay(c.calledAt) === day && c.durationSec >= s.minDurationSec);
  out(`Сделка ${o.leadId}, контактов ${contacts.length}, звонков с записью всего ${parsed.length}; за ${dayLabel(day)} не короче ${s.minDurationSec} с — ${dayCalls.length}`);

  // Звонки в базу (дубли не вставляются), скачать и расшифровать с ожиданием.
  let rows = dayCalls.length ? (await deps.calls.insertNew(o.accountId, dayCalls.map((c) => ({ ...c, leadId: o.leadId })), 'async'), await deps.calls.byNoteIds(o.accountId, dayCalls.map((c) => c.noteId))) : [];
  const ids = rows.map((r) => r.id);
  for (const r of rows) if (r.status === 'new' || (r.status === 'failed' && r.stage === 'download')) await downloadCall(deps, r, { sleep });
  const deadline = now().getTime() + (o.waitMs ?? DEFAULT_WAIT_MS);
  while (rows.length) {
    rows = await deps.calls.byNoteIds(o.accountId, dayCalls.map((c) => c.noteId));
    if (!rows.some((r) => r.status === 'downloaded' || (r.status === 'failed' && r.stage === 'transcribe'))) break;
    await transcribeCalls(deps, o.accountId, s, { now, sleep, ids, inlineWaitMs: 60_000, ...(o.stt ? { stt: o.stt } : {}) });
    rows = await deps.calls.byNoteIds(o.accountId, dayCalls.map((c) => c.noteId));
    if (!rows.some((r) => r.status === 'downloaded') || now().getTime() >= deadline) break;
    await sleep(POLL_MS);
  }
  const ready = rows.filter((r) => r.transcript && !('pending' in r.transcript));
  const notReady = rows.filter((r) => !r.transcript || 'pending' in r.transcript);
  for (const r of notReady) out(`  звонок ${r.id} (${r.direction === 'in' ? 'вх' : 'исх'} ${r.phone}, ${r.calledAt.toISOString()}): ${r.status} — ${r.error ?? 'расшифровка ещё идёт'}`);

  // Лента дня: звонки без итога + все источники; уже учтённое в прежних итогах дня — не берём.
  const g: Group = { key: `lead:${o.leadId}:${day}`, leadId: o.leadId, contactId: null, day, calls: ready.filter((r) => r.daySummaryId === null), items: [] };
  const warnings = await fillGroupItems(deps, o.accountId, s, amo, client, g, since, until);
  for (const w of warnings) out(`  источник не прочитан: ${w}`);
  const prior = await deps.days.summarizedItemIds(o.accountId, { leadId: o.leadId, contactId: null }, day);
  const base: DemoResult = { day, calls: rows.length, transcribed: ready.length, notReady: notReady.length, items: g.items.length + prior.size, newItems: g.items.length, noteText: null, posted: null, cost: null };
  if (prior.size) {
    for (const d of await deps.days.forLead(o.accountId, o.leadId, day)) out(`Итог ${d.id} за ${dayLabel(d.day)} уже есть${d.noteId ? ` (примечание ${d.noteId})` : ' (без примечания)'}: ${d.itemIds.length} записей ленты${d.noteText ? `\n${d.noteText}` : ''}`);
  }
  if (!g.items.length) {
    out(`\nХронология за ${dayLabel(day)}: нового общения нет — итог не считается.`);
    return base;
  }

  const a = await analyzeGroup(deps, o.accountId, g);
  // Хронология — после разбора: у звонков уже расставлены роли говорящих.
  out(`\nХронология за ${dayLabel(day)} (новых записей ${g.items.length}${prior.size ? `, уже в итоге ${prior.size}` : ''}; показаны первые ${Math.min(SHOW_ITEMS, g.items.length)}):`);
  for (const it of g.items.slice(0, SHOW_ITEMS)) out(formatItem(it.callId && a.transcripts.has(it.callId) ? { ...it, transcript: a.transcripts.get(it.callId) } : it));
  const cost = { sttRub: Math.round(a.cost.sttRub * 100) / 100, sttUsd: a.cost.sttUsd, llmUsd: Math.round(a.cost.llmUsd * 10_000) / 10_000, llmRub: Math.round(a.cost.llmRub * 100) / 100 };
  out(`\n${a.noteText ?? `Делового общения нет: ${a.summary.summary}`}`);
  if (a.truncated.length) out(`(лента сокращена: ${a.truncated.join('; ')})`);
  out(`\nСтоимость: расшифровка ${cost.sttRub} ₽${cost.sttUsd ? ` + $${cost.sttUsd}` : ''}, итог моделью ${a.provider}:${a.model} $${cost.llmUsd} ≈ ${cost.llmRub} ₽ (вход ${a.cost.llmInputTokens} / выход ${a.cost.llmOutputTokens} токенов, попыток ${a.attempts}); звонков ${a.summary.counts.calls} (${mmss(a.summary.totalCallDuration)})`);
  if (!o.post) {
    out('\nБез --post: в amoCRM и таблицы итогов ничего не записано.');
    return { ...base, noteText: a.noteText, posted: null, cost };
  }
  const posted = await persistGroup(deps, o.accountId, s, amo, a);
  out(posted.noteId ? `\nПримечание ${posted.noteId} записано в сделку ${o.leadId}; итог ${posted.summaryId} сохранён.` : `\nИтог ${posted.summaryId} сохранён без примечания (${a.noteText ? 'примечания выключены в настройках' : 'делового общения нет'}).`);
  return { ...base, noteText: a.noteText, posted, cost };
}

export { formatDayNote };
