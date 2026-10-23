import type { Db } from '@core/db';
import type { DaySummary } from './day-analyze.ts';
import type { RefusalAnalysis } from './refusal-analyze.ts';
import type { CallEntity, ParsedCallNote } from './notes.ts';
import type { CallTranscript, PendingTranscription, SttMode } from './stt.ts';

/**
 * Статусы звонка: new → downloaded → transcribed → posted (вошёл в итог дня с примечанием) / analyzed (в итоге дня без
 * примечания — нет делового содержания — или вне воронки / этапа); unavailable — запись не отдаётся или не расшифровать;
 * failed — ошибка на шаге stage.
 */
export type CallStatus = 'new' | 'downloaded' | 'transcribed' | 'analyzed' | 'posted' | 'unavailable' | 'failed';
/** Шаги с повторами: скачивание, расшифровка, итог дня. */
export type CallStage = 'download' | 'transcribe' | 'day';

/** Поле transcript: готовая расшифровка либо запущенная операция SpeechKit (статус остаётся downloaded). */
export type TranscriptField = CallTranscript | { pending: PendingTranscription };

export interface CallRow {
  id: number;
  accountId: number;
  noteId: number;
  entity: CallEntity;
  entityId: number;
  recordKey: string;
  direction: 'in' | 'out';
  phone: string;
  durationSec: number;
  callStatus: number | null;
  link: string;
  calledAt: Date;
  noteUpdatedAt: Date;
  managerId: number | null;
  leadId: number | null;
  status: CallStatus;
  stage: CallStage | null;
  error: string | null;
  attempts: number;
  sttMode: SttMode;
  alertedAt: Date | null;
  filePath: string | null;
  fileBytes: number | null;
  fileMime: string | null;
  downloadedAt: Date | null;
  fileDeletedAt: Date | null;
  transcript: TranscriptField | null;
  cost: Record<string, unknown> | null;
  daySummaryId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CallsSync {
  lastUpdatedAt: Date;
  lastRunAt: Date | null;
  lastError: string | null;
}

/** Таблицы calls и calls_sync (БД розницы, миграция 018). */
export class CallsRepo {
  constructor(private readonly db: Db) {}

  /** Новые звонки; уже известные (account_id + note_id + record_key) пропускаются. На каждый входной — id вставленного или null (дубль). */
  async insertNew(accountId: number, calls: (ParsedCallNote & { leadId: number | null })[], sttMode: SttMode = 'async'): Promise<(number | null)[]> {
    const ids: (number | null)[] = [];
    for (const c of calls) {
      const { rows } = await this.db.query<{ id: string }>(
        `INSERT INTO calls (account_id, note_id, entity, entity_id, record_key, direction, phone, duration_sec, call_status, link, called_at, note_updated_at, manager_id, lead_id, stt_mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (account_id, note_id, record_key) DO NOTHING
         RETURNING id`,
        [accountId, c.noteId, c.entity, c.entityId, c.recordKey, c.direction, c.phone, c.durationSec, c.callStatus, c.link, c.calledAt, c.noteUpdatedAt, c.managerId, c.leadId, sttMode],
      );
      ids.push(rows[0] ? Number(rows[0].id) : null);
    }
    return ids;
  }

  async get(accountId: number, id: number): Promise<CallRow | null> {
    const { rows } = await this.db.query('SELECT * FROM calls WHERE account_id = $1 AND id = $2', [accountId, id]);
    return rows[0] ? mapCall(rows[0]) : null;
  }

  async listByStatus(accountId: number, status: CallStatus, limit = 50): Promise<CallRow[]> {
    const { rows } = await this.db.query('SELECT * FROM calls WHERE account_id = $1 AND status = $2 ORDER BY called_at ASC, id ASC LIMIT $3', [accountId, status, limit]);
    return rows.map(mapCall);
  }

