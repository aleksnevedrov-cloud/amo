import { migrate } from '@core/db';
import { loadEnv } from '@core/shared';
import { KB_MIGRATIONS_DIR, priceListKeyOf } from '@opt/kb';
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
// KB-MATCH: у записей цен без признаков (до миграции 005) признаки извлекаются из модели, сокращения и назначения — один раз.
const backfilled = await deps.kb.prices.backfillFeatures();
if (backfilled) app.log.info({ rows: backfilled }, 'kb_prices: признаки заполнены у старых записей');
// KB-MULTIPRICE: у прайсов, загруженных до миграции 007, ключ прайса — из имени файла (один раз).
const keyed = await deps.kb.repo.backfillPriceKeys(priceListKeyOf);
if (keyed) app.log.info({ rows: keyed }, 'kb_sources: ключи прайсов заполнены у старых файлов');
await app.listen({ host: env.API_HOST, port: env.API_PORT });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await deps.close();
    process.exit(0);
  });
}
