import { unlink } from 'node:fs/promises';
import { costOfUsage } from '@core/llm';
import { addDays, mskDay, runDaySummary, type DaySummaryOptions, type DaySummaryResult } from './day-summary.ts';
import type { CallsDeps, CallsSettings } from './deps.ts';
import { errorText } from './errors.ts';
import { callFileRel, downloadRecord, RecordUnavailableError, resolveCallPath, saveRecordFile } from './download.ts';
import { CALL_ERROR_KIND, CALL_FETCH_KIND } from './kinds.ts';
import { amoRaw, fetchCallNotes, parseCallNote, recordHostAllowed, type AmoRaw, type CallEntity, type ParsedCallNote } from './notes.ts';
import type { CallRow } from './repo.ts';
import { OPENAI_STT_USD_PER_MIN, SPEECHKIT_RUB_PER_MIN, type SttMode } from './stt.ts';
import { RETRY_FAILED_AFTER_MS, transcribeCalls, type TranscribeOptions, type TranscribeResult } from './transcribe.ts';

/**
 * RFD-AI-AGENT-CALLS-RETAIL, п. 1: плановый опрос amoCRM (calls-poll, раз в 10 минут) — примечания-звонки контактов и
 * сделок с отметки последнего сбора, дедупликация, привязка к сделке воронки «Двери», скачивание MP3 на том, расшифровка
 * (не больше 2 одновременно), удаление MP3 по сроку. Итог дня — отдельное задание (day-summary.ts).
 */

export const CALLS_QUEUE = 'calls';
export const CALLS_POLL_JOB = 'calls-poll';
export const CALLS_POLL_EVERY_MS = 10 * 60_000;
export const CALLS_DAY_JOB = 'calls-day-summary';
/** Проверка времени запуска итога дня — раз в 5 минут; запуск, когда по Москве наступило calls.daySummaryTime и сегодня ещё не запускали. */
export const CALLS_DAY_CHECK_EVERY_MS = 5 * 60_000;
/** Отметка запуска итога дня в calls_sync. */
export const DAY_SYNC_ENTITY = 'day_summary';

const DOWNLOADS_PER_RUN = 30;
const FIRST_RUN_OVERLAP_MS = 5 * 60_000;
/** Закрытые этапы amo: 142 — успешно реализовано, 143 — закрыто и не реализовано. */
const CLOSED_STATUSES = new Set([142, 143]);

export interface CallsPollOptions {
  /** Догрузка («--days N»): примечания за столько дней назад, независимо от отметки. */
  sinceDays?: number;
  /** Режим SpeechKit для новых звонков; по умолчанию deferred при догрузке, иначе async. */
  sttMode?: SttMode;
  maxDownloads?: number;
  /** false — только собрать и скачать (догрузка: расшифровку делает плановый опрос). */
  transcribe?: boolean;
  transcribeOptions?: TranscribeOptions;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  amo?: AmoRaw;
}

export interface CallsPollResult {
  accountId: number;
  enabled: boolean;
  found: number;
  skippedShort: number;
  noLink: number;
  inserted: number;
  downloaded: number;
  unavailable: number;
  failed: number;
  filesDeleted: number;
  errors: string[];
  transcribed: TranscribeResult | null;
}

const emptyResult = (accountId: number, enabled: boolean): CallsPollResult => ({ accountId, enabled, found: 0, skippedShort: 0, noLink: 0, inserted: 0, downloaded: 0, unavailable: 0, failed: 0, filesDeleted: 0, errors: [], transcribed: null });

export async function runCallsPollAll(deps: CallsDeps, opts: CallsPollOptions = {}): Promise<CallsPollResult[]> {
  const out: CallsPollResult[] = [];
  for (const accountId of await deps.accountIds()) {
    try {
      out.push(await runCallsPoll(deps, accountId, opts));
    } catch (err) {
      out.push({ ...emptyResult(accountId, true), errors: [(err as Error).message] });
      await deps.journal.add({ accountId, kind: CALL_ERROR_KIND, summary: `Звонки: опрос не выполнен — ${(err as Error).message}`, details: { error: (err as Error).message } }).catch(() => undefined);
    }
  }
  return out;
}