  /** Звонки аккаунта (последние сверху); по сделке — по lead_id. */
  async list(accountId: number, opts: { leadId?: number; limit?: number; offset?: number } = {}): Promise<CallRow[]> {
    const params: unknown[] = [accountId];
    let where = 'account_id = $1';
    if (opts.leadId) {
      params.push(opts.leadId);
      where += ` AND lead_id = $${params.length}`;
    }
    params.push(Math.min(opts.limit ?? 50, 500), opts.offset ?? 0);
    const { rows } = await this.db.query(`SELECT * FROM calls WHERE ${where} ORDER BY called_at DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return rows.map(mapCall);
  }

  /** Последний расшифрованный звонок аккаунта — для проверки меток говорящих на реальной записи. */
  async lastTranscribed(accountId: number): Promise<CallRow | null> {
    const { rows } = await this.db.query(`SELECT * FROM calls WHERE account_id = $1 AND transcript IS NOT NULL AND transcript->'pending' IS NULL ORDER BY updated_at DESC LIMIT 1`, [accountId]);
    return rows[0] ? mapCall(rows[0]) : null;
  }

  async countByStatus(accountId: number): Promise<Record<string, number>> {
    const { rows } = await this.db.query<{ status: string; n: string }>('SELECT status, count(*)::text AS n FROM calls WHERE account_id = $1 GROUP BY status', [accountId]);
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }

  async setDownloaded(id: number, f: { filePath: string; fileBytes: number; fileMime: string }): Promise<void> {
    await this.db.query(
      `UPDATE calls SET status = 'downloaded', stage = NULL, error = NULL, file_path = $2, file_bytes = $3, file_mime = $4, downloaded_at = now(), file_deleted_at = NULL, updated_at = now() WHERE id = $1`,
      [id, f.filePath, f.fileBytes, f.fileMime],
    );
  }

  /** Запись не отдаётся или не расшифровать — конечный статус, повторов нет. */
  async setUnavailable(id: number, reason: string): Promise<void> {
    await this.db.query(`UPDATE calls SET status = 'unavailable', error = $2, updated_at = now() WHERE id = $1`, [id, reason.slice(0, 1000)]);
  }

  /** Скачивание упало: failed без счёта попыток (повтор при опросе не чаще раза в полчаса). */
  async setFailed(id: number, stage: CallStage, error: string): Promise<void> {
    await this.db.query(`UPDATE calls SET status = 'failed', stage = $2, error = $3, updated_at = now() WHERE id = $1`, [id, stage, error.slice(0, 1000)]);
  }

  async listFailedAt(accountId: number, stage: CallStage, limit = 20): Promise<CallRow[]> {
    const { rows } = await this.db.query(`SELECT * FROM calls WHERE account_id = $1 AND status = 'failed' AND stage = $2 ORDER BY updated_at ASC LIMIT $3`, [accountId, stage, limit]);
    return rows.map(mapCall);
  }

  /** MP3, скачанные раньше указанной даты и ещё лежащие на томе, — на удаление по сроку хранения. */
  async filesOlderThan(accountId: number, before: Date, limit = 100): Promise<Pick<CallRow, 'id' | 'filePath'>[]> {
    const { rows } = await this.db.query<{ id: string; file_path: string }>(
      'SELECT id, file_path FROM calls WHERE account_id = $1 AND file_path IS NOT NULL AND downloaded_at < $2 ORDER BY downloaded_at ASC LIMIT $3',
      [accountId, before, limit],
    );
    return rows.map((r) => ({ id: Number(r.id), filePath: r.file_path }));
  }

  async markFileDeleted(id: number): Promise<void> {
    await this.db.query(`UPDATE calls SET file_path = NULL, file_deleted_at = now(), updated_at = now() WHERE id = $1`, [id]);
  }

  /** Какие из примечаний уже есть в calls (оценка догрузки до запуска). */
  async existingNoteIds(accountId: number, noteIds: number[]): Promise<Set<number>> {
    if (!noteIds.length) return new Set();
    const { rows } = await this.db.query<{ note_id: string }>('SELECT note_id FROM calls WHERE account_id = $1 AND note_id = ANY($2::bigint[])', [accountId, noteIds]);
    return new Set(rows.map((r) => Number(r.note_id)));
  }

  /** Звонки по id примечаний amo (для демо по сделке: что уже в базе). */
  /** Звонок попал в calls опросом раньше, чем появилась сделка (lead_id пуст или другая сделка контакта) — привязать к сделке анализа. */
  async setLeadId(ids: number[], leadId: number): Promise<void> {
    if (!ids.length) return;
    await this.db.query('UPDATE calls SET lead_id = $2, updated_at = now() WHERE id = ANY($1::bigint[]) AND (lead_id IS NULL OR lead_id <> $2) AND day_summary_id IS NULL', [ids, leadId]);
  }

  async byNoteIds(accountId: number, noteIds: number[]): Promise<CallRow[]> {
    if (!noteIds.length) return [];
    const { rows } = await this.db.query('SELECT * FROM calls WHERE account_id = $1 AND note_id = ANY($2::bigint[]) ORDER BY called_at ASC, id ASC', [accountId, noteIds]);
    return rows.map(mapCall);
  }

  /** На расшифровку: скачанные (в т. ч. с запущенной операцией) и упавшие на расшифровке не раньше retryBefore, не больше maxAttempts; ids — только эти. */
  async listForTranscription(accountId: number, o: { retryBefore: Date; maxAttempts: number; limit: number; ids?: number[] }): Promise<CallRow[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM calls
        WHERE account_id = $1
          AND (status = 'downloaded' OR (status = 'failed' AND stage = 'transcribe' AND attempts < $2 AND updated_at < $3))
          AND ($5::bigint[] IS NULL OR id = ANY($5::bigint[]))
        ORDER BY called_at ASC, id ASC
        LIMIT $4`,
      [accountId, o.maxAttempts, o.retryBefore, o.limit, o.ids ?? null],
    );
    return rows.map(mapCall);
  }

