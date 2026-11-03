/**
 * Многолистовой прайс (RFD-AI-AGENT-OPT-KB-PRICE-SHEETS): все вкладки файла собираются в единую карточку товара по ID.
 * Вкладки узнаются по имени, колонки — по названиям в первых пяти строках листа (не по номеру). Неизвестные вкладки и
 * колонки пропускаются с записью в журнал; ошибки (нет ID, кривое число) — с листом, строкой и колонкой.
 *
 * Лист 1 «Прайс по ГОСТ» — как одностраничный прайс плюс ГОСТы, створок, цвета, «входит в базу», примечание; связь с
 * листом «ID» по колонке «№». «Размеры» — сетка размеров (авторитетнее текста «2000×600–900»). «Нестандарт» — проценты
 * надбавок. «Подбор» — синонимы, характеристики, примечания КП, условия цены. «Дополнения» — фурнитура по ID тарифа.
 * «Словарь», «Сокращения», «ГОСТы», «Типоразмеры» — словарь агента. «Задача_Клауду» — документация, не импортируется.
 */
import { FORMULA_NO_VALUE, type KbSheetRow } from './extract.ts';
import { parsePrice } from './price-list.ts';
import type { ComponentKind } from './category.ts';
import { sizesOf } from './model-key.ts';

export type ComponentStatus = 'priced' | 'included' | 'not_priced';
export type ProductStatus = 'active' | 'inactive' | 'estimate_only';
export type UnitBasis = 'leaf' | 'block' | 'leaf_pair' | 'opening';
export type Geometry = 'single' | 'pair' | 'each_leaf' | 'overall_pair';
export type Family = 'interior' | 'steel' | 'aluminium';

/** Карточка товара в kb_prices.card: всё, что не нужно в SQL-фильтрах. */
export interface ProductCard {
  unit: UnitBasis | null;
  sizeBasis: UnitBasis | null;
  geometry: Geometry | null;
  fill: 'solid' | 'glazed' | null;
  comment: string | null;
  gosts: string[];
  leafCount: number | null;
  colors: string[];
  baseIncludes: string | null;
  note: string | null;
  technical: Record<string, unknown> | null;
  quoteNotes: string[];
  priceConditions: Record<string, unknown> | null;
  /** Фурнитура: единица («шт», «м²», «м»), что включено, что уточнить. */
  hardwareUnit?: string | null;
  includes?: string | null;
  clarify?: string | null;
  /** Сметная цена собрана по правилу из комментария (INT-008): из чего. */
  estimateFormula?: string | null;
  /** «Обозначение по ГОСТ (шаблон)» с листа 1. */
  designation?: string | null;
}

export interface BookProduct {
  row: number;
  no: string | null;
  productId: string | null;
  model: string;
  abbr: string | null;
  typeText: string | null;
  coating: string | null;
  material: string | null;
  construction: string | null;
  purpose: string | null;
  fire: string | null;
  sizesText: string | null;
  equipment: string | null;
  price: number | null;
  components: Partial<Record<ComponentKind, { status: ComponentStatus; price: number | null }>>;
  family: Family | null;
  status: ProductStatus;
  estimate: boolean;
  card: ProductCard;
  aliases: string[];
}

export interface BookSize {
  row: number;
  sizeId: string | null;
  productId: string;
  widthMm: number;
  heightMm: number;
  basis: string | null;
  leafWidthsMm: number[] | null;
}

export interface BookRule {
  largeThresholdPercent: number;
  regularSurchargePercent: number;
  largeSurchargePercent: number;
  appliesTo: string;
  productionNote: string | null;
}

export interface BookDictionaryEntry {
  sheet: string;
  row: number;
  term: string;
  meaning: string | null;
  context: string | null;
  rule: string | null;
}

export interface BookHardware {
  row: number;
  tariffId: string;
  type: string | null;
  name: string;
  unit: string;
  price: number | null;
  status: ProductStatus;
  forModels: string[] | '*';
  includes: string | null;
  clarify: string | null;
  aliases: string[];
}

export interface BookIssue {
  sheet: string;
  row: number | null;
  column: string | null;
  message: string;
}

export interface PriceBook {
  products: BookProduct[];
  sizes: BookSize[];
  rule: BookRule | null;
  dictionary: BookDictionaryEntry[];
  hardware: BookHardware[];
  /** Ошибки, из-за которых импорт отменяется целиком. */
  errors: BookIssue[];
  /** Пропущенное: вкладки, колонки, строки — в журнал. */
  skipped: BookIssue[];
}

