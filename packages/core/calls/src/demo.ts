import { mmss } from './day-analyze.ts';
import { analyzeGroup, dayLabel, formatDayNote, mskDay, persistGroup, type Group } from './day-summary.ts';
import type { CallsDeps } from './deps.ts';
import { downloadCall } from './job.ts';
import { amoRaw, fetchEntityCallNotes, leadContactIds, parseCallNote, type AmoRaw, type ParsedCallNote } from './notes.ts';
import type { CallStt, CallTranscript, SttProviderName } from './stt.ts';
import { transcribeCalls } from './transcribe.ts';

/**
 * RFD-AI-AGENT-CALLS-DEMO: итог по одной сделке в консоль. Звонки сделки и её контактов за день (по умолчанию — день последнего
 * звонка с записью), скачивание, расшифровка асинхронным SpeechKit с ожиданием до 5 минут, итог тем же кодом, что
 * calls-day-summary. Без post ничего не пишет в amo и в таблицы итогов (звонки и расшифровки — в calls, чтобы не
 * расшифровывать повторно); с post — публикует примечание и сохраняет итог с защитой от дублей.
 */

export interface DemoOptions {
  accountId: number;
  leadId: number;
  /** ГГГГ-ММ-ДД по Москве; нет — день последнего звонка с записью. */
  date?: string;
  post?: boolean;
  waitMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  amo?: AmoRaw;
  stt?: (preferred: SttProviderName) => CallStt | null;
  /** Вывод (console.log в команде). */
  out?: (line: string) => void;
}

export interface DemoResult {
  day: string;
  /** Звонков сделки за день с записью. */
  calls: number;
  transcribed: number;
  /** Не расшифровались за время ожидания или недоступны. */
  notReady: number;
  /** Уже были в итоге дня — повторно не публикуются. */
  alreadySummarized: number;
  noteText: string | null;
  posted: { summaryId: number; noteId: number | null } | null;
  cost: { sttRub: number; sttUsd: number; llmUsd: number; llmRub: number } | null;
}

const DEFAULT_WAIT_MS = 5 * 60_000;
const POLL_MS = 10_000;

