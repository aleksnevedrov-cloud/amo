import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AccountsRepo, type Db } from '@ai-door/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb } from '../../db/test/setup.ts';
import { assertPublicUrl, CatalogImporter, CatalogRepo, decodeFeed, parseYml, toOrTsQuery } from '../src/index.ts';

const FEED = new Uint8Array(readFileSync(fileURLToPath(new URL('../../../evals/fixtures/catalog.yml', import.meta.url))));

describe('parseYml', () => {
  it('разбирает фид в windows-1251', () => {
    const feed = parseYml(decodeFeed(FEED));
    expect(feed.shopName).toBe('РФ-Двери (тест)');
    expect(feed.categories).toHaveLength(8);
    expect(feed.products).toHaveLength(16);
    const p = feed.products.find((x) => x.id === '1002');
    expect(p).toMatchObject({
      name: 'Дверь межкомнатная Турин 2 эмаль слоновая кость',
      price: 16500,
      oldPrice: 17900,
      available: true,
      vendorCode: 'TUR-2-I',
      description: 'Классическая филёнка, эмаль в 3 слоя.',
    });
    expect(p?.params).toContainEqual({ name: 'Ширина полотна', value: '600, 700, 800', unit: 'мм' });
    expect(feed.products.find((x) => x.id === '1003')?.available).toBe(false);
  });

  it('собирает имя из typePrefix/vendor/model и пропускает офферы без id', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?><yml_catalog><shop><offers>
      <offer id="a1"><typePrefix>Дверь</typePrefix><vendor>Бренд</vendor><model>X1</model><price>1 000,50</price></offer>
      <offer><name>Без id</name></offer></offers></shop></yml_catalog>`;
    const feed = parseYml(xml);
    expect(feed.products).toEqual([expect.objectContaining({ id: 'a1', name: 'Дверь Бренд X1', price: 1000.5, available: null })]);
  });

  it('понятная ошибка для не-YML', () => {
    expect(() => parseYml('<html><body>404</body></html>')).toThrow(/YML/);
  });
});

describe('assertPublicUrl', () => {
  const resolve = (ip: string) => async () => [ip];
  it('пропускает публичный адрес', async () => {
    await expect(assertPublicUrl('https://rf-dveri.ru/feed.xml', resolve('93.158.134.3'))).resolves.toBeInstanceOf(URL);
  });
  it.each(['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.20.0.2', '169.254.169.254', '::1'])('блокирует %s', async (ip) => {
    await expect(assertPublicUrl('https://feed.example/x', resolve(ip))).rejects.toThrow(/внутреннюю/);
  });
  it('блокирует другие схемы и логин в адресе', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow();
    await expect(assertPublicUrl('https://u:p@rf-dveri.ru/', resolve('93.158.134.3'))).rejects.toThrow();
  });
});

describe('toOrTsQuery', () => {
  it('строит OR-запрос из слов', () => {
    expect(toOrTsQuery('Белая дверь, эмаль 80 см!')).toBe('белая | дверь | эмаль | 80 | см');
    expect(toOrTsQuery("'; DROP TABLE --")).toBe('drop | table');
  });
});

describe('импорт и поиск', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let repo: CatalogRepo;

  beforeAll(async () => {
    ({ db, drop } = await freshDb());
    await new AccountsRepo(db).upsertInstalled({ id: 1, subdomain: 'a', accountDomain: 'a.amocrm.ru' });
    await new AccountsRepo(db).upsertInstalled({ id: 2, subdomain: 'b', accountDomain: 'b.amocrm.ru' });
    await new CatalogImporter(db).importFromBytes(1, FEED);
    repo = new CatalogRepo(db);
  });
  afterAll(async () => drop());

  it('статистика импорта', async () => {
    const s = await repo.stats(1);
    expect(s.products).toBe(16);
    expect(s.lastImport).toMatchObject({ status: 'ok', products: 16 });
  });

  it('находит по словам с учётом морфологии', async () => {
    const res = await repo.search(1, { query: 'белые двери эмалью' });
    expect(res[0]?.id).toBe('1001');
  });

  it('находит по артикулу', async () => {
    const res = await repo.search(1, { query: 'por-22-v' });
    expect(res[0]?.id).toBe('1005');
  });

  it('фильтрует по цене и наличию', async () => {
    const res = await repo.search(1, { query: 'межкомнатная дверь', maxPrice: 7000, availableOnly: true, limit: 10 });
    expect(res[0]?.id).toBe('1007');
    expect(res.every((p) => (p.price ?? 0) <= 7000 && p.available !== false)).toBe(true);
    expect(res.map((p) => p.id)).not.toContain('1008');
  });

  it('находит похожие в той же категории', async () => {
    const res = await repo.search(1, { similarTo: '1004', limit: 10 });
    expect(res.map((p) => p.id).sort()).toEqual(['1005', '1006']);
  });

  it('карточка по id и артикулу, чужой аккаунт не видит товар', async () => {
    expect((await repo.get(1, '2001'))?.params).toContainEqual({ name: 'Терморазрыв', value: 'да' });
    expect((await repo.get(1, 'str-c'))?.id).toBe('2002');
    expect(await repo.get(2, '2001')).toBeNull();
    expect(await repo.search(2, { query: 'дверь' })).toEqual([]);
  });

  it('повторный импорт удаляет пропавшие товары и обновляет цены', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?><yml_catalog><shop><offers>
      <offer id="1001" available="true"><name>Дверь Турин 1</name><price>15500</price></offer></offers></shop></yml_catalog>`;
    await new CatalogImporter(db).importFromBytes(1, new TextEncoder().encode(xml));
    expect((await repo.stats(1)).products).toBe(1);
    expect((await repo.get(1, '1001'))?.price).toBe(15500);
    await new CatalogImporter(db).importFromBytes(1, FEED);
  });

  it('пустой фид не стирает каталог и фиксирует ошибку', async () => {
    const xml = '<?xml version="1.0"?><yml_catalog><shop><offers></offers></shop></yml_catalog>';
    await expect(new CatalogImporter(db).importFromBytes(1, new TextEncoder().encode(xml))).rejects.toThrow(/ни одного/);
    const s = await repo.stats(1);
    expect(s.products).toBe(16);
    expect(s.lastImport).toMatchObject({ status: 'failed' });
  });

  it('импорт по URL через fetch', async () => {
    const fetchImpl = (async () => new Response(FEED, { status: 200 })) as typeof fetch;
    const imp = new CatalogImporter(db, { fetch: fetchImpl, resolve: async () => ['93.158.134.3'] });
    await expect(imp.importFromUrl(2, 'https://rf-dveri.ru/feed.yml')).resolves.toMatchObject({ products: 16 });
  });
});
