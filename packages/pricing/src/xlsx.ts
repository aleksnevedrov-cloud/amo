import ExcelJS from 'exceljs';
import { pricingRulesSchema, type PricingRules } from './rules.ts';

/**
 * Формат XLSX для правил цен — три листа:
 *  «Размеры»: Параметр | Значение
 *  «Комплектующие»: Код | Наименование | Шт. на дверь | В комплекте | Округлять вверх | Серия | Цена
 *    (несколько строк с одним кодом — цены по сериям; строка без серии — цена по умолчанию)
 *  «Услуги»: Код | Наименование | Тип | Цена | Базовая цена
 */
const UNIT_RU: Record<string, PricingRules['services'][number]['unit']> = {
  'за заказ': 'fixed',
  'за дверь': 'per_door',
  'за км': 'per_km',
  'за дверь за этаж': 'per_door_per_floor',
};
const UNIT_TO_RU = Object.fromEntries(Object.entries(UNIT_RU).map(([k, v]) => [v, k]));

export class RulesImportError extends Error {
  override name = 'RulesImportError';
  constructor(readonly problems: string[]) {
    super(problems.join('; '));
  }
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue);
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return String(v.text);
  }
  return String(v).trim();
}

function num(v: string): number | null {
  if (!v) return null;
  const n = Number(v.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

const yes = (v: string, dflt: boolean) => (v ? /^(да|yes|1|true|\+)$/i.test(v) : dflt);

function rows(ws: ExcelJS.Worksheet | undefined): string[][] {
  if (!ws) return [];
  const out: string[][] = [];
  ws.eachRow((row, i) => {
    if (i === 1) return; // заголовок
    const vals = Array.from({ length: 8 }, (_, k) => cellText(row.getCell(k + 1).value));
    if (vals.some(Boolean)) out.push(vals);
  });
  return out;
}

export async function importRulesXlsx(buf: ArrayBuffer | Uint8Array): Promise<PricingRules> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as ArrayBuffer);
  } catch {
    throw new RulesImportError(['Файл не является книгой Excel (.xlsx)']);
  }
  const problems: string[] = [];
  const raw: Record<string, unknown> = { sizes: {}, components: [], services: [] };

  const sizes: Record<string, unknown> = {};
  for (const [param, value] of rows(wb.getWorksheet('Размеры'))) {
    const p = (param ?? '').toLowerCase();
    const list = (value ?? '').split(/[,;\s]+/).map((x) => num(x)).filter((x): x is number => x !== null);
    if (p.startsWith('стандартные ширины')) sizes.standardWidths = list;
    else if (p.startsWith('стандартные высоты')) sizes.standardHeights = list;
    else if (p.startsWith('наценка')) sizes.nonStandardMarkupPct = value ? num(value) : null;
    else if (p.startsWith('пояснение')) raw.disclaimer = value;
  }
  raw.sizes = sizes;

  const components = new Map<string, Record<string, unknown> & { prices: { series: string; price: number }[] }>();
  rows(wb.getWorksheet('Комплектующие')).forEach(([code = '', name = '', perDoor = '', inKit = '', roundUp = '', series = '', price = ''], i) => {
    const line = `«Комплектующие», строка ${i + 2}`;
    if (!code) return problems.push(`${line}: нет кода`);
    let c = components.get(code);
    if (!c) {
      c = { code, name, qtyPerDoor: num(perDoor) ?? 0, inKit: yes(inKit, true), roundUp: yes(roundUp, true), prices: [], defaultPrice: null };
      components.set(code, c);
    }
    const p = num(price);
    if (price && p === null) return problems.push(`${line}: цена «${price}» не число`);
    if (series) {
      if (p === null) return problems.push(`${line}: нет цены для серии «${series}»`);
      c.prices.push({ series, price: p });
    } else {
      c.defaultPrice = p;
    }
    return undefined;
  });
  raw.components = [...components.values()];

  raw.services = rows(wb.getWorksheet('Услуги')).map(([code = '', name = '', unit = '', price = '', base = '']) => ({
    code,
    name,
    unit: UNIT_RU[unit.toLowerCase()] ?? unit,
    price: num(price),
    basePrice: num(base) ?? 0,
  }));

  if (!components.size && !(raw.services as unknown[]).length) problems.push('Нет ни одной строки на листах «Комплектующие» и «Услуги»');
  if (problems.length) throw new RulesImportError(problems);
  const parsed = pricingRulesSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RulesImportError(parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`));
  }
  return parsed.data;
}

export async function exportRulesXlsx(r: PricingRules): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const sizes = wb.addWorksheet('Размеры');
  sizes.addRow(['Параметр', 'Значение']);
  sizes.addRow(['Стандартные ширины, мм', r.sizes.standardWidths.join(', ')]);
  sizes.addRow(['Стандартные высоты, мм', r.sizes.standardHeights.join(', ')]);
  sizes.addRow(['Наценка за нестандарт, %', r.sizes.nonStandardMarkupPct ?? '']);
  sizes.addRow(['Пояснение к расчёту', r.disclaimer]);

  const comp = wb.addWorksheet('Комплектующие');
  comp.addRow(['Код', 'Наименование', 'Шт. на дверь', 'В комплекте', 'Округлять вверх', 'Серия', 'Цена']);
  for (const c of r.components) {
    const base = [c.code, c.name, c.qtyPerDoor, c.inKit ? 'да' : 'нет', c.roundUp ? 'да' : 'нет'];
    comp.addRow([...base, '', c.defaultPrice ?? '']);
    for (const p of c.prices) comp.addRow([...base, p.series, p.price]);
  }
  const svc = wb.addWorksheet('Услуги');
  svc.addRow(['Код', 'Наименование', 'Тип (за заказ / за дверь / за км / за дверь за этаж)', 'Цена', 'Базовая цена']);
  for (const s of r.services) svc.addRow([s.code, s.name, UNIT_TO_RU[s.unit], s.price, s.basePrice]);
  for (const ws of [sizes, comp, svc]) {
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((col) => (col.width = 24));
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