export async function runCallsDemo(deps: CallsDeps, o: DemoOptions): Promise<DemoResult> {
  const out = o.out ?? (() => undefined);
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const all = await deps.settingsFor(o.accountId);
  const s = all.calls;
  const account = await deps.accounts.get(o.accountId);
  if (!account || account.uninstalledAt) throw new Error(`Аккаунт ${o.accountId} не подключён`);
  const amo = o.amo ?? amoRaw(account.accountDomain, () => deps.tokenService.getAccessToken(o.accountId), deps.fetch);

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
  if (!parsed.length) {
    out(`Сделка ${o.leadId}: звонков с записью нет (контактов ${contacts.length})`);
    return { day: o.date ?? '', calls: 0, transcribed: 0, notReady: 0, alreadySummarized: 0, noteText: null, posted: null, cost: null };
  }
  const day = o.date ?? mskDay(parsed.reduce((m, c) => (c.calledAt > m.calledAt ? c : m)).calledAt);
  const dayCalls = parsed.filter((c) => mskDay(c.calledAt) === day && c.durationSec >= s.minDurationSec);
  out(`Сделка ${o.leadId}, контактов ${contacts.length}, звонков с записью всего ${parsed.length}; за ${dayLabel(day)} не короче ${s.minDurationSec} с — ${dayCalls.length}`);
  if (!dayCalls.length) return { day, calls: 0, transcribed: 0, notReady: 0, alreadySummarized: 0, noteText: null, posted: null, cost: null };

  // В базу (дубли не вставляются), затем — что уже есть.
  await deps.calls.insertNew(o.accountId, dayCalls.map((c) => ({ ...c, leadId: o.leadId })), 'async');
  let rows = await deps.calls.byNoteIds(o.accountId, dayCalls.map((c) => c.noteId));
  const ids = rows.map((r) => r.id);

  // Скачать, что ещё не скачано; расшифровать с ожиданием.
  for (const r of rows) if (r.status === 'new' || (r.status === 'failed' && r.stage === 'download')) await downloadCall(deps, r, { sleep });
  const deadline = now().getTime() + (o.waitMs ?? DEFAULT_WAIT_MS);
  for (;;) {
    rows = await deps.calls.byNoteIds(o.accountId, dayCalls.map((c) => c.noteId));
    const todo = rows.filter((r) => r.status === 'downloaded' || (r.status === 'failed' && r.stage === 'transcribe'));
    if (!todo.length) break;
    await transcribeCalls(deps, o.accountId, s, { now, sleep, ids, inlineWaitMs: 60_000, ...(o.stt ? { stt: o.stt } : {}) });
    rows = await deps.calls.byNoteIds(o.accountId, dayCalls.map((c) => c.noteId));
    if (!rows.some((r) => r.status === 'downloaded') || now().getTime() >= deadline) break;
    await sleep(POLL_MS);
  }
  const ready = rows.filter((r) => r.transcript && !('pending' in r.transcript));
  const notReady = rows.filter((r) => !r.transcript || 'pending' in r.transcript);
  for (const r of notReady) out(`  звонок ${r.id} (${r.direction === 'in' ? 'вх' : 'исх'} ${r.phone}, ${r.calledAt.toISOString()}): ${r.status} — ${r.error ?? 'расшифровка ещё идёт'}`);
  const fresh = ready.filter((r) => r.daySummaryId === null);
  const already = ready.filter((r) => r.daySummaryId !== null);
  if (already.length) {
    const ids = [...new Set(already.map((r) => r.daySummaryId))];
    for (const id of ids) {
      const d = await deps.days.get(o.accountId, id as number);
      if (d) out(`Итог ${d.id} за ${dayLabel(d.day)} уже есть${d.noteId ? ` (примечание ${d.noteId})` : ' (без примечания)'}:\n${d.noteText ?? formatDayNote(d.day, d.summary, [])}`);
    }
  }
  const base: DemoResult = { day, calls: rows.length, transcribed: ready.length, notReady: notReady.length, alreadySummarized: already.length, noteText: null, posted: null, cost: null };
  if (!fresh.length) {
    out(already.length ? 'Новых звонков для итога нет.' : 'Расшифрованных звонков нет — итог не считается.');
    return base;
  }

  const group: Group = { key: `lead:${o.leadId}:${day}`, leadId: o.leadId, contactId: null, day, calls: fresh };
  const a = await analyzeGroup(deps, o.accountId, group);
  // Реплики с ролями — первые 20 по всем звонкам.
  let shown = 0;
  for (const c of fresh) {
    const t = a.transcripts.get(c.id) as CallTranscript;
    out(`\nЗвонок ${c.id}: ${c.direction === 'in' ? 'входящий' : 'исходящий'} ${c.phone}, ${c.calledAt.toISOString()}, ${mmss(c.durationSec)}, ${t.provider}/${t.mode}${a.business.includes(c) ? '' : ' — без делового содержания'}`);
    for (const seg of t.segments) {
      if (shown >= 20) break;
      out(`  [${seg.startMs === null ? '—:——' : mmss(seg.startMs / 1000)}] ${seg.role === 'manager' ? 'Менеджер' : seg.role === 'client' ? 'Клиент' : `говорящий ${seg.speaker ?? '?'}`}: ${seg.text}`);
      shown++;
    }
  }
  const cost = { sttRub: Math.round(a.cost.sttRub * 100) / 100, sttUsd: a.cost.sttUsd, llmUsd: Math.round(a.cost.llmUsd * 10_000) / 10_000, llmRub: Math.round(a.cost.llmRub * 100) / 100 };
  out(`\n${a.noteText ?? `Деловых звонков нет: ${a.summary.summary}`}`);
  out(`\nСтоимость: расшифровка ${cost.sttRub} ₽${cost.sttUsd ? ` + $${cost.sttUsd}` : ''}, итог моделью ${a.provider}:${a.model} $${cost.llmUsd} ≈ ${cost.llmRub} ₽ (попыток ${a.attempts})`);
  if (!o.post) {
    out('\nБез --post: в amoCRM и таблицы итогов ничего не записано.');
    return { ...base, noteText: a.noteText, posted: null, cost };
  }
  const posted = await persistGroup(deps, o.accountId, s, amo, a);
  out(posted.noteId ? `\nПримечание ${posted.noteId} записано в сделку ${o.leadId}; итог ${posted.summaryId} сохранён.` : `\nИтог ${posted.summaryId} сохранён без примечания (${a.noteText ? 'примечания выключены в настройках' : 'деловых звонков нет'}).`);
  return { ...base, noteText: a.noteText, posted, cost };
}