/** Добавить в список по ключу карты, создав его при первом обращении. */
function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

const normHeader = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[\s_]+/g, ' ').trim();
const sheetKind = (name: string): 'list1' | 'id' | 'sizes' | 'nonstandard' | 'pick' | 'extras' | 'dictionary' | 'doc' | null => {
  const n = normHeader(name);
  if (/задача/.test(n)) return 'doc';
  if (/^id$|^ид$/.test(n)) return 'id';
  if (/типоразмер|словар|сокращен|^гост/.test(n)) return 'dictionary';
  if (/^размер/.test(n)) return 'sizes';
  if (/нестандарт/.test(n)) return 'nonstandard';
  if (/подбор/.test(n)) return 'pick';
  if (/дополнен/.test(n)) return 'extras';
  if (/прайс/.test(n)) return 'list1';
  return null;
};

type Col = Record<string, number>;
const HEADER_ROWS = 5;

/** Шапка листа: строка из первых пяти, где нашлось больше всего известных колонок (не меньше двух). */
function findHeader(rows: KbSheetRow[], rx: Record<string, RegExp>): { cols: Col; headerRow: number; unknown: string[] } | null {
  let best: { cols: Col; headerRow: number; unknown: string[]; score: number } | null = null;
  for (const r of rows.slice(0, HEADER_ROWS)) {
    const cols: Col = {};
    const unknown: string[] = [];
    r.cells.forEach((c, i) => {
      const h = normHeader(c);
      if (!h) return;
      const key = Object.keys(rx).find((k) => cols[k] === undefined && (rx[k] as RegExp).test(h));
      if (key) cols[key] = i;
      else unknown.push(c.trim());
    });
    const score = Object.keys(cols).length;
    if (score >= 2 && (best === null || score > best.score)) best = { cols, headerRow: r.row, unknown, score };
  }
  return best;
}

