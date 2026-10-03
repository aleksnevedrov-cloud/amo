import type { Db } from './pool.ts';

/** Вариант комплектующего конкретной двери (RFD-AI-AGENT-KOMPLEKTUYUWIE). */
export interface DoorComponentRow {
  group: string;
  name: string;
  pageId: number | null;
  offerId: number | null;
  price: number;
}

export class DoorComponentsRepo {
  constructor(private readonly db: Db) {}

  /** Связка из кэша или null, если её нет или она старше ttlHours. */
  async get(accountId: number, productId: string, ttlHours = 24): Promise<DoorComponentRow[] | null> {
    const { rows: state } = await this.db.query(
      `SELECT checked_at FROM door_components_state
        WHERE account_id = $1 AND product_id = $2
          AND checked_at > now() - ($3 || ' hours')::interval`,
      [accountId, productId, String(ttlHours)],
    );
    if (!state[0]) return null;
    const { rows } = await this.db.query(
      `SELECT group_name, name, page_id, offer_id, price FROM door_components
        WHERE account_id = $1 AND product_id = $2 ORDER BY id`,
      [accountId, productId],
    );
    return rows.map((r) => ({
      group: String(r.group_name),
      name: String(r.name ?? ''),
      pageId: r.page_id === null ? null : Number(r.page_id),
      offerId: r.offer_id === null ? null : Number(r.offer_id),
      price: Number(r.price),
    }));
  }

  /** Перезаписывает связку и отмечает попытку — в том числе пустую и с ошибкой. */
  async save(
    accountId: number,
    productId: string,
    url: string,
    items: DoorComponentRow[],
    error: string | null = null,
  ): Promise<void> {
    await this.db.query('DELETE FROM door_components WHERE account_id = $1 AND product_id = $2', [
      accountId,
      productId,
    ]);
    for (const i of items) {
      await this.db.query(
        `INSERT INTO door_components (account_id, product_id, url, group_name, name, page_id, offer_id, price)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [accountId, productId, url, i.group, i.name, i.pageId, i.offerId, i.price],
      );
    }
    await this.db.query(
      `INSERT INTO door_components_state (account_id, product_id, url, items, error, checked_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (account_id, product_id) DO UPDATE
         SET url = excluded.url, items = excluded.items, error = excluded.error, checked_at = now()`,
      [accountId, productId, url, items.length, error],
    );
  }

  /** Счётчик для журнала: сколько карточек разобрано, сколько без связки, сколько с ошибкой. */
  async stats(accountId: number): Promise<{ products: number; empty: number; errors: number }> {
    const { rows } = await this.db.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE items = 0 AND error IS NULL)::int AS empty,
              count(*) FILTER (WHERE error IS NOT NULL)::int AS errors
         FROM door_components_state WHERE account_id = $1`,
      [accountId],
    );
    const r = rows[0];
    return { products: Number(r?.total ?? 0), empty: Number(r?.empty ?? 0), errors: Number(r?.errors ?? 0) };
  }
}
