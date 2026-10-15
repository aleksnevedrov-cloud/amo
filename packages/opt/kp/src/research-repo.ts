import type { Db } from '@core/db';
import type { ChatRoute, LlmGateway } from '@core/llm';
import { modelKeyOf } from '@opt/kb';
import { cleanName, orientSize, parseSizeMm, researchMarketPrice, type MarketResearchInput, type MarketResearchOptions, type MarketResearchResult } from './market-research.ts';

/**
 * Хранение результатов поиска рыночных цен и кэш (RFD-AI-AGENT-OPT-PRICE, этап 3).
 * Таблица kp_price_research (миграция 002). Кэш: та же модель (model_key — название без размера, RFD-AI-AGENT-OPT-KB)
 * моложе cacheDays (по умолчанию 30) — модель и веб-поиск не вызываются, берётся сохранённое, другой размер
 * пересчитывается по площади; force обходит кэш; результаты failed в кэш не идут.
 */

export const DEFAULT_CACHE_DAYS = 30;

/** Нормализованный запрос: нижний регистр, ё→е, одиночные пробелы, без пунктуации по краям. */
export function queryKey(query: string): string {
  return query.toLowerCase().replace(/ё/g, 'е').replace(/[«»"']/g, '').replace(/\s+/g, ' ').trim();
}

/** Ключ позиции: наименование и размер черновика — совпадает при повторной сборке той же заявки. */
export function itemKey(input: Pick<MarketResearchInput, 'item' | 'line'>): string {
  return queryKey(`${input.item.name || input.line.name} ${input.item.width_mm ?? ''}x${input.item.height_mm ?? ''}`);
}

/** Ключ модели: наименование без размера и количества — одинаков у позиций одной модели разных размеров (один веб-поиск на модель). */
export function modelKey(input: Pick<MarketResearchInput, 'item' | 'line'>): string {
  return modelKeyOf(cleanName(input.item.name || input.line.name)) || queryKey(cleanName(input.item.name || input.line.name));
}

/** Размер позиции: из заявки, иначе из текста. */
export function sizeOfInput(input: Pick<MarketResearchInput, 'item' | 'line'>): { widthMm: number | null; heightMm: number | null } {
  const fromText = parseSizeMm(`${input.item.raw} ${input.item.name} ${input.line.size}`);
  return orientSize(input.item.width_mm ?? fromText?.widthMm ?? null, input.item.height_mm ?? fromText?.heightMm ?? null);
}

export interface PriceResearchRow {
  id: number;
  accountId: number;
  draftId: number | null;
  requestIndex: number;
  query: string;
  queryKey: string;
  itemKey: string;
  modelKey: string;
  card: MarketResearchResult['card'];
  status: MarketResearchResult['status'];
  offers: MarketResearchResult['offers'];
  stats: MarketResearchResult['stats'];
  analog: MarketResearchResult['analog'];
  error: string | null;
  provider: string | null;
  model: string | null;
  webSearchCalls: number;
  costUsd: number;
  sources: MarketResearchResult['sources'];
  createdAt: Date;
}

export interface SaveResearchInput {
  accountId: number;
  draftId: number | null;
  requestIndex: number;
  itemKey: string;
  modelKey?: string;
  result: MarketResearchResult;
}

export class KpPriceResearchRepo {
  constructor(private readonly db: Db) {}

  async save(input: SaveResearchInput): Promise<number> {
    const r = input.result;
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO kp_price_research
         (account_id, draft_id, request_index, query, query_key, item_key, model_key, card, status, offers, stats, analog, error, provider, model, web_search_calls, cost_usd, sources)
       VALUES ($1, $2, $3, $4, $5, $6, $18, $7::jsonb, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16, $17::jsonb)
       RETURNING id`,
      [
        input.accountId,
        input.draftId,
        input.requestIndex,
        r.query,
        queryKey(r.query),
        input.itemKey,
        r.card === null ? null : JSON.stringify(r.card),
        r.status,
        JSON.stringify(r.offers),
        r.stats === null ? null : JSON.stringify(r.stats),
        r.analog === null ? null : JSON.stringify(r.analog),
        r.error,
        r.provider,
        r.model,
        r.webSearchCalls,
        r.cost.usd,
        JSON.stringify(r.sources),
        input.modelKey ?? '',
      ],
    );
    return Number(rows[0]?.id ?? 0);
  }

  /** Свежий результат по модели (без размера) — один веб-поиск на модель, размеры пересчитываются по площади. */
  latestByModelKey(accountId: number, key: string, maxAgeDays = DEFAULT_CACHE_DAYS): Promise<PriceResearchRow | null> {
    return this.latestBy('model_key', accountId, key, maxAgeDays);
  }

  /** Потрачено на веб-поиск за сутки, $ (по времени сервера БД) — дневной лимит RFD-AI-AGENT-OPT-KB. */
  async spentTodayUsd(accountId: number): Promise<number> {
    const { rows } = await this.db.query<{ s: string }>("SELECT coalesce(sum(cost_usd), 0)::text AS s FROM kp_price_research WHERE account_id = $1 AND created_at >= date_trunc('day', now())", [accountId]);
    return Number(rows[0]?.s ?? 0);
  }

  async byId(accountId: number, id: number): Promise<PriceResearchRow | null> {
    const { rows } = await this.db.query('SELECT * FROM kp_price_research WHERE account_id = $1 AND id = $2', [accountId, id]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /** Результаты по черновику: по позициям, свежие первыми. */
  async listByDraft(accountId: number, draftId: number): Promise<PriceResearchRow[]> {
    const { rows } = await this.db.query('SELECT * FROM kp_price_research WHERE account_id = $1 AND draft_id = $2 ORDER BY request_index, created_at DESC', [accountId, draftId]);
    return rows.map(mapRow);
  }

  /** Свежий результат по ключу запроса не старше maxAgeDays; failed не возвращается (в кэш не идёт). */
  latestByQueryKey(accountId: number, key: string, maxAgeDays = DEFAULT_CACHE_DAYS): Promise<PriceResearchRow | null> {
    return this.latestBy('query_key', accountId, key, maxAgeDays);
  }

  /** То же по ключу позиции — срабатывает до вызова модели за карточкой. */
  latestByItemKey(accountId: number, key: string, maxAgeDays = DEFAULT_CACHE_DAYS): Promise<PriceResearchRow | null> {
    return this.latestBy('item_key', accountId, key, maxAgeDays);
  }

  private async latestBy(column: 'query_key' | 'item_key' | 'model_key', accountId: number, key: string, maxAgeDays: number): Promise<PriceResearchRow | null> {
    if (!key) return null;
    const { rows } = await this.db.query(
      `SELECT * FROM kp_price_research
        WHERE account_id = $1 AND ${column} = $2 AND status <> 'failed'
          AND created_at > now() - make_interval(days => $3)
        ORDER BY created_at DESC LIMIT 1`,
      [accountId, key, Math.max(0, maxAgeDays)],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }
}

function mapRow(r: Record<string, unknown>): PriceResearchRow {
  return {
    id: Number(r.id),
    accountId: Number(r.account_id),
    draftId: r.draft_id === null || r.draft_id === undefined ? null : Number(r.draft_id),
    requestIndex: Number(r.request_index ?? 0),
    query: String(r.query ?? ''),
    queryKey: String(r.query_key ?? ''),
    itemKey: String(r.item_key ?? ''),
    modelKey: String(r.model_key ?? ''),
    card: (r.card ?? null) as PriceResearchRow['card'],
    status: r.status as PriceResearchRow['status'],
    offers: (r.offers ?? []) as PriceResearchRow['offers'],
    stats: (r.stats ?? null) as PriceResearchRow['stats'],
    analog: (r.analog ?? null) as PriceResearchRow['analog'],
    error: (r.error ?? null) as string | null,
    provider: (r.provider ?? null) as string | null,
    model: (r.model ?? null) as string | null,
    webSearchCalls: Number(r.web_search_calls ?? 0),
    costUsd: Number(r.cost_usd ?? 0),
    sources: (r.sources ?? []) as PriceResearchRow['sources'],
    createdAt: r.created_at as Date,
  };
}

/** Результат из кэша или новый поиск; cached — откуда взят, createdAt — когда найден. */
export interface CachedResearch {
  result: MarketResearchResult;
  cached: boolean;
  researchId: number;
  createdAt: Date;
}

export interface CachedResearchOptions extends MarketResearchOptions {
  accountId: number;
  draftId: number | null;
  requestIndex: number;
  /** Срок кэша в днях; 0 — не использовать. */
  cacheDays?: number;
  /** «Искать заново»: кэш не читается, результат всё равно сохраняется. */
  force?: boolean;
}

/** Строка кэша → результат (стоимость нулевая: провайдер не вызывался). */
export function rowToResult(row: PriceResearchRow): MarketResearchResult {
  return {
    query: row.query,
    card: row.card,
    status: row.status,
    offers: row.offers,
    stats: row.stats,
    analog: row.analog,
    error: row.error,
    provider: row.provider,
    model: row.model,
    webSearchCalls: 0,
    cost: { inputTokens: 0, outputTokens: 0, usd: 0 },
    sources: row.sources,
  };
}

/**
 * Результат по той же модели другого размера: статистика и принятые предложения пересчитываются по площади
 * (цена × S позиции / S найденного), пометка «пересчёт по площади с W×H». Без размера у кэша или позиции — как есть.
 */
export function rescaleResult(row: PriceResearchRow, size: { widthMm: number | null; heightMm: number | null }): MarketResearchResult {
  const base = rowToResult(row);
  const from = row.card ? orientSize(row.card.widthMm, row.card.heightMm) : { widthMm: null, heightMm: null };
  if (!from.widthMm || !from.heightMm || !size.widthMm || !size.heightMm) return base;
  if (from.widthMm === size.widthMm && from.heightMm === size.heightMm) return base;
  const ratio = (size.widthMm * size.heightMm) / (from.widthMm * from.heightMm);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const sourceSize = `${from.widthMm}×${from.heightMm}`;
  return {
    ...base,
    card: row.card ? { ...row.card, widthMm: size.widthMm, heightMm: size.heightMm } : null,
    stats: base.stats ? { ...base.stats, min: r2(base.stats.min * ratio), max: r2(base.stats.max * ratio), median: r2(base.stats.median * ratio) } : null,
    offers: base.offers.map((o) => (o.accepted && o.unitPrice !== null ? { ...o, unitPrice: r2(o.unitPrice * ratio), areaScaled: true, sourceSize, notes: [...o.notes, `кэш по модели, пересчёт по площади с ${sourceSize}`] } : o)),
    areaScaled: true,
  };
}

/**
 * Поиск цены по позиции с кэшем: сначала по ключу позиции (без вызовов модели), затем новый поиск и сохранение.
 * Ошибки модели сохраняются как failed (чтобы были видны в журнале), но в кэш не попадают.
 */
export async function researchWithCache(repo: KpPriceResearchRepo, llm: LlmGateway, route: ChatRoute, input: MarketResearchInput, opts: CachedResearchOptions): Promise<CachedResearch> {
  const days = opts.cacheDays ?? DEFAULT_CACHE_DAYS;
  const key = itemKey(input);
  const mkey = modelKey(input);
  if (!opts.force && days > 0) {
    // Та же позиция (с размером) — как есть; та же модель другого размера — пересчёт по площади (один поиск на модель).
    const same = await repo.latestByItemKey(opts.accountId, key, days);
    if (same) return { result: rowToResult(same), cached: true, researchId: same.id, createdAt: same.createdAt };
    const byModel = mkey ? await repo.latestByModelKey(opts.accountId, mkey, days) : null;
    if (byModel) return { result: rescaleResult(byModel, sizeOfInput(input)), cached: true, researchId: byModel.id, createdAt: byModel.createdAt };
  }
  const result = await researchMarketPrice(llm, route, input, opts);
  const researchId = await repo.save({ accountId: opts.accountId, draftId: opts.draftId, requestIndex: opts.requestIndex, itemKey: key, modelKey: mkey, result });
  const saved = await repo.byId(opts.accountId, researchId);
  return { result, cached: false, researchId, createdAt: saved?.createdAt ?? new Date() };
}
