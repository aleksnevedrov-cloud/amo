import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CatalogImporter, CatalogRepo } from '@ai-door/catalog';
import { AccountsRepo, type Db } from '@ai-door/db';
import { KnowledgeRepo } from '@ai-door/knowledge';
import { freshDb } from '../../db/test/setup.ts';

export const FEED_PATH = fileURLToPath(new URL('../../../evals/fixtures/catalog.yml', import.meta.url));
export const KNOWLEDGE_PATH = fileURLToPath(new URL('../../../evals/fixtures/knowledge.json', import.meta.url));

export interface Seeded {
  db: Db;
  drop: () => Promise<void>;
  catalog: CatalogRepo;
  knowledge: KnowledgeRepo;
}

/** Схема БД с тестовым каталогом и базой знаний для аккаунта accountId. */
export async function seeded(accountId = 1): Promise<Seeded> {
  const { db, drop } = await freshDb();
  await new AccountsRepo(db).upsertInstalled({ id: accountId, subdomain: 'test', accountDomain: 'test.amocrm.ru' });
  await new CatalogImporter(db).importFromBytes(accountId, new Uint8Array(readFileSync(FEED_PATH)));
  const knowledge = new KnowledgeRepo(db);
  const kb = JSON.parse(readFileSync(KNOWLEDGE_PATH, 'utf8')) as {
    faq: { q: string; a: string }[];
    texts: { title: string; content: string }[];
  };
  for (const f of kb.faq) await knowledge.addFaq(accountId, f.q, f.a);
  for (const t of kb.texts) await knowledge.addText(accountId, t.title, t.content);
  return { db, drop, catalog: new CatalogRepo(db), knowledge };
}
