import { readKbSheetRows, type KbSheetRow } from './extract.ts';
import { featuresFromColumns, featuresOf, mergeFeatures, type DoorFeatures } from './features.ts';
import { sizeOf, sizesOf } from './model-key.ts';
import type { NonstandardRules, PriceVat } from './prices.ts';

/**
 * Цены из xlsx-прайса по колонкам (RFD-AI-AGENT-OPT-KB, этап 3): шапка ищется в первых строках листа,
 * колонки подбираются по названиям («наименование», «цена», «размер», «фабрика»…), менеджер видит предпросмотр
 * и может поправить сопоставление перед импортом. Без шапки — колонка с наибольшим числом «ценоподобных» значений
 * считается ценой, самая текстовая — моделью.
 */
export interface ColumnMapping {
  sheet: string | null;
  model: number;
  price: number;
  size: number | null;
  width: number | null;
  height: number | null;
  factory: number | null;
  unit: number | null;
  /** «Сокращение в названии» и «Назначение/Конструкция» — дополнительные ключи подбора (KB-PRICELIST, г). */
  abbr: number | null;
  description: number | null;
  /** Колонки признаков (KB-MATCH): «Г/О», «Покрытие», «Материал», «Конструкция», «Назначение», «Огнестойкость». */
  go?: number | null;
  coating?: number | null;
  equipment?: number | null;
  material?: number | null;
  construction?: number | null;
  purpose?: number | null;
  fire?: number | null;
  /** Строка шапки (с 1); строки до неё включительно пропускаются. */
  headerRow: number | null;
}

export interface PriceListColumn {
  index: number;
  header: string;
  sample: string[];
}

export interface PriceDraft {
  sheet: string;
  row: number;
  model: string;
  factory: string | null;
  unit: string;
  widthMm: number | null;
  heightMm: number | null;
  price: number;
  /** Раздел прайса (строка без цены над группой) — в примечание. */
  section: string | null;
  abbr: string | null;
  description: string | null;
  /** Признаки двери из колонок и текста строки (KB-MATCH). */
  features: DoorFeatures;
  /** Текст колонок «Покрытие» и «Комплектация» (KP-NAME). */
  coating: string | null;
  equipment: string | null;
}

export interface PriceListPreview {
  sheets: string[];
  columns: PriceListColumn[];
  mapping: ColumnMapping;
  headerFound: boolean;
  sample: PriceDraft[];
  total: number;
  skipped: number;
  /** НДС по заголовку колонки цены: «с НДС» → included, «без НДС» → no_vat, иначе unknown. */
  vatHint: PriceVat;
  /** Файл распознан как прайс: шапка с колонками модели и цены и хотя бы одна позиция (автоимпорт, б). */
  isPriceList: boolean;
}

const HEADER_SCAN_ROWS = 30;
const RX = {
  model: /наимен|назван|модель|артикул|номенкл|товар|позиц|издели/i,
  price: /цена|стоим|руб|₽|price/i,
  size: /размер|габарит|формат/i,
  width: /ширин/i,
  height: /высот/i,
  factory: /фабрик|производ|бренд|завод|поставщик/i,
  unit: /^ед|единиц|ед\.\s*изм/i,
  abbr: /сокращ|аббрев|кратк|обознач/i,
  description: /назнач|конструкц|описан|характерист/i,
  go: /^г\s*\/\s*о$|^г\/о|глух.*остекл|остекл.*глух/i,
  coating: /покрыт|отделк|облицов/i,
  material: /материал/i,
  construction: /конструкц/i,
  purpose: /назнач/i,
  fire: /огнест|предел огн|\bei\b/i,
  equipment: /комплект/i,
};

/** НДС по заголовку колонки цены. */
export function vatFromHeader(header: string | undefined): PriceVat {
  const h = (header ?? '').toLowerCase();
  if (/без\s*ндс/.test(h)) return 'no_vat';
  if (/ндс/.test(h)) return 'included';
  return 'unknown';
}

/** «3 450,00 ₽», «3450», «3.450» → 3450; текст без числа → null. Цены меньше 10 и больше 10 млн — не цена. */
export function parsePrice(cell: string): number | null {
  const t = cell.replace(/\s|\u00a0/g, '').replace(/₽|руб\.?|р\.|rub/gi, '');
  if (!/^\d[\d.,]*$/.test(t)) return null;
  // Разделитель тысяч и десятичная запятая: «3.450,50» → 3450.50; «3450.5» → 3450.5; «3.450» (три знака после точки) → 3450.
  let n: number;
  if (/,\d{1,2}$/.test(t)) n = Number(t.replace(/\./g, '').replace(',', '.'));
  else if (/\.\d{3}$/.test(t) && !t.includes(',')) n = Number(t.replace(/\./g, ''));
  else n = Number(t.replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 10 || n > 10_000_000) return null;
  return Math.round(n * 100) / 100;
}

