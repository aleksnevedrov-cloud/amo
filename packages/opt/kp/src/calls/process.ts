import { readFile } from 'node:fs/promises';
import type { OptCore } from '../deps.ts';
import { resolveKpPath } from '../paths.ts';
import { callsSettingsOf, resolveOptRoute, type OptSettings } from '../settings.ts';
import { analyzeTranscript, type CallAnalysis } from './analyze.ts';
import type { CallsCore } from './job.ts';
import { CALL_ANALYSIS_KIND, CALL_ERROR_KIND, CALL_NOTE_KIND } from './kinds.ts';
import { formatCallNote, postCallNote } from './note.ts';
import { amoRaw, type AmoRaw } from './notes.ts';
import { type CallRow, type CallStage } from './repo.ts';
import { pickStt, type CallStt, type CallTranscript, type SttProviderName } from './stt.ts';

/**
 * RFD-AI-AGENT-OPT-CALLS, этапы 2–3: обработка скачанных звонков — расшифровка (downloaded → transcribed), разбор
 * моделью (→ analyzed), примечание в amo (→ posted). Идёт в очереди calls-poll после скачивания; одновременно не больше
 * двух звонков (общий предел для опроса и догрузки — догрузка только собирает и скачивает, обрабатывает этот же код).
 * Ошибка шага → failed с причиной, повтор через 30 минут, после 3 попыток — алерт в Telegram и остановка.
 */

export const RETRY_FAILED_AFTER_MS = 30 * 60_000;
export const MAX_ATTEMPTS = 3;
export const PROCESS_CONCURRENCY = 2;
/** Звонков на обработку за один опрос аккаунта. */
const PROCESS_LIMIT = 20;
/** Асинхронный SpeechKit обычно отвечает за десятки секунд: ждём результат прямо в опросе, дольше — проверим в следующий. */
const INLINE_WAIT_MS = 30_000;
const INLINE_POLL_MS = 5_000;

export type CallsProcessCore = CallsCore & Pick<OptCore, 'ai' | 'env' | 'alerter'>;

export interface ProcessOptions {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Провайдер расшифровки в тестах; null — ключей нет. */
  stt?: (preferred: SttProviderName) => CallStt | null;
  amo?: AmoRaw;
  limit?: number;
  inlineWaitMs?: number;
}

export interface ProcessResult {
  picked: number;
  transcribed: number;
  /** Операций SpeechKit запущено или ещё идёт — результат в следующем опросе. */
  pending: number;
  analyzed: number;
  posted: number;
  /** Примечание не пишется: нет делового содержания или выключено. */
  skipped: number;
  unavailable: number;
  failed: number;
  alerts: number;
}

type StepOutcome = 'next' | 'stop' | 'unavailable';

export async function processCalls(core: CallsProcessCore, accountId: number, settings: OptSettings, opts: ProcessOptions = {}): Promise<ProcessResult> {
  const now = opts.now ?? (() => new Date());
  const r: ProcessResult = { picked: 0, transcribed: 0, pending: 0, analyzed: 0, posted: 0, skipped: 0, unavailable: 0, failed: 0, alerts: 0 };
  const rows = await core.calls.listForProcessing(accountId, { retryBefore: new Date(now().getTime() - RETRY_FAILED_AFTER_MS), maxAttempts: MAX_ATTEMPTS, limit: opts.limit ?? PROCESS_LIMIT });
  r.picked = rows.length;
  if (!rows.length) return r;
  const account = await core.accounts.get(accountId);
  if (!account) throw new Error(`Аккаунт ${accountId} не подключён`);
  const ctx: Ctx = {
    core,
    settings,
    opts,
    now,
    sleep: opts.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms))),
    amo: opts.amo ?? amoRaw(account.accountDomain, () => core.tokenService.getAccessToken(accountId), core.fetch),
    stt: opts.stt ?? ((preferred) => pickStt(preferred, { speechkit: core.env.YANDEX_SPEECHKIT_API_KEY ?? null, openai: core.env.OPENAI_API_KEY ?? null }, core.fetch)),
    result: r,
  };
  // Пул на PROCESS_CONCURRENCY звонков: каждый воркер берёт следующий из очереди.
  const queue = [...rows];
  await Promise.all(Array.from({ length: Math.min(PROCESS_CONCURRENCY, queue.length) }, async () => {
    for (let row = queue.shift(); row; row = queue.shift()) await processOne(ctx, row);
  }));
  return r;
}

