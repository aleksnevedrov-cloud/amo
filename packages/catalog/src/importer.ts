import { withTransaction, type Db } from '@ai-door/db';
import { assertPublicUrl } from './safe-url.ts';
import { categoryPaths, decodeFeed, FeedError, parseYml, type Feed } from './yml.ts';

const MAX_FEED_BYTES = 100 * 1024 * 1024;

export interface ImportResult {
  importId: number;
  products: number;
  categories: number;
}

export interface ImporterOptions {
  fetch?: typeof fetch;
  resolve?: (host: string) => Promise<string[]>;
}

export class CatalogImporter {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly db: Db,
    private readonly opts: ImporterOptions = {},
  ) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** Скачивает фид по адресу и импортирует его. Ошибка фиксируется в catalog_imports. */
  async importFromUrl(accountId: number, feedUrl: string): Promise<ImportResult> {
    return this.run(accountId, feedUrl, async () => {
      const url = await assertPublicUrl(feedUrl, this.opts.resolve);
      const res = await this.fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new FeedError(`Фид недоступен: HTTP ${res.status}`);
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > MAX_FEED_BYTES) throw new FeedError('Фид больше 100 МБ');
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > MAX_FEED_BYTES) throw new FeedError('Фид больше 100 МБ');
      return parseYml(decodeFeed(buf));
    });
  }

  /** Импорт из загруженного файла (кнопка в настройках, тесты, песочница). */
  async importFromBytes(accountId: number, bytes: Uint8Array, source = 'upload'): Promise<ImportResult> {
    return this.run(accountId, source, async () => parseYml(decodeFeed(bytes)));
  }

  private async run(accountId: number, source: string, load: () => Promise<Feed>): Promise<ImportResult> {
    const { rows } = await this.db.query(
      `INSERT INTO catalog_imports (account_id, source, status) VALUES ($1, $2, 'running') RETURNING id`,
      [accountId, source],
    );
    const importId = Number(rows[0].id);
    try {
      const feed = await load();
      // Пустой или битый фид не должен стирать рабочий каталог.
      if (feed.products.length === 0) throw new FeedError('В фиде нет ни одного товара');
      await this.save(accountId, feed);
      await this.db.query(
        `UPDATE catalog_imports SET status = 'ok', finished_at = now(), products = $2, categories = $3 WHERE id = $1`,
        [importId, feed.products.length, feed.categories.length],
      );
      return { importId, products: feed.products.length, categories: feed.categories.length };
    } catch (err) {
      await this.db.query(
        `UPDATE catalog_imports SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`,
        [importId, (err as Error).message.slice(0, 1000)],
      );
      throw err;
    }
  }

  private async save(accountId: number, feed: Feed): Promise<void> {
    const paths = categoryPaths(feed.categories);
    await withTransaction(this.db, async (c) => {
      await c.query('DELETE FROM catalog_categories WHERE account_id = $1', [accountId]);
      await c.query(
        `INSERT INTO catalog_categories (account_id, id, parent_id, name)
         SELECT $1, x.id, x.parent_id, x.name FROM jsonb_to_recordset($2::jsonb) AS x(id text, parent_id text, name text)
         ON CONFLICT DO NOTHING`,
        [accountId, JSON.stringify(feed.categories.map((k) => ({ id: k.id, parent_id: k.parentId, name: k.name })))],
      );
      // Порции по 1000, чтобы не упереться в размер параметра.
      for (let i = 0; i < feed.products.length; i += 1000) {
        const batch = feed.products.slice(i, i + 1000).map((p) => ({
          id: p.id,
          name: p.name,
          url: p.url,
          price: p.price,
          old_price: p.oldPrice,
          currency: p.currency,
          available: p.available,
          category_id: p.categoryId,
          category_path: p.categoryId ? (paths.get(p.categoryId) ?? null) : null,
          vendor: p.vendor,
          vendor_code: p.vendorCode,
          description: p.description,
          params: p.params,
          pictures: p.pictures,
        }));
        await c.query(
          `INSERT INTO catalog_products (account_id, id, name, url, price, old_price, currency, available, category_id,
                                         category_path, vendor, vendor_code, description, params, pictures, updated_at)
           SELECT $1, x.id, x.name, x.url, x.price, x.old_price, x.currency, x.available, x.category_id,
                  x.category_path, x.vendor, x.vendor_code, x.description, coalesce(x.params, '[]'),
                  coalesce(ARRAY(SELECT jsonb_array_elements_text(x.pictures)), '{}'), now()
             FROM jsonb_to_recordset($2::jsonb) AS x(
               id text, name text, url text, price numeric, old_price numeric, currency text, available boolean,
               category_id text, category_path text, vendor text, vendor_code text, description text,
               params jsonb, pictures jsonb)
           ON CONFLICT (account_id, id) DO UPDATE SET
             name = EXCLUDED.name, url = EXCLUDED.url, price = EXCLUDED.price, old_price = EXCLUDED.old_price,
             currency = EXCLUDED.currency, available = EXCLUDED.available, category_id = EXCLUDED.category_id,
             category_path = EXCLUDED.category_path, vendor = EXCLUDED.vendor, vendor_code = EXCLUDED.vendor_code,
             description = EXCLUDED.description, params = EXCLUDED.params, pictures = EXCLUDED.pictures,
             updated_at = now()`,
          [accountId, JSON.stringify(batch)],
        );
      }
      // Товары, которых больше нет в фиде, удаляются.
      await c.query('DELETE FROM catalog_products WHERE account_id = $1 AND NOT (id = ANY($2::text[]))', [
        accountId,
        feed.products.map((p) => p.id),
      ]);
    });
  }
}
