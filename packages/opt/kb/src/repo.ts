import { withTransaction, type Db } from '@core/db';
import type { ChunkMeta } from './chunk.ts';
import { toVectorLiteral } from './embeddings.ts';

/** Лимиты на аккаунт (ТЗ раздел 3): 500 МБ источников и 20 000 фрагментов. */
export const KB_LIMIT_BYTES = 500 * 1024 * 1024;
export const KB_LIMIT_CHUNKS = 20_000;

export type KbSourceKind = 'file' | 'url' | 'text';
export type KbSourceStatus = 'new' | 'indexed' | 'error';

export interface KbSource {
  id: number;
  accountId: number;
  kind: KbSourceKind;
  title: string;
  original: string | null;
  filePath: string | null;
  mime: string | null;
  status: KbSourceStatus;
  sizeBytes: number;
  chunks: number;
  embeddedChunks: number;
  refreshDays: number | null;
  nextRefreshAt: Date | null;
  error: string | null;
  createdBy: number | null;
  createdAt: Date;
  updatedAt: Date;
  indexedAt: Date | null;
  /** Ссылка-раздел: при индексации найденные страницы раздела добавляются источниками-детьми (до 50). */
  crawl: boolean;
  parentId: number | null;
  httpStatus: number | null;
  contentHash: string | null;
  /** Ключ прайса (KB-MULTIPRICE): нормализованное имя файла; NULL — источник не прайс. */
  priceKey: string | null;
  /** Итог последнего импорта цен из этого файла. */
  priceImport: PriceImportSummary | null;
  /** KP-AGENT-V2, п. 4а: сайт — комментарий менеджера «какие двери есть на сайте» и флаг «фабрика». */
  comment: string | null;
  isFactory: boolean;
  /** KB-MARKUP: наценка прайса в % (−50…300): цена КП = цена фабрики × (1 + N / 100); 0 — без наценки. */
  markupPct: number;
}

export interface PriceImportSummary {
  /** Короткое название прайса («Межкомнатные»). */
  title: string;
  /** Файл с тем же ключом уже был: это обновление, а не новый прайс. */
  updated: boolean;
  was: number;
  imported: number;
  removed: number;
  added: number;
  at: string;
  /** Многолистовой прайс (KB-PRICE-SHEETS): счётчики по вкладкам и что пропущено. */
  book?: { doors: number; components: number; hardware: number; hardwareUnpriced: number; estimates: number; sizes: number; aliases: number; comments: number; dictionary: number; skipped: string[] } | null;
  /** Импорт отменён (ошибка на вкладке, расхождение тарифа): причина для карточки источника; прежние данные прайса сохранены. */
  error?: string | null;
}

export interface NewKbSource {
  accountId: number;
  kind: KbSourceKind;
  title: string;
  original?: string | null;
  filePath?: string | null;
  mime?: string | null;
  sizeBytes?: number;
  refreshDays?: number | null;
  createdBy?: number | null;
  crawl?: boolean;
  parentId?: number | null;
}

export interface KbChunkRow {
  id: number;
  sourceId: number;
  position: number;
  text: string;
  meta: ChunkMeta;
  hasEmbedding: boolean;
}

export interface KbChunkInsert {
  position: number;
  text: string;
  meta: ChunkMeta;
  embedding: number[] | null;
}

export interface KbSearchRow {
  chunkId: number;
  sourceId: number;
  position: number;
  text: string;
  meta: ChunkMeta;
  /** Косинусная близость (вектор) или ранг ts_rank_cd (полнотекстовый). */
  score: number;
}

export interface KbUsage {
  sources: number;
  bytes: number;
  chunks: number;
  limits: { bytes: number; chunks: number };
}

export class KbRepo {
  constructor(private readonly db: Db) {}

