import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATALOG_YML_BASE64 } from '../fixtures/catalog-yml.ts';
import { evalFixtures, pricingRulesFixture } from '../seed.ts';
import { TEST_DATABASE_URL } from '../../packages/db/test/setup.ts';

describe('фикстуры eval для прогона из API', () => {
  it('встроенный каталог совпадает с catalog.yml (иначе — pnpm --filter @ai-door/evals run embed)', () => {
    expect(Buffer.from(CATALOG_YML_BASE64, 'base64').equals(readFileSync(new URL('../fixtures/catalog.yml', import.meta.url)))).toBe(true);
    expect(Object.keys(pricingRulesFixture).length).toBeGreaterThan(1);
  });

  it('временная схема: каталог с поиском и база знаний, после drop схемы нет', async () => {
    const f = await evalFixtures(TEST_DATABASE_URL, 1);
    try {
      expect((await f.catalog.search(1, { query: 'белая эмаль' })).map((p) => p.id)).toContain('1001');
      expect(f.groundTruth[0]).toContain('Турин 1');
      expect(await f.knowledge.list(1)).not.toHaveLength(0);
    } finally {
      await f.drop();
    }
    const { rows } = await (await evalFixtures(TEST_DATABASE_URL, 1).then(async (g) => (await g.drop(), g))).db.query('SELECT 1').catch(() => ({ rows: [] }));
    expect(rows).toEqual([]);
  });
});