/** Опрос одного аккаунта: сбор → вставка новых → скачивание → расшифровка → удаление старых MP3 → журнал. */
export async function runCallsPoll(deps: CallsDeps, accountId: number, opts: CallsPollOptions = {}): Promise<CallsPollResult> {
  const now = opts.now ?? (() => new Date());
  const s = (await deps.settingsFor(accountId)).calls;
  const r = emptyResult(accountId, s.callsEnabled);
  if (!s.callsEnabled) return r;
  const account = await deps.accounts.get(accountId);
  if (!account || account.uninstalledAt) throw new Error(`Аккаунт ${accountId} не подключён`);
  const amo = opts.amo ?? amoRaw(account.accountDomain, () => deps.tokenService.getAccessToken(accountId), deps.fetch);

  const insertedCalls: { id: number; leadId: number | null }[] = [];
  for (const entity of ['contact', 'lead'] as const) {
    try {
      const got = await collectEntity(deps, amo, accountId, entity, s, now(), opts.sinceDays, opts.sttMode ?? (opts.sinceDays ? 'deferred' : 'async'));
      r.found += got.found;
      r.skippedShort += got.skippedShort;
      r.noLink += got.noLink;
      r.inserted += got.inserted.length;
      insertedCalls.push(...got.inserted);
    } catch (err) {
      const msg = `${entity === 'contact' ? 'контакты' : 'сделки'}: ${(err as Error).message}`;
      r.errors.push(msg);
      const prev = await deps.calls.getSync(accountId, entity);
      if (prev) await deps.calls.setSync(accountId, entity, { lastUpdatedAt: prev.lastUpdatedAt, lastError: msg });
    }
  }

  const retryBefore = new Date(now().getTime() - RETRY_FAILED_AFTER_MS);
  const maxDownloads = opts.maxDownloads ?? DOWNLOADS_PER_RUN;
  const queue: CallRow[] = [...(await deps.calls.listByStatus(accountId, 'new', maxDownloads)), ...(await deps.calls.listFailedAt(accountId, 'download', maxDownloads)).filter((c) => c.updatedAt < retryBefore)].slice(0, maxDownloads);
  for (const call of queue) {
    const res = await downloadCall(deps, call, opts);
    if (res === 'downloaded') r.downloaded++;
    else if (res === 'unavailable') r.unavailable++;
    else r.failed++;
  }

  if (opts.transcribe !== false) r.transcribed = await transcribeCalls(deps, accountId, s, { now, ...(opts.sleep ? { sleep: opts.sleep } : {}), ...opts.transcribeOptions });
  r.filesDeleted = await deleteExpiredFiles(deps, accountId, s, now());

  const t = r.transcribed;
  if (r.inserted || r.downloaded || r.unavailable || r.failed || r.errors.length || (t && (t.transcribed || t.failed || t.unavailable))) {
    const parts = [`найдено ${r.found}`, `новых ${r.inserted}`];
    if (r.skippedShort) parts.push(`коротких и пропущенных ${r.skippedShort}`);
    if (r.noLink) parts.push(`без записи ${r.noLink}`);
    if (r.downloaded) parts.push(`скачано ${r.downloaded}`);
    if (r.unavailable) parts.push(`недоступно ${r.unavailable}`);
    if (r.failed) parts.push(`ошибок скачивания ${r.failed}`);
    if (t?.transcribed) parts.push(`расшифровано ${t.transcribed}`);
    if (t?.pending) parts.push(`расшифровка идёт ${t.pending}`);
    if (t?.unavailable) parts.push(`не расшифровать ${t.unavailable}`);
    if (t?.failed) parts.push(`ошибок расшифровки ${t.failed}`);
    if (r.filesDeleted) parts.push(`удалено старых MP3 ${r.filesDeleted}`);
    if (r.errors.length) parts.push(`сбой сбора: ${r.errors.join('; ')}`);
    await deps.journal.add({ accountId, kind: CALL_FETCH_KIND, summary: `Звонки: ${parts.join(', ')}`, details: { ...r, inserted: insertedCalls.map((c) => c.id), leads: [...new Set(insertedCalls.map((c) => c.leadId).filter((x): x is number => x !== null))] } });
  }
  return r;
}

