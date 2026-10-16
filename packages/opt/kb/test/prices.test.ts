import type { Db } from '@core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { leavesOf, modelKeyOf, sizeOf } from '../src/model-key.ts';
import { applyRules, KbAliasesRepo, KbPricesRepo, lookupPrice, priceLabelOf, type KbPrice } from '../src/prices.ts';
import { KbRepo } from '../src/repo.ts';
import { freshKbDb } from './setup.ts';

const ACCOUNT = 555;
const row = (over: Partial<KbPrice>): KbPrice => ({ id: 1, accountId: ACCOUNT, sourceId: null, model: 'ДПГ сота', modelKey: 'дпг сота', factory: 'Текона', unit: 'шт', baseSize: '800×2000', widthMm: 800, heightMm: 2000, price: 3450, vat: 'included', currency: 'RUB', validAt: new Date('2026-10-01'), confidence: 70, origin: 'price_list', nonstandard: {}, url: null, note: null, createdBy: null, createdAt: new Date(), updatedAt: new Date(), sourceTitle: 'прайс Текона.xlsx', sourceKind: 'file', abbr: null, description: null, altKeys: [], searchTokens: ['дпг', 'сота'], sourceRow: null, ...over });

describe('ключ модели и правила нестандарта', () => {
  it('ключ без размера, количества и общих слов; размер и створки из текста', () => {
    expect(modelKeyOf('Дверь ДПГ сота 800×2000 мм — 12 шт')).toBe('дпг сота');
    expect(modelKeyOf('Полотно межкомнатное «Турин» 2000*700, 3 штуки')).toBe('турин');
    expect(modelKeyOf('Профиль Дорс 2.47U белый сатинат')).toBe('профиль дорс 2 47u белый сатинат');
    expect(sizeOf('ДПГ 2000*800*40 мм')).toEqual({ widthMm: 800, heightMm: 2000 });
    expect(sizeOf('1,4х2,7 м')).toEqual({ widthMm: 1400, heightMm: 2700 });
    expect(sizeOf('добор 10 шт')).toBeNull();
    expect(leavesOf('дверь двупольная')).toBe(2);
    expect(leavesOf('дверь')).toBeNull();
  });

  it('точный размер — базовая цена; нестандарт по высоте/ширине — доплаты; без правил — площадь; двупольная — доплата', () => {
    const base = row({ nonstandard: { heightPct: 15, widthPct: 10, doubleLeafPct: 20 } });
    expect(applyRules(base, { name: 'x', widthMm: 800, heightMm: 2000 })).toMatchObject({ price: 3450, basis: 'exact', notes: [] });
    expect(applyRules(base, { name: 'x', widthMm: 800, heightMm: 2300 })).toMatchObject({ price: 3967.5, basis: 'rules', notes: ['нестандарт по высоте 2300 мм: +15 %'] });
    expect(applyRules(base, { name: 'x', widthMm: 900, heightMm: 2300 }).price).toBe(3450 * 1.25);
    expect(applyRules(base, { name: 'x', widthMm: 800, heightMm: 2000, leaves: 2 })).toMatchObject({ price: 4140, notes: ['двупольное исполнение: +20 %'] });
    const noRules = row({});
    const area = applyRules(noRules, { name: 'x', widthMm: 900, heightMm: 2100 });
    expect(area.basis).toBe('area');
    expect(area.price).toBeCloseTo(3450 * ((900 * 2100) / (800 * 2000)), 2);
    expect(applyRules(row({ nonstandard: { areaScale: false } }), { name: 'x', widthMm: 900, heightMm: 2100 })).toMatchObject({ price: 3450, basis: 'base' });
    expect(applyRules(row({ widthMm: null, heightMm: null, baseSize: null }), { name: 'x', widthMm: 900, heightMm: 2100 })).toMatchObject({ price: 3450, basis: 'base' });
    expect(applyRules(noRules, { name: 'x' })).toMatchObject({ basis: 'base', notes: ['размер позиции не указан — базовая цена'] });
  });

  it('подписи источника цены', () => {
    expect(priceLabelOf(row({}))).toBe(`по базе: прайс Текона.xlsx (${new Date('2026-10-01').toLocaleDateString('ru-RU')})`);
    expect(priceLabelOf(row({ origin: 'web', sourceTitle: null }))).toMatch(/^по рынку \(/);
    expect(priceLabelOf(row({ origin: 'manager' }))).toBe('изменено менеджером');
    expect(priceLabelOf(row({ origin: 'purchase' }))).toMatch(/^по закупке \(/);
    expect(priceLabelOf(row({ sourceTitle: null }))).toMatch(/^по базе: прайс Текона \(/);
  });
});

describe('kb_prices и kb_aliases на БД', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let prices: KbPricesRepo;
  let aliases: KbAliasesRepo;
  let sourceId = 0;
  beforeAll(async () => {
    ({ db, drop } = await freshKbDb());
    prices = new KbPricesRepo(db);
    aliases = new KbAliasesRepo(db);
    sourceId = await new KbRepo(db).createSource({ accountId: ACCOUNT, kind: 'file', title: 'прайс Текона 01.10.2026.xlsx', original: 'прайс.xlsx' });
  });
  afterAll(() => drop());

  it('импорт прайса, повтор заменяет, список с поиском, правка и удаление', async () => {
    const { imported: n } = await prices.replacePriceList(ACCOUNT, sourceId, [
      { model: 'ДПГ сота', factory: 'Текона', widthMm: 800, heightMm: 2000, price: 3450, origin: 'price_list', validAt: new Date('2026-10-01'), nonstandard: { heightPct: 15 } },
      { model: 'ДПГ сота', factory: 'Текона', widthMm: 900, heightMm: 2000, price: 3650, origin: 'price_list', validAt: new Date('2026-10-01') },
      { model: 'ДПО сота', factory: 'Текона', widthMm: 800, heightMm: 2000, price: 4100, origin: 'price_list', validAt: new Date('2026-10-01') },
      { model: 'Турин', factory: 'Браво', price: 7900, origin: 'price_list', validAt: new Date('2026-10-01') },
    ]);
    expect(n).toBe(4);
    expect(await prices.replacePriceList(ACCOUNT, sourceId, [{ model: 'ДПГ сота', widthMm: 800, heightMm: 2000, price: 3500, origin: 'price_list' }, { model: 'ДПГ сота', widthMm: 900, heightMm: 2000, price: 3650, origin: 'price_list', nonstandard: { heightPct: 15 } }, { model: 'ДПО сота', widthMm: 800, heightMm: 2000, price: 4100, origin: 'price_list' }, { model: 'Турин', factory: 'Браво', price: 7900, origin: 'price_list' }])).toEqual({ imported: 4, replaced: 4 });
    const all = await prices.list(ACCOUNT);
    expect(all.total).toBe(4);
    expect(all.items.map((p) => [p.model, p.baseSize, p.price, p.confidence, p.sourceTitle])).toEqual([
      ['ДПГ сота', '800×2000', 3500, 70, 'прайс Текона 01.10.2026.xlsx'],
      ['ДПГ сота', '900×2000', 3650, 70, 'прайс Текона 01.10.2026.xlsx'],
      ['ДПО сота', '800×2000', 4100, 70, 'прайс Текона 01.10.2026.xlsx'],
      ['Турин', null, 7900, 70, 'прайс Текона 01.10.2026.xlsx'],
    ]);
    expect((await prices.list(ACCOUNT, { q: 'турин' })).items.map((p) => p.model)).toEqual(['Турин']);
    const turin = (await prices.list(ACCOUNT, { q: 'турин' })).items[0]!;
    const upd = await prices.update(ACCOUNT, turin.id, { price: 8100, widthMm: 800, heightMm: 2000, confidence: 90 });
    expect(upd).toMatchObject({ price: 8100, baseSize: '800×2000', confidence: 90 });
    // Ручная запись менеджера: отдельная строка с доверием 90 рядом с прайсовой.
    const manual = await prices.upsert({ accountId: ACCOUNT, model: 'ДПО сота 800×2000', widthMm: 800, heightMm: 2000, price: 3990, origin: 'manager', createdBy: 7 });
    expect((await prices.byId(ACCOUNT, manual))).toMatchObject({ modelKey: 'дпо сота', baseSize: '800×2000', confidence: 90, origin: 'manager', sourceTitle: null });
    expect((await prices.upsert({ accountId: ACCOUNT, model: 'ДПО сота', widthMm: 800, heightMm: 2000, price: 4050, origin: 'manager', createdBy: 7 }))).toBe(manual);
    expect((await prices.byId(ACCOUNT, manual))?.price).toBe(4050);
  });

  it('подбор: точный размер › доверие; правила нестандарта; синоним; похожая модель; устаревшая цена; чужой аккаунт', async () => {
    // ДПГ сота 800×2000: прайсовая 3500.
    const exact = await lookupPrice(prices, aliases, ACCOUNT, { name: 'Дверь ДПГ сота 800×2000 мм', widthMm: 800, heightMm: 2000 }, new Date('2026-10-15'));
    expect(exact).toMatchObject({ price: 3500, basis: 'exact', match: 'exact', stale: false, label: expect.stringContaining('по базе: прайс Текона 01.10.2026.xlsx') });
    // ДПО сота 800×2000: прайс (4100) выше ручной правки менеджера (4050) при том же размере (KB-PRICELIST, д: прайс › менеджер › веб).
    expect(await lookupPrice(prices, aliases, ACCOUNT, { name: 'ДПО сота', widthMm: 800, heightMm: 2000 })).toMatchObject({ price: 4100, label: expect.stringContaining('по базе') });
    // Без строки прайса на этот размер и модель — правка менеджера; веб-цена ниже обеих.
    await prices.upsert({ accountId: ACCOUNT, model: 'Тоскана', widthMm: 800, heightMm: 2000, price: 9000, origin: 'web' });
    await prices.upsert({ accountId: ACCOUNT, model: 'Тоскана', widthMm: 800, heightMm: 2000, price: 8700, origin: 'manager', createdBy: 7 });
    expect(await lookupPrice(prices, aliases, ACCOUNT, { name: 'Тоскана', widthMm: 800, heightMm: 2000 })).toMatchObject({ price: 8700, label: 'изменено менеджером' });
    // Нестандарт по высоте: ближайшая запись с правилом (900×2000 с heightPct 15) → 3650 × 1,15; размер в тексте.
    const tall = await lookupPrice(prices, aliases, ACCOUNT, { name: 'ДПГ сота 900×2300' });
    expect(tall).toMatchObject({ basis: 'rules', price: 4197.5, notes: ['нестандарт по высоте 2300 мм: +15 %'] });
    // Другой размер без правил → площадь.
    const area = await lookupPrice(prices, aliases, ACCOUNT, { name: 'ДПО сота', widthMm: 600, heightMm: 2000 });
    expect(area?.basis).toBe('area');
    // Синоним: «ДПГ + УПД (сота)» = «ДПГ сота».
    await aliases.addLine(ACCOUNT, 'ДПГ сота = ДПГ + УПД (сота) = дверь глухая ламинированная сотовое заполнение', { createdBy: 7 });
    expect((await aliases.list(ACCOUNT)).map((a) => [a.aliasKey, a.canonicalKey])).toEqual([['глухая ламинированная сотовое заполнение', 'дпг сота'], ['дпг упд сота', 'дпг сота']]);
    const viaAlias = await lookupPrice(prices, aliases, ACCOUNT, { name: 'дверь глухая ламинированная сотовое заполнение', widthMm: 800, heightMm: 2000 });
    expect(viaAlias).toMatchObject({ price: 3500, match: 'alias', notes: ['по синониму: ДПГ сота'] });
    // Похожая модель по словам: «Турин» внутри длинного названия.
    const tokens = await lookupPrice(prices, aliases, ACCOUNT, { name: 'Дверь Браво Турин белая эмаль', widthMm: 800, heightMm: 2000 });
    expect(tokens).toMatchObject({ match: 'tokens', price: 8100, notes: [expect.stringContaining('похожая модель в базе: Турин')] });
    // Устарела: прайс 01.10.2026 через 100 дней.
    const old = await lookupPrice(prices, aliases, ACCOUNT, { name: 'ДПГ сота', widthMm: 800, heightMm: 2000 }, new Date('2027-01-20'));
    expect(old).toMatchObject({ stale: true, validityDays: 90, notes: [expect.stringContaining('цена устарела')] });
    expect(await lookupPrice(prices, aliases, ACCOUNT, { name: 'Добор телескопический 100 мм' })).toBeNull();
    expect(await lookupPrice(prices, aliases, 1, { name: 'ДПГ сота', widthMm: 800, heightMm: 2000 })).toBeNull();
    expect(await aliases.remove(ACCOUNT, (await aliases.list(ACCOUNT))[0]!.id)).toBe(true);
    expect(await prices.remove(ACCOUNT, exact!.row.id)).toBe(true);
    // 4 прайсовых минус удалённая плюс ручная ДПО и две Тосканы.
    expect((await prices.list(ACCOUNT)).total).toBe(6);
  });
});

describe('прайс — единый источник цен (RFD-AI-AGENT-OPT-KB-PRICELIST)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let prices: KbPricesRepo;
  let aliases: KbAliasesRepo;
  let repo: KbRepo;
  const ACC = 777;
  beforeAll(async () => {
    ({ db, drop } = await freshKbDb());
    prices = new KbPricesRepo(db);
    aliases = new KbAliasesRepo(db);
    repo = new KbRepo(db);
  });
  afterAll(() => drop());

  it('а, е: новый прайс заменяет цены прежнего целиком (правки менеджера и веб-цены остаются); удаление файла удаляет его цены, сирот нет, повторное удаление не падает', async () => {
    const first = await repo.createSource({ accountId: ACC, kind: 'file', title: 'прайс-1.xlsx', original: 'прайс-1.xlsx' });
    const r1 = await prices.replacePriceList(ACC, first, [
      { model: 'ДВ CPL', widthMm: 1010, heightMm: 2100, price: 23_900, origin: 'price_list', abbr: 'ДВ CPL', description: 'Дверной блок деревянный внутренний глухой однопольный без порога', sourceRow: 17 },
      { model: 'ДВ CPL', widthMm: 910, heightMm: 2100, price: 23_900, origin: 'price_list', abbr: 'ДВ CPL', description: 'Дверной блок деревянный внутренний глухой однопольный без порога', sourceRow: 17 },
    ]);
    expect(r1).toEqual({ imported: 2, replaced: 0 });
    await prices.upsert({ accountId: ACC, model: 'ДВ CPL', widthMm: 1010, heightMm: 2100, price: 23_000, origin: 'manager', createdBy: 7 });
    await prices.upsert({ accountId: ACC, model: 'Турин', widthMm: 800, heightMm: 2000, price: 8000, origin: 'web' });
    expect((await prices.list(ACC, { q: 'cpl' })).items.find((p) => p.origin === 'price_list')).toMatchObject({ abbr: 'ДВ CPL', altKeys: ['блок деревянный внутренний глухой однопольный порога'], sourceRow: 17 });
    expect((await prices.countBySource(ACC)).get(first)).toBe(2);
    // Второй файл: те же модели — конфликта по kb_prices_key нет, прежний прайс удалён.
    const second = await repo.createSource({ accountId: ACC, kind: 'file', title: 'прайс-2.xlsx', original: 'прайс-2.xlsx' });
    const r2 = await prices.replacePriceList(ACC, second, [{ model: 'ДВ CPL', widthMm: 1010, heightMm: 2100, price: 24_500, origin: 'price_list', sourceRow: 3 }]);
    expect(r2).toEqual({ imported: 1, replaced: 2 });
    const left = await prices.list(ACC);
    // Список: по ключу модели и размеру, внутри — по доверию (менеджер 90 выше прайса 70).
    expect(left.items.map((p) => [p.model, p.baseSize, p.price, p.origin, p.sourceId])).toEqual([
      ['ДВ CPL', '1010×2100', 23_000, 'manager', null],
      ['ДВ CPL', '1010×2100', 24_500, 'price_list', second],
      ['Турин', '800×2000', 8000, 'web', null],
    ]);
    expect((await prices.countBySource(ACC)).get(first)).toBeUndefined();
    // Удаление файла второго прайса: его цены ушли вместе с ним (CASCADE), менеджер и веб на месте; первый файл удаляется без ошибки.
    expect(await repo.remove(ACC, second)).not.toBeNull();
    expect((await prices.list(ACC)).items.map((p) => p.origin)).toEqual(['manager', 'web']);
    expect(await repo.remove(ACC, first)).not.toBeNull();
    expect((await db.query(`SELECT count(*)::int AS n FROM kb_prices WHERE account_id = $1 AND source_id IS NULL AND origin = 'price_list'`, [ACC])).rows[0]?.n).toBe(0);
  });

  it('г: ключ назначения — точное совпадение; подбор по словам с совпадением и строкой прайса; д: прайс выше веб-цены при том же размере', async () => {
    const src = await repo.createSource({ accountId: ACC, kind: 'file', title: 'прайс ДВ.xlsx', original: 'прайс ДВ.xlsx' });
    await prices.replacePriceList(ACC, src, [
      { model: 'ДВ CPL', widthMm: 1010, heightMm: 2100, price: 23_900, origin: 'price_list', abbr: 'ДВ CPL', description: 'Дверной блок деревянный внутренний глухой однопольный без порога, покрытие CPL', sourceRow: 17, validAt: new Date('2026-10-10') },
      { model: 'ДВ CPL', widthMm: 910, heightMm: 2100, price: 23_900, origin: 'price_list', abbr: 'ДВ CPL', description: 'Дверной блок деревянный внутренний глухой однопольный без порога, покрытие CPL', sourceRow: 17, validAt: new Date('2026-10-10') },
      { model: 'ДВ ПВХ', widthMm: 910, heightMm: 2100, price: 19_900, origin: 'price_list', abbr: 'ДВ ПВХ', description: 'Дверной блок деревянный внутренний остеклённый однопольный с порогом, покрытие ПВХ', sourceRow: 18, validAt: new Date('2026-10-10') },
    ]);
    // Название из письма клиента совпадает с «Назначение/Конструкция» дословно → точное совпадение по дополнительному ключу.
    const byDescription = await lookupPrice(prices, aliases, ACC, { name: 'Дверной блок деревянный внутренний глухой однопольный без порога, покрытие CPL', widthMm: 1010, heightMm: 2100 }, new Date('2026-10-16'));
    expect(byDescription).toMatchObject({ price: 23_900, basis: 'exact', match: 'exact', confidence: 70, notes: ['найдено по прайсу: ДВ CPL (строка 17), по назначению'] });
    // Другая формулировка — подбор по словам: совпадение ≥ 50 %, доверие снижено, подпись со строкой прайса.
    const byWords = await lookupPrice(prices, aliases, ACC, { name: 'Дверной блок деревянный внутренний глухой однопольный CPL без порога 910×2100', widthMm: 910, heightMm: 2100 }, new Date('2026-10-16'));
    expect(byWords).toMatchObject({ price: 23_900, basis: 'exact', match: 'words', row: { model: 'ДВ CPL', widthMm: 910 } });
    expect(byWords?.similarity).toBeGreaterThanOrEqual(0.5);
    expect(byWords?.confidence).toBeLessThan(70);
    expect(byWords?.notes.at(-1)).toMatch(/^найдено по прайсу: ДВ CPL \(строка 17\), совпадение \d+ %$/);
    // Мало общих слов — не подбирается.
    expect(await lookupPrice(prices, aliases, ACC, { name: 'Дверной блок стальной наружный', widthMm: 910, heightMm: 2100 })).toBeNull();
    // Веб-цена на ту же модель и размер не перебивает строку прайса.
    await prices.upsert({ accountId: ACC, model: 'ДВ CPL', widthMm: 1010, heightMm: 2100, price: 21_000, origin: 'web', validAt: new Date('2026-10-15') });
    expect(await lookupPrice(prices, aliases, ACC, { name: 'ДВ CPL', widthMm: 1010, heightMm: 2100 }, new Date('2026-10-16'))).toMatchObject({ price: 23_900, label: expect.stringContaining('по базе: прайс ДВ.xlsx') });
  });
});
