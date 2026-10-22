import { unlink } from 'node:fs/promises';
import { costOfUsage } from '@core/llm';
import type { OptCore } from '../deps.ts';
import { resolveKpPath } from '../paths.ts';
import { callsSettingsOf, resolveOptRoute, type CallsSettings } from '../settings.ts';
import { callFileRel, downloadRecord, RecordUnavailableError, saveRecordFile } from './download.ts';
import { CALL_ERROR_KIND, CALL_FETCH_KIND } from './kinds.ts';
import { amoRaw, fetchCallNotes, parseCallNote, recordHostAllowed, type AmoRaw, type CallEntity, type ParsedCallNote } from './notes.ts';
import { processCalls, type CallsProcessCore, type ProcessOptions, type ProcessResult } from './process.ts';
import type { CallRow } from './repo.ts';
import { OPENAI_STT_USD_PER_MIN, SPEECHKIT_RUB_PER_MIN, type SttMode } from './stt.ts';

/**
 * RFD-AI-AGENT-OPT-CALLS, этап 1: плановый опрос amoCRM (раз в 10 мин) — примечания-звонки контактов и сделок с
 * отметки последнего сбора, дедупликация по примечанию и ключу записи, привязка к сделке, скачивание MP3 на том,
 * удаление MP3 по сроку хранения. Расшифровка и разбор — этапы 2–3, они берут звонки со статусом downloaded.
 */

export const CALLS_QUEUE = 'calls-poll';
export const CALLS_POLL_JOB = 'poll';
export const CALLS_POLL_EVERY_MS = 10 * 60_000;

/** Скачиваний за один опрос аккаунта: записи по 1–5 МБ, 10 минут между опросами — хватает с запасом. */
const DOWNLOADS_PER_RUN = 30;
/** Повтор скачивания после ошибки (failed / download) — не раньше чем через столько минут, чтобы не долбить ВАТС. */
const RETRY_FAILED_AFTER_MS = 30 * 60_000;
/** Отметка первого сбора — чуть назад, чтобы не потерять звонок, оформленный в amo в минуту включения. */
const FIRST_RUN_OVERLAP_MS = 5 * 60_000;

export type CallsCore = Pick<OptCore, 'calls' | 'journal' | 'settings' | 'accounts' | 'tokenService' | 'fetch' | 'filesRoot' | 'ai' | 'env' | 'alerter'>;

export interface CallsPollOptions {
  /** Разовый догон истории («Загрузить историю»): примечания за столько дней назад, независимо от отметки. */
  sinceDays?: number;
  /** Режим SpeechKit для новых звонков этого опроса; по умолчанию deferred при догоне, иначе async. */
  sttMode?: SttMode;
  /** Скачиваний за опрос (догрузка ставит больше). */
  maxDownloads?: number;
  /** false — только собрать и скачать (догрузка: обработку делает плановый опрос воркера). */
  process?: boolean;
  processOptions?: ProcessOptions;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Клиент amo в тестах. */
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
  /** Этапы 2–3: расшифровка, разбор, примечания за этот опрос. */
  processed: ProcessResult | null;
}

/** Все подключённые аккаунты с включённым разбором звонков — по одному. */
export async function runCallsPollAll(core: CallsCore, opts: CallsPollOptions = {}): Promise<CallsPollResult[]> {
  const out: CallsPollResult[] = [];
  for (const accountId of await core.calls.installedAccountIds()) {
    try {
      out.push(await runCallsPoll(core, accountId, opts));
    } catch (err) {
      out.push({ ...emptyResult(accountId, true), errors: [(err as Error).message] });
      await core.journal.add({ accountId, kind: CALL_ERROR_KIND, summary: `Звонки: опрос не выполнен — ${(err as Error).message}`, details: { error: (err as Error).message } }).catch(() => undefined);
    }
  }
  return out;
}

const emptyResult = (accountId: number, enabled: boolean): CallsPollResult => ({ accountId, enabled, found: 0, skippedShort: 0, noLink: 0, inserted: 0, downloaded: 0, unavailable: 0, failed: 0, filesDeleted: 0, errors: [], processed: null });

