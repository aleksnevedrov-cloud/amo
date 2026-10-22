import type { Db } from '@core/db';
import type { CallEntity, ParsedCallNote } from './notes.ts';
import type { CallTranscript, PendingTranscription, SttMode } from './stt.ts';

/** Поле transcript: готовая расшифровка либо запущенная операция SpeechKit (статус остаётся downloaded). */
export type TranscriptField = CallTranscript | { pending: PendingTranscription };
/** Шаги обработки после скачивания; на каждом возможен failed с повтором. */
export type CallStage = 'transcribe' | 'analyze' | 'post';
export const CALL_STAGES: CallStage[] = ['transcribe', 'analyze', 'post'];

/** Статусы звонка: цепочка обработки и два конечных «не вышло». */
export type CallStatus = 'new' | 'downloaded' | 'transcribed' | 'analyzed' | 'posted' | 'unavailable' | 'failed';

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
  stage: string | null;
  error: string | null;
  filePath: string | null;
  fileBytes: number | null;
  fileMime: string | null;
  downloadedAt: Date | null;
  fileDeletedAt: Date | null;
  transcript: TranscriptField | null;
  analysis: Record<string, unknown> | null;
  posted: Record<string, unknown> | null;
  cost: Record<string, unknown> | null;
  /** Сколько раз шаг (stage) падал; после 3 — алерт, повторов нет. */
  attempts: number;
  sttMode: SttMode;
  alertedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CallsSync {
  lastUpdatedAt: Date;
  lastRunAt: Date | null;
  lastError: string | null;
}

/** Таблицы calls и calls_sync (БД опта). */
export class CallsRepo {
  constructor(private readonly db: Db) {}

  /** Аккаунты, у которых интеграция установлена, — кандидаты на опрос (сам опрос зависит от настройки calls.enabled). */
  async installedAccountIds(): Promise<number[]> {
    const { rows } = await this.db.query<{ id: string }>('SELECT id FROM accounts WHERE uninstalled_at IS NULL ORDER BY id');
    return rows.map((r) => Number(r.id));
  }

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

  /** Звонки аккаунта (последние сверху); по сделке — её звонки и звонки её контактов (по lead_id). */
  async list(accountId: number, opts: { leadId?: number; limit?: number; offset?: number } = {}): Promise<CallRow[]> {
    const params: unknown[] = [accountId];
    let where = 'account_id = $1';
    if (opts.leadId) {
      params.push(opts.leadId);
      where += ` AND lead_id = $${params.length}`;
    }
    params.push(Math.min(opts.limit ?? 50, 200), opts.offset ?? 0);
    const { rows } = await this.db.query(`SELECT * FROM calls WHERE ${where} ORDER BY called_at DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return rows.map(mapCall);
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

  /** Запись не отдаётся (404, не аудио, чужой хост, старый OnlinePBX) — конечный статус, повторов нет. */
  async setUnavailable(id: number, reason: string): Promise<void> {
    await this.db.query(`UPDATE calls SET status = 'unavailable', stage = 'download', error = $2, updated_at = now() WHERE id = $1`, [id, reason.slice(0, 1000)]);
  }

  /** Ошибка на шаге; статус failed, при следующем опросе шаг повторяется (download) или ждёт «Обработать заново». */
  async setFailed(id: number, stage: string, error: string): Promise<void> {
    await this.db.query(`UPDATE calls SET status = 'failed', stage = $2, error = $3, updated_at = now() WHERE id = $1`, [id, stage, error.slice(0, 1000)]);
  }

  /** Сколько раз скачивание уже падало — по журналу не считаем, хватает поля error; повтор решает вызывающий. */
  async listFailedAt(accountId: number, stage: string, limit = 20): Promise<CallRow[]> {
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

  /** Какие из примечаний уже есть в calls (для оценки догрузки до запуска). */
  async existingNoteIds(accountId: number, noteIds: number[]): Promise<Set<number>> {
    if (!noteIds.length) return new Set();
    const { rows } = await this.db.query<{ note_id: string }>('SELECT note_id FROM calls WHERE account_id = $1 AND note_id = ANY($2::bigint[])', [accountId, noteIds]);
    return new Set(rows.map((r) => Number(r.note_id)));
  }

  /**
   * Звонки на обработку (этапы 2–3): скачанные, расшифрованные, разобранные без примечания; упавшие на шагах
   * transcribe / analyze / post — не раньше retryBefore и не больше maxAttempts попыток. От старых к новым.
   */
  async listForProcessing(accountId: number, o: { retryBefore: Date; maxAttempts: number; limit: number }): Promise<CallRow[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM calls
        WHERE account_id = $1
          AND (status IN ('downloaded', 'transcribed') OR (status = 'analyzed' AND posted IS NULL)
               OR (status = 'failed' AND stage = ANY($2::text[]) AND attempts < $3 AND updated_at < $4))
        ORDER BY called_at ASC, id ASC
        LIMIT $5`,
      [accountId, CALL_STAGES, o.maxAttempts, o.retryBefore, o.limit],
    );
    return rows.map(mapCall);
  }