async function collectEntity(deps: CallsDeps, amo: AmoRaw, accountId: number, entity: CallEntity, s: CallsSettings, now: Date, sinceDays: number | undefined, sttMode: SttMode) {
  const sync = await deps.calls.getSync(accountId, entity);
  // Первый опрос — с момента включения: историю не тянем; догрузка за N дней — только командой.
  const since = sinceDays ? new Date(now.getTime() - sinceDays * 86_400_000) : (sync?.lastUpdatedAt ?? new Date(now.getTime() - FIRST_RUN_OVERLAP_MS));
  const { notes, truncated } = await fetchCallNotes(amo, entity, since);
  let skippedShort = 0;
  let noLink = 0;
  const parsed: ParsedCallNote[] = [];
  for (const n of notes) {
    const c = parseCallNote(n, entity);
    if (!c) {
      noLink++;
      continue;
    }
    if (c.durationSec < s.minDurationSec) {
      skippedShort++;
      continue;
    }
    parsed.push(c);
  }
  const leadCache = new Map<number, number | null>();
  const rows: (ParsedCallNote & { leadId: number | null })[] = [];
  for (const c of parsed) rows.push({ ...c, leadId: c.entity === 'lead' ? c.entityId : await leadOfContact(amo, c.entityId, s.pipelineId, leadCache) });
  const ids = await deps.calls.insertNew(accountId, rows, sttMode);
  const inserted = ids.flatMap((id, i) => (id === null ? [] : [{ id, leadId: rows[i]?.leadId ?? null }]));
  const maxUpdated = notes.reduce((m, n) => Math.max(m, (n.updated_at || n.created_at) * 1000), 0);
  const lastUpdatedAt = truncated && maxUpdated ? new Date(maxUpdated) : new Date(Math.max(maxUpdated, now.getTime() - FIRST_RUN_OVERLAP_MS));
  await deps.calls.setSync(accountId, entity, { lastUpdatedAt, lastError: null });
  return { found: notes.length, skippedShort, noLink, inserted };
}

/** Открытая сделка контакта в воронке «Двери» (самая свежая по updated_at); нет — звонок без сделки, итог пойдёт в контакт. */
export async function leadOfContact(amo: AmoRaw, contactId: number, pipelineId: number, cache?: Map<number, number | null>): Promise<number | null> {
  if (cache?.has(contactId)) return cache.get(contactId) ?? null;
  let result: number | null = null;
  try {
    const contact = await amo.get<{ _embedded?: { leads?: { id: number }[] } }>(`/api/v4/contacts/${contactId}?with=leads`);
    const ids = (contact?._embedded?.leads ?? []).map((l) => l.id).slice(0, 50);
    if (ids.length) {
      const q = ids.map((id) => `filter[id][]=${id}`).join('&');
      const res = await amo.get<{ _embedded?: { leads?: { id: number; status_id: number; pipeline_id: number; updated_at: number; closed_at?: number | null }[] } }>(`/api/v4/leads?${q}`);
      const open = (res?._embedded?.leads ?? []).filter((l) => !CLOSED_STATUSES.has(l.status_id) && !l.closed_at && l.pipeline_id === pipelineId);
      open.sort((a, b) => b.updated_at - a.updated_at);
      result = open[0]?.id ?? null;
    }
  } catch {
    result = null;
  }
  cache?.set(contactId, result);
  return result;
}

