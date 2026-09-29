/**
 * Тестовый каталог и база знаний eval-набора в отдельной схеме БД — для прогона из API (кнопка «Прогнать eval»).
 * Файлы fixtures в образ не попадают, поэтому каталог встроен байтами (catalog-yml.ts), база знаний — JSON-модуль.
 */
import { randomBytes } from 'node:crypto';
import { CatalogImporter, CatalogRepo } from '@ai-door/catalog';
import { AccountsRepo, createPool, migrate, type Db } from '@ai-door/db';
import { KnowledgeRepo } from '@ai-door/knowledge';
import pg from 'pg';
import { CATALOG_YML_BASE64 } from './fixtures/catalog-yml.ts';
import knowledgeFixture from './fixtures/knowledge.json' with { type: 'json' };
import pricingFixture from './fixtures/pricing-rules.json' with { type: 'json' };

/** Правила цен eval-набора (с полем _comment — снимается withoutComment). */
export const pricingRulesFixture: Record<string, unknown> = pricingFixture as Record<string, unknown>;

export interface EvalFixtures {
  db: Db;
  catalog: CatalogRepo;
  knowledge: KnowledgeRepo;
  /** Полный дамп каталога и базы знаний для независимой сверки цифр. */
  groundTruth: string[];
  drop(): Promise<void>;
}

const kb = knowledgeFixture as { faq: { q: string; a: string }[]; texts: { title: string; content: string }[] };

/** Наполняет схему аккаунтом, каталогом и базой знаний eval-набора. */
export async function seedFixtures(db: Db, accountId: number): Promise<void> {
  await new AccountsRepo(db).upsertInstalled({ id: accountId, subdomain: 'eval', accountDomain: 'eval.amocrm.ru' });
  await new CatalogImporter(db).importFromBytes(accountId, new Uint8Array(Buffer.from(CATALOG_YML_BASE64, 'base64')));
  const knowledge = new KnowledgeRepo(db);
  for (const f of kb.faq) await knowledge.addFaq(accountId, f.q, f.a);
  for (const t of kb.texts) await knowledge.addText(accountId, t.title, t.content);
}

export async function groundTruthOf(db: Db): Promise<string[]> {
  const catalogDump = await db.query('SELECT name, price, old_price, params, description FROM catalog_products');
  const kbDump = await db.query('SELECT content FROM knowledge_chunks');
  return [JSON.stringify(catalogDump.rows), JSON.stringify(kbDump.rows)];
}

/**
 * Временная схема `eval_<id>` в той же БД: миграции, фикстуры, после прогона — DROP SCHEMA.
 * Данные аккаунтов не трогаются: схема отдельная, search_path только на неё.
 */
export async function evalFixtures(databaseUrl: string, accountId = 1, migrationsDir?: string): Promise<EvalFixtures> {
  const schema = `eval_${randomBytes(5).toString('hex')}`;
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    await admin.query('CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public').catch(() => undefined);
    await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema},public`);
  const db = createPool(url.toString());
  const drop = async () => {
    await db.end();
    const c = new pg.Client({ connectionString: databaseUrl });
    await c.connect();
    try {
      await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await c.end();
    }
  };
  try {
    await migrate(db, migrationsDir);
    await seedFixtures(db, accountId);
    return { db, catalog: new CatalogRepo(db), knowledge: new KnowledgeRepo(db), groundTruth: await groundTruthOf(db), drop };
  } catch (err) {
    await drop().catch(() => undefined);
    throw err;
  }
}
