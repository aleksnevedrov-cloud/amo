import type { Db } from '@core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { leavesOf, modelKeyOf, sizeOf } from '../src/model-key.ts';
import { applyRules, categoryMedian, KbAliasesRepo, KbPricesRepo, lookupPrice, priceLabelOf, type KbPrice } from '../src/prices.ts';
import { EMPTY_FEATURES, featuresOf } from '../src/features.ts';
import { KbRepo } from '../src/repo.ts';
import { freshKbDb } from './setup.ts';

const ACCOUNT = 555;
const row = (over: Partial<KbPrice>): KbPrice => ({ id: 1, accountId: ACCOUNT, sourceId: null, model: 'ДПГ сота', modelKey: 'дпг сота', factory: 'Текона', unit: 'шт', baseSize: '800×2000', widthMm: 800, heightMm: 2000, price: 3450, vat: 'included', currency: 'RUB', validAt: new Date('2026-10-01'), confidence: 70, origin: 'price_list', nonstandard: {}, url: null, note: null, createdBy: null, createdAt: new Date(), updatedAt: new Date(), sourceTitle: 'прайс Текона.xlsx', sourceKind: 'file', abbr: null, description: null, altKeys: [], searchTokens: ['дпг', 'сота'], sourceRow: null, features: null, featureKey: null, coating: null, equipment: null, priceKey: null, priceTitle: null, category: 'door', componentKind: null, productId: null, tariffId: null, status: 'active', estimate: false, family: null, appliesTo: [], componentStatus: null, card: null, ...over });

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
    expect(await prices.replacePriceList(ACCOUNT, sourceId, [{ model: 'ДПГ сота', widthMm: 800, heightMm: 2000, price: 3500, origin: 'price_list' }, { model: 'ДПГ сота', widthMm: 900, heightMm: 2000, price: 3650, origin: 'price_list', nonstandard: { heightPct: 15 } }, { model: 'ДПО сота', widthMm: 800, heightMm: 2000, price: 4100, origin: 'price_list' }, { model: 'Турин', factory: 'Браво', price: 7900, origin: 'price_list' }])).toEqual({ imported: 4, replaced: 4, was: 4, removed: 0, added: 0 });
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
    // KB-MATCH: ключ совпал и признаки подошли (полотно, глухое) → подпись «по прайсу: …», пометка о совпавших признаках.
    expect(exact).toMatchObject({ price: 3500, basis: 'exact', match: 'exact', stale: false, label: 'по прайсу: ДПГ сота', notes: ['по прайсу: ДПГ сота — совпали: полотно, глухой'] });
    // ДПО сота 800×2000: прайс (4100) выше ручной правки менеджера (4050) при том же размере (KB-PRICELIST, д: прайс › менеджер › веб).
    expect(await lookupPrice(prices, aliases, ACCOUNT, { name: 'ДПО сота', widthMm: 800, heightMm: 2000 })).toMatchObject({ price: 4100, label: 'по прайсу: ДПО сота', row: { origin: 'price_list' } });
    // Без строки прайса на этот размер и модель — правка менеджера; веб-цена ниже обеих.
    await prices.upsert({ accountId: ACCOUNT, model: 'Тоскана', widthMm: 800, heightMm: 2000, price: 9000, origin: 'web' });
    await prices.upsert({ accountId: ACCOUNT, model: 'Тоскана', widthMm: 800, heightMm: 2000, price: 8700, origin: 'manager', createdBy: 7 });
    expect(await lookupPrice(prices, aliases, ACCOUNT, { name: 'Тоскана', widthMm: 800, heightMm: 2000 })).toMatchObject({ price: 8700, label: 'изменено менеджером' });
    // Нестандарт по высоте: ближайшая запись с правилом (900×2000 с heightPct 15) → 3650 × 1,15; размер в тексте.
    const tall = await lookupPrice(prices, aliases, ACCOUNT, { name: 'ДПГ сота 900×2300' });
    expect(tall).toMatchObject({ basis: 'rules', price: 4197.5, notes: ['нестандарт по высоте 2300 мм: +15 %', 'по прайсу: ДПГ сота — совпали: полотно, глухой'] });
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
    expect(tokens).toMatchObject({ match: 'tokens', price: 8100, notes: expect.arrayContaining([expect.stringContaining('похожая модель в базе: Турин'), 'цвет уточнить: в письме «белый», в строке прайса Турин цвет не указан']) });
    // Устарела: прайс 01.10.2026 через 100 дней.
    const old = await lookupPrice(prices, aliases, ACCOUNT, { name: 'ДПГ сота', widthMm: 800, heightMm: 2000 }, new Date('2027-01-20'));
    expect(old).toMatchObject({ stale: true, validityDays: 90, notes: expect.arrayContaining([expect.stringContaining('цена устарела')]) });
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
    expect(r1).toEqual({ imported: 2, replaced: 0, was: 0, removed: 0, added: 2 });
    await prices.upsert({ accountId: ACC, model: 'ДВ CPL', widthMm: 1010, heightMm: 2100, price: 23_000, origin: 'manager', createdBy: 7 });
    await prices.upsert({ accountId: ACC, model: 'Турин', widthMm: 800, heightMm: 2000, price: 8000, origin: 'web' });
    expect((await prices.list(ACC, { q: 'cpl' })).items.find((p) => p.origin === 'price_list')).toMatchObject({ abbr: 'ДВ CPL', altKeys: ['блок деревянный внутренний глухой однопольный порога'], sourceRow: 17 });
    expect((await prices.countBySource(ACC)).get(first)).toBe(2);
    // Второй файл того же прайса (KB-MULTIPRICE: тот же ключ — импорт передаёт прежний файл): те же модели — конфликта по kb_prices_key нет, прежний прайс удалён.
    const second = await repo.createSource({ accountId: ACC, kind: 'file', title: 'прайс-2.xlsx', original: 'прайс-2.xlsx' });
    const r2 = await prices.replacePriceList(ACC, second, [{ model: 'ДВ CPL', widthMm: 1010, heightMm: 2100, price: 24_500, origin: 'price_list', sourceRow: 3 }], [first]);
    expect(r2).toEqual({ imported: 1, replaced: 2, was: 2, removed: 1, added: 0 });
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
    expect(byDescription).toMatchObject({ price: 23_900, basis: 'exact', match: 'exact', confidence: 70, label: 'по прайсу: ДВ CPL (строка 17)', notes: ['по прайсу: ДВ CPL (строка 17) — совпали: дверной блок, деревянный, глухой, однопольный, без порога, CPL'] });
    // Другая формулировка — подбор по словам: совпадение ≥ 50 %, доверие снижено, подпись со строкой прайса.
    const byWords = await lookupPrice(prices, aliases, ACC, { name: 'Дверной блок деревянный внутренний глухой однопольный CPL без порога 910×2100', widthMm: 910, heightMm: 2100 }, new Date('2026-10-16'));
    expect(byWords).toMatchObject({ price: 23_900, basis: 'exact', match: 'words', row: { model: 'ДВ CPL', widthMm: 910 } });
    expect(byWords?.similarity).toBeGreaterThanOrEqual(0.5);
    expect(byWords?.confidence).toBeLessThan(70);
    expect(byWords?.notes.at(-1)).toBe('по прайсу: ДВ CPL (строка 17) — совпали: дверной блок, деревянный, глухой, однопольный, без порога, CPL');
    // Мало общих слов — не подбирается.
    expect(await lookupPrice(prices, aliases, ACC, { name: 'Дверной блок стальной наружный', widthMm: 910, heightMm: 2100 })).toBeNull();
    // Веб-цена на ту же модель и размер не перебивает строку прайса.
    await prices.upsert({ accountId: ACC, model: 'ДВ CPL', widthMm: 1010, heightMm: 2100, price: 21_000, origin: 'web', validAt: new Date('2026-10-15') });
    expect(await lookupPrice(prices, aliases, ACC, { name: 'ДВ CPL', widthMm: 1010, heightMm: 2100 }, new Date('2026-10-16'))).toMatchObject({ price: 23_900, row: { origin: 'price_list' }, label: 'по прайсу: ДВ CPL (строка 17)' });
  });
});