function detectHeader(rows: KbSheetRow[]): { row: KbSheetRow; score: number } | null {
  let best: { row: KbSheetRow; score: number } | null = null;
  for (const r of rows.slice(0, HEADER_SCAN_ROWS)) {
    let score = 0;
    for (const c of r.cells) {
      if (RX.model.test(c)) score += 2;
      if (RX.price.test(c)) score += 2;
      if (RX.size.test(c) || RX.width.test(c) || RX.height.test(c)) score += 1;
      if (RX.factory.test(c) || RX.unit.test(c) || RX.abbr.test(c) || RX.description.test(c)) score += 1;
    }
    if (score >= 4 && (!best || score > best.score)) best = { row: r, score };
  }
  return best;
}

export function detectMapping(rows: KbSheetRow[], sheet: string | null = null): { mapping: ColumnMapping; headerFound: boolean } {
  const scoped = sheet ? rows.filter((r) => r.sheet === sheet) : rows;
  const header = detectHeader(scoped);
  const find = (rx: RegExp, exclude: number[] = []) => header?.row.cells.findIndex((c, i) => rx.test(c) && !exclude.includes(i)) ?? -1;
  if (header) {
    const price = find(RX.price);
    // «Сокращение в названии» содержит «назван» — ищется раньше модели, чтобы не занять её колонку.
    const abbr = find(RX.abbr, [price]);
    const description = find(RX.description, [price, abbr]);
    const model = find(RX.model, [price, abbr, description]);
    const width = find(RX.width, [price, model, abbr, description]);
    const height = find(RX.height, [price, model, width, abbr, description]);
    const size = width >= 0 && height >= 0 ? -1 : find(RX.size, [price, model, width, height, abbr, description]);
    const factory = find(RX.factory, [price, model, width, height, size, abbr, description]);
    const unit = find(RX.unit, [price, model, width, height, size, factory, abbr, description]);
    const taken = [price, model, width, height, size, factory, unit, abbr, description];
    const go = find(RX.go, taken);
    const coating = find(RX.coating, [...taken, go]);
    const material = find(RX.material, [...taken, go, coating]);
    const construction = find(RX.construction, [...taken, go, coating, material]);
    const purpose = find(RX.purpose, [...taken, go, coating, material, construction]);
    const fire = find(RX.fire, [...taken, go, coating, material, construction, purpose]);
    const equipment = find(RX.equipment, [...taken, go, coating, material, construction, purpose, fire]);
    const opt = (i: number) => (i >= 0 ? i : null);
    if (price >= 0 && model >= 0) {
      return { mapping: { sheet, model, price, size: size >= 0 ? size : null, width: width >= 0 ? width : null, height: height >= 0 ? height : null, factory: factory >= 0 ? factory : null, unit: unit >= 0 ? unit : null, abbr: abbr >= 0 ? abbr : null, description: description >= 0 ? description : null, go: opt(go), coating: opt(coating), material: opt(material), construction: opt(construction), purpose: opt(purpose), fire: opt(fire), equipment: opt(equipment), headerRow: header.row.row }, headerFound: true };
    }
  }
  // Без шапки: статистика по колонкам первых 200 строк.
  const width = Math.max(0, ...scoped.slice(0, 200).map((r) => r.cells.length));
  const stats = Array.from({ length: width }, () => ({ prices: 0, texts: 0, sizes: 0 }));
  for (const r of scoped.slice(0, 200)) {
    r.cells.forEach((c, i) => {
      const st = stats[i];
      if (!st || !c.trim()) return;
      if (parsePrice(c) !== null) st.prices += 1;
      else if (sizeOf(c)) st.sizes += 1;
      else if (/\p{L}{3,}/u.test(c)) st.texts += 1;
    });
  }
  const price = argmax(stats.map((s) => s.prices));
  const model = argmax(stats.map((s, i) => (i === price ? -1 : s.texts)));
  const size = argmax(stats.map((s, i) => (i === price || i === model ? -1 : s.sizes)));
  return { mapping: { sheet, model: model >= 0 ? model : 0, price: price >= 0 ? price : 1, size: size >= 0 && (stats[size]?.sizes ?? 0) > 0 ? size : null, width: null, height: null, factory: null, unit: null, abbr: null, description: null, headerRow: null }, headerFound: false };
}

const argmax = (xs: number[]) => xs.reduce((best, v, i) => (v > (xs[best] ?? -Infinity) ? i : best), -1);