interface Ctx {
  core: CallsProcessCore;
  settings: OptSettings;
  opts: ProcessOptions;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  amo: AmoRaw;
  stt: (preferred: SttProviderName) => CallStt | null;
  result: ProcessResult;
}

function stageOf(row: CallRow): CallStage | null {
  if (row.status === 'downloaded') return 'transcribe';
  if (row.status === 'transcribed') return 'analyze';
  if (row.status === 'analyzed') return row.posted ? null : 'post';
  if (row.status === 'failed' && row.stage && ['transcribe', 'analyze', 'post'].includes(row.stage)) return row.stage as CallStage;
  return null;
}

/** Все шаги подряд, пока звонок не дошёл до конца, не остановился (операция идёт, шаг выключен) или не упал. */
async function processOne(ctx: Ctx, first: CallRow): Promise<void> {
  let row: CallRow | null = first;
  for (let guard = 0; row && guard < 4; guard++) {
    const stage = stageOf(row);
    if (!stage) return;
    let outcome: StepOutcome;
    try {
      outcome = stage === 'transcribe' ? await stepTranscribe(ctx, row) : stage === 'analyze' ? await stepAnalyze(ctx, row) : await stepPost(ctx, row);
    } catch (err) {
      await onFailure(ctx, row, stage, (err as Error).message);
      return;
    }
    if (outcome !== 'next') return;
    row = await ctx.core.calls.get(row.accountId, row.id);
  }
}

async function onFailure(ctx: Ctx, row: CallRow, stage: CallStage, message: string): Promise<void> {
  const attempts = await ctx.core.calls.bumpFailed(row.id, stage, message);
  ctx.result.failed++;
  const stageRu = stage === 'transcribe' ? 'расшифровка' : stage === 'analyze' ? 'анализ' : 'примечание';
  const last = attempts >= MAX_ATTEMPTS;
  await ctx.core.journal.add({
    accountId: row.accountId,
    ...(row.leadId ? { leadId: row.leadId } : {}),
    kind: CALL_ERROR_KIND,
    summary: `Звонок ${row.id} (${describe(row)}): ${stageRu} не удалась (попытка ${attempts} из ${MAX_ATTEMPTS}) — ${message}${last ? '; повторов больше не будет' : `; повтор через ${RETRY_FAILED_AFTER_MS / 60_000} мин`}`,
    details: { callId: row.id, noteId: row.noteId, leadId: row.leadId, stage, attempts, error: message, sttMode: row.sttMode },
  });
  if (last && !row.alertedAt) {
    await ctx.core.alerter.alert(`Агент опт, звонки: звонок ${row.id} (${describe(row)}${row.leadId ? `, сделка ${row.leadId}` : ''}) — ${stageRu} не удалась ${MAX_ATTEMPTS} раза: ${message}`).catch(() => undefined);
    await ctx.core.calls.markAlerted(row.id);
    ctx.result.alerts++;
  }
}

const describe = (row: CallRow): string => `${row.direction === 'in' ? 'входящий' : 'исходящий'} ${row.phone || 'без номера'}, ${row.calledAt.toISOString().slice(0, 16).replace('T', ' ')}`;