  /** Расшифровка: готовая — статус transcribed; запущенная операция — статус остаётся downloaded. */
  async setTranscript(id: number, transcript: TranscriptField, status: 'transcribed' | 'downloaded'): Promise<void> {
    await this.db.query(`UPDATE calls SET transcript = $2::jsonb, status = $3, stage = NULL, error = NULL, updated_at = now() WHERE id = $1`, [id, JSON.stringify(transcript), status]);
  }

  async setAnalysis(id: number, analysis: Record<string, unknown>, transcript?: TranscriptField): Promise<void> {
    await this.db.query(
      `UPDATE calls SET analysis = $2::jsonb, transcript = COALESCE($3::jsonb, transcript), status = 'analyzed', stage = NULL, error = NULL, updated_at = now() WHERE id = $1`,
      [id, JSON.stringify(analysis), transcript ? JSON.stringify(transcript) : null],
    );
  }

  /** Примечание создано (status posted) или намеренно не пишется (status analyzed, posted — причина). */
  async setPosted(id: number, posted: Record<string, unknown>, status: 'posted' | 'analyzed'): Promise<void> {
    await this.db.query(`UPDATE calls SET posted = $2::jsonb, status = $3, stage = NULL, error = NULL, updated_at = now() WHERE id = $1`, [id, JSON.stringify(posted), status]);
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

  async getSync(accountId: number, entity: CallEntity): Promise<CallsSync | null> {
    const { rows } = await this.db.query<{ last_updated_at: Date; last_run_at: Date | null; last_error: string | null }>('SELECT last_updated_at, last_run_at, last_error FROM calls_sync WHERE account_id = $1 AND entity = $2', [accountId, entity]);
    const r = rows[0];
    return r ? { lastUpdatedAt: r.last_updated_at, lastRunAt: r.last_run_at, lastError: r.last_error } : null;
  }

  async setSync(accountId: number, entity: CallEntity, s: { lastUpdatedAt: Date; lastError: string | null }): Promise<void> {
    await this.db.query(
      `INSERT INTO calls_sync (account_id, entity, last_updated_at, last_run_at, last_error) VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (account_id, entity) DO UPDATE SET last_updated_at = EXCLUDED.last_updated_at, last_run_at = now(), last_error = EXCLUDED.last_error`,
      [accountId, entity, s.lastUpdatedAt, s.lastError],
    );
  }
}

function mapCall(r: Record<string, unknown>): CallRow {
  const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
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
    callStatus: n(r.call_status),
    link: String(r.link),
    calledAt: r.called_at as Date,
    noteUpdatedAt: r.note_updated_at as Date,
    managerId: n(r.manager_id),
    leadId: n(r.lead_id),
    status: r.status as CallStatus,
    stage: (r.stage as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    filePath: (r.file_path as string | null) ?? null,
    fileBytes: n(r.file_bytes),
    fileMime: (r.file_mime as string | null) ?? null,
    downloadedAt: (r.downloaded_at as Date | null) ?? null,
    fileDeletedAt: (r.file_deleted_at as Date | null) ?? null,
    transcript: (r.transcript as TranscriptField | null) ?? null,
    analysis: (r.analysis as Record<string, unknown> | null) ?? null,
    posted: (r.posted as Record<string, unknown> | null) ?? null,
    cost: (r.cost as Record<string, unknown> | null) ?? null,
    attempts: Number(r.attempts ?? 0),
    sttMode: (r.stt_mode as SttMode) ?? 'async',
    alertedAt: (r.alerted_at as Date | null) ?? null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  };
}