export function extractPrices(rows: KbSheetRow[], m: ColumnMapping): { drafts: PriceDraft[]; skipped: number } {
  const drafts: PriceDraft[] = [];
  let skipped = 0;
  let section: string | null = null;
  const scoped = m.sheet ? rows.filter((r) => r.sheet === m.sheet) : rows;
  for (const r of scoped) {
    if (m.headerRow !== null && r.sheet === (m.sheet ?? r.sheet) && r.row <= m.headerRow) continue;
    const cell = (i: number | null) => (i === null ? '' : (r.cells[i] ?? '').trim());
    const model = cell(m.model);
    const price = parsePrice(cell(m.price));
    if (price === null) {
      // Строка без цены с единственным текстом в любой колонке — заголовок раздела (фабрика, коллекция).
      const texts = r.cells.map((c) => c.trim()).filter(Boolean);
      if (texts.length === 1 && /\p{L}/u.test(texts[0] ?? '')) section = (texts[0] as string).slice(0, 120);
      else if (model) skipped += 1;
      continue;
    }
    if (!model || /^\d+(\.\d+)?$/.test(model)) {
      skipped += 1;
      continue;
    }
    const w = m.width !== null ? toMm(cell(m.width)) : null;
    const h = m.height !== null ? toMm(cell(m.height)) : null;
    // Несколько размеров в одной ячейке («1010×2100; 910×2100. Проход ≥800 мм…») — отдельная строка цены на каждый (KB-PRICELIST, в).
    const sizes: ({ widthMm: number; heightMm: number } | null)[] = w && h ? [{ widthMm: Math.min(w, h), heightMm: Math.max(w, h) }] : [];
    if (!sizes.length) sizes.push(...sizesOf(cell(m.size)));
    if (!sizes.length) sizes.push(sizeOf(model));
    const abbr = cell(m.abbr) || null;
    const description = cell(m.description) || null;
    // Признаки: текст модели, сокращения и назначения плюс отдельные колонки признаков (их значения главнее).
    const features = mergeFeatures(featuresOf([model, abbr, description, cell(m.construction ?? null), cell(m.purpose ?? null)].filter(Boolean).join(' | ')), featuresFromColumns({ go: cell(m.go ?? null), coating: cell(m.coating ?? null), material: cell(m.material ?? null), construction: cell(m.construction ?? null), purpose: cell(m.purpose ?? null), fire: cell(m.fire ?? null) }));
    const base = { sheet: r.sheet, row: r.row, model: model.slice(0, 300), factory: cell(m.factory) || null, unit: cell(m.unit) || 'шт', price, section, abbr, description, features, coating: cell(m.coating ?? null) || null, equipment: cell(m.equipment ?? null) || null };
    for (const size of sizes) drafts.push({ ...base, widthMm: size?.widthMm ?? null, heightMm: size?.heightMm ?? null });
  }
  return { drafts, skipped };
}

function toMm(cell: string): number | null {
  const n = Number(cell.replace(',', '.').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 10 ? Math.round(n * 1000) : Math.round(n);
}

export function columnsOf(rows: KbSheetRow[], m: ColumnMapping): PriceListColumn[] {
  const scoped = m.sheet ? rows.filter((r) => r.sheet === m.sheet) : rows;
  const header = m.headerRow !== null ? scoped.find((r) => r.row === m.headerRow) : null;
  const body = scoped.filter((r) => m.headerRow === null || r.row > m.headerRow).slice(0, 5);
  const width = Math.max(header?.cells.length ?? 0, ...body.map((r) => r.cells.length), m.model + 1, m.price + 1);
  return Array.from({ length: width }, (_, i) => ({ index: i, header: header?.cells[i]?.trim() || `Колонка ${i + 1}`, sample: body.map((r) => (r.cells[i] ?? '').trim()).filter(Boolean).slice(0, 3) }));
}

/** Предпросмотр прайса: авто-сопоставление (или заданное менеджером), колонки с примерами, первые 20 позиций, итог. */
export async function previewPriceList(bytes: Uint8Array, given: Partial<ColumnMapping> = {}): Promise<PriceListPreview> {
  const rows = await readKbSheetRows(bytes);
  const sheets = [...new Set(rows.map((r) => r.sheet))];
  const sheet = given.sheet ?? sheets[0] ?? null;
  const auto = detectMapping(rows, sheet);
  const mapping: ColumnMapping = { ...auto.mapping, ...stripUndefined(given), sheet };
  const { drafts, skipped } = extractPrices(rows, mapping);
  const header = mapping.headerRow !== null ? rows.find((r) => r.sheet === (mapping.sheet ?? r.sheet) && r.row === mapping.headerRow) : null;
  return { sheets, columns: columnsOf(rows, mapping), mapping, headerFound: auto.headerFound, sample: drafts.slice(0, 20), total: drafts.length, skipped, vatHint: vatFromHeader(header?.cells[mapping.price]), isPriceList: auto.headerFound && drafts.length > 0 };
}

const stripUndefined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

export interface ImportDefaults {
  factory?: string | null;
  validAt?: Date;
  vat?: PriceVat;
  nonstandard?: NonstandardRules;
  confidence?: number;
}

/** Черновики позиций → записи цен (без account/source). */
export function draftsToPrices(drafts: PriceDraft[], d: ImportDefaults = {}) {
  return drafts.map((x) => ({
    model: x.model,
    factory: x.factory ?? d.factory ?? null,
    unit: x.unit,
    widthMm: x.widthMm,
    heightMm: x.heightMm,
    price: x.price,
    vat: d.vat ?? 'unknown',
    validAt: d.validAt ?? new Date(),
    confidence: d.confidence,
    origin: 'price_list' as const,
    nonstandard: d.nonstandard ?? {},
    note: [x.section ? `раздел: ${x.section}` : '', `лист «${x.sheet}», строка ${x.row}`].filter(Boolean).join('; '),
    abbr: x.abbr,
    description: x.description,
    sourceRow: x.row,
    features: x.features,
    coating: x.coating,
    equipment: x.equipment,
  }));
}