describe('подбор по смыслу: прайс в приоритете, веб не перебивает (RFD-AI-AGENT-OPT-KB-MATCH)', () => {
  const ACC = 777;
  let db: Db;
  let drop: () => Promise<void>;
  let prices: KbPricesRepo;
  let aliases: KbAliasesRepo;
  let repo: KbRepo;
  beforeAll(async () => {
    ({ db, drop } = await freshKbDb());
    prices = new KbPricesRepo(db);
    aliases = new KbAliasesRepo(db);
    repo = new KbRepo(db);
  });
  afterAll(() => drop());

  const LETTER = 'Дверной блок деревянный внутренний глухой однопольный без порога распашной с доводчиком, внутренним механическим замком, облицовка CPL светлосерый';

  it('строка прайса «ДВ CPL» подбирается по признакам к тексту письма; старые веб-записи «модель = текст письма» не перебивают; признаки хранятся у записи', async () => {
    // Веб-цены, записанные до KB-MATCH: модель — текст письма как есть, точное совпадение ключа.
    const webA = await prices.upsert({ accountId: ACC, model: `${LETTER} 1010×2100`, widthMm: 1010, heightMm: 2100, price: 5683, origin: 'web', validAt: new Date('2026-10-15') });
    const webB = await prices.upsert({ accountId: ACC, model: `${LETTER} 910×2100`, widthMm: 910, heightMm: 2100, price: 5120, origin: 'web', validAt: new Date('2026-10-15') });
    // У веб-записей признаки извлечены из текста модели (как сделает backfillFeatures для старых строк).
    expect((await prices.byId(ACC, webA))?.features).toMatchObject({ type: 'block', material: 'wood', glazing: 'solid', coating: 'cpl', closer: true, lock: true });
    expect((await prices.byId(ACC, webB))?.featureKey).toBe('block|wood|solid|cpl|*');
    // Без прайса — веб-цена (медианы прайса нет, диапазон не проверяется).
    expect(await lookupPrice(prices, aliases, ACC, { name: LETTER, widthMm: 1010, heightMm: 2100 }, new Date('2026-10-16'))).toMatchObject({ price: 5683, row: { origin: 'web' } });
    // Прайс с колонками признаков: «ДВ CPL», строка 17.
    const src = await repo.createSource({ accountId: ACC, kind: 'file', title: 'прайс ДВ.xlsx', original: 'прайс ДВ.xlsx' });
    const cpl = { material: 'wood' as const, glazing: 'solid' as const, coating: 'cpl' as const, type: 'block' as const, leaves: 1 as const, threshold: 'without' as const, opening: 'swing' as const };
    await prices.replacePriceList(ACC, src, [
      { model: 'ДВ CPL', widthMm: 1010, heightMm: 2100, price: 23_900, origin: 'price_list', abbr: 'ДВ 1Рп Г ПрБ', description: 'внутренняя, общественные помещения', sourceRow: 17, validAt: new Date('2026-10-10'), features: cpl, coating: 'CPL 0,2 мм', equipment: 'коробка, 3 петли, уплотнитель, замок, ручки, доводчик' },
      { model: 'ДВ CPL', widthMm: 910, heightMm: 2100, price: 23_900, origin: 'price_list', abbr: 'ДВ 1Рп Г ПрБ', description: 'внутренняя, общественные помещения', sourceRow: 17, validAt: new Date('2026-10-10'), features: cpl },
      { model: 'ДВ ПВХ', widthMm: 910, heightMm: 2100, price: 19_900, origin: 'price_list', abbr: 'ДВ 1Рп О', sourceRow: 18, validAt: new Date('2026-10-10'), features: { ...cpl, glazing: 'glazed', coating: 'pvc' } },
      { model: 'ДПГ сота', widthMm: 800, heightMm: 2000, price: 8800, origin: 'price_list', sourceRow: 3, validAt: new Date('2026-10-10') },
      { model: 'ДПО сота', widthMm: 800, heightMm: 2000, price: 9900, origin: 'price_list', sourceRow: 4, validAt: new Date('2026-10-10') },
    ]);
    expect((await prices.listByOrigin(ACC, 'price_list')).map((r) => [r.model, r.featureKey])).toEqual([
      ['ДВ CPL', 'block|wood|solid|cpl|*'],
      ['ДВ CPL', 'block|wood|solid|cpl|*'],
      ['ДВ ПВХ', 'block|wood|glazed|pvc|*'],
      ['ДПГ сота', 'leaf|*|solid|*|*'],
      ['ДПО сота', 'leaf|*|glazed|*|*'],
    ]);
    // Текст письма → «ДВ CPL» по признакам, обе ширины; веб-запись с точным ключом не перебивает.
    for (const [w, h] of [[1010, 2100], [910, 2100]] as const) {
      const hit = await lookupPrice(prices, aliases, ACC, { name: LETTER, raw: `${LETTER} ${w}×${h}`, widthMm: w, heightMm: h }, new Date('2026-10-16'));
      expect(hit).toMatchObject({ price: 23_900, basis: 'exact', match: 'features', confidence: 70, label: 'по прайсу: ДВ CPL (строка 17)', row: { origin: 'price_list', widthMm: w }, features: { matched: ['type', 'material', 'glazing', 'leaves', 'threshold', 'opening', 'coating'] } });
      // KP-NAME: в письме «светлосерый», в строке прайса цвета нет — «цвет уточнить»; покрытие и комплектация у записи.
      expect(hit?.notes).toEqual(['по прайсу: ДВ CPL (строка 17) — совпали: дверной блок, деревянный, глухой, однопольный, без порога, распашной, CPL', 'цвет уточнить: в письме «светло-серый», в строке прайса ДВ CPL (строка 17) цвет не указан']);
      expect(hit?.row).toMatchObject(w === 1010 ? { coating: 'CPL 0,2 мм', equipment: 'коробка, 3 петли, уплотнитель, замок, ручки, доводчик' } : { coating: null, equipment: null });
    }
    // Цвет назван и в строке прайса — пометки нет.
    await prices.upsert({ accountId: ACC, sourceId: src, model: 'ДВ CPL светло-серый', widthMm: 710, heightMm: 2100, price: 23_900, origin: 'price_list', features: cpl, sourceRow: 19 });
    const colored = await lookupPrice(prices, aliases, ACC, { name: 'Дверной блок деревянный глухой однопольный CPL светло серый', widthMm: 710, heightMm: 2100 }, new Date('2026-10-16'));
    expect(colored?.row.model).toBe('ДВ CPL светло-серый');
    expect(colored?.notes.some((n) => n.startsWith('цвет уточнить'))).toBe(false);
    // Явные признаки от модели разбора письма дополняют текст: «дверь внутренняя» + material/glazing/coating → та же строка.
    expect(await lookupPrice(prices, aliases, ACC, { name: 'Дверь внутренняя однопольная', widthMm: 910, heightMm: 2100, features: { type: 'block', material: 'wood', glazing: 'solid', coating: 'cpl' } }, new Date('2026-10-16'))).toMatchObject({ price: 23_900, match: 'features', row: { model: 'ДВ CPL' } });
    // «ДПГ + УПД, сота 2000×800» → ДПГ сота 8 800 (полотно глухое; ДПО отвергнуто по Г/О).
    expect(await lookupPrice(prices, aliases, ACC, { name: 'ДПГ + УПД, сота 2000×800' }, new Date('2026-10-16'))).toMatchObject({ price: 8800, row: { model: 'ДПГ сота' }, label: 'по прайсу: ДПГ сота (строка 3)', notes: ['по прайсу: ДПГ сота (строка 3) — совпали: полотно, глухой'] });
    // Алюминиевая дверь: материал расходится со всеми строками прайса, веб-записей нет → null (дальше — веб-поиск).
    expect(await lookupPrice(prices, aliases, ACC, { name: 'Дверь алюминиевая остеклённая с порогом', widthMm: 900, heightMm: 2100 }, new Date('2026-10-16'))).toBeNull();
    // Остеклённая с CPL: покрытие совпало, Г/О с «ДВ CPL» расходится, с «ДВ ПВХ» расходится покрытие → null.
    expect(await lookupPrice(prices, aliases, ACC, { name: 'Дверной блок деревянный остеклённый CPL', widthMm: 910, heightMm: 2100 }, new Date('2026-10-16'))).toBeNull();
  });

  it('веб-цена вне 40–300 % медианы прайса по группе признаков отбрасывается при подборе; правка менеджера выше веб, но ниже прайса', async () => {
    // Группа «стальная противопожарная EI60» есть в прайсе только одним размером; на другой размер — веб-записи.
    const src = await repo.createSource({ accountId: ACC, kind: 'file', title: 'прайс ДН.xlsx', original: 'прайс ДН.xlsx' });
    await prices.replacePriceList(ACC, src, [
      { model: 'ДПМ EI60', widthMm: 900, heightMm: 2100, price: 40_000, origin: 'price_list', description: 'дверь противопожарная металлическая EI60 глухая', sourceRow: 5, validAt: new Date('2026-10-10') },
      { model: 'ДПМ EI60 2Рп', widthMm: 1300, heightMm: 2100, price: 60_000, origin: 'price_list', description: 'дверь противопожарная металлическая EI60 глухая двупольная', sourceRow: 6, validAt: new Date('2026-10-10') },
    ]);
    await prices.upsert({ accountId: ACC, model: 'Дверь противопожарная металлическая EI60 глухая 1000×2100', widthMm: 1000, heightMm: 2100, price: 7000, origin: 'web', validAt: new Date('2026-10-15') });
    // Медиана группы steel|solid|EI60 — 50 000; веб 7 000 < 40 % → не кандидат; остаётся прайс по площади.
    const byPriceList = await lookupPrice(prices, aliases, ACC, { name: 'Дверь противопожарная металлическая EI60 глухая', widthMm: 1000, heightMm: 2100 }, new Date('2026-10-16'));
    expect(byPriceList).toMatchObject({ row: { origin: 'price_list', model: 'ДПМ EI60' }, basis: 'area' });
    // Правка менеджера на этот размер: прайс на этот размер есть только по площади, но прайс всё равно выше правки.
    await prices.upsert({ accountId: ACC, model: 'Дверь противопожарная металлическая EI60 глухая', widthMm: 1000, heightMm: 2100, price: 45_000, origin: 'manager', createdBy: 7 });
    expect(await lookupPrice(prices, aliases, ACC, { name: 'Дверь противопожарная металлическая EI60 глухая', widthMm: 1000, heightMm: 2100 }, new Date('2026-10-16'))).toMatchObject({ row: { origin: 'price_list' } });
    // Группа, которой в прайсе нет (пластик): веб-запись берётся без проверки диапазона.
    await prices.upsert({ accountId: ACC, model: 'Дверь пластиковая остеклённая', widthMm: 900, heightMm: 2100, price: 12_000, origin: 'web', validAt: new Date('2026-10-15') });
    expect(await lookupPrice(prices, aliases, ACC, { name: 'Дверь пластиковая остеклённая', widthMm: 900, heightMm: 2100 }, new Date('2026-10-16'))).toMatchObject({ price: 12_000, row: { origin: 'web' } });
    // backfillFeatures: запись без признаков получает их из модели.
    await db.query('UPDATE kb_prices SET features = NULL, feature_key = NULL WHERE account_id = $1 AND origin = $2', [ACC, 'web']);
    expect(await prices.backfillFeatures()).toBe(4);
    expect((await prices.listByOrigin(ACC, 'web')).map((r) => r.featureKey)).toEqual(['block|wood|solid|cpl|*', 'block|wood|solid|cpl|*', '*|steel|solid|*|EI60', '*|plastic|glazed|*|*']);
    expect(await prices.backfillFeatures()).toBe(0);
  });
});

