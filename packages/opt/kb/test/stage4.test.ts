import ExcelJS from 'exceljs';
import type { Db } from '@core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportPricesXlsx, pricesExportFilename } from '../src/export.ts';
import { KbAliasesRepo, KbPricesRepo, knownModelNames } from '../src/prices.ts';
import { KbRepo } from '../src/repo.ts';
import { freshKbDb } from './setup.ts';

const ACCOUNT = 444;

describe('этап 4: известные названия без модели и выгрузка цен в xlsx', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let prices: KbPricesRepo;
  let aliases: KbAliasesRepo;
  beforeAll(async () => {
    ({ db, drop } = await freshKbDb());
    prices = new KbPricesRepo(db);
    aliases = new KbAliasesRepo(db);
    const sourceId = await new KbRepo(db).createSource({ accountId: ACCOUNT, kind: 'file', title: 'прайс Текона.xlsx', original: 'прайс Текона.xlsx' });
    await prices.replaceForSource(ACCOUNT, sourceId, [
      { model: 'ДПГ сота', factory: 'Текона', widthMm: 800, heightMm: 2000, price: 3450, origin: 'price_list', validAt: new Date('2026-10-01'), nonstandard: { heightPct: 15 }, url: null, note: 'лист «Прайс», строка 5' },
      { model: 'Турин', factory: 'Браво', price: 7900, origin: 'price_list', validAt: new Date('2026-10-01') },
    ]);
    await aliases.addLine(ACCOUNT, 'ДПГ сота = ДПГ + УПД (сота) = дверь глухая ламинированная сотовое заполнение');
  });
  afterAll(() => drop());

  it('knownModelNames: синоним → каноническое, модель из цен → название с фабрикой, неизвестное — не в ответе; повтор того же ключа из кэша', async () => {
    const known = await knownModelNames(prices, aliases, ACCOUNT, ['Дверь ДПГ + УПД (сота) 800×2000 — 10 шт', 'дверь Турин 700*2000', 'Добор телескопический 100 мм', 'ДПГ сота 900×2000', 'Полотно ДПГ + УПД (сота)']);
    expect([...known.entries()]).toEqual([
      [0, { name: 'ДПГ сота', via: 'alias', factory: null }],
      [1, { name: 'Турин', via: 'price', factory: 'Браво' }],
      [3, { name: 'ДПГ сота', via: 'alias', factory: null }],
      [4, { name: 'ДПГ сота', via: 'alias', factory: null }],
    ]);
    expect((await knownModelNames(prices, aliases, 1, ['ДПГ сота'])).size).toBe(0);
  });

  it('выгрузка в xlsx: шапка, строка на запись, дата и правила нестандарта', async () => {
    const rows = await prices.all(ACCOUNT);
    const bytes = await exportPricesXlsx(rows, new Date('2026-10-15T10:00:00Z'));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const ws = wb.getWorksheet('Цены')!;
    expect(ws.getRow(1).values).toEqual([undefined, 'Модель', 'Фабрика', 'Размер', 'Ширина, мм', 'Высота, мм', 'Ед.', 'Цена, ₽', 'НДС', 'Актуальна на', 'Доверие', 'Происхождение', 'Источник', 'Доплата за высоту, %', 'Доплата за ширину, %', 'Доплата за толщину, %', 'Доплата за двупольную, %', 'Ссылка', 'Примечание', 'id']);
    expect(ws.rowCount).toBe(3);
    const r = ws.getRow(2).values as unknown[];
    expect(r.slice(1, 13)).toEqual(['ДПГ сота', 'Текона', '800×2000', 800, 2000, 'шт', 3450, 'не указан', expect.any(Date), 70, 'прайс', 'прайс Текона.xlsx']);
    expect(r[13]).toBe(15);
    expect(r[18]).toBe('лист «Прайс», строка 5');
    expect((ws.getRow(3).values as unknown[]).slice(1, 4)).toEqual(['Турин', 'Браво', '']);
    expect(pricesExportFilename(new Date('2026-10-15T10:00:00Z'))).toBe('kb-prices-2026-10-15.xlsx');
  });
});