/** Опрос одного аккаунта: сбор → вставка новых → скачивание → удаление старых MP3 → журнал. */
export async function runCallsPoll(core: CallsCore, accountId: number, opts: CallsPollOptions = {}): Promise<CallsPollResult> {
  const now = opts.now ?? (() => new Date());
  const all = (await core.settings.get(accountId)).settings;
  const settings = callsSettingsOf(all);
  const r = emptyResult(accountId, settings.enabled);
  if (!settings.enabled) return r;
  const account = await core.accounts.get(accountId);
  if (!account || account.uninstalledAt) throw new Error(`Аккаунт ${accountId} не подключён к «Агенту опт»`);
  const amo = opts.amo ?? amoRaw(account.accountDomain, () => core.tokenService.getAccessToken(accountId), core.fetch);

  const insertedCalls: { id: number; leadId: number | null; link: string }[] = [];
  for (const entity of ['contact', 'lead'] as const) {
    try {
      const got = await collectEntity(core, amo, accountId, entity, settings, now(), opts.sinceDays, opts.sttMode ?? (opts.sinceDays ? 'deferred' : 'async'));
      r.found += got.found;
      r.skippedShort += got.skippedShort;
      r.noLink += got.noLink;
      r.inserted += got.inserted.length;
      insertedCalls.push(...got.inserted);
    } catch (err) {
      const msg = `${entity === 'contact' ? 'контакты' : 'сделки'}: ${(err as Error).message}`;
      r.errors.push(msg);
      const prev = await core.calls.getSync(accountId, entity);
      if (prev) await core.calls.setSync(accountId, entity, { lastUpdatedAt: prev.lastUpdatedAt, lastError: msg });
    }
  }

  // Скачивание: новые и упавшие раньше (не чаще раза в полчаса), не больше DOWNLOADS_PER_RUN за опрос.
  const retryBefore = new Date(now().getTime() - RETRY_FAILED_AFTER_MS);
  const maxDownloads = opts.maxDownloads ?? DOWNLOADS_PER_RUN;
  const queue: CallRow[] = [...(await core.calls.listByStatus(accountId, 'new', maxDownloads)), ...(await core.calls.listFailedAt(accountId, 'download', maxDownloads)).filter((c) => c.updatedAt < retryBefore)].slice(0, maxDownloads);
  for (const call of queue) {
    const res = await downloadOne(core, call, opts);
    if (res === 'downloaded') r.downloaded++;
    else if (res === 'unavailable') r.unavailable++;
    else r.failed++;
  }

  // Этапы 2–3: расшифровка → разбор → примечание, не больше 2 звонков одновременно; догрузка (process: false) это пропускает.
  if (opts.process !== false) r.processed = await processCalls(core as CallsProcessCore, accountId, all, { now, ...(opts.sleep ? { sleep: opts.sleep } : {}), ...(opts.amo ? { amo: opts.amo } : {}), ...opts.processOptions });

  r.filesDeleted = await deleteExpiredFiles(core, accountId, settings, now());

  const p = r.processed;
  if (r.inserted || r.downloaded || r.unavailable || r.failed || r.errors.length || (p && (p.transcribed || p.analyzed || p.posted || p.failed || p.unavailable))) {
    const parts = [`найдено ${r.found}`, `новых ${r.inserted}`];
    if (r.skippedShort) parts.push(`коротких и пропущенных ${r.skippedShort}`);
    if (r.noLink) parts.push(`без записи ${r.noLink}`);
    if (r.downloaded) parts.push(`скачано ${r.downloaded}`);
    if (r.unavailable) parts.push(`недоступно ${r.unavailable}`);
    if (r.failed) parts.push(`ошибок скачивания ${r.failed}`);
    if (p?.transcribed) parts.push(`расшифровано ${p.transcribed}`);
    if (p?.pending) parts.push(`расшифровка идёт ${p.pending}`);
    if (p?.analyzed) parts.push(`разобрано ${p.analyzed}`);
    if (p?.posted) parts.push(`примечаний ${p.posted}`);
    if (p?.skipped) parts.push(`без примечания ${p.skipped}`);
    if (p?.unavailable) parts.push(`не расшифровать ${p.unavailable}`);
    if (p?.failed) parts.push(`ошибок обработки ${p.failed}`);
    if (r.filesDeleted) parts.push(`удалено старых MP3 ${r.filesDeleted}`);
    if (r.errors.length) parts.push(`сбой сбора: ${r.errors.join('; ')}`);
    await core.journal.add({ accountId, kind: CALL_FETCH_KIND, summary: `Звонки: ${parts.join(', ')}`, details: { ...r, inserted: insertedCalls.map((c) => c.id), leads: [...new Set(insertedCalls.map((c) => c.leadId).filter((x): x is number => x !== null))] } });
  }
  return r;
}