describe('несколько прайсов, замена по файлу (RFD-AI-AGENT-OPT-KB-MULTIPRICE)', () => {
  const ACC = 888;
  let db: Db;
  let drop: () => Promise<void>;
  let prices: KbPricesRepo;
  let aliases: KbAliasesRepo;
  let repo: KbRepo;
  beforeAll(async () => {
    ({ db, drop } = await freshKbDb());
    prices = new KbPricesRepo(db);
    aliases = new KbAliasesRepo(db);
    repo = new KbRepo(db);
  });
  afterAll(() => drop());

  it('второй файл с другим ключом добавляет прайс рядом; файл с тем же ключом заменяет только свои цены (было/удалено/добавлено); удаление файла уносит только его цены', async () => {
    const inner = await repo.createSource({ accountId: ACC, kind: 'file', title: 'Прайс_межкомнатные_двери_ГОСТ.xlsx', original: 'Прайс_межкомнатные_двери_ГОСТ.xlsx' });
    await repo.setPriceInfo(inner, 'прайс межкомнатные двери гост', null);
    const r1 = await prices.replacePriceList(ACC, inner, [
      { model: 'ДВ CPL', widthMm: 1010, heightMm: 2100, price: 23_900, origin: 'price_list', validAt: new Date('2026-10-10') },
      { model: 'ДВ CPL', widthMm: 910, heightMm: 2100, price: 23_900, origin: 'price_list', validAt: new Date('2026-10-10') },
      { model: 'ДВ ПВХ', widthMm: 910, heightMm: 2100, price: 19_900, origin: 'price_list', validAt: new Date('2026-10-10') },
    ]);
    expect(r1).toEqual({ imported: 3, replaced: 0, was: 0, removed: 0, added: 3 });
    // Металлические — другой ключ: цены межкомнатных не трогаются.
    const metal = await repo.createSource({ accountId: ACC, kind: 'file', title: 'Прайс_металлические_двери_ГОСТ.xlsx', original: 'Прайс_металлические_двери_ГОСТ.xlsx' });
    await repo.setPriceInfo(metal, 'прайс металлические двери гост', null);
    const r2 = await prices.replacePriceList(ACC, metal, [{ model: 'ДМ EI60', widthMm: 900, heightMm: 2100, price: 40_000, origin: 'price_list', validAt: new Date('2026-10-16') }], (await repo.byPriceKey(ACC, 'прайс металлические двери гост', metal)).map((x) => x.id));
    expect(r2).toEqual({ imported: 1, replaced: 0, was: 0, removed: 0, added: 1 });
    expect((await prices.listByOrigin(ACC, 'price_list')).map((p) => [p.model, p.priceTitle])).toEqual([['ДВ CPL', 'Межкомнатные'], ['ДВ CPL', 'Межкомнатные'], ['ДВ ПВХ', 'Межкомнатные'], ['ДМ EI60', 'Металлические']]);
    expect(await prices.countBySource(ACC)).toEqual(new Map([[inner, 3], [metal, 1]]));
    // Файл межкомнатных с тем же ключом: заменяются только цены межкомнатных; одна модель ушла, одна добавилась.
    const inner2 = await repo.createSource({ accountId: ACC, kind: 'file', title: 'Прайс_межкомнатные_двери_ГОСТ — обновил 16102026.xlsx', original: 'Прайс_межкомнатные_двери_ГОСТ — обновил 16102026.xlsx' });
    const same = await repo.byPriceKey(ACC, 'прайс межкомнатные двери гост', inner2);
    expect(same.map((x) => x.id)).toEqual([inner]);
    const r3 = await prices.replacePriceList(ACC, inner2, [
      { model: 'ДВ CPL', widthMm: 1010, heightMm: 2100, price: 24_900, origin: 'price_list', validAt: new Date('2026-10-16') },
      { model: 'ДВ CPL', widthMm: 910, heightMm: 2100, price: 24_900, origin: 'price_list', validAt: new Date('2026-10-16') },
      { model: 'ДВ ламинат', widthMm: 910, heightMm: 2100, price: 15_900, origin: 'price_list', validAt: new Date('2026-10-16') },
    ], same.map((x) => x.id));
    expect(r3).toEqual({ imported: 3, replaced: 3, was: 3, removed: 1, added: 1 });
    expect(await prices.countBySource(ACC)).toEqual(new Map([[inner2, 3], [metal, 1]]));
    expect((await prices.listByOrigin(ACC, 'price_list')).map((p) => [p.model, p.price])).toEqual([['ДМ EI60', 40_000], ['ДВ CPL', 24_900], ['ДВ CPL', 24_900], ['ДВ ламинат', 15_900]]);
    // Удаление металлических уносит только их цены.
    await repo.remove(ACC, metal);
    expect((await prices.listByOrigin(ACC, 'price_list')).map((p) => p.model)).toEqual(['ДВ CPL', 'ДВ CPL', 'ДВ ламинат']);
    // backfillPriceKeys: у источника с ценами, но без ключа — ключ из имени файла.
    await db.query('UPDATE kb_sources SET price_key = NULL WHERE id = $1', [inner2]);
    expect(await repo.backfillPriceKeys((n) => n.toLowerCase().replace(/\.xlsx$/, '').replace(/_/g, ' ').replace(/ — обновил \d+$/, ''))).toBe(1);
    expect((await repo.get(ACC, inner2))?.priceKey).toBe('прайс межкомнатные двери гост');
    expect(await repo.backfillPriceKeys(() => 'x')).toBe(0);
  });

  it('одинаково подходящие строки в двух прайсах: берётся более свежая, пометка «найдено в двух прайсах»', async () => {
    const a = await repo.createSource({ accountId: ACC, kind: 'file', title: 'Прайс_А.xlsx', original: 'Прайс_А.xlsx' });
    const b = await repo.createSource({ accountId: ACC, kind: 'file', title: 'Прайс_Б.xlsx', original: 'Прайс_Б.xlsx' });
    await repo.setPriceInfo(a, 'прайс а', null);
    await repo.setPriceInfo(b, 'прайс б', null);
    await prices.replacePriceList(ACC, a, [{ model: 'ДПГ сота', widthMm: 800, heightMm: 2000, price: 8000, origin: 'price_list', validAt: new Date('2026-10-01') }]);
    await prices.replacePriceList(ACC, b, [{ model: 'ДПГ сота', widthMm: 800, heightMm: 2000, price: 8800, origin: 'price_list', validAt: new Date('2026-10-16') }]);
    const hit = await lookupPrice(prices, aliases, ACC, { name: 'ДПГ сота', widthMm: 800, heightMm: 2000 }, new Date('2026-10-16'));
    expect(hit).toMatchObject({ price: 8800, row: { sourceId: b } });
    expect(hit?.notes).toContain('найдено в двух прайсах: «А» (16.10.2026), «Б» (01.10.2026) — взята более свежая'.replace('«А» (16.10.2026), «Б» (01.10.2026)', '«Б» (16.10.2026), «А» (01.10.2026)'));
    // Строка только в одном прайсе — пометки нет.
    await prices.replacePriceList(ACC, a, [{ model: 'ДПО сота', widthMm: 800, heightMm: 2000, price: 9000, origin: 'price_list', validAt: new Date('2026-10-01') }]);
    const single = await lookupPrice(prices, aliases, ACC, { name: 'ДПО сота', widthMm: 800, heightMm: 2000 }, new Date('2026-10-16'));
    expect(single?.notes.some((n) => n.startsWith('найдено в'))).toBe(false);
  });
});