/** Шаг 1: расшифровка. Короткие и без файла — unavailable; SpeechKit — операция с ожиданием до INLINE_WAIT_MS. */
async function stepTranscribe(ctx: Ctx, row: CallRow): Promise<StepOutcome> {
  const calls = callsSettingsOf(ctx.settings);
  if (row.durationSec < calls.minDurationSec) {
    await ctx.core.calls.setUnavailable(row.id, `звонок короче ${calls.minDurationSec} с (${row.durationSec} с) — не расшифровывается`);
    ctx.result.unavailable++;
    return 'unavailable';
  }
  const pending = row.transcript && 'pending' in row.transcript ? row.transcript.pending : null;
  if (pending) {
    const stt = ctx.stt(pending.provider);
    if (!stt || stt.name !== pending.provider) throw new Error(`операция ${pending.operationId} запущена в ${pending.provider}, а ключа провайдера больше нет`);
    const t = await stt.poll(pending, row.durationSec);
    if (!t) {
      await ctx.core.calls.setTranscript(row.id, { pending: { ...pending, polls: pending.polls + 1 } }, 'downloaded');
      ctx.result.pending++;
      return 'stop';
    }
    return finishTranscript(ctx, row, t);
  }
  if (!row.filePath) {
    await ctx.core.calls.setUnavailable(row.id, row.fileDeletedAt ? 'MP3 удалён по сроку хранения до расшифровки' : 'файл записи не сохранён');
    ctx.result.unavailable++;
    return 'unavailable';
  }
  const stt = ctx.stt(calls.sttProvider);
  if (!stt) throw new Error('нет ключей ни SpeechKit (YANDEX_SPEECHKIT_API_KEY), ни OpenAI (OPENAI_API_KEY)');
  const bytes = new Uint8Array(await readFile(resolveKpPath(ctx.core.filesRoot, row.filePath)));
  const started = await stt.start(bytes, row.fileMime ?? 'audio/mpeg', { mode: row.sttMode, durationSec: row.durationSec });
  if ('transcript' in started) return finishTranscript(ctx, row, started.transcript);
  // Операция SpeechKit: асинхронный режим — подождать немного здесь; отложенный — проверять в следующих опросах.
  let p = started.pending;
  await ctx.core.calls.setTranscript(row.id, { pending: p }, 'downloaded');
  const waitMs = p.mode === 'deferred' ? 0 : (ctx.opts.inlineWaitMs ?? INLINE_WAIT_MS);
  const deadline = ctx.now().getTime() + waitMs;
  while (waitMs > 0) {
    await ctx.sleep(INLINE_POLL_MS);
    p = { ...p, polls: p.polls + 1 };
    const t = await stt.poll(p, row.durationSec);
    if (t) return finishTranscript(ctx, row, t);
    await ctx.core.calls.setTranscript(row.id, { pending: p }, 'downloaded');
    if (ctx.now().getTime() >= deadline) break;
  }
  ctx.result.pending++;
  return 'stop';
}

async function finishTranscript(ctx: Ctx, row: CallRow, t: CallTranscript): Promise<StepOutcome> {
  if (!t.text.trim()) {
    await ctx.core.calls.setUnavailable(row.id, `расшифровка пустая (${t.provider}, ${t.mode}) — речи в записи не распознано`);
    ctx.result.unavailable++;
    return 'unavailable';
  }
  await ctx.core.calls.setTranscript(row.id, t, 'transcribed');
  await ctx.core.calls.addCost(row.id, { sttRub: t.cost.rub, sttUsd: t.cost.usd, sttProvider: t.provider, sttMode: t.mode });
  ctx.result.transcribed++;
  return 'next';
}