  /**
   * Упавшие на расшифровке по сети («сеть: …») — обратно в downloaded без счёта попыток: следующий опрос продолжит по
   * сохранённой операции (transcript.pending) или отправит файл заново. Возвращает число перезапущенных.
   */
  async resetNetworkFailed(accountId: number): Promise<number> {
    const { rowCount } = await this.db.query(`UPDATE calls SET status = 'downloaded', stage = NULL, updated_at = now() WHERE account_id = $1 AND status = 'failed' AND stage = 'transcribe' AND error LIKE 'сеть: %'`, [accountId]);
    return rowCount ?? 0;
  }

  /** Расшифровка: готовая — статус transcribed; запущенная операция — статус остаётся downloaded. */
  async setTranscript(id: number, transcript: TranscriptField, status: 'transcribed' | 'downloaded'): Promise<void> {
    await this.db.query(`UPDATE calls SET transcript = $2::jsonb, status = $3, stage = NULL, error = NULL, updated_at = now() WHERE id = $1`, [id, JSON.stringify(transcript), status]);
  }

  /** Шаг упал: attempts + 1; возвращает новое число попыток. */
  async bumpFailed(id: number, stage: CallStage, error: string): Promise<number> {
    const { rows } = await this.db.query<{ attempts: number }>(`UPDATE calls SET status = 'failed', stage = $2, error = $3, attempts = attempts + 1, updated_at = now() WHERE id = $1 RETURNING attempts`, [id, stage, error.slice(0, 1000)]);
    return rows[0]?.attempts ?? 0;
  }

  async markAlerted(id: number): Promise<void> {
    await this.db.query(`UPDATE calls SET alerted_at = now() WHERE id = $1`, [id]);
  }

  async addCost(id: number, cost: Record<string, unknown>): Promise<void> {
    await this.db.query(`UPDATE calls SET cost = COALESCE(cost, '{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1`, [id, JSON.stringify(cost)]);
  }