async function collectEntity(core: CallsCore, amo: AmoRaw, accountId: number, entity: CallEntity, s: CallsSettings, now: Date, sinceDays: number | undefined, sttMode: SttMode) {
  const sync = await core.calls.getSync(accountId, entity);
  // Первый опрос — с момента включения (ТЗ п. 9): историю не тянем; догон за N дней — только по кнопке.
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
  for (const c of parsed) {
    rows.push({ ...c, leadId: c.entity === 'lead' ? c.entityId : await leadOfContact(amo, c.entityId, s.pipelineIds, leadCache) });
  }
  const ids = await core.calls.insertNew(accountId, rows, sttMode);
  const inserted = ids.flatMap((id, i) => (id === null ? [] : [{ id, leadId: rows[i]?.leadId ?? null, link: rows[i]?.link ?? '' }]));
  // Отметка: самый поздний updated_at среди полученных (при обрыве по лимиту страниц остаток придёт в следующий раз);
  // всё прочитано — не раньше «сейчас минус запас», чтобы не перечитывать одно и то же каждые 10 минут.
  const maxUpdated = notes.reduce((m, n) => Math.max(m, (n.updated_at || n.created_at) * 1000), 0);
  const lastUpdatedAt = truncated && maxUpdated ? new Date(maxUpdated) : new Date(Math.max(maxUpdated, now.getTime() - FIRST_RUN_OVERLAP_MS));
  await core.calls.setSync(accountId, entity, { lastUpdatedAt, lastError: null });
  return { found: notes.length, skippedShort, noLink, inserted };
}

interface LeadBrief {
  id: number;
  status_id: number;
  pipeline_id: number;
  updated_at: number;
  closed_at?: number | null;
}

/** Закрытые этапы amo: 142 — успешно реализовано, 143 — закрыто и не реализовано. */
const CLOSED_STATUSES = new Set([142, 143]);

/** Открытая сделка контакта в воронках из настроек (пусто — любые); несколько — самая свежая по updated_at. */
export async function leadOfContact(amo: AmoRaw, contactId: number, pipelineIds: number[], cache?: Map<number, number | null>): Promise<number | null> {
  if (cache?.has(contactId)) return cache.get(contactId) ?? null;
  let result: number | null = null;
  try {
    const contact = await amo.get<{ _embedded?: { leads?: { id: number }[] } }>(`/api/v4/contacts/${contactId}?with=leads`);
    const ids = (contact?._embedded?.leads ?? []).map((l) => l.id).slice(0, 50);
    if (ids.length) {
      const q = ids.map((id) => `filter[id][]=${id}`).join('&');
      const res = await amo.get<{ _embedded?: { leads?: LeadBrief[] } }>(`/api/v4/leads?${q}`);
      const open = (res?._embedded?.leads ?? []).filter((l) => !CLOSED_STATUSES.has(l.status_id) && !l.closed_at && (!pipelineIds.length || pipelineIds.includes(l.pipeline_id)));
      open.sort((a, b) => b.updated_at - a.updated_at);
      result = open[0]?.id ?? null;
    }
  } catch {
    // Контакт удалён или amo не ответил — звонок остаётся без сделки, разбор пойдёт в контакт.
    result = null;
  }
  cache?.set(contactId, result);
  return result;
}

async function downloadOne(core: CallsCore, call: CallRow, opts: CallsPollOptions): Promise<'downloaded' | 'unavailable' | 'failed'> {
  try {
    const rec = await downloadRecord(call.link, { fetch: core.fetch, ...(opts.sleep ? { sleep: opts.sleep } : {}) });
    const rel = callFileRel(call.accountId, call.id, call.recordKey, call.calledAt);
    await saveRecordFile(core.filesRoot, rel, rec.bytes);
    await core.calls.setDownloaded(call.id, { filePath: rel, fileBytes: rec.bytes.byteLength, fileMime: rec.mime });
    return 'downloaded';
  } catch (err) {
    const msg = (err as Error).message;
    if (err instanceof RecordUnavailableError) {
      await core.calls.setUnavailable(call.id, msg);
      await core.journal.add({ accountId: call.accountId, ...(call.leadId ? { leadId: call.leadId } : {}), kind: CALL_ERROR_KIND, summary: `Звонок ${call.id} (${call.direction === 'in' ? 'входящий' : 'исходящий'} ${call.phone}, ${call.calledAt.toISOString()}): запись недоступна — ${msg}`, details: { callId: call.id, noteId: call.noteId, link: call.link, status: 'unavailable', error: msg } });
      return 'unavailable';
    }
    await core.calls.setFailed(call.id, 'download', msg);
    await core.journal.add({ accountId: call.accountId, ...(call.leadId ? { leadId: call.leadId } : {}), kind: CALL_ERROR_KIND, summary: `Звонок ${call.id}: запись не скачана — ${msg}; повтор при следующем опросе`, details: { callId: call.id, noteId: call.noteId, link: call.link, status: 'failed', stage: 'download', error: msg } });
    return 'failed';
  }
}