/** Шаг 2: разбор моделью «Агента опт»; роли говорящих — в реплики расшифровки. */
async function stepAnalyze(ctx: Ctx, row: CallRow): Promise<StepOutcome> {
  if (!callsSettingsOf(ctx.settings).analyzeEnabled) return 'stop';
  const t = row.transcript;
  if (!t || 'pending' in t) throw new Error('расшифровки нет');
  const ai = await ctx.core.ai(row.accountId);
  if (!ai) throw new Error('нет ключа модели «Агента опт» (вкладка «Модель»)');
  const route = resolveOptRoute(ctx.settings);
  const res = await analyzeTranscript(ai.llm, route, { transcript: t, direction: row.direction, durationSec: row.durationSec, pricing: ctx.settings.billing.pricing });
  const roles = new Map(res.analysis.speakers.map((s) => [s.tag, s.role]));
  const withRoles: CallTranscript = { ...t, segments: t.segments.map((s) => {
    const role = s.speaker ? roles.get(s.speaker) : undefined;
    return role ? { ...s, role } : s;
  }) };
  const analysis: CallAnalysis & { provider: string; model: string; at: string; attempts: number } = { ...res.analysis, provider: res.provider, model: res.model, at: ctx.now().toISOString(), attempts: res.attempts };
  await ctx.core.calls.setAnalysis(row.id, analysis, withRoles);
  const rate = ctx.settings.billing.usdRubRate;
  await ctx.core.calls.addCost(row.id, { llmUsd: res.cost.usd, llmInputTokens: res.cost.inputTokens, llmOutputTokens: res.cost.outputTokens, llmModel: `${res.provider}:${res.model}` });
  ctx.result.analyzed++;
  await ctx.core.journal.add({
    accountId: row.accountId,
    ...(row.leadId ? { leadId: row.leadId } : {}),
    kind: CALL_ANALYSIS_KIND,
    summary: res.analysis.businessContent ? `Звонок ${row.id} (${describe(row)}) разобран: ${res.analysis.summary.slice(0, 300)} — оценка ${res.analysis.managerScore}/10` : `Звонок ${row.id} (${describe(row)}): без делового содержания — ${res.analysis.summary.slice(0, 200)}`,
    details: { callId: row.id, noteId: row.noteId, leadId: row.leadId, provider: res.provider, model: res.model, attempts: res.attempts, stt: { provider: t.provider, mode: t.mode, rub: t.cost.rub, usd: t.cost.usd }, raw: res.raw },
    inputTokens: res.cost.inputTokens,
    outputTokens: res.cost.outputTokens,
    costUsd: res.cost.usd + t.cost.usd,
    costRub: (res.cost.usd + t.cost.usd) * rate + t.cost.rub,
  });
  return 'next';
}

/** Шаг 3: примечание «Анализ звонка»; posted заполнен — повторно не публикуем; без делового содержания — не пишем. */
async function stepPost(ctx: Ctx, row: CallRow): Promise<StepOutcome> {
  if (!callsSettingsOf(ctx.settings).postNoteEnabled) return 'stop';
  const posted = row.posted as { noteId?: number } | null;
  if (posted?.noteId) {
    if (row.status !== 'posted') await ctx.core.calls.setPosted(row.id, posted, 'posted');
    return 'stop';
  }
  const a = row.analysis as (CallAnalysis & Record<string, unknown>) | null;
  if (!a) throw new Error('разбора нет');
  if (a.businessContent === false) {
    await ctx.core.calls.setPosted(row.id, { skipped: 'без делового содержания', at: ctx.now().toISOString() }, 'analyzed');
    ctx.result.skipped++;
    return 'stop';
  }
  const durationSec = row.transcript && !('pending' in row.transcript) && row.transcript.durationSec ? row.transcript.durationSec : row.durationSec;
  const text = formatCallNote(row, a, durationSec);
  const note = await postCallNote(ctx.amo, row, text, ctx.now());
  await ctx.core.calls.setPosted(row.id, { ...note }, 'posted');
  ctx.result.posted++;
  await ctx.core.journal.add({
    accountId: row.accountId,
    ...(note.entity === 'lead' ? { leadId: note.entityId } : row.leadId ? { leadId: row.leadId } : {}),
    kind: CALL_NOTE_KIND,
    summary: `Звонок ${row.id}: примечание «Анализ звонка» записано в ${note.entity === 'lead' ? `сделку ${note.entityId}` : `контакт ${note.entityId}`} (id ${note.noteId})`,
    details: { callId: row.id, noteId: note.noteId, entity: note.entity, entityId: note.entityId, text },
  });
  return 'next';
}
