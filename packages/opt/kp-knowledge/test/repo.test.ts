import { AccountsRepo, type Db } from '@core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshOptDb } from '../../kp/test/setup.ts';
import { EMPTY_KNOWLEDGE, KpKnowledgeRepo } from '../src/repo.ts';

describe('KpKnowledgeRepo на БД опта', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await freshOptDb());
    await new AccountsRepo(db).upsertInstalled({ id: 1, subdomain: 'acc', accountDomain: 'acc.amocrm.ru' });
  });
  afterAll(() => drop());

  it('пусто → EMPTY_KNOWLEDGE; загрузка заменяет файл того же вида; удаление', async () => {
    const repo = new KpKnowledgeRepo(db);
    expect(await repo.loadSet(1)).toEqual(EMPTY_KNOWLEDGE);
    expect(await repo.list(1)).toEqual([]);
    await repo.save(1, 'delivery', { filename: 'delivery.csv', content: 'зона;цена\nМосква;1500', data: [{ zone: 'Москва', description: '', priceRub: 1500, minOrderRub: null, note: '' }], rows: 1, userId: 7 });
    await repo.save(1, 'delivery', { filename: 'delivery-v2.csv', content: 'зона;цена\nМосква;1600\nМО;2500', data: [{ zone: 'Москва', description: '', priceRub: 1600, minOrderRub: null, note: '' }, { zone: 'МО', description: '', priceRub: 2500, minOrderRub: null, note: '' }], rows: 2, userId: 7 });
    await repo.save(1, 'b2b', { filename: 'b2b.md', content: '## Документы\nx', data: { sections: [{ title: 'Документы', text: 'x' }] }, rows: 1, userId: 7 });
    expect((await repo.list(1)).map((i) => [i.kind, i.filename, i.rows, i.usage])).toEqual([['b2b', 'b2b.md', 1, 'reference'], ['delivery', 'delivery-v2.csv', 2, 'reference']]);
    const set = await repo.loadSet(1);
    expect(set.delivery).toHaveLength(2);
    expect(set.b2b?.sections[0]?.title).toBe('Документы');
    expect(set.analogs).toEqual([]);
    expect((await repo.get(1, 'delivery'))?.data[1]?.zone).toBe('МО');
    expect(await repo.remove(1, 'delivery')).toBe(true);
    expect(await repo.remove(1, 'delivery')).toBe(false);
    expect((await repo.loadSet(1)).delivery).toEqual([]);
  });
});