  async createSource(s: NewKbSource): Promise<number> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO kb_sources (account_id, kind, title, original, file_path, mime, size_bytes, refresh_days, next_refresh_at, created_by, crawl, parent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $8::int IS NULL THEN NULL ELSE now() + make_interval(days => $8::int) END, $9, $10, $11)
       RETURNING id`,
      [s.accountId, s.kind, s.title.slice(0, 500), s.original ?? null, s.filePath ?? null, s.mime ?? null, s.sizeBytes ?? 0, s.refreshDays ?? null, s.createdBy ?? null, s.crawl ?? false, s.parentId ?? null],
    );
    return Number(rows[0]?.id ?? 0);
  }

  async setFilePath(id: number, filePath: string, sizeBytes: number): Promise<void> {
    await this.db.query('UPDATE kb_sources SET file_path = $2, size_bytes = $3, updated_at = now() WHERE id = $1', [id, filePath, sizeBytes]);
  }

  async get(accountId: number, id: number): Promise<KbSource | null> {
    const { rows } = await this.db.query('SELECT * FROM kb_sources WHERE account_id = $1 AND id = $2', [accountId, id]);
    return rows[0] ? mapSource(rows[0]) : null;
  }

  /** Ссылка уже добавлена в этот аккаунт? */
  async findUrl(accountId: number, url: string): Promise<KbSource | null> {
    const { rows } = await this.db.query("SELECT * FROM kb_sources WHERE account_id = $1 AND kind = 'url' AND original = $2", [accountId, url]);
    return rows[0] ? mapSource(rows[0]) : null;
  }

  /** Ссылки, у которых подошёл срок обновления; каждая сразу переводится в new, чтобы соседний запуск её не взял. */
  async takeDueForRefresh(limit = 20): Promise<KbSource[]> {
    const { rows } = await this.db.query(
      `UPDATE kb_sources SET status = 'new', error = NULL, updated_at = now()
        WHERE id IN (SELECT id FROM kb_sources WHERE kind = 'url' AND status <> 'new' AND next_refresh_at IS NOT NULL AND next_refresh_at <= now() ORDER BY next_refresh_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [limit],
    );
    return rows.map(mapSource);
  }

  async setTitle(id: number, title: string): Promise<void> {
    await this.db.query('UPDATE kb_sources SET title = $2, updated_at = now() WHERE id = $1', [id, title.slice(0, 500)]);
  }

  async setFetchInfo(id: number, info: { httpStatus: number | null; contentHash: string | null; mime: string | null; refreshDays?: number | null }): Promise<void> {
    await this.db.query('UPDATE kb_sources SET http_status = $2, content_hash = $3, mime = COALESCE($4, mime), refresh_days = COALESCE($5, refresh_days), updated_at = now() WHERE id = $1', [id, info.httpStatus, info.contentHash, info.mime, info.refreshDays ?? null]);
  }

  /** Ключ прайса и итог импорта у файла (KB-MULTIPRICE). */
  async setPriceInfo(id: number, priceKey: string, priceImport: PriceImportSummary | null): Promise<void> {
    await this.db.query('UPDATE kb_sources SET price_key = $2, price_import = COALESCE($3::jsonb, price_import) WHERE id = $1', [id, priceKey, priceImport ? JSON.stringify(priceImport) : null]);
  }

  /** Источники аккаунта с тем же ключом прайса (кроме указанного). */
  async byPriceKey(accountId: number, priceKey: string, exceptId: number | null = null): Promise<KbSource[]> {
    const { rows } = await this.db.query('SELECT * FROM kb_sources WHERE account_id = $1 AND price_key = $2 AND ($3::bigint IS NULL OR id <> $3) ORDER BY created_at', [accountId, priceKey, exceptId]);
    return rows.map(mapSource);
  }

  /** Старые прайсы без ключа (до KB-MULTIPRICE): ключ из имени файла у источников, у которых есть цены прайса — один раз при старте. */
  async backfillPriceKeys(keyOf: (name: string) => string): Promise<number> {
    const { rows } = await this.db.query<{ id: string; title: string; original: string | null }>(
      "SELECT s.id, s.title, s.original FROM kb_sources s WHERE s.price_key IS NULL AND EXISTS (SELECT 1 FROM kb_prices p WHERE p.source_id = s.id AND p.origin = 'price_list')",
    );
    for (const r of rows) await this.db.query('UPDATE kb_sources SET price_key = $2 WHERE id = $1', [Number(r.id), keyOf(r.original ?? r.title)]);
    return rows.length;
  }

  /** Комментарий и флаг «фабрика» сайта (п. 4а); пустой комментарий — NULL. */
  async setSiteMeta(accountId: number, id: number, meta: { comment?: string | null; isFactory?: boolean }): Promise<KbSource | null> {
    const comment = meta.comment === undefined ? undefined : meta.comment?.trim().slice(0, 2000) || null;
    const { rows } = await this.db.query(
      `UPDATE kb_sources SET comment = CASE WHEN $3::boolean THEN $4::text ELSE comment END, is_factory = COALESCE($5::boolean, is_factory), updated_at = now()
       WHERE account_id = $1 AND id = $2 AND kind = 'url' RETURNING *`,
      [accountId, id, comment !== undefined, comment ?? null, meta.isFactory ?? null],
    );
    return rows[0] ? mapSource(rows[0]) : null;
  }

  /** KB-MARKUP: наценка прайса-источника; возвращает прежнее значение и обновлённый источник (для журнала «было → стало»). */
  async setMarkup(accountId: number, id: number, markupPct: number): Promise<{ before: number; source: KbSource } | null> {
    const { rows } = await this.db.query(
      `UPDATE kb_sources s SET markup_pct = $3, updated_at = now() FROM (SELECT id, markup_pct AS before FROM kb_sources WHERE account_id = $1 AND id = $2 FOR UPDATE) o
        WHERE s.id = o.id RETURNING s.*, o.before`,
      [accountId, id, markupPct],
    );
    return rows[0] ? { before: Number(rows[0].before ?? 0), source: mapSource(rows[0]) } : null;
  }

  /**
   * KB-MARKUP: повторная загрузка того же прайса (новый файл с тем же ключом) — наценка прежнего файла переходит к новому,
   * если у нового она ещё не задана. Возвращает перенесённую наценку или null.
   */
  async inheritMarkup(accountId: number, id: number, fromIds: number[]): Promise<number | null> {
    if (!fromIds.length) return null;
    const { rows } = await this.db.query<{ markup_pct: string }>(
      `UPDATE kb_sources SET markup_pct = o.markup_pct
         FROM (SELECT markup_pct FROM kb_sources WHERE account_id = $1 AND id = ANY($3::bigint[]) AND markup_pct <> 0 ORDER BY created_at DESC, id DESC LIMIT 1) o
        WHERE kb_sources.account_id = $1 AND kb_sources.id = $2 AND kb_sources.markup_pct = 0
        RETURNING kb_sources.markup_pct`,
      [accountId, id, fromIds],
    );
    return rows[0] ? Number(rows[0].markup_pct) : null;
  }

  /**
   * KB-MARKUP: текущая наценка прайса для пересчёта черновика — по источнику строки; источника уже нет (файл заменён
   * повторной загрузкой) — по самому свежему файлу с тем же ключом прайса. Ничего не нашлось — null.
   */
  async markupOf(accountId: number, sourceId: number | null, priceKey: string | null): Promise<number | null> {
    if (sourceId !== null) {
      const { rows } = await this.db.query<{ markup_pct: string }>('SELECT markup_pct FROM kb_sources WHERE account_id = $1 AND id = $2', [accountId, sourceId]);
      if (rows[0]) return Number(rows[0].markup_pct);
    }
    if (!priceKey) return null;
    const { rows } = await this.db.query<{ markup_pct: string }>('SELECT markup_pct FROM kb_sources WHERE account_id = $1 AND price_key = $2 ORDER BY created_at DESC, id DESC LIMIT 1', [accountId, priceKey]);
    return rows[0] ? Number(rows[0].markup_pct) : null;
  }

  /** Сайты-источники (ссылки верхнего уровня, без страниц-детей раздела) — для выбора, где искать цену. */
  async sites(accountId: number): Promise<KbSource[]> {
    const { rows } = await this.db.query("SELECT * FROM kb_sources WHERE account_id = $1 AND kind = 'url' AND parent_id IS NULL ORDER BY is_factory DESC, id", [accountId]);
    return rows.map(mapSource);
  }

  async list(accountId: number): Promise<KbSource[]> {
    const { rows } = await this.db.query('SELECT * FROM kb_sources WHERE account_id = $1 ORDER BY created_at DESC, id DESC', [accountId]);
    return rows.map(mapSource);
  }

  /** Удаляет источник и его фрагменты (каскад); возвращает удалённую запись, чтобы убрать файл с тома. */
  async remove(accountId: number, id: number): Promise<KbSource | null> {
    const { rows } = await this.db.query('DELETE FROM kb_sources WHERE account_id = $1 AND id = $2 RETURNING *', [accountId, id]);
    return rows[0] ? mapSource(rows[0]) : null;
  }

  /** Источник снова в очередь: статус new, старые фрагменты остаются до успешной переиндексации. */
  async markNew(id: number): Promise<void> {
    await this.db.query("UPDATE kb_sources SET status = 'new', error = NULL, updated_at = now() WHERE id = $1", [id]);
  }

  async markIndexed(id: number, r: { chunks: number; embeddedChunks: number; sizeBytes?: number }): Promise<void> {
    await this.db.query(
      `UPDATE kb_sources
          SET status = 'indexed', error = NULL, chunks = $2, embedded_chunks = $3, size_bytes = COALESCE($4, size_bytes),
              indexed_at = now(), updated_at = now(),
              next_refresh_at = CASE WHEN refresh_days IS NULL THEN NULL ELSE now() + make_interval(days => refresh_days) END
        WHERE id = $1`,
      [id, r.chunks, r.embeddedChunks, r.sizeBytes ?? null],
    );
  }

  async markError(id: number, error: string): Promise<void> {
    await this.db.query("UPDATE kb_sources SET status = 'error', error = $2, updated_at = now() WHERE id = $1", [id, error.slice(0, 2000)]);
  }

  /** Фрагменты источника заменяются целиком в одной транзакции. */
  async replaceChunks(accountId: number, sourceId: number, chunks: KbChunkInsert[]): Promise<void> {
    await withTransaction(this.db, async (c) => {
      await c.query('DELETE FROM kb_chunks WHERE source_id = $1', [sourceId]);
      for (let i = 0; i < chunks.length; i += 200) {
        const batch = chunks.slice(i, i + 200);
        const values: string[] = [];
        const params: unknown[] = [sourceId, accountId];
        for (const ch of batch) {
          const base = params.length;
          params.push(ch.position, ch.text, JSON.stringify(ch.meta ?? {}), ch.embedding ? toVectorLiteral(ch.embedding) : null);
          values.push(`($1, $2, $${base + 1}, $${base + 2}, $${base + 3}::jsonb, $${base + 4}::vector)`);
        }
        await c.query(`INSERT INTO kb_chunks (source_id, account_id, position, text, meta, embedding) VALUES ${values.join(', ')}`, params);
      }
    });
  }

  async listChunks(accountId: number, sourceId: number, opts: { limit?: number; offset?: number } = {}): Promise<KbChunkRow[]> {
    const { rows } = await this.db.query(
      `SELECT id, source_id, position, text, meta, (embedding IS NOT NULL) AS has_embedding
         FROM kb_chunks WHERE account_id = $1 AND source_id = $2
        ORDER BY position LIMIT $3 OFFSET $4`,
      [accountId, sourceId, Math.min(opts.limit ?? 50, 500), opts.offset ?? 0],
    );
    return rows.map(mapChunk);
  }

  async usage(accountId: number): Promise<KbUsage> {
    const { rows } = await this.db.query<{ sources: number; bytes: string; chunks: number }>(
      `SELECT count(*)::int AS sources, coalesce(sum(size_bytes), 0)::text AS bytes,
              (SELECT count(*)::int FROM kb_chunks c WHERE c.account_id = $1) AS chunks
         FROM kb_sources WHERE account_id = $1`,
      [accountId],
    );
    const r = rows[0];
    return { sources: r?.sources ?? 0, bytes: Number(r?.bytes ?? 0), chunks: r?.chunks ?? 0, limits: { bytes: KB_LIMIT_BYTES, chunks: KB_LIMIT_CHUNKS } };
  }

  /** Ближайшие фрагменты по косинусной близости; только проиндексированные источники. */
  async searchVector(accountId: number, vector: number[], limit = 20): Promise<KbSearchRow[]> {
    const { rows } = await this.db.query(
      `SELECT c.id, c.source_id, c.position, c.text, c.meta, 1 - (c.embedding <=> $2::vector) AS score
         FROM kb_chunks c JOIN kb_sources s ON s.id = c.source_id
        WHERE c.account_id = $1 AND s.status = 'indexed' AND c.embedding IS NOT NULL
        ORDER BY c.embedding <=> $2::vector LIMIT $3`,
      [accountId, toVectorLiteral(vector), limit],
    );
    return rows.map(mapHit);
  }

  /** Полнотекстовый поиск (русская морфология); при пустом результате — по триграммам (опечатки, артикулы). */
  async searchText(accountId: number, query: string, limit = 20): Promise<KbSearchRow[]> {
    const q = query.trim();
    if (!q) return [];
    const fts = await this.db.query(
      `SELECT c.id, c.source_id, c.position, c.text, c.meta, ts_rank_cd(c.tsv, q) AS score
         FROM kb_chunks c JOIN kb_sources s ON s.id = c.source_id, websearch_to_tsquery('russian', $2) q
        WHERE c.account_id = $1 AND s.status = 'indexed' AND c.tsv @@ q
        ORDER BY score DESC LIMIT $3`,
      [accountId, q, limit],
    );
    if (fts.rows.length) return fts.rows.map(mapHit);
    const trgm = await this.db.query(
      `SELECT c.id, c.source_id, c.position, c.text, c.meta, word_similarity($2, c.text) AS score
         FROM kb_chunks c JOIN kb_sources s ON s.id = c.source_id
        WHERE c.account_id = $1 AND s.status = 'indexed' AND word_similarity($2, c.text) > 0.3
        ORDER BY score DESC LIMIT $3`,
      [accountId, q, limit],
    );
    return trgm.rows.map(mapHit);
  }
}

