import ExcelJS from 'exceljs';
import type { KbPrice } from './prices.ts';

/** Выгрузка kb_prices в xlsx (этап 4): одна строка — одна запись, колонки как в таблице. */
const ORIGIN: Record<KbPrice['origin'], string> = { price_list: 'прайс', web: 'веб-поиск', manager: 'менеджер', purchase: 'закупка' };
const VAT: Record<KbPrice['vat'], string> = { included: 'с НДС', no_vat: 'без НДС', unknown: 'не указан' };

export async function exportPricesXlsx(rows: KbPrice[], exportedAt = new Date()): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Агент опт — база знаний';
  wb.created = exportedAt;
  const ws = wb.addWorksheet('Цены');
  ws.columns = [
    { header: 'Модель', key: 'model', width: 40 },
    { header: 'Фабрика', key: 'factory', width: 18 },
    { header: 'Размер', key: 'size', width: 12 },
    { header: 'Ширина, мм', key: 'width', width: 12 },
    { header: 'Высота, мм', key: 'height', width: 12 },
    { header: 'Ед.', key: 'unit', width: 6 },
    { header: 'Цена, ₽', key: 'price', width: 12 },
    { header: 'НДС', key: 'vat', width: 10 },
    { header: 'Актуальна на', key: 'validAt', width: 14 },
    { header: 'Доверие', key: 'confidence', width: 9 },
    { header: 'Происхождение', key: 'origin', width: 14 },
    { header: 'Источник', key: 'source', width: 30 },
    { header: 'Доплата за высоту, %', key: 'heightPct', width: 12 },
    { header: 'Доплата за ширину, %', key: 'widthPct', width: 12 },
    { header: 'Доплата за толщину, %', key: 'thicknessPct', width: 12 },
    { header: 'Доплата за двупольную, %', key: 'doubleLeafPct', width: 12 },
    { header: 'Ссылка', key: 'url', width: 40 },
    { header: 'Примечание', key: 'note', width: 40 },
    { header: 'id', key: 'id', width: 8 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const p of rows) {
    ws.addRow({
      model: p.model,
      factory: p.factory ?? '',
      size: p.baseSize ?? '',
      width: p.widthMm ?? '',
      height: p.heightMm ?? '',
      unit: p.unit,
      price: p.price ?? 'нет цены',
      vat: VAT[p.vat],
      validAt: p.validAt,
      confidence: p.confidence,
      origin: ORIGIN[p.origin],
      source: p.sourceTitle ?? '',
      heightPct: p.nonstandard.heightPct ?? '',
      widthPct: p.nonstandard.widthPct ?? '',
      thicknessPct: p.nonstandard.thicknessPct ?? '',
      doubleLeafPct: p.nonstandard.doubleLeafPct ?? '',
      url: p.url ?? '',
      note: p.note ?? '',
      id: p.id,
    });
  }
  ws.getColumn('validAt').numFmt = 'dd.mm.yyyy';
  ws.getColumn('price').numFmt = '# ##0.00';
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

export const pricesExportFilename = (d = new Date()) => `kb-prices-${d.toISOString().slice(0, 10)}.xlsx`;