  /**
   * Кандидаты в итог дня: расшифрованные, ещё не вошедшие в итог, со звонком до until; упавшие на итоге — не раньше
   * retryBefore и не больше maxAttempts попыток.
   */
  async listForDaySummary(accountId: number, o: { until: Date; retryBefore: Date; maxAttempts: number }): Promise<CallRow[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM calls
        WHERE account_id = $1 AND day_summary_id IS NULL AND called_at < $2
          AND (status = 'transcribed' OR (status = 'failed' AND stage = 'day' AND attempts < $3 AND updated_at < $4))
        ORDER BY called_at ASC, id ASC`,
      [accountId, o.until, o.maxAttempts, o.retryBefore],
    );
    return rows.map(mapCall);
  }

  /** Звонки до until, которые ещё не расшифрованы (new / downloaded / failed на скачивании или расшифровке): итог дня их ждёт. */
  async countNotTranscribed(accountId: number, until: Date): Promise<number> {
    const { rows } = await this.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM calls WHERE account_id = $1 AND called_at < $2 AND (status IN ('new', 'downloaded') OR (status = 'failed' AND stage IN ('download', 'transcribe')))`,
      [accountId, until],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** Звонки вошли в итог дня: posted — с примечанием, analyzed — без (нет делового содержания). */
  async attachToSummary(ids: number[], summaryId: number, status: 'posted' | 'analyzed'): Promise<void> {
    if (!ids.length) return;
    await this.db.query(`UPDATE calls SET day_summary_id = $2, status = $3, stage = NULL, error = NULL, updated_at = now() WHERE id = ANY($1::bigint[])`, [ids, summaryId, status]);
  }

  /** Звонок не попадает в итог (сделка вне воронки или на закрытом этапе): analyzed с причиной, повторно не берётся. */
  async setSkipped(ids: number[], reason: string): Promise<void> {
    if (!ids.length) return;
    await this.db.query(`UPDATE calls SET status = 'analyzed', stage = 'day', error = $2, updated_at = now() WHERE id = ANY($1::bigint[])`, [ids, reason.slice(0, 1000)]);
  }

  async getSync(accountId: number, entity: string): Promise<CallsSync | null> {
    const { rows } = await this.db.query<{ last_updated_at: Date; last_run_at: Date | null; last_error: string | null }>('SELECT last_updated_at, last_run_at, last_error FROM calls_sync WHERE account_id = $1 AND entity = $2', [accountId, entity]);
    const r = rows[0];
    return r ? { lastUpdatedAt: r.last_updated_at, lastRunAt: r.last_run_at, lastError: r.last_error } : null;
  }

  async setSync(accountId: number, entity: string, s: { lastUpdatedAt: Date; lastError: string | null }): Promise<void> {
    await this.db.query(
      `INSERT INTO calls_sync (account_id, entity, last_updated_at, last_run_at, last_error) VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (account_id, entity) DO UPDATE SET last_updated_at = EXCLUDED.last_updated_at, last_run_at = now(), last_error = EXCLUDED.last_error`,
      [accountId, entity, s.lastUpdatedAt, s.lastError],
    );
  }
}

export interface DaySummaryRow {
  id: number;
  accountId: number;
  leadId: number | null;
  contactId: number | null;
  /** День по Москве, ГГГГ-ММ-ДД. */
  day: string;
  business: boolean;
  summary: DaySummary;
  callIds: number[];
  /** id записей ленты общения (call:… / wz:… / chat:… / agent:… / note:… / mail:…), вошедших в итог. */
  itemIds: string[];
  counts: { calls: number; messages: number; emails: number; notes: number } | null;
  callsCount: number;
  totalDurationSec: number;
  noteId: number | null;
  noteEntity: 'lead' | 'contact' | null;
  noteText: string | null;
  provider: string | null;
  model: string | null;
  cost: Record<string, unknown> | null;
  createdAt: Date;
}

/** Таблица call_day_summaries: итоги разговоров за день по сделке или контакту. */
export class DaySummariesRepo {
  constructor(private readonly db: Db) {}

