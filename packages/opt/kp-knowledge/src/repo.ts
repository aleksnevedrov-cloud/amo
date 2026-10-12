import type { Db } from '@core/db';
import { KNOWLEDGE_KINDS, type KnowledgeKind, type KnowledgeUsage } from './kinds.ts';
import type { KnowledgeData } from './schemas.ts';

export interface KnowledgeItem<K extends KnowledgeKind = KnowledgeKind> {
  kind: K;
  usage: KnowledgeUsage;
  filename: string;
  rows: number;
  data: KnowledgeData[K];
  updatedAt: Date;
  updatedBy: number | null;
}

/** Загруженные справочники аккаунта; отсутствующий справочник — пустой список (или null для регламента). */
export interface KnowledgeSet {
  delivery: KnowledgeData['delivery'];
  installation: KnowledgeData['installation'];
  b2b: KnowledgeData['b2b'] | null;
  analogs: KnowledgeData['analogs'];
  stoplist: KnowledgeData['stoplist'];
}

export const EMPTY_KNOWLEDGE: KnowledgeSet = { delivery: [], installation: [], b2b: null, analogs: [], stoplist: [] };

/** Таблица kp_knowledge_items в БД опта: один файл на вид справочника и аккаунт, новая загрузка заменяет старую. */
export class KpKnowledgeRepo {
  constructor(private readonly db: Db) {}

  async list(accountId: number): Promise<Omit<KnowledgeItem, 'data'>[]> {
    const { rows } = await this.db.query<{ kind: KnowledgeKind; usage: KnowledgeUsage; filename: string; rows: number; updated_at: Date; updated_by: number | null }>(
      'SELECT kind, usage, filename, rows, updated_at, updated_by FROM kp_knowledge_items WHERE account_id = $1 ORDER BY kind',
      [accountId],
    );
    return rows.map((r) => ({ kind: r.kind, usage: r.usage, filename: r.filename, rows: r.rows, updatedAt: r.updated_at, updatedBy: r.updated_by }));
  }

  async get<K extends KnowledgeKind>(accountId: number, kind: K): Promise<KnowledgeItem<K> | null> {
    const { rows } = await this.db.query<{ usage: KnowledgeUsage; filename: string; rows: number; data: KnowledgeData[K]; updated_at: Date; updated_by: number | null }>(
      'SELECT usage, filename, rows, data, updated_at, updated_by FROM kp_knowledge_items WHERE account_id = $1 AND kind = $2',
      [accountId, kind],
    );
    const r = rows[0];
    return r ? { kind, usage: r.usage, filename: r.filename, rows: r.rows, data: r.data, updatedAt: r.updated_at, updatedBy: r.updated_by } : null;
  }

  async save<K extends KnowledgeKind>(accountId: number, kind: K, item: { filename: string; content: string; data: KnowledgeData[K]; rows: number; userId: number | null; usage?: KnowledgeUsage }): Promise<void> {
    await this.db.query(
      `INSERT INTO kp_knowledge_items (account_id, kind, usage, filename, content, data, rows, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       ON CONFLICT (account_id, kind) DO UPDATE SET
         usage = EXCLUDED.usage, filename = EXCLUDED.filename, content = EXCLUDED.content, data = EXCLUDED.data,
         rows = EXCLUDED.rows, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [accountId, kind, item.usage ?? 'reference', item.filename, item.content, JSON.stringify(item.data), item.rows, item.userId],
    );
  }

  async remove(accountId: number, kind: KnowledgeKind): Promise<boolean> {
    const r = await this.db.query('DELETE FROM kp_knowledge_items WHERE account_id = $1 AND kind = $2', [accountId, kind]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Все справочники аккаунта одним запросом — для сборки черновика. */
  async loadSet(accountId: number): Promise<KnowledgeSet> {
    const { rows } = await this.db.query<{ kind: KnowledgeKind; data: unknown }>('SELECT kind, data FROM kp_knowledge_items WHERE account_id = $1', [accountId]);
    const set: KnowledgeSet = { ...EMPTY_KNOWLEDGE };
    for (const r of rows) {
      if (!KNOWLEDGE_KINDS.includes(r.kind)) continue;
      (set as unknown as Record<string, unknown>)[r.kind] = r.data;
    }
    return set;
  }
}