/** Скачать запись одного звонка: downloaded / unavailable (конечный) / failed (повтор при опросе). */
export async function downloadCall(deps: CallsDeps, call: CallRow, opts: Pick<CallsPollOptions, 'sleep'> = {}): Promise<'downloaded' | 'unavailable' | 'failed'> {
  try {
    const rec = await downloadRecord(call.link, { fetch: deps.fetch, ...(opts.sleep ? { sleep: opts.sleep } : {}) });
    const rel = callFileRel(call.accountId, call.id, call.recordKey, call.calledAt);
    await saveRecordFile(deps.filesRoot, rel, rec.bytes);
    await deps.calls.setDownloaded(call.id, { filePath: rel, fileBytes: rec.bytes.byteLength, fileMime: rec.mime });
    return 'downloaded';
  } catch (err) {
    const msg = (err as Error).message;
    const lead = call.leadId ? { leadId: call.leadId } : {};
    if (err instanceof RecordUnavailableError) {
      await deps.calls.setUnavailable(call.id, msg);
      await deps.journal.add({ accountId: call.accountId, ...lead, kind: CALL_ERROR_KIND, summary: `Звонок ${call.id} (${call.direction === 'in' ? 'входящий' : 'исходящий'} ${call.phone}, ${call.calledAt.toISOString()}): запись недоступна — ${msg}`, details: { callId: call.id, noteId: call.noteId, link: call.link, status: 'unavailable', error: msg } });
      return 'unavailable';
    }
    await deps.calls.setFailed(call.id, 'download', msg);
    await deps.journal.add({ accountId: call.accountId, ...lead, kind: CALL_ERROR_KIND, summary: `Звонок ${call.id}: запись не скачана — ${msg}; повтор при следующем опросе`, details: { callId: call.id, noteId: call.noteId, link: call.link, status: 'failed', stage: 'download', error: msg } });
    return 'failed';
  }
}

async function deleteExpiredFiles(deps: CallsDeps, accountId: number, s: CallsSettings, now: Date): Promise<number> {
  const before = new Date(now.getTime() - s.keepMp3Days * 86_400_000);
  let n = 0;
  for (const f of await deps.calls.filesOlderThan(accountId, before)) {
    if (f.filePath) await unlink(resolveCallPath(deps.filesRoot, f.filePath)).catch(() => undefined);
    await deps.calls.markFileDeleted(f.id);
    n++;
  }
  return n;
}

/** Пора ли запускать итог дня: по Москве наступило calls.daySummaryTime и сегодня его ещё не запускали. */
/**
 * Плановый запуск итога дня (проверка раз в 5 минут): только когда наступило calls.daySummaryTime и сегодня ещё не
 * запускали — один раз в день (RFD-AI-AGENT-CALLS-DAY: до этого проверка запускала итог при каждом проходе, и звонки,
 * оставшиеся без итога, публиковались в любое время). Вне времени — ничего не делает (null). Время запуска пишется в
 * calls_sync до работы, чтобы долгий итог не запустился второй раз; ошибка — в lastError.
 */
export async function runDaySummaryIfDue(deps: CallsDeps, accountId: number, opts: DaySummaryOptions = {}): Promise<DaySummaryResult | null> {
  const s = (await deps.settingsFor(accountId)).calls;
  if (!s.callsEnabled) return null;
  const now = (opts.now ?? (() => new Date()))();
  const sync = await deps.calls.getSync(accountId, DAY_SYNC_ENTITY);
  if (!daySummaryDue(s.daySummaryTime, sync?.lastRunAt ?? null, now)) return null;
  // Догон: дни после последнего выполненного запуска (простой воркера) — каждый своим итогом; первый запуск — только сегодня.
  const fromDay = sync?.lastRunAt ? addDays(mskDay(sync.lastRunAt), 1) : mskDay(now);
  await deps.calls.setSync(accountId, DAY_SYNC_ENTITY, { lastUpdatedAt: now, lastError: null });
  try {
    return await runDaySummary(deps, accountId, { fromDay, ...opts });
  } catch (err) {
    await deps.calls.setSync(accountId, DAY_SYNC_ENTITY, { lastUpdatedAt: now, lastError: errorText(err) }).catch(() => undefined);
    throw err;
  }
}

export function daySummaryDue(time: string, lastRunAt: Date | null, now: Date): boolean {
  const today = mskDay(now);
  if (lastRunAt && mskDay(lastRunAt) === today) return false;
  const hm = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hour12: false }).format(now).replace(/^24/, '00');
  return hm >= time;
}