  async insert(r: { accountId: number; leadId: number | null; contactId: number | null; day: string; business: boolean; summary: DaySummary; callIds: number[]; itemIds: string[]; counts: { calls: number; messages: number; emails: number; notes: number } | null; callsCount: number; totalDurationSec: number; provider: string | null; model: string | null; cost: Record<string, unknown> | null }): Promise<number> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO call_day_summaries (account_id, lead_id, contact_id, day, business, summary, call_ids, item_ids, counts, calls_count, total_duration_sec, provider, model, cost)
       VALUES ($1, $2, $3, $4::date, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14::jsonb) RETURNING id`,
      [r.accountId, r.leadId, r.contactId, r.day, r.business, JSON.stringify(r.summary), JSON.stringify(r.callIds), JSON.stringify(r.itemIds), r.counts ? JSON.stringify(r.counts) : null, r.callsCount, r.totalDurationSec, r.provider, r.model, r.cost ? JSON.stringify(r.cost) : null],
    );
    return Number(rows[0]?.id ?? 0);
  }

  /** id записей общения, уже вошедших в итоги этого дня по сделке (или контакту) — повторный запуск берёт только новое. */
  async summarizedItemIds(accountId: number, where: { leadId: number | null; contactId: number | null }, day: string): Promise<Set<string>> {
    const { rows } = await this.db.query<{ item_ids: string[] }>(
      `SELECT item_ids FROM call_day_summaries WHERE account_id = $1 AND day = $2::date AND (($3::bigint IS NOT NULL AND lead_id = $3) OR ($3::bigint IS NULL AND contact_id = $4))`,
      [accountId, day, where.leadId, where.contactId],
    );
    return new Set(rows.flatMap((r) => r.item_ids ?? []));
  }

  async setNote(id: number, note: { noteId: number; entity: 'lead' | 'contact'; text: string }): Promise<void> {
    await this.db.query(`UPDATE call_day_summaries SET note_id = $2, note_entity = $3, note_text = $4 WHERE id = $1`, [id, note.noteId, note.entity, note.text]);
  }

  async get(accountId: number, id: number): Promise<DaySummaryRow | null> {
    const { rows } = await this.db.query('SELECT * FROM call_day_summaries WHERE account_id = $1 AND id = $2', [accountId, id]);
    return rows[0] ? mapDay(rows[0]) : null;
  }

  /** Итоги по сделке за день (несколько — если итог делали повторно по новым звонкам), ранние сверху. */
  async forLead(accountId: number, leadId: number, day: string): Promise<DaySummaryRow[]> {
    const { rows } = await this.db.query('SELECT * FROM call_day_summaries WHERE account_id = $1 AND lead_id = $2 AND day = $3::date ORDER BY id ASC', [accountId, leadId, day]);
    return rows.map(mapDay);
  }

  /** Итоги, опубликованные (created_at) в окне — для списка «что опубликовано за день» (calls-inspect --day-summaries). */
  async listCreatedBetween(accountId: number, from: Date, to: Date): Promise<DaySummaryRow[]> {
    const { rows } = await this.db.query('SELECT * FROM call_day_summaries WHERE account_id = $1 AND created_at >= $2 AND created_at < $3 ORDER BY created_at ASC, id ASC', [accountId, from, to]);
    return rows.map(mapDay);
  }

  async list(accountId: number, opts: { leadId?: number; limit?: number } = {}): Promise<DaySummaryRow[]> {
    const params: unknown[] = [accountId];
    let where = 'account_id = $1';
    if (opts.leadId) {
      params.push(opts.leadId);
      where += ` AND lead_id = $${params.length}`;
    }
    params.push(Math.min(opts.limit ?? 50, 500));
    const { rows } = await this.db.query(`SELECT * FROM call_day_summaries WHERE ${where} ORDER BY day DESC, id DESC LIMIT $${params.length}`, params);
    return rows.map(mapDay);
  }
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function mapCall(r: Record<string, unknown>): CallRow {
  return {
    id: Number(r.id),
    accountId: Number(r.account_id),
    noteId: Number(r.note_id),
    entity: r.entity as CallEntity,
    entityId: Number(r.entity_id),
    recordKey: String(r.record_key),
    direction: r.direction as 'in' | 'out',
    phone: String(r.phone ?? ''),
    durationSec: Number(r.duration_sec),
    callStatus: num(r.call_status),
    link: String(r.link),
    calledAt: r.called_at as Date,
    noteUpdatedAt: r.note_updated_at as Date,
    managerId: num(r.manager_id),
    leadId: num(r.lead_id),
    status: r.status as CallStatus,
    stage: (r.stage as CallStage | null) ?? null,
    error: (r.error as string | null) ?? null,
    attempts: Number(r.attempts ?? 0),
    sttMode: (r.stt_mode as SttMode) ?? 'async',
    alertedAt: (r.alerted_at as Date | null) ?? null,
    filePath: (r.file_path as string | null) ?? null,
    fileBytes: num(r.file_bytes),
    fileMime: (r.file_mime as string | null) ?? null,
    downloadedAt: (r.downloaded_at as Date | null) ?? null,
    fileDeletedAt: (r.file_deleted_at as Date | null) ?? null,
    transcript: (r.transcript as TranscriptField | null) ?? null,
    cost: (r.cost as Record<string, unknown> | null) ?? null,
    daySummaryId: num(r.day_summary_id),
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  };
}

/** Колонка day приходит из pg как Date (полночь UTC) или строкой — в ГГГГ-ММ-ДД. */
const dayStr = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

function mapDay(r: Record<string, unknown>): DaySummaryRow {
  return {
    id: Number(r.id),
    accountId: Number(r.account_id),
    leadId: num(r.lead_id),
    contactId: num(r.contact_id),
    day: dayStr(r.day),
    business: Boolean(r.business),
    summary: r.summary as DaySummary,
    callIds: ((r.call_ids as number[] | null) ?? []).map(Number),
    itemIds: ((r.item_ids as string[] | null) ?? []).map(String),
    counts: (r.counts as DaySummaryRow['counts']) ?? null,
    callsCount: Number(r.calls_count ?? 0),
    totalDurationSec: Number(r.total_duration_sec ?? 0),
    noteId: num(r.note_id),
    noteEntity: (r.note_entity as 'lead' | 'contact' | null) ?? null,
    noteText: (r.note_text as string | null) ?? null,
    provider: (r.provider as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    cost: (r.cost as Record<string, unknown> | null) ?? null,
    createdAt: r.created_at as Date,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// RFD-AI-AGENT-REFUSAL-ANALYSIS: анализ сделки при переносе в «Отказ» — одна строка на один переход (event_id).

export interface RefusalRow {
  id: number;
  accountId: number;
  leadId: number;
  eventId: string;
  changedAt: Date;
  statusId: number;
  pipelineId: number;
  analysis: RefusalAnalysis | null;
  counts: { calls: number; messages: number; emails: number; notes: number } | null;
  itemIds: string[];
  noteId: number | null;
  noteText: string | null;
  taskId: number | null;
  taskUpdated: boolean;
  provider: string | null;
  model: string | null;
  cost: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  /** Раньше этого не запускать (задержка после перехода, ожидание записи звонка). */
  nextTryAt: Date | null;
  /** Факты общения без текста: короткие звонки, звонки без записи, чаты без текста. */
  facts: string[];
  createdAt: Date;
}

const mapRefusal = (r: Record<string, unknown>): RefusalRow => ({
  id: Number(r.id),
  accountId: Number(r.account_id),
  leadId: Number(r.lead_id),
  eventId: String(r.event_id),
  changedAt: r.changed_at as Date,
  statusId: Number(r.status_id),
  pipelineId: Number(r.pipeline_id),
  analysis: (r.analysis as RefusalAnalysis | null) ?? null,
  counts: (r.counts as RefusalRow['counts']) ?? null,
  itemIds: (r.item_ids as string[]) ?? [],
  noteId: r.note_id === null || r.note_id === undefined ? null : Number(r.note_id),
  noteText: (r.note_text as string | null) ?? null,
  taskId: r.task_id === null || r.task_id === undefined ? null : Number(r.task_id),
  taskUpdated: Boolean(r.task_updated),
  provider: (r.provider as string | null) ?? null,
  model: (r.model as string | null) ?? null,
  cost: (r.cost as Record<string, unknown> | null) ?? null,
  error: (r.error as string | null) ?? null,
  attempts: Number(r.attempts ?? 0),
  nextTryAt: (r.next_try_at as Date | null) ?? null,
  facts: (r.facts as string[] | null) ?? [],
  createdAt: r.created_at as Date,
});

export class RefusalsRepo {
  constructor(private readonly db: Db) {}

  /** Занять переход: строка на событие; уже есть — null (защита от дублей при повторном событии / перекрытии окон опроса). */
  async claim(r: { accountId: number; leadId: number; eventId: string; changedAt: Date; statusId: number; pipelineId: number; nextTryAt?: Date | null }): Promise<number | null> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO refusal_analyses (account_id, lead_id, event_id, changed_at, status_id, pipeline_id, next_try_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (account_id, event_id) DO NOTHING RETURNING id`,
      [r.accountId, r.leadId, r.eventId, r.changedAt, r.statusId, r.pipelineId, r.nextTryAt ?? null],
    );
    return rows[0] ? Number(rows[0].id) : null;
  }