function mapSource(r: Record<string, unknown>): KbSource {
  return {
    id: Number(r.id),
    accountId: Number(r.account_id),
    kind: r.kind as KbSourceKind,
    title: String(r.title ?? ''),
    original: (r.original ?? null) as string | null,
    filePath: (r.file_path ?? null) as string | null,
    mime: (r.mime ?? null) as string | null,
    status: r.status as KbSourceStatus,
    sizeBytes: Number(r.size_bytes ?? 0),
    chunks: Number(r.chunks ?? 0),
    embeddedChunks: Number(r.embedded_chunks ?? 0),
    refreshDays: r.refresh_days === null || r.refresh_days === undefined ? null : Number(r.refresh_days),
    nextRefreshAt: (r.next_refresh_at ?? null) as Date | null,
    error: (r.error ?? null) as string | null,
    createdBy: r.created_by === null || r.created_by === undefined ? null : Number(r.created_by),
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
    indexedAt: (r.indexed_at ?? null) as Date | null,
    crawl: Boolean(r.crawl),
    parentId: r.parent_id === null || r.parent_id === undefined ? null : Number(r.parent_id),
    httpStatus: r.http_status === null || r.http_status === undefined ? null : Number(r.http_status),
    contentHash: (r.content_hash ?? null) as string | null,
    priceKey: (r.price_key ?? null) as string | null,
    priceImport: (r.price_import ?? null) as PriceImportSummary | null,
    comment: (r.comment ?? null) as string | null,
    isFactory: Boolean(r.is_factory),
    markupPct: Number(r.markup_pct ?? 0),
  };
}

function mapChunk(r: Record<string, unknown>): KbChunkRow {
  return { id: Number(r.id), sourceId: Number(r.source_id), position: Number(r.position), text: String(r.text ?? ''), meta: (r.meta ?? {}) as ChunkMeta, hasEmbedding: Boolean(r.has_embedding) };
}

function mapHit(r: Record<string, unknown>): KbSearchRow {
  return { chunkId: Number(r.id), sourceId: Number(r.source_id), position: Number(r.position), text: String(r.text ?? ''), meta: (r.meta ?? {}) as ChunkMeta, score: Number(r.score ?? 0) };
}
