import { createPool, migrate } from '../src/index.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL не задан');
const db = createPool(url);
const applied = await migrate(db);
console.log(applied.length ? `Применены миграции: ${applied.join(', ')}` : 'Новых миграций нет');
await db.end();
