import { migrate } from '@core/db';
import { loadEnv } from '@core/shared';
import { KB_MIGRATIONS_DIR } from '@opt/kb';
import { OPT_MIGRATIONS_DIR } from '@opt/kp';
import { buildApp } from './app.ts';
import { createDeps } from './deps.ts';

const env = loadEnv();
const deps = createDeps(env);
// Миграции БД опта (ai_door_opt): в образе путь задаёт MIGRATIONS_DIR.
await migrate(deps.db, process.env.MIGRATIONS_DIR ?? OPT_MIGRATIONS_DIR);
// Миграции базы знаний (ai_door_opt_kb, контейнер opt-kb-db): в образе путь задаёт KB_MIGRATIONS_DIR.
await migrate(deps.kb.db, process.env.KB_MIGRATIONS_DIR ?? KB_MIGRATIONS_DIR);

const app = await buildApp(deps);
await app.listen({ host: env.API_HOST, port: env.API_PORT });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await deps.close();
    process.exit(0);
  });
}