  async setResult(id: number, r: { analysis: RefusalAnalysis | null; counts: RefusalRow['counts']; itemIds: string[]; facts?: string[]; noteId: number | null; noteText: string | null; taskId: number | null; taskUpdated: boolean; provider: string | null; model: string | null; cost: Record<string, unknown> | null }): Promise<void> {
    await this.db.query(
      `UPDATE refusal_analyses SET analysis = $2::jsonb, counts = $3::jsonb, item_ids = $4::jsonb, note_id = $5, note_text = $6, task_id = $7, task_updated = $8, provider = $9, model = $10, cost = $11::jsonb, facts = $12::jsonb, error = NULL, next_try_at = NULL, updated_at = now() WHERE id = $1`,
      [id, r.analysis ? JSON.stringify(r.analysis) : null, r.counts ? JSON.stringify(r.counts) : null, JSON.stringify(r.itemIds), r.noteId, r.noteText, r.taskId, r.taskUpdated, r.provider, r.model, r.cost ? JSON.stringify(r.cost) : null, JSON.stringify(r.facts ?? [])],
    );
  }

  /** Ошибка разбора: попытка засчитана, повтор не раньше retryAt. */
  async setError(id: number, error: string, retryAt: Date | null = null): Promise<void> {
    await this.db.query(`UPDATE refusal_analyses SET error = $2, attempts = attempts + 1, next_try_at = $3, updated_at = now() WHERE id = $1`, [id, error.slice(0, 2000), retryAt]);
  }

