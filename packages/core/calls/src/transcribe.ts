import { readFile } from 'node:fs/promises';
import type { CallsDeps, CallsSettings } from './deps.ts';
import { resolveCallPath } from './download.ts';
import { errorText, isNetworkError } from './errors.ts';
import { CALL_ERROR_KIND } from './kinds.ts';
import type { CallRow } from './repo.ts';
import { pickStt, type CallStt, type CallTranscript, type SttProviderName } from './stt.ts';

/**
 * RFD-AI-AGENT-CALLS-RETAIL, п. 1: расшифровка скачанных звонков (downloaded → transcribed). Примечание по звонку не
 * пишется — звонок ждёт итога дня. Одновременно не больше двух звонков (общий предел опроса и догрузки — догрузка только
 * собирает и скачивает). Ошибка → failed, повтор через 30 минут, после 3 попыток — алерт в Telegram и остановка.
 */

export const RETRY_FAILED_AFTER_MS = 30 * 60_000;
export const MAX_ATTEMPTS = 3;
export const TRANSCRIBE_CONCURRENCY = 2;
const TRANSCRIBE_LIMIT = 20;
/** Асинхронный SpeechKit обычно отвечает за десятки секунд: ждём результат прямо в опросе, дольше — проверим в следующий. */
const INLINE_WAIT_MS = 30_000;
const INLINE_POLL_MS = 5_000;

export interface TranscribeOptions {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Провайдер расшифровки в тестах; null — ключей нет. */
  stt?: (preferred: SttProviderName) => CallStt | null;
  limit?: number;
  inlineWaitMs?: number;
  /** Только эти звонки (демо по сделке). */
  ids?: number[];
}

export interface TranscribeResult {
  /** Перезапущено упавших по сети (обратно в downloaded, без счёта попыток). */
  restarted: number;
  picked: number;
  transcribed: number;
  /** Операций SpeechKit запущено или ещё идёт — результат в следующем опросе. */
  pending: number;
  unavailable: number;
  failed: number;
  alerts: number;
}

export async function transcribeCalls(deps: CallsDeps, accountId: number, settings: CallsSettings, opts: TranscribeOptions = {}): Promise<TranscribeResult> {
  const now = opts.now ?? (() => new Date());
  const r: TranscribeResult = { restarted: 0, picked: 0, transcribed: 0, pending: 0, unavailable: 0, failed: 0, alerts: 0 };
  r.restarted = await deps.calls.resetNetworkFailed(accountId);
  const rows = await deps.calls.listForTranscription(accountId, { retryBefore: new Date(now().getTime() - RETRY_FAILED_AFTER_MS), maxAttempts: MAX_ATTEMPTS, limit: opts.limit ?? TRANSCRIBE_LIMIT, ...(opts.ids ? { ids: opts.ids } : {}) });
  r.picked = rows.length;
  if (!rows.length) return r;
  const ctx: Ctx = {
    deps,
    settings,
    opts,
    now,
    sleep: opts.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms))),
    stt: opts.stt ?? ((preferred) => pickStt(preferred, deps.keys, deps.fetch)),
    result: r,
  };
  // Пул на TRANSCRIBE_CONCURRENCY звонков: каждый воркер берёт следующий из очереди.
  const queue = [...rows];
  await Promise.all(Array.from({ length: Math.min(TRANSCRIBE_CONCURRENCY, queue.length) }, async () => {
    for (let row = queue.shift(); row; row = queue.shift()) await transcribeOne(ctx, row);
  }));
  return r;
}

interface Ctx {
  deps: CallsDeps;
  settings: CallsSettings;
  opts: TranscribeOptions;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  stt: (preferred: SttProviderName) => CallStt | null;
  result: TranscribeResult;
}

export const describeCall = (row: Pick<CallRow, 'direction' | 'phone' | 'calledAt'>): string => `${row.direction === 'in' ? 'входящий' : 'исходящий'} ${row.phone || 'без номера'}, ${row.calledAt.toISOString().slice(0, 16).replace('T', ' ')}`;

async function transcribeOne(ctx: Ctx, row: CallRow): Promise<void> {
  try {
    await stepTranscribe(ctx, row);
  } catch (err) {
    if (isNetworkError(err)) return onNetworkFailure(ctx, row, errorText(err));
    await onFailure(ctx, row, errorText(err));
  }
}

/** Сеть (DNS, соединение, таймаут): failed без счёта попыток и без алерта; следующий опрос вернёт звонок в downloaded. */
async function onNetworkFailure(ctx: Ctx, row: CallRow, message: string): Promise<void> {
  const op = row.transcript && 'pending' in row.transcript ? row.transcript.pending?.operationId : undefined;
  await ctx.deps.calls.setFailed(row.id, 'transcribe', `сеть: ${message}`);
  ctx.result.failed++;
  await ctx.deps.journal.add({
    accountId: row.accountId,
    ...(row.leadId ? { leadId: row.leadId } : {}),
    kind: CALL_ERROR_KIND,
    summary: `Звонок ${row.id} (${describeCall(row)}): расшифровка — сетевая ошибка (${message}); повтор при следующем опросе${op ? `, операция ${op} сохранена` : ''}`,
    details: { callId: row.id, noteId: row.noteId, leadId: row.leadId, stage: 'transcribe', network: true, error: message, sttMode: row.sttMode },
  });
}

