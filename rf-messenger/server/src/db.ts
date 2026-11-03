import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;

export function createPool(connectionString: string, max = 5): Db {
  return new pg.Pool({ connectionString, max });
}

export async function withTransaction<T>(db: Db, fn: (c: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

const LOCK_KEY = 7_214_101;
export const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL('../migrations/', import.meta.url));

/** Миграции только вперёд: применяет по порядку файлы, которых нет в schema_migrations. */
export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  return withTransaction(db, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const applied: string[] = [];
    for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      await c.query(await readFile(join(dir, file), 'utf8'));
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      applied.push(file);
    }
    return applied;
  });
}