describe('категории: комплектующие, фурнитура, работы (RFD-AI-AGENT-OPT-KB-COMPONENTS)', () => {
  const ACC = 999;
  let db: Db;
  let drop: () => Promise<void>;
  let prices: KbPricesRepo;
  let aliases: KbAliasesRepo;
  let repo: KbRepo;
  beforeAll(async () => {
    ({ db, drop } = await freshKbDb());
    prices = new KbPricesRepo(db);
    aliases = new KbAliasesRepo(db);
    repo = new KbRepo(db);
  });
  afterAll(() => drop());

  it('подбор внутри категории: дверь не берёт строки комплектующих, добор берёт «Добор (…)» своего вида, фурнитура — из прайса фурнитуры, работы — без подбора; медиана по категории', async () => {
    const doors = await repo.createSource({ accountId: ACC, kind: 'file', title: 'Прайс_межкомнатные_двери_ГОСТ.xlsx', original: 'Прайс_межкомнатные_двери_ГОСТ.xlsx' });
    await repo.setPriceInfo(doors, 'прайс межкомнатные двери гост', null);
    const cpl = { material: 'wood' as const, coating: 'cpl' as const, glazing: 'solid' as const, type: 'block' as const };
    await prices.replacePriceList(ACC, doors, [
      { model: 'ДВ CPL', widthMm: 910, heightMm: 2100, price: 23_900, origin: 'price_list', abbr: 'ДВ 1Рп Г ПрБ', features: cpl, coating: 'CPL 0,2 мм' },
      { model: 'ДВ ПВХ', widthMm: 910, heightMm: 2100, price: 19_900, origin: 'price_list', features: { ...cpl, coating: 'pvc' }, coating: 'ПВХ' },
      { model: 'Добор (ДВ CPL)', price: 900, origin: 'price_list', category: 'component', componentKind: 'добор', features: cpl, coating: 'CPL 0,2 мм', description: 'комплектующее к ДВ CPL' },
      { model: 'Добор (ДВ ПВХ)', price: 850, origin: 'price_list', category: 'component', componentKind: 'добор', features: { ...cpl, coating: 'pvc' }, coating: 'ПВХ', description: 'комплектующее к ДВ ПВХ' },
      { model: 'Коробка (ДВ CPL)', price: 3500, origin: 'price_list', category: 'component', componentKind: 'коробка', features: cpl, coating: 'CPL 0,2 мм' },
    ]);
    const hw = await repo.createSource({ accountId: ACC, kind: 'file', title: 'Прайс_фурнитура.xlsx', original: 'Прайс_фурнитура.xlsx' });
    await repo.setPriceInfo(hw, 'прайс фурнитура', null);
    await prices.replacePriceList(ACC, hw, [
      { model: 'Ручка Palladium Luna', price: 1450, origin: 'price_list', category: 'hardware' },
      { model: 'Petля универсальная 100×70'.replace('Pet', 'Пет'), price: 190, origin: 'price_list', category: 'hardware' },
      { model: 'Замок врезной межкомнатный', price: 980, origin: 'price_list', category: 'hardware' },
    ]);
    expect((await prices.listByOrigin(ACC, 'price_list')).map((p) => [p.model, p.category, p.componentKind])).toEqual(expect.arrayContaining([['ДВ CPL', 'door', null], ['Добор (ДВ CPL)', 'component', 'добор'], ['Коробка (ДВ CPL)', 'component', 'коробка'], ['Ручка Palladium Luna', 'hardware', null], ['Замок врезной межкомнатный', 'hardware', null]]));
    // Дверь: строки комплектующих («Добор (ДВ CPL)» содержит те же слова) в кандидаты не попадают.
    const door = await lookupPrice(prices, aliases, ACC, { name: 'Дверной блок деревянный глухой CPL', widthMm: 910, heightMm: 2100 }, new Date('2026-10-17'));
    expect(door).toMatchObject({ price: 23_900, row: { model: 'ДВ CPL', category: 'door' } });
    // Добор без указания двери: своего вида, по признакам (МДФ → дерево совпало) — самая дешёвая из равных строк с пометкой.
    const dobor = await lookupPrice(prices, aliases, ACC, { name: 'Добор телескопический, МДФ, 300×2150' }, new Date('2026-10-17'));
    expect(dobor).toMatchObject({ price: 850, basis: 'base', match: 'features', row: { model: 'Добор (ДВ ПВХ)', category: 'component' } });
    expect(dobor?.notes).toEqual(['в прайсе нет размера — базовая цена', 'комплектующее по прайсу: Добор (ДВ ПВХ) — совпали: деревянный']);
    // Добор с покрытием CPL — строка к ДВ CPL; коробка — своя строка; порога в прайсе нет → null.
    expect(await lookupPrice(prices, aliases, ACC, { name: 'Добор CPL 200 мм' }, new Date('2026-10-17'))).toMatchObject({ price: 900, row: { model: 'Добор (ДВ CPL)' } });
    expect(await lookupPrice(prices, aliases, ACC, { name: 'Коробка дверная CPL' }, new Date('2026-10-17'))).toMatchObject({ price: 3500, row: { model: 'Коробка (ДВ CPL)' } });
    expect(await lookupPrice(prices, aliases, ACC, { name: 'Порог дубовый' }, new Date('2026-10-17'))).toBeNull();
    // Фурнитура: по ключу/словам среди строк фурнитуры; дверные строки не мешают; работы — null.
    expect(await lookupPrice(prices, aliases, ACC, { name: 'Ручка Palladium Luna' }, new Date('2026-10-17'))).toMatchObject({ price: 1450, row: { category: 'hardware' } });
    expect(await lookupPrice(prices, aliases, ACC, { name: 'Замок врезной' }, new Date('2026-10-17'))).toMatchObject({ price: 980 });
    expect(await lookupPrice(prices, aliases, ACC, { name: 'Монтаж дверного блока' }, new Date('2026-10-17'))).toBeNull();
    // Медиана по категории: добор — 875 (900 и 850), дверь CPL — 23 900, фурнитура «ручка» — 1450, «порог» без группы — null.
    const rows = await prices.listByOrigin(ACC, 'price_list');
    expect(categoryMedian(rows, { category: 'component', features: featuresOf('Добор телескопический'), componentKind: 'добор', tokens: ['добор', 'телескопический'] })).toBe(875);
    expect(categoryMedian(rows, { category: 'door', features: featuresOf('Дверной блок деревянный глухой CPL'), componentKind: null, tokens: [] })).toBe(23_900);
    expect(categoryMedian(rows, { category: 'component', features: EMPTY_FEATURES, componentKind: 'порог', tokens: ['порог'] })).toBeNull();
    expect(categoryMedian(rows, { category: 'hardware', features: EMPTY_FEATURES, componentKind: null, tokens: ['ручка', 'дверная'] })).toBe(1450);
    // KB-PRICE-SHEETS-FIX, п. 5: фурнитура без своей группы по первому слову («доводчик», «автопорог») — медиана всей фурнитуры прайса (980 из 1450 / 980 / 190).
    expect(categoryMedian(rows, { category: 'hardware', features: EMPTY_FEATURES, componentKind: null, tokens: ['доводчик'] })).toBe(980);
    // backfillCategories: веб-запись «Добор …» со старой категорией door → component.
    const web = await prices.upsert({ accountId: ACC, model: 'Добор телескопический МДФ', widthMm: 300, heightMm: 2150, price: 2013, origin: 'web' });
    await db.query("UPDATE kb_prices SET category = 'door', component_kind = NULL WHERE id = $1", [web]);
    expect(await prices.backfillCategories()).toBe(1);
    expect((await prices.byId(ACC, web))).toMatchObject({ category: 'component', componentKind: 'добор' });
    expect(await prices.backfillCategories()).toBe(0);
  });
});
