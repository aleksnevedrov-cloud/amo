import { unlink } from 'node:fs/promises';
import type { JournalKind } from '@core/db';
import type { OptCore } from '../deps.ts';
import { resolveKpPath } from '../paths.ts';
import { callsSettingsOf, type CallsSettings } from '../settings.ts';
import { callFileRel, downloadRecord, RecordUnavailableError, saveRecordFile } from './download.ts';
import { amoRaw, fetchCallNotes, parseCallNote, type AmoRaw, type CallEntity, type ParsedCallNote } from './notes.ts';
import type { CallRow } from './repo.ts';

/**
 * RFD-AI-AGENT-OPT-CALLS, этап 1: плановый опрос amoCRM (раз в 10 мин) — примечания-звонки контактов и сделок с
 * отметки последнего сбора, дедупликация по примечанию и ключу записи, привязка к сделке, скачивание MP3 на том,
 * удаление MP3 по сроку хранения. Расшифровка и разбор — этапы 2–3, они берут звонки со статусом downloaded.
 */

export const CALLS_QUEUE = 'calls-poll';
export const CALLS_POLL_JOB = 'poll';
export const CALLS_POLL_EVERY_MS = 10 * 60_000;

/** Виды записей журнала по звонкам; в общий JournalKind (packages/core) не добавляются — ядро не меняем. */
export const CALL_FETCH_KIND = 'call_fetch' as JournalKind;
export const CALL_ERROR_KIND = 'call_error' as JournalKind;

/** Скачиваний за один опрос аккаунта: записи по 1–5 МБ, 10 минут между опросами — хватает с запасом. */
const DOWNLOADS_PER_RUN = 30;
/** Повтор скачивания после ошибки (failed / download) — не раньше чем через столько минут, чтобы не долбить ВАТС. */
const RETRY_FAILED_AFTER_MS = 30 * 60_000;
/** Отметка первого сбора — чуть назад, чтобы не потерять звонок, оформленный в amo в минуту включения. */
const FIRST_RUN_OVERLAP_MS = 5 * 60_000;

export type CallsCore = Pick<OptCore, 'calls' | 'journal' | 'settings' | 'accounts' | 'tokenService' | 'fetch' | 'filesRoot'>;

export interface CallsPollOptions {
  /** Разовый догон истории («Загрузить историю»): примечания за столько дней назад, независимо от отметки. */
  sinceDays?: number;
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

const emptyResult = (accountId: number, enabled: boolean): CallsPollResult => ({ accountId, enabled, found: 0, skippedShort: 0, noLink: 0, inserted: 0, downloaded: 0, unavailable: 0, failed: 0, filesDeleted: 0, errors: [] });

/** Опрос одного аккаунта: сбор → вставка новых → скачивание → удаление старых MP3 → журнал. */
export async function runCallsPoll(core: CallsCore, accountId: number, opts: CallsPollOptions = {}): Promise<CallsPollResult> {
  const now = opts.now ?? (() => new Date());
  const settings = callsSettingsOf((await core.settings.get(accountId)).settings);
  const r = emptyResult(accountId, settings.enabled);
  if (!settings.enabled) return r;
  const account = await core.accounts.get(accountId);
  if (!account || account.uninstalledAt) throw new Error(`Аккаунт ${accountId} не подключён к «Агенту опт»`);
  const amo = opts.amo ?? amoRaw(account.accountDomain, () => core.tokenService.getAccessToken(accountId), core.fetch);

  const insertedCalls: { id: number; leadId: number | null; link: string }[] = [];
  for (const entity of ['contact', 'lead'] as const) {
    try {
      const got = await collectEntity(core, amo, accountId, entity, settings, now(), opts.sinceDays);
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
  const queue: CallRow[] = [...(await core.calls.listByStatus(accountId, 'new', DOWNLOADS_PER_RUN)), ...(await core.calls.listFailedAt(accountId, 'download', DOWNLOADS_PER_RUN)).filter((c) => c.updatedAt < retryBefore)].slice(0, DOWNLOADS_PER_RUN);
  for (const call of queue) {
    const res = await downloadOne(core, call, opts);
    if (res === 'downloaded') r.downloaded++;
    else if (res === 'unavailable') r.unavailable++;
    else r.failed++;
  }

  r.filesDeleted = await deleteExpiredFiles(core, accountId, settings, now());

  if (r.inserted || r.downloaded || r.unavailable || r.failed || r.errors.length) {
    const parts = [`найдено ${r.found}`, `новых ${r.inserted}`];
    if (r.skippedShort) parts.push(`коротких и пропущенных ${r.skippedShort}`);
    if (r.noLink) parts.push(`без записи ${r.noLink}`);
    if (r.downloaded) parts.push(`скачано ${r.downloaded}`);
    if (r.unavailable) parts.push(`недоступно ${r.unavailable}`);
    if (r.failed) parts.push(`ошибок скачивания ${r.failed}`);
    if (r.filesDeleted) parts.push(`удалено старых MP3 ${r.filesDeleted}`);
    if (r.errors.length) parts.push(`сбой сбора: ${r.errors.join('; ')}`);
    await core.journal.add({ accountId, kind: CALL_FETCH_KIND, summary: `Звонки: ${parts.join(', ')}`, details: { ...r, inserted: insertedCalls.map((c) => c.id), leads: [...new Set(insertedCalls.map((c) => c.leadId).filter((x): x is number => x !== null))] } });
  }
  return r;
}

async function collectEntity(core: CallsCore, amo: AmoRaw, accountId: number, entity: CallEntity, s: CallsSettings, now: Date, sinceDays?: number) {
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
  const ids = await core.calls.insertNew(accountId, rows);
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