const cellOf = (r: KbSheetRow, cols: Col, key: string): string => (cols[key] === undefined ? '' : (r.cells[cols[key] as number] ?? '').trim());
const list = (s: string): string[] => {
  const t = s.trim();
  if (!t) return [];
  if (/^[[{]/.test(t)) {
    try {
      const v = JSON.parse(t) as unknown;
      if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
      if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).flat().map((x) => String(x).trim()).filter(Boolean);
    } catch {
      /* не JSON — список через разделители */
    }
  }
  return t.split(/[;\n|]+/).map((x) => x.trim()).filter(Boolean);
};
const json = (s: string): Record<string, unknown> | null => {
  const t = s.trim();
  if (!t || !/^[[{]/.test(t)) return t ? { text: t } : null;
  try {
    const v = JSON.parse(t) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return { text: t };
  }
};
const intOf = (s: string): number | null => {
  const n = Number(s.replace(',', '.').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

const COMPONENT_COLS: Record<ComponentKind, RegExp> = { коробка: /коробк/, наличник: /наличник/, добор: /добор/, порог: /порог/ };

/** Статус компонента по ячейке листа 1: число — priced; «включена»/«входит» — included; «—», пусто, «нет» — не задано. */
function componentCell(s: string): { status: ComponentStatus | null; price: number | null } {
  const t = s.trim().toLowerCase();
  if (!t || /^[-—–]+$/.test(t) || /^нет$/.test(t)) return { status: null, price: null };
  if (/включ|входит|в цене/.test(t)) return { status: 'included', price: null };
  const p = parsePrice(s);
  if (p !== null && p > 0) return { status: 'priced', price: p };
  if (/уточн|по запрос|не оцен/.test(t)) return { status: 'not_priced', price: null };
  return { status: null, price: null };
}

const statusOf = (s: string): ComponentStatus | null => {
  const t = s.trim().toLowerCase();
  if (!t) return null;
  if (/^priced|плат|отдельн/.test(t)) return 'priced';
  if (/^included|включ|входит/.test(t)) return 'included';
  if (/not_priced|нет цены|не оцен|уточн/.test(t)) return 'not_priced';
  return null;
};
const productStatusOf = (s: string): ProductStatus => {
  const t = s.trim().toLowerCase();
  if (/inactive|неактив|снят|архив/.test(t)) return 'inactive';
  if (/estimate|смет/.test(t)) return 'estimate_only';
  return 'active';
};
const enumOf = <T extends string>(s: string, values: readonly T[]): T | null => {
  const t = s.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return (values as readonly string[]).includes(t) ? (t as T) : null;
};

/** Текст ошибки для ячейки с ценой: формула без значения (файл писала не Excel) или просто не число. */
function formulaOrNotNumber(cell: string): string {
  return cell.startsWith(FORMULA_NO_VALUE) ? `ячейка ${cell.slice(FORMULA_NO_VALUE.length)} — формула без значения, пересохраните файл в Excel` : `не число: «${cell}»`;
}

/** Сметная цена по правилу из комментария: «полотно INT-005 8 800 + коробка 3 160 = 11 960» → 11 960 (или сумма чисел). */
export function estimateFromComment(comment: string | null | undefined): { price: number; formula: string } | null {
  if (!comment) return null;
  const text = comment.replace(/\u00a0/g, ' ');
  const eq = /=\s*(\d[\d\s]*(?:[.,]\d+)?)/.exec(text);
  if (eq) {
    const v = parsePrice(eq[1] as string);
    if (v && v > 0) return { price: v, formula: text.trim().slice(0, 300) };
  }
  const nums = [...text.replace(/[A-ZА-Я]{2,}-\d+/g, ' ').matchAll(/(?<![\d.,])(\d{1,3}(?:[ \u00a0]\d{3})+|\d{3,})(?![\d.,])/g)].map((m) => parsePrice(m[1] as string)).filter((v): v is number => v !== null && v >= 100);
  if (nums.length >= 2 && /\+/.test(text)) return { price: nums.reduce((a, b) => a + b, 0), formula: text.trim().slice(0, 300) };
  return null;
}

/** Файл в новом формате: есть вкладка «ID» (или «Прайс…» вместе с «Размеры»/«Подбор»). */
export function isPriceBook(rows: KbSheetRow[]): boolean {
  const kinds = new Set([...new Set(rows.map((r) => r.sheet))].map(sheetKind));
  return kinds.has('id') || (kinds.has('list1') && (kinds.has('sizes') || kinds.has('pick')));
}

export function parsePriceBook(rows: KbSheetRow[]): PriceBook {
  const book: PriceBook = { products: [], sizes: [], rule: null, dictionary: [], hardware: [], errors: [], skipped: [] };
  const sheets = new Map<string, KbSheetRow[]>();
  for (const r of rows) push(sheets, r.sheet, r);
  const byKind = new Map<ReturnType<typeof sheetKind>, { name: string; rows: KbSheetRow[] }[]>();
  for (const [name, list1] of sheets) {
    const k = sheetKind(name);
    if (k === null) {
      book.skipped.push({ sheet: name, row: null, column: null, message: 'неизвестная вкладка — пропущена' });
      continue;
    }
    if (k === 'doc') continue;
    push(byKind, k, { name, rows: list1 });
  }
  const unknownCols = (sheet: string, unknown: string[]) => {
    if (unknown.length) book.skipped.push({ sheet, row: null, column: unknown.join(', '), message: 'неизвестные колонки — пропущены' });
  };

  // ---- Лист 1
  const list1 = byKind.get('list1')?.[0];
  if (!list1) {
    book.errors.push({ sheet: '—', row: null, column: null, message: 'нет вкладки прайса («Прайс по ГОСТ»)' });
    return book;
  }
  const L1 = findHeader(list1.rows, {
    no: /^№$|^№ ?п\/?п$|^n$|^номер$/,
    model: /модель|наимен|назван/,
    abbr: /сокращ|аббрев/,
    designation: /обознач/,
    type: /^тип|тип двер|г\/о/,
    coating: /покрыт|отделк|облицов/,
    material: /материал/,
    construction: /конструкц/,
    purpose: /назначен/,
    fire: /огнест|звукоизол|предел огн/,
    sizes: /размер/,
    equipment: /комплектац/,
    price: /^цена|стоим/,
    коробка: COMPONENT_COLS.коробка,
    наличник: COMPONENT_COLS.наличник,
    добор: COMPONENT_COLS.добор,
    порог: COMPONENT_COLS.порог,
    gosts: /^гост/,
    leaves: /створ/,
    // «Цветов» (число) — не список цветов: берётся колонка «Цвета / исполнения».
    colors: /^цвета|^цвет$|цвета ?\//,
    baseIncludes: /входит/,
    note: /примеч/,
  });
  if (!L1 || L1.cols.model === undefined || L1.cols.price === undefined) {
    book.errors.push({ sheet: list1.name, row: null, column: null, message: 'в первых пяти строках не найдена шапка с колонками «Модель» и «Цена»' });
    return book;
  }
  unknownCols(list1.name, L1.unknown);
  const byNo = new Map<string, BookProduct>();
  for (const r of list1.rows) {
    if (r.row <= L1.headerRow) continue;
    const model = cellOf(r, L1.cols, 'model');
    const no = cellOf(r, L1.cols, 'no');
    // Строки-разделы (зелёные полосы без №) и «Итого» пропускаются.
    if (!no && (!model || /^итого/i.test(model))) continue;
    if (!model || /^итого/i.test(model) || /^итого/i.test(no)) continue;
    const priceCell = cellOf(r, L1.cols, 'price');
    const price = priceCell ? parsePrice(priceCell) : null;
    if (priceCell && price === null && !/^[-—–]+$/.test(priceCell.trim()) && !/смет|уточн|по запрос/i.test(priceCell)) {
      book.errors.push({ sheet: list1.name, row: r.row, column: 'Цена', message: formulaOrNotNumber(priceCell) });
      continue;
    }
    const components: BookProduct['components'] = {};
    for (const kind of Object.keys(COMPONENT_COLS) as ComponentKind[]) {
      if (L1.cols[kind] === undefined) continue;
      const c = componentCell(cellOf(r, L1.cols, kind));
      if (c.status) components[kind] = { status: c.status, price: c.price };
    }
    const leaves = intOf(cellOf(r, L1.cols, 'leaves'));
    const p: BookProduct = {
      row: r.row,
      no: no || null,
      productId: null,
      model: model.slice(0, 300),
      abbr: cellOf(r, L1.cols, 'abbr') || null,
      typeText: cellOf(r, L1.cols, 'type') || null,
      coating: cellOf(r, L1.cols, 'coating') || null,
      material: cellOf(r, L1.cols, 'material') || null,
      construction: cellOf(r, L1.cols, 'construction') || null,
      purpose: cellOf(r, L1.cols, 'purpose') || null,
      fire: cellOf(r, L1.cols, 'fire') || null,
      sizesText: cellOf(r, L1.cols, 'sizes') || null,
      equipment: cellOf(r, L1.cols, 'equipment') || null,
      price: price && price > 0 ? price : null,
      components,
      family: null,
      status: 'active',
      estimate: false,
      card: { unit: null, sizeBasis: null, geometry: null, fill: null, comment: null, gosts: list(cellOf(r, L1.cols, 'gosts')), leafCount: leaves && leaves <= 4 ? leaves : null, colors: list(cellOf(r, L1.cols, 'colors')), baseIncludes: cellOf(r, L1.cols, 'baseIncludes') || null, note: cellOf(r, L1.cols, 'note') || null, technical: null, quoteNotes: [], priceConditions: null, designation: cellOf(r, L1.cols, 'designation') || null },
      aliases: [],
    };
    book.products.push(p);
    if (p.no) byNo.set(p.no.replace(/[^\d]/g, '') || p.no, p);
  }

  // ---- ID: связь по «№»
  const idSheet = byKind.get('id')?.[0];
  if (idSheet) {
    const H = findHeader(idSheet.rows, {
      no: /^№$|^№ ?п\/?п$|^n$|^номер$/,
      productId: /^id\b|^ид\b|product[_ ]?id|id товар/,
      unit: /единиц/,
      sizeBasis: /основани/,
      geometry: /геометр/,
      family: /семейств/,
      fill: /заполн/,
      коробка: /статус.*короб|короб.*статус|^коробк/,
      наличник: /статус.*наличн|наличн.*статус|^наличник/,
      добор: /статус.*добор|добор.*статус|^добор/,
      порог: /статус.*порог|порог.*статус|^порог/,
      comment: /коммент/,
      status: /^статус$|статус товар/,
    });
    if (!H || H.cols.productId === undefined) book.errors.push({ sheet: idSheet.name, row: null, column: null, message: 'не найдена шапка с колонкой «ID»' });
    else {
      unknownCols(idSheet.name, H.unknown);
      for (const r of idSheet.rows) {
        if (r.row <= H.headerRow) continue;
        const productId = cellOf(r, H.cols, 'productId');
        if (!productId) continue;
        const no = cellOf(r, H.cols, 'no');
        const p = byNo.get(no.replace(/[^\d]/g, '') || no);
        if (!p) {
          book.errors.push({ sheet: idSheet.name, row: r.row, column: '№', message: `ID ${productId}: на листе прайса нет строки с № «${no || '—'}»` });
          continue;
        }
        if (p.productId) {
          book.errors.push({ sheet: idSheet.name, row: r.row, column: 'ID', message: `№ ${no} уже связан с ${p.productId}` });
          continue;
        }
        p.productId = productId;
        p.card.unit = enumOf(cellOf(r, H.cols, 'unit'), ['leaf', 'block', 'leaf_pair', 'opening'] as const);
        p.card.sizeBasis = enumOf(cellOf(r, H.cols, 'sizeBasis'), ['leaf', 'block', 'opening', 'leaf_pair'] as const);
        p.card.geometry = enumOf(cellOf(r, H.cols, 'geometry'), ['single', 'pair', 'each_leaf', 'overall_pair'] as const);
        p.family = enumOf(cellOf(r, H.cols, 'family'), ['interior', 'steel', 'aluminium'] as const);
        p.card.fill = enumOf(cellOf(r, H.cols, 'fill'), ['solid', 'glazed'] as const);
        p.card.comment = cellOf(r, H.cols, 'comment') || null;
        if (H.cols.status !== undefined) p.status = productStatusOf(cellOf(r, H.cols, 'status'));
        for (const kind of Object.keys(COMPONENT_COLS) as ComponentKind[]) {
          const st = statusOf(cellOf(r, H.cols, kind));
          if (!st) continue;
          const cur = p.components[kind];
          // Лист 1 даёт цену; лист ID — статус. priced без цены на листе 1 — считаем not_priced.
          if (st === 'priced') p.components[kind] = { status: cur?.price ? 'priced' : 'not_priced', price: cur?.price ?? null };
          else p.components[kind] = { status: st, price: st === 'included' ? null : (cur?.price ?? null) };
        }
      }
    }
  }
  for (const p of book.products) {
    // Цены нет, но в комментарии / «входит в базу» есть правило сборки — сметная цена.
    if (p.price === null) {
      const est = estimateFromComment(p.card.comment) ?? estimateFromComment(p.card.baseIncludes);
      if (est) {
        p.price = est.price;
        p.estimate = true;
        p.card.estimateFormula = est.formula;
        if (p.status === 'active') p.status = 'estimate_only';
      } else book.skipped.push({ sheet: list1.name, row: p.row, column: 'Цена', message: `«${p.model}»: цены нет и правила сборки в комментарии нет — строка без цены пропущена` });
    }
    // Комментарий ID говорит «estimate_only» — позиция только для сметы, даже если цена на листе 1 есть (формула сборки).
    if (p.status === 'active' && /estimate_only/i.test(p.card.comment ?? '')) p.status = 'estimate_only';
  }
  book.products = book.products.filter((p) => p.price !== null);

  // ---- Размеры
  const sizesSheet = byKind.get('sizes')?.[0];
  if (sizesSheet) {
    const H = findHeader(sizesSheet.rows, { sizeId: /^size[_ ]?id|^id размер/, productId: /product[_ ]?id|^id\b|^ид\b|товар/, width: /^width|^ширин/, height: /^height|^высот/, basis: /basis|основани/, leafWidths: /leaf[_ ]?widths|створ/ });
    if (!H || H.cols.productId === undefined || H.cols.width === undefined || H.cols.height === undefined) book.errors.push({ sheet: sizesSheet.name, row: null, column: null, message: 'не найдена шапка с колонками product_id, width_mm, height_mm' });
    else {
      unknownCols(sizesSheet.name, H.unknown);
      const known = new Set(book.products.map((p) => p.productId).filter(Boolean));
      for (const r of sizesSheet.rows) {
        if (r.row <= H.headerRow) continue;
        const productId = cellOf(r, H.cols, 'productId');
        if (!productId) continue;
        const w = intOf(cellOf(r, H.cols, 'width'));
        const h = intOf(cellOf(r, H.cols, 'height'));
        if (!w || !h) {
          book.errors.push({ sheet: sizesSheet.name, row: r.row, column: 'width_mm/height_mm', message: `${productId}: размер не число («${cellOf(r, H.cols, 'width')}» × «${cellOf(r, H.cols, 'height')}»)` });
          continue;
        }
        if (!known.has(productId)) {
          book.skipped.push({ sheet: sizesSheet.name, row: r.row, column: 'product_id', message: `${productId}: такого ID нет на листе ID — размер пропущен` });
          continue;
        }
        const lw = cellOf(r, H.cols, 'leafWidths');
        const leafWidths = lw ? list(lw).map((x) => intOf(x)).filter((x): x is number => x !== null) : null;
        book.sizes.push({ row: r.row, sizeId: cellOf(r, H.cols, 'sizeId') || null, productId, widthMm: w, heightMm: h, basis: cellOf(r, H.cols, 'basis') || null, leafWidthsMm: leafWidths && leafWidths.length ? leafWidths : null });
      }
    }
  }

  // ---- Нестандарт: строка с заголовками-параметрами или пары «параметр | значение»
  const ns = byKind.get('nonstandard')?.[0];
  if (ns) {
    const H = findHeader(ns.rows, { large_threshold_percent: /large[_ ]threshold/, regular_surcharge_percent: /regular[_ ]surcharge/, large_surcharge_percent: /large[_ ]surcharge/, applies_to: /applies/, production_note: /production|примеч/ });
    const rule: BookRule = { largeThresholdPercent: 30, regularSurchargePercent: 30, largeSurchargePercent: 100, appliesTo: 'base', productionNote: null };
    const set = (k: string, v: string) => {
      const n = Number(v.replace(',', '.').replace(/[^\d.]/g, ''));
      if (/large[_ ]threshold/.test(k) && Number.isFinite(n)) rule.largeThresholdPercent = n;
      else if (/regular[_ ]surcharge/.test(k) && Number.isFinite(n)) rule.regularSurchargePercent = n;
      else if (/large[_ ]surcharge/.test(k) && Number.isFinite(n)) rule.largeSurchargePercent = n;
      else if (/applies/.test(k) && v.trim()) rule.appliesTo = v.trim();
      else if (/production|примеч/.test(k) && v.trim()) rule.productionNote = v.trim();
    };
    if (H && Object.keys(H.cols).length >= 3) {
      const data = ns.rows.find((r) => r.row > H.headerRow);
      if (data) for (const [k, i] of Object.entries(H.cols)) set(k, data.cells[i] ?? '');
    } else {
      for (const r of ns.rows) {
        const [k, v] = [normHeader(r.cells[0] ?? ''), r.cells[1] ?? ''];
        if (k) set(k, v);
      }
    }
    book.rule = rule;
  }

  // ---- Подбор
  const pick = byKind.get('pick')?.[0];
  if (pick) {
    const H = findHeader(pick.rows, { productId: /product[_ ]?id|^id\b|^ид\b/, aliases: /синоним/, technical: /характерист/, quoteNotes: /примеч/, conditions: /услови/ });
    if (!H || H.cols.productId === undefined) book.errors.push({ sheet: pick.name, row: null, column: null, message: 'не найдена шапка с колонкой ID' });
    else {
      unknownCols(pick.name, H.unknown);
      const byId = new Map(book.products.map((p) => [p.productId, p]));
      for (const r of pick.rows) {
        if (r.row <= H.headerRow) continue;
        const productId = cellOf(r, H.cols, 'productId');
        if (!productId) continue;
        const p = byId.get(productId);
        if (!p) {
          book.skipped.push({ sheet: pick.name, row: r.row, column: 'ID', message: `${productId}: такого ID нет — строка подбора пропущена` });
          continue;
        }
        p.aliases = list(cellOf(r, H.cols, 'aliases'));
        p.card.technical = json(cellOf(r, H.cols, 'technical'));
        p.card.quoteNotes = list(cellOf(r, H.cols, 'quoteNotes'));
        p.card.priceConditions = json(cellOf(r, H.cols, 'conditions'));
        const c = p.card.priceConditions;
        if (c) {
          if (typeof c.status === 'string') p.status = productStatusOf(c.status);
          if (c.estimate_only === true || c.estimateOnly === true) p.status = p.status === 'inactive' ? 'inactive' : 'estimate_only';
        }
      }
    }
  }

  // Позиция только для сметы с ценой на листе 1 (формула сборки, INT-008 = P12+Q12): правило из комментария — в карточку.
  for (const p of book.products) {
    if (p.status !== 'estimate_only' || p.estimate) continue;
    const est = estimateFromComment(p.card.comment) ?? estimateFromComment(p.card.baseIncludes);
    if (est) {
      p.estimate = true;
      p.card.estimateFormula = est.formula;
    }
  }

  // ---- Дополнения (фурнитура)
  const extras = byKind.get('extras')?.[0];
  if (extras) {
    const H = findHeader(extras.rows, { tariffId: /id тариф|тариф|^id$/, type: /^тип/, name: /наимен|назван/, unit: /единиц|ед\.?/, price: /^цена|стоим/, status: /статус/, forModels: /для модел|модел/, includes: /включ/, clarify: /уточн/, aliases: /синоним/ });
    if (!H || H.cols.tariffId === undefined || H.cols.name === undefined) book.errors.push({ sheet: extras.name, row: null, column: null, message: 'не найдена шапка с колонками «ID тарифа» и «Наименование»' });
    else {
      unknownCols(extras.name, H.unknown);
      for (const r of extras.rows) {
        if (r.row <= H.headerRow) continue;
        const tariffId = cellOf(r, H.cols, 'tariffId');
        const name = cellOf(r, H.cols, 'name');
        if (!tariffId || !name) continue;
        const priceCell = cellOf(r, H.cols, 'price');
        const price = priceCell ? parsePrice(priceCell) : null;
        if (priceCell && price === null && !/^[-—–]+$/.test(priceCell) && !/уточн|по запрос|нет/i.test(priceCell)) {
          book.errors.push({ sheet: extras.name, row: r.row, column: 'Цена', message: `${tariffId}: ${formulaOrNotNumber(priceCell)}` });
          continue;
        }
        const unitRaw = cellOf(r, H.cols, 'unit').toLowerCase();
        const unit = /m2|м2|м²|кв/.test(unitRaw) ? 'м²' : /^m$|^м$|пог|метр/.test(unitRaw) ? 'м' : 'шт';
        const fm = cellOf(r, H.cols, 'forModels');
        const forModels: string[] | '*' = !fm || /^\*$|^все|^all/i.test(fm.trim()) ? '*' : list(fm);
        book.hardware.push({ row: r.row, tariffId, type: cellOf(r, H.cols, 'type') || null, name, unit, price: price && price > 0 ? price : null, status: productStatusOf(cellOf(r, H.cols, 'status')), forModels, includes: cellOf(r, H.cols, 'includes') || null, clarify: cellOf(r, H.cols, 'clarify') || null, aliases: list(cellOf(r, H.cols, 'aliases')) });
      }
    }
  }

  // ---- Словари
  for (const d of byKind.get('dictionary') ?? []) {
    const H = findHeader(d.rows, { term: /слово|код|сокращ|термин|^гост|типоразм|обознач|наимен|^полотно|^марк/, meaning: /значен|расшифр|описан|регламент|област|проем|проём|пример/, context: /контекст|где|примен|роль|замена/, rule: /правил|агент/ });
    if (!H || H.cols.term === undefined) {
      book.skipped.push({ sheet: d.name, row: null, column: null, message: 'не найдена шапка словаря (слово/код, значение) — вкладка пропущена' });
      continue;
    }
    unknownCols(d.name, H.unknown);
    for (const r of d.rows) {
      if (r.row <= H.headerRow) continue;
      const term = cellOf(r, H.cols, 'term');
      if (!term) continue;
      book.dictionary.push({ sheet: d.name, row: r.row, term, meaning: cellOf(r, H.cols, 'meaning') || null, context: cellOf(r, H.cols, 'context') || null, rule: cellOf(r, H.cols, 'rule') || null });
    }
  }

  // Товары без ID при наличии вкладки ID — ошибка связи.
  if (idSheet) for (const p of book.products) if (!p.productId) book.errors.push({ sheet: list1.name, row: p.row, column: '№', message: `«${p.model}» (№ ${p.no ?? '—'}): нет строки на вкладке ID` });
  // Размеры из текста листа 1 — только если вкладки «Размеры» нет.
  if (!sizesSheet) {
    for (const p of book.products) {
      if (!p.productId) continue;
      for (const s of sizesOf(p.sizesText ?? '')) if (s) book.sizes.push({ row: p.row, sizeId: null, productId: p.productId, widthMm: s.widthMm, heightMm: s.heightMm, basis: p.card.sizeBasis, leafWidthsMm: null });
    }
  }
  return book;
}