export interface BackfillPreview {
  accountId: number;
  days: number;
  found: number;
  newCalls: number;
  newMinutes: number;
  shortOrNoLink: number;
  /** Будущих примечаний: пар «сделка (контакт) + день» среди новых звонков. */
  futureNotes: number;
  estimate: { sttRub: number; llmUsd: number; llmRub: number; totalRub: number; model: string };
}

const LLM_INPUT_TOKENS_PER_MIN = 230;
const LLM_INPUT_TOKENS_BASE = 1200;
const LLM_OUTPUT_TOKENS = 450;

/** Догрузка (п. 5): сколько звонков за период, минут, будущих примечаний и во что обойдётся — без записи в базу. */
export async function previewCallsBackfill(deps: CallsDeps, accountId: number, days: number, opts: { now?: () => Date; amo?: AmoRaw } = {}): Promise<BackfillPreview> {
  const now = opts.now ?? (() => new Date());
  const all = await deps.settingsFor(accountId);
  const s = all.calls;
  const account = await deps.accounts.get(accountId);
  if (!account || account.uninstalledAt) throw new Error(`Аккаунт ${accountId} не подключён`);
  const amo = opts.amo ?? amoRaw(account.accountDomain, () => deps.tokenService.getAccessToken(accountId), deps.fetch);
  const since = new Date(now().getTime() - days * 86_400_000);
  let found = 0;
  let shortOrNoLink = 0;
  const candidates: ParsedCallNote[] = [];
  for (const entity of ['contact', 'lead'] as const) {
    const { notes } = await fetchCallNotes(amo, entity, since);
    found += notes.length;
    for (const n of notes) {
      const c = parseCallNote(n, entity);
      if (!c || c.durationSec < s.minDurationSec || !recordHostAllowed(c.link)) {
        shortOrNoLink++;
        continue;
      }
      candidates.push(c);
    }
  }
  const existing = await deps.calls.existingNoteIds(accountId, candidates.map((c) => c.noteId));
  const fresh = candidates.filter((c) => !existing.has(c.noteId));
  const minutes = fresh.reduce((m, c) => m + Math.ceil(c.durationSec / 15) * 15, 0) / 60;
  const cache = new Map<number, number | null>();
  const groups = new Set<string>();
  for (const c of fresh) {
    const leadId = c.entity === 'lead' ? c.entityId : await leadOfContact(amo, c.entityId, s.pipelineId, cache);
    groups.add(`${leadId !== null ? `lead:${leadId}` : `contact:${c.entityId}`}:${mskDay(c.calledAt)}`);
  }
  const llm = await deps.llmFor(accountId);
  const hasSpeechKit = Boolean(deps.keys.speechkit);
  const sttRub = hasSpeechKit ? minutes * SPEECHKIT_RUB_PER_MIN.deferred : 0;
  const sttUsd = hasSpeechKit ? 0 : minutes * OPENAI_STT_USD_PER_MIN;
  const llmUsdOnly = llm ? fresh.reduce((usd, c) => usd + costOfUsage(llm.route.primary, { inputTokens: Math.round((c.durationSec / 60) * LLM_INPUT_TOKENS_PER_MIN), outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 }, llm.pricing).usd, 0) + groups.size * costOfUsage(llm.route.primary, { inputTokens: LLM_INPUT_TOKENS_BASE, outputTokens: LLM_OUTPUT_TOKENS, cachedInputTokens: 0, cacheWriteTokens: 0 }, llm.pricing).usd : 0;
  const rate = llm?.usdRubRate ?? all.billing.usdRubRate;
  const llmUsd = llmUsdOnly + sttUsd;
  return {
    accountId,
    days,
    found,
    newCalls: fresh.length,
    newMinutes: Math.round(minutes * 10) / 10,
    shortOrNoLink,
    futureNotes: groups.size,
    estimate: { sttRub: Math.round(sttRub * 100) / 100, llmUsd: Math.round(llmUsd * 10_000) / 10_000, llmRub: Math.round(llmUsd * rate * 100) / 100, totalRub: Math.round((sttRub + llmUsd * rate) * 100) / 100, model: llm ? `${llm.route.primary.provider}:${llm.route.primary.model}` : 'ключа модели нет' },
  };
}