  /** Отложить (ждём запись звонка): попытка не тратится. */
  async postpone(id: number, until: Date, reason: string): Promise<void> {
    await this.db.query(`UPDATE refusal_analyses SET next_try_at = $2, error = NULL, facts = $3::jsonb, updated_at = now() WHERE id = $1`, [id, until, JSON.stringify([reason])]);
  }

  /** К запуску: без примечания, срок наступил (или не задан), попыток меньше max. */
  async listDue(accountId: number, now: Date, maxAttempts: number, limit = 20): Promise<RefusalRow[]> {
    const { rows } = await this.db.query(`SELECT * FROM refusal_analyses WHERE account_id = $1 AND note_id IS NULL AND attempts < $2 AND (next_try_at IS NULL OR next_try_at <= $3) ORDER BY changed_at ASC LIMIT $4`, [accountId, maxAttempts, now, limit]);
    return rows.map(mapRefusal);
  }

  async get(accountId: number, id: number): Promise<RefusalRow | null> {
    const { rows } = await this.db.query('SELECT * FROM refusal_analyses WHERE account_id = $1 AND id = $2', [accountId, id]);
    return rows[0] ? mapRefusal(rows[0]) : null;
  }

  /** Незавершённые (ошибка, попыток меньше max) — повтор при следующем опросе. */
  async listRetry(accountId: number, maxAttempts: number, limit = 20): Promise<RefusalRow[]> {
    const { rows } = await this.db.query(`SELECT * FROM refusal_analyses WHERE account_id = $1 AND note_id IS NULL AND error IS NOT NULL AND attempts < $2 ORDER BY changed_at ASC LIMIT $3`, [accountId, maxAttempts, limit]);
    return rows.map(mapRefusal);
  }

  /** Есть ли по сделке записанный анализ отказа с переходом не раньше since: он охватывает всю историю, итог дня за этот день не нужен (RFD-AI-AGENT-CALLS-DAY-FIX2, п. 2). */
  async coversSince(accountId: number, leadId: number, since: Date): Promise<RefusalRow | null> {
    const { rows } = await this.db.query('SELECT * FROM refusal_analyses WHERE account_id = $1 AND lead_id = $2 AND note_id IS NOT NULL AND changed_at >= $3 ORDER BY changed_at DESC LIMIT 1', [accountId, leadId, since]);
    return rows[0] ? mapRefusal(rows[0]) : null;
  }

  /** Ждут срока (next_try_at в будущем) и ещё без примечания. */
  async countWaiting(accountId: number, now: Date, maxAttempts: number): Promise<number> {
    const { rows } = await this.db.query<{ n: string }>(`SELECT count(*) AS n FROM refusal_analyses WHERE account_id = $1 AND note_id IS NULL AND attempts < $2 AND next_try_at > $3`, [accountId, maxAttempts, now]);
    return Number(rows[0]?.n ?? 0);
  }

  async forLead(accountId: number, leadId: number): Promise<RefusalRow[]> {
    const { rows } = await this.db.query('SELECT * FROM refusal_analyses WHERE account_id = $1 AND lead_id = $2 ORDER BY changed_at ASC, id ASC', [accountId, leadId]);
    return rows.map(mapRefusal);
  }

  async list(accountId: number, limit = 100): Promise<RefusalRow[]> {
    const { rows } = await this.db.query('SELECT * FROM refusal_analyses WHERE account_id = $1 ORDER BY id ASC LIMIT $2', [accountId, limit]);
    return rows.map(mapRefusal);
  }
}