/** Ошибка шага: failed, попытка + 1, журнал; после MAX_ATTEMPTS — один алерт. */
export async function onFailure(ctx: { deps: CallsDeps; result: { failed: number; alerts: number } }, row: CallRow, message: string, stage: 'transcribe' | 'day' = 'transcribe'): Promise<void> {
  const attempts = await ctx.deps.calls.bumpFailed(row.id, stage, message);
  ctx.result.failed++;
  const stageRu = stage === 'transcribe' ? 'расшифровка' : 'итог дня';
  const last = attempts >= MAX_ATTEMPTS;
  await ctx.deps.journal.add({
    accountId: row.accountId,
    ...(row.leadId ? { leadId: row.leadId } : {}),
    kind: CALL_ERROR_KIND,
    summary: `Звонок ${row.id} (${describeCall(row)}): ${stageRu} не удалась (попытка ${attempts} из ${MAX_ATTEMPTS}) — ${message}${last ? '; повторов больше не будет' : `; повтор через ${RETRY_FAILED_AFTER_MS / 60_000} мин`}`,
    details: { callId: row.id, noteId: row.noteId, leadId: row.leadId, stage, attempts, error: message, sttMode: row.sttMode },
  });
  if (last && !row.alertedAt) {
    await ctx.deps.alerter.alert(`Звонки: звонок ${row.id} (${describeCall(row)}${row.leadId ? `, сделка ${row.leadId}` : ''}) — ${stageRu} не удалась ${MAX_ATTEMPTS} раза: ${message}`).catch(() => undefined);
    await ctx.deps.calls.markAlerted(row.id);
    ctx.result.alerts++;
  }
}

/** Короткие и без файла — unavailable; SpeechKit — операция с ожиданием до INLINE_WAIT_MS (отложенный режим не ждёт). */
async function stepTranscribe(ctx: Ctx, row: CallRow): Promise<void> {
  if (row.durationSec < ctx.settings.minDurationSec) {
    await ctx.deps.calls.setUnavailable(row.id, `звонок короче ${ctx.settings.minDurationSec} с (${row.durationSec} с) — не расшифровывается`);
    ctx.result.unavailable++;
    return;
  }
  const pending = row.transcript && 'pending' in row.transcript ? row.transcript.pending : null;
  if (pending) {
    const stt = ctx.stt(pending.provider);
    if (!stt || stt.name !== pending.provider) throw new Error(`операция ${pending.operationId} запущена в ${pending.provider}, а ключа провайдера больше нет`);
    const t = await stt.poll(pending, row.durationSec);
    if (!t) {
      await ctx.deps.calls.setTranscript(row.id, { pending: { ...pending, polls: pending.polls + 1 } }, 'downloaded');
      ctx.result.pending++;
      return;
    }
    return finishTranscript(ctx, row, t);
  }
  if (!row.filePath) {
    await ctx.deps.calls.setUnavailable(row.id, row.fileDeletedAt ? 'MP3 удалён по сроку хранения до расшифровки' : 'файл записи не сохранён');
    ctx.result.unavailable++;
    return;
  }
  const stt = ctx.stt(ctx.settings.sttProvider);
  if (!stt) throw new Error('нет ключей ни SpeechKit (YANDEX_SPEECHKIT_API_KEY), ни OpenAI (OPENAI_API_KEY)');
  const bytes = new Uint8Array(await readFile(resolveCallPath(ctx.deps.filesRoot, row.filePath)));
  const started = await stt.start(bytes, row.fileMime ?? 'audio/mpeg', { mode: row.sttMode, durationSec: row.durationSec });
  if ('transcript' in started) return finishTranscript(ctx, row, started.transcript);
  let p = started.pending;
  await ctx.deps.calls.setTranscript(row.id, { pending: p }, 'downloaded');
  const waitMs = p.mode === 'deferred' ? 0 : (ctx.opts.inlineWaitMs ?? INLINE_WAIT_MS);
  const deadline = ctx.now().getTime() + waitMs;
  while (waitMs > 0) {
    await ctx.sleep(INLINE_POLL_MS);
    p = { ...p, polls: p.polls + 1 };
    const t = await stt.poll(p, row.durationSec);
    if (t) return finishTranscript(ctx, row, t);
    await ctx.deps.calls.setTranscript(row.id, { pending: p }, 'downloaded');
    if (ctx.now().getTime() >= deadline) break;
  }
  ctx.result.pending++;
}

async function finishTranscript(ctx: Ctx, row: CallRow, t: CallTranscript): Promise<void> {
  if (!t.text.trim()) {
    await ctx.deps.calls.setUnavailable(row.id, `расшифровка пустая (${t.provider}, ${t.mode}) — речи в записи не распознано`);
    ctx.result.unavailable++;
    return;
  }
  await ctx.deps.calls.setTranscript(row.id, t, 'transcribed');
  await ctx.deps.calls.addCost(row.id, { sttRub: t.cost.rub, sttUsd: t.cost.usd, sttProvider: t.provider, sttMode: t.mode });
  ctx.result.transcribed++;
}
