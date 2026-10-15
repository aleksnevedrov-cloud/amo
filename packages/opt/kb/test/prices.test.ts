import type { Db } from '@core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { leavesOf, modelKeyOf, sizeOf } from '../src/model-key.ts';
import { applyRules, KbAliasesRepo, KbPricesRepo, lookupPrice, priceLabelOf, type KbPrice } from '../src/prices.ts';
import { KbRepo } from '../src/repo.ts';
import { freshKbDb } from './setup.ts';

const ACCOUNT = 555;
const row = (over: Partial<KbPrice>): KbPrice => ({ id: 1, accountId: ACCOUNT, sourceId: null, model: 'ДПГ сота', modelKey: 'дпг сота', factory: 'Текона', unit: 'шт', baseSize: '800×2000', widthMm: 800, heightMm: 2000, price: 3450, vat: 'included', currency: 'RUB', validAt: new Date('2026-10-01'), confidence: 70, origin: 'price_list', nonstandard: {}, url: null, note: null, createdBy: null, createdAt: new Date(), updatedAt: new Date(), sourceTitle: 'прайс Текона.xlsx', sourceKind: 'file', ...over });

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
    const n = await prices.replaceForSource(ACCOUNT, sourceId, [
      { model: 'ДПГ сота', factory: 'Текона', widthMm: 800, heightMm: 2000, price: 3450, origin: 'price_list', validAt: new Date('2026-10-01'), nonstandard: { heightPct: 15 } },
      { model: 'ДПГ сота', factory: 'Текона', widthMm: 900, heightMm: 2000, price: 3650, origin: 'price_list', validAt: new Date('2026-10-01') },
      { model: 'ДПО сота', factory: 'Текона', widthMm: 800, heightMm: 2000, price: 4100, origin: 'price_list', validAt: new Date('2026-10-01') },
      { model: 'Турин', factory: 'Браво', price: 7900, origin: 'price_list', validAt: new Date('2026-10-01') },
    ]);
    expect(n).toBe(4);
    expect((await prices.replaceForSource(ACCOUNT, sourceId, [{ model: 'ДПГ сота', widthMm: 800, heightMm: 2000, price: 3500, origin: 'price_list' }, { model: 'ДПГ сота', widthMm: 900, heightMm: 2000, price: 3650, origin: 'price_list', nonstandard: { heightPct: 15 } }, { model: 'ДПО сота', widthMm: 800, heightMm: 2000, price: 4100, origin: 'price_list' }, { model: 'Турин', factory: 'Браво', price: 7900, origin: 'price_list' }]))).toBe(4);
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
    // ДПО сота 800×2000: менеджер (90) перекрывает прайс (70).
    expect(await lookupPrice(prices, aliases, ACCOUNT, { name: 'ДПО сота', widthMm: 800, heightMm: 2000 })).toMatchObject({ price: 4050, label: 'изменено менеджером' });
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
    expect((await prices.list(ACCOUNT)).total).toBe(4);
  });
});