/** MP3 старше срока хранения — удалить с тома; текст и разбор в базе остаются. */
async function deleteExpiredFiles(core: CallsCore, accountId: number, s: CallsSettings, now: Date): Promise<number> {
  const before = new Date(now.getTime() - s.keepMp3Days * 86_400_000);
  let n = 0;
  for (const f of await core.calls.filesOlderThan(accountId, before)) {
    if (f.filePath) await unlink(resolveKpPath(core.filesRoot, f.filePath)).catch(() => undefined);
    await core.calls.markFileDeleted(f.id);
    n++;
  }
  return n;
}

export interface BackfillPreview {
  accountId: number;
  days: number;
  /** Примечаний-звонков за период, из них новых (нет в calls) с записью и не короче минимума. */
  found: number;
  newCalls: number;
  newMinutes: number;
  shortOrNoLink: number;
  estimate: { sttRub: number; llmUsd: number; llmRub: number; totalRub: number; model: string };
}

/** Оценка стоимости для одного разобранного звонка: ≈ 230 токенов входа на минуту + подсказка, ≈ 350 токенов ответа. */
const LLM_INPUT_TOKENS_PER_MIN = 230;
const LLM_INPUT_TOKENS_BASE = 900;
const LLM_OUTPUT_TOKENS = 350;

/** Догрузка (ТЗ этапов 2–3, п. 5): сколько звонков найдено за период и во что обойдётся расшифровка (отложенный режим) и разбор — без записи в базу. */
export async function previewCallsBackfill(core: CallsCore, accountId: number, days: number, opts: { now?: () => Date; amo?: AmoRaw } = {}): Promise<BackfillPreview> {
  const now = opts.now ?? (() => new Date());
  const all = (await core.settings.get(accountId)).settings;
  const s = callsSettingsOf(all);
  const account = await core.accounts.get(accountId);
  if (!account || account.uninstalledAt) throw new Error(`Аккаунт ${accountId} не подключён к «Агенту опт»`);
  const amo = opts.amo ?? amoRaw(account.accountDomain, () => core.tokenService.getAccessToken(accountId), core.fetch);
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
  const existing = await core.calls.existingNoteIds(accountId, candidates.map((c) => c.noteId));
  const fresh = candidates.filter((c) => !existing.has(c.noteId));
  const minutes = fresh.reduce((m, c) => m + Math.ceil(c.durationSec / 15) * 15, 0) / 60;
  const route = resolveOptRoute(all);
  const hasSpeechKit = Boolean(core.env.YANDEX_SPEECHKIT_API_KEY);
  const sttRub = hasSpeechKit ? minutes * SPEECHKIT_RUB_PER_MIN.deferred : 0;
  const sttUsd = hasSpeechKit ? 0 : minutes * OPENAI_STT_USD_PER_MIN;
  const llm = fresh.reduce((usd, c) => usd + costOfUsage(route.primary, { inputTokens: Math.round((c.durationSec / 60) * LLM_INPUT_TOKENS_PER_MIN) + LLM_INPUT_TOKENS_BASE, outputTokens: LLM_OUTPUT_TOKENS, cachedInputTokens: 0, cacheWriteTokens: 0 }, all.billing.pricing).usd, 0);
  const rate = all.billing.usdRubRate;
  const llmUsd = llm + sttUsd;
  return {
    accountId,
    days,
    found,
    newCalls: fresh.length,
    newMinutes: Math.round(minutes * 10) / 10,
    shortOrNoLink,
    estimate: { sttRub: Math.round(sttRub * 100) / 100, llmUsd: Math.round(llmUsd * 10_000) / 10_000, llmRub: Math.round(llmUsd * rate * 100) / 100, totalRub: Math.round((sttRub + llmUsd * rate) * 100) / 100, model: `${route.primary.provider}:${route.primary.model}` },
  };
}
