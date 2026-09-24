import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTransaction, type Db } from './pool.ts';

const DEFAULT_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const LOCK_KEY = 7_214_001; // advisory lock: одна миграция за раз

/** Применяет по порядку SQL-файлы из migrations/, которых ещё нет в schema_migrations. */
export async function migrate(db: Db, dir = DEFAULT_DIR): Promise<string[]> {
  return withTransaction(db, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    await c.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set((await c.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      await c.query(await readFile(join(dir, file), 'utf8'));
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      applied.push(file);
    }
    return applied;
  });
}
