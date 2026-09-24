import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createPool, migrate, type Db } from '../src/index.ts';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://aidoor:aidoor@localhost:5432/aidoor_test';

/** Отдельная схема на каждый тестовый файл: тесты не мешают друг другу. */
export async function freshDb(): Promise<{ db: Db; drop: () => Promise<void> }> {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  // Расширения ставятся в public один раз: параллельные тесты не должны создавать их в своих схемах.
  await admin.query('CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public').catch(() => undefined);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const url = new URL(TEST_DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema},public`);
  const db = createPool(url.toString());
  await migrate(db);
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
