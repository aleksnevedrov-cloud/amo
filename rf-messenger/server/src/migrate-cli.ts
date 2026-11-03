import { createPool, migrate } from './db.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL не задан');
const db = createPool(url, 1);
const applied = await migrate(db);
process.stdout.write(applied.length ? `Применены миграции: ${applied.join(', ')}\n` : 'Новых миграций нет\n');
await db.end();
