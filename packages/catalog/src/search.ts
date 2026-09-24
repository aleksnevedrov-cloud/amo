import type { Db } from '@ai-door/db';

export interface ProductSummary {
  id: string;
  name: string;
  price: number | null;
  oldPrice: number | null;
  currency: string | null;
  available: boolean | null;
  url: string | null;
  category: string | null;
  vendorCode: string | null;
  picture: string | null;
  params: { name: string; value: string; unit?: string }[];
}

export interface Product extends ProductSummary {
  vendor: string | null;
  description: string | null;
  pictures: string[];
  updatedAt: Date;
}

export interface SearchQuery {
  query?: string;
  minPrice?: number;
  maxPrice?: number;
  availableOnly?: boolean;
  similarTo?: string;
  limit?: number;
}

export interface CatalogStats {
  products: number;
  lastImport: {
    status: string;
    startedAt: Date;
    finishedAt: Date | null;
    products: number | null;
    error: string | null;
    source: string;
  } | null;
}

/** Слова запроса → tsquery с OR: ранжирование поднимает товары с большим числом совпадений. */
export function toOrTsQuery(q: string): string {
  const words = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 2).slice(0, 12);
  return words.join(' | ');
}

const SUMMARY_COLS = `id, name, price, old_price, currency, available, url, category_path, vendor_code, pictures, params`;

function toSummary(r: Record<string, unknown>): ProductSummary {
  const pictures = (r.pictures as string[] | null) ?? [];
  return {
    id: r.id as string,
    name: r.name as string,
    price: r.price == null ? null : Number(r.price),
    oldPrice: r.old_price == null ? null : Number(r.old_price),
    currency: (r.currency as string | null) ?? null,
    available: (r.available as boolean | null) ?? null,
    url: (r.url as string | null) ?? null,
    category: (r.category_path as string | null) ?? null,
    vendorCode: (r.vendor_code as string | null) ?? null,
    picture: pictures[0] ?? null,
    params: ((r.params as ProductSummary['params']) ?? []).slice(0, 12),
  };
}

export class CatalogRepo {
  constructor(private readonly db: Db) {}

  async search(accountId: number, q: SearchQuery): Promise<ProductSummary[]> {
    const limit = Math.min(Math.max(q.limit ?? 5, 1), 10);
    if (q.similarTo) return this.similar(accountId, q.similarTo, q, limit);
    const text = (q.query ?? '').trim();
    const tsq = toOrTsQuery(text);
    const { rows } = await this.db.query(
      `SELECT ${SUMMARY_COLS},
              (CASE WHEN $2 = '' THEN 0 ELSE ts_rank(search, to_tsquery('russian', $2)) END)
              + (CASE WHEN $3 = '' THEN 0 ELSE public.similarity(lower(name), $3) END)
              + (CASE WHEN $3 <> '' AND lower(vendor_code) = $3 THEN 10 ELSE 0 END) AS score
         FROM catalog_products
        WHERE account_id = $1
          AND ($3 = '' OR ($2 <> '' AND search @@ to_tsquery('russian', $2))
               OR public.similarity(lower(name), $3) > 0.3 OR lower(vendor_code) = $3)
          AND ($4::numeric IS NULL OR price >= $4)
          AND ($5::numeric IS NULL OR price <= $5)
          AND (NOT $6 OR available IS NOT FALSE)
        ORDER BY score DESC, available DESC NULLS LAST, price NULLS LAST
        LIMIT $7`,
      [accountId, tsq, text.toLowerCase(), q.minPrice ?? null, q.maxPrice ?? null, q.availableOnly ?? false, limit],
    );
    return rows.map(toSummary);
  }

  /** Похожие: та же категория, цена ±30 %, сначала в наличии. */
  private async similar(accountId: number, id: string, q: SearchQuery, limit: number): Promise<ProductSummary[]> {
    const { rows } = await this.db.query(
      `SELECT ${SUMMARY_COLS.split(', ').map((c) => `p.${c}`).join(', ')}
         FROM catalog_products p JOIN catalog_products base ON base.account_id = p.account_id AND base.id = $2
        WHERE p.account_id = $1 AND p.id <> base.id
          AND p.category_id IS NOT DISTINCT FROM base.category_id
          AND (base.price IS NULL OR p.price BETWEEN base.price * 0.7 AND base.price * 1.3)
          AND ($3::numeric IS NULL OR p.price >= $3)
          AND ($4::numeric IS NULL OR p.price <= $4)
          AND (NOT $5 OR p.available IS NOT FALSE)
        ORDER BY p.available DESC NULLS LAST, abs(coalesce(p.price, 0) - coalesce(base.price, 0))
        LIMIT $6`,
      [accountId, id, q.minPrice ?? null, q.maxPrice ?? null, q.availableOnly ?? false, limit],
    );
    return rows.map(toSummary);
  }

  /** Карточка по id из фида или по артикулу. */
  async get(accountId: number, idOrCode: string): Promise<Product | null> {
    const { rows } = await this.db.query(
      `SELECT ${SUMMARY_COLS}, vendor, description, updated_at FROM catalog_products
        WHERE account_id = $1 AND (id = $2 OR lower(vendor_code) = lower($2))
        ORDER BY (id = $2) DESC LIMIT 1`,
      [accountId, idOrCode],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      ...toSummary(r),
      params: r.params ?? [],
      vendor: r.vendor,
      description: r.description,
      pictures: r.pictures ?? [],
      updatedAt: r.updated_at,
    };
  }

  async stats(accountId: number): Promise<CatalogStats> {
    const [count, last] = await Promise.all([
      this.db.query('SELECT count(*)::int AS n FROM catalog_products WHERE account_id = $1', [accountId]),
      this.db.query(
        `SELECT status, started_at, finished_at, products, error, source FROM catalog_imports
          WHERE account_id = $1 ORDER BY id DESC LIMIT 1`,
        [accountId],
      ),
    ]);
    const l = last.rows[0];
    return {
      products: count.rows[0].n,
      lastImport: l
        ? {
            status: l.status,
            startedAt: l.started_at,
            finishedAt: l.finished_at,
            products: l.products,
            error: l.error,
            source: l.source,
          }
        : null,
    };
  }

  /** Время последнего успешного импорта — для расписания. */
  async lastSuccessAt(accountId: number): Promise<Date | null> {
    const { rows } = await this.db.query(
      `SELECT max(finished_at) AS t FROM catalog_imports WHERE account_id = $1 AND status = 'ok'`,
      [accountId],
    );
    return rows[0]?.t ?? null;
  }
}
