import { randomBytes } from 'node:crypto';
import { createPool, migrate, type Db } from '@core/db';
import pg from 'pg';
import { KB_MIGRATIONS_DIR } from '../src/migrations.ts';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://aidoor:aidoor@localhost:5432/aidoor_test';

/** Отдельная схема на тестовый файл с миграциями базы знаний (расширение vector нужно в БД: образ pgvector/pgvector:pg16). */
export async function freshKbDb(): Promise<{ db: Db; drop: () => Promise<void> }> {
  const schema = `kb_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const url = new URL(TEST_DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema},public`);
  const db = createPool(url.toString());
  await migrate(db, KB_MIGRATIONS_DIR);
  return {
    db,
    drop: async () => {
      await db.end();
      const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await c.connect();
      await c.query(`DROP SCHEMA ${schema} CASCADE`);
      await c.end();
    },
  };
}

/**
 * Эмбеддер без сети: вектор по словам (хэш слова → координата), косинус близок у текстов с общими словами.
 * Достаточно, чтобы проверить путь «эмбеддинг → pgvector → поиск».
 */
export function fakeEmbedder(model = 'fake-embedding') {
  const calls: string[][] = [];
  const dims = 1536;
  const vec = (text: string): number[] => {
    const v = new Array<number>(dims).fill(0);
    for (const w of text.toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/).filter((x) => x.length > 2)) {
      let h = 2166136261;
      for (const ch of w) h = (h ^ ch.charCodeAt(0)) * 16777619;
      const i = Math.abs(h) % dims;
      v[i] = (v[i] ?? 0) + 1;
    }
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  };
  return {
    calls,
    embedder: {
      model,
      async embed(texts: string[]) {
        calls.push(texts);
        const tokens = texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0);
        return { vectors: texts.map(vec), tokens, usd: (tokens / 1_000_000) * 0.02, model };
      },
    },
  };
}
