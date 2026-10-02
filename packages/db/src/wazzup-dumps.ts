import type { Db } from './pool.ts';
import type { WazzupMessage } from './wazzup.ts';

export type WazzupDumpStatus = 'queued' | 'pending' | 'processing' | 'done' | 'failed';

export interface WazzupDump {
  id: number;
  accountId: number;
  exportId: string | null;
  channelId: string | null;
  startAt: Date;
  endAt: Date;
  status: WazzupDumpStatus;
  url: string | null;
  columns: string | null;
  rowsTotal: number;
  inserted: number;
  skipped: number;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

interface Row {
  id: string; account_id: string; export_id: string | null; channel_id: string | null;
  start_at: Date; end_at: Date; status: WazzupDumpStatus; url: string | null; columns: string | null;
  rows_total: number; inserted: number; skipped: number; error: string | null;
  created_at: Date; updated_at: Date; finished_at: Date | null;
}

const COLS = 'id, account_id, export_id, channel_id, start_at, end_at, status, url, columns, rows_total, inserted, skipped, error, created_at, updated_at, finished_at';

function toDump(r: Row): WazzupDump {
  return {
    id: Number(r.id), accountId: Number(r.account_id), exportId: r.export_id, channelId: r.channel_id,
    startAt: r.start_at, endAt: r.end_at, status: r.status, url: r.url, columns: r.columns,
    rowsTotal: r.rows_total, inserted: r.inserted, skipped: r.skipped, error: r.error,
    createdAt: r.created_at, updatedAt: r.updated_at, finishedAt: r.finished_at,
  };
}

type Patch = Partial<Pick<WazzupDump, 'exportId' | 'status' | 'url' | 'columns' | 'rowsTotal' | 'inserted' | 'skipped' | 'error'>> & { finished?: boolean };

/** Выгрузки истории Wazzup (messages_dump): заявка → export_id → CSV → строки в wazzup_messages. */
export class WazzupDumpRepo {
  constructor(private readonly db: Db) {}

  async create(accountId: number, p: { startAt: Date; endAt: Date; channelId?: string | null; userId?: number | null }): Promise<WazzupDump> {
    const { rows } = await this.db.query<Row>(
      `INSERT INTO wazzup_dumps (account_id, channel_id, start_at, end_at, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING ${COLS}`,
      [accountId, p.channelId ?? null, p.startAt, p.endAt, p.userId ?? null],
    );
    return toDump(rows[0]!);
  }

  async list(accountId: number, limit = 10): Promise<WazzupDump[]> {
    const { rows } = await this.db.query<Row>(`SELECT ${COLS} FROM wazzup_dumps WHERE account_id = $1 ORDER BY id DESC LIMIT $2`, [accountId, limit]);
    return rows.map(toDump);
  }

  /** Незавершённые заявки всех аккаунтов — для планового опроса воркером. */
  async active(): Promise<WazzupDump[]> {
    const { rows } = await this.db.query<Row>(`SELECT ${COLS} FROM wazzup_dumps WHERE status IN ('queued','pending','processing') ORDER BY id`);
    return rows.map(toDump);
  }

  async hasActive(accountId: number): Promise<boolean> {
    const { rows } = await this.db.query(`SELECT 1 FROM wazzup_dumps WHERE account_id = $1 AND status IN ('queued','pending','processing') LIMIT 1`, [accountId]);
    return rows.length > 0;
  }

  async update(id: number, p: Patch): Promise<void> {
    await this.db.query(
      `UPDATE wazzup_dumps SET
         export_id = COALESCE($2, export_id), status = COALESCE($3, status), url = COALESCE($4, url),
         columns = COALESCE($5, columns), rows_total = COALESCE($6, rows_total), inserted = COALESCE($7, inserted),
         skipped = COALESCE($8, skipped), error = $9, updated_at = now(),
         finished_at = CASE WHEN $10::boolean THEN now() ELSE finished_at END
       WHERE id = $1`,
      [id, p.exportId ?? null, p.status ?? null, p.url ?? null, p.columns ?? null, p.rowsTotal ?? null, p.inserted ?? null, p.skipped ?? null, p.error ?? null, p.finished ?? false],
    );
  }

  /** Строка из выгрузки: только вставка — то, что уже пришло по вебхукам, не трогаем. */
  async insertFromDump(accountId: number, m: WazzupMessage): Promise<boolean> {
    const { rows } = await this.db.query(
      `INSERT INTO wazzup_messages (account_id, message_id, channel_id, chat_id, chat_type, phone, direction, author, text, status, is_system, sent_at, source, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'dump',$13)
       ON CONFLICT (account_id, message_id) DO NOTHING RETURNING id`,
      [accountId, m.messageId, m.channelId, m.chatId, m.chatType, m.phone, m.direction, m.author, m.text, m.status, m.isSystem, m.sentAt, m.raw ?? null],
    );
    return rows.length > 0;
  }
}
