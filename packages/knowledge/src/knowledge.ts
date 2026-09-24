import { assertPublicUrl, toOrTsQuery } from '@ai-door/catalog';
import { withTransaction, type Db } from '@ai-door/db';
import { chunkText, htmlToText } from './chunk.ts';

export type KnowledgeKind = 'faq' | 'text' | 'url' | 'file';

export interface KnowledgeItem {
  id: number;
  kind: KnowledgeKind;
  title: string;
  source: string | null;
  createdAt: Date;
  chunks: number;
}

export interface KnowledgeHit {
  chunkId: number;
  itemId: number;
  title: string;
  kind: KnowledgeKind;
  source: string | null;
  createdAt: Date;
  content: string;
}

export class KnowledgeRepo {
  constructor(
    private readonly db: Db,
    private readonly opts: { fetch?: typeof fetch; resolve?: (host: string) => Promise<string[]> } = {},
  ) {}

  addFaq(accountId: number, question: string, answer: string, userId?: number): Promise<number> {
    return this.add(accountId, 'faq', question, `Вопрос: ${question}\nОтвет: ${answer}`, null, userId);
  }

  addText(accountId: number, title: string, content: string, source: string | null = null, userId?: number) {
    return this.add(accountId, 'text', title, content, source, userId);
  }

  /** Загружает статью по URL (например, раздел «Полезные советы про двери»). */
  async addUrl(accountId: number, url: string, userId?: number): Promise<number> {
    const safe = await assertPublicUrl(url, this.opts.resolve);
    const res = await (this.opts.fetch ?? fetch)(safe, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Страница недоступна: HTTP ${res.status}`);
    const { title, text } = htmlToText(await res.text());
    if (text.length < 50) throw new Error('На странице не найден текст');
    return this.add(accountId, 'url', title ?? url, text, url, userId);
  }

  private async add(
    accountId: number,
    kind: KnowledgeKind,
    title: string,
    content: string,
    source: string | null,
    userId?: number,
  ): Promise<number> {
    const chunks = kind === 'faq' ? [content] : chunkText(content);
    if (!chunks.length) throw new Error('Пустой текст');
    return withTransaction(this.db, async (c) => {
      const { rows } = await c.query(
        'INSERT INTO knowledge_items (account_id, kind, title, source, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [accountId, kind, title.slice(0, 500), source, userId ?? null],
      );
      const id = Number(rows[0].id);
      await c.query(
        `INSERT INTO knowledge_chunks (item_id, account_id, position, content)
         SELECT $1, $2, ord - 1, t FROM unnest($3::text[]) WITH ORDINALITY AS u(t, ord)`,
        [id, accountId, chunks],
      );
      return id;
    });
  }

  async list(accountId: number): Promise<KnowledgeItem[]> {
    const { rows } = await this.db.query(
      `SELECT i.id, i.kind, i.title, i.source, i.created_at, count(c.id)::int AS chunks
         FROM knowledge_items i LEFT JOIN knowledge_chunks c ON c.item_id = i.id
        WHERE i.account_id = $1 GROUP BY i.id ORDER BY i.created_at DESC, i.id DESC`,
      [accountId],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      kind: r.kind,
      title: r.title,
      source: r.source,
      createdAt: r.created_at,
      chunks: r.chunks,
    }));
  }

  async remove(accountId: number, id: number): Promise<boolean> {
    const { rowCount } = await this.db.query('DELETE FROM knowledge_items WHERE account_id = $1 AND id = $2', [
      accountId,
      id,
    ]);
    return (rowCount ?? 0) > 0;
  }

  async search(accountId: number, query: string, limit = 4): Promise<KnowledgeHit[]> {
    const tsq = toOrTsQuery(query);
    if (!tsq) return [];
    const { rows } = await this.db.query(
      `SELECT c.id AS chunk_id, i.id AS item_id, i.title, i.kind, i.source, i.created_at, c.content,
              ts_rank(c.search, to_tsquery('russian', $2)) AS score
         FROM knowledge_chunks c JOIN knowledge_items i ON i.id = c.item_id
        WHERE c.account_id = $1 AND c.search @@ to_tsquery('russian', $2)
        ORDER BY score DESC LIMIT $3`,
      [accountId, tsq, Math.min(Math.max(limit, 1), 8)],
    );
    return rows.map((r) => ({
      chunkId: Number(r.chunk_id),
      itemId: Number(r.item_id),
      title: r.title,
      kind: r.kind,
      source: r.source,
      createdAt: r.created_at,
      content: r.content,
    }));
  }
}
