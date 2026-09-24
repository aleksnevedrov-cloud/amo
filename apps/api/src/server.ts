import { fileURLToPath } from 'node:url';
import { migrate } from '@ai-door/db';
import { loadEnv } from '@ai-door/shared';
import { buildApp } from './app.ts';
import { createDeps } from './deps.ts';

const env = loadEnv();
const deps = createDeps(env);
// Путь одинаков для src/server.ts и собранного dist/server.js.
const migrationsDir =
  process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL('../../../packages/db/migrations/', import.meta.url));
await migrate(deps.db, migrationsDir);

const app = await buildApp(deps);
await app.listen({ host: env.API_HOST, port: env.API_PORT });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await deps.close();
    process.exit(0);
  });
}
