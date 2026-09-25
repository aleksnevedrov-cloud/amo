import type { Opening } from './schema.ts';

/**
 * Комплект по замерному листу — по правилам замерщика РФ-Двери (из реальных листов):
 * одностворчатая — 2,5 коробки, 5 наличников, 2,5 добора; двустворчатая — 3 / 6 / 3.
 * Полотно выбирается по проёму: ширина проёма минус 60–120 мм → ближайшее типовое.
 * Ширина добора — по толщине стены (95–110 → 100; 235 → 250).
 */
export interface KitLine {
  opening: string;
  double: boolean;
  qty: number;
  leaf_width_mm: number | null;
  leaf_height_mm: number | null;
  /** Нестандартный размер полотна (нет типового). */
  nonstandard: boolean;
  boxes: number;
  casings: number;
  extensions: number;
  extension_width_mm: number | null;
}

export interface KitEstimate {
  lines: KitLine[];
  totals: { doors: number; boxes: number; casings: number; extensions: number };
}

const LEAF_WIDTHS = [400, 550, 600, 700, 800, 900];
const LEAF_HEIGHTS = [1900, 2000];
const EXTENSION_WIDTHS = [100, 150, 200, 250, 300];
/** Запас проёма на коробку и монтаж, мм. */
const GAP_MIN = 60;
const GAP_MAX = 160;

export function leafWidthForOpening(opening: number | null, leaf: number | null): { width: number | null; nonstandard: boolean } {
  if (leaf) return { width: leaf, nonstandard: !LEAF_WIDTHS.includes(leaf) };
  if (!opening) return { width: null, nonstandard: false };
  const fit = [...LEAF_WIDTHS].reverse().find((w) => opening - w >= GAP_MIN && opening - w <= GAP_MAX);
  if (fit) return { width: fit, nonstandard: false };
  // Типовое не влезает с нормальным зазором: полотно под заказ, ширина проём − 80.
  return { width: Math.round((opening - 80) / 10) * 10, nonstandard: true };
}

export function leafHeightForOpening(opening: number | null): { height: number | null; nonstandard: boolean } {
  if (!opening) return { height: null, nonstandard: false };
  const fit = [...LEAF_HEIGHTS].reverse().find((h) => opening - h >= 30 && opening - h <= 110);
  if (fit) return { height: fit, nonstandard: false };
  return { height: Math.round((opening - 60) / 10) * 10, nonstandard: true };
}

export function extensionWidthForWall(wall: number | null): number | null {
  if (!wall) return null;
  // Замерщик берёт добор по толщине стены: ближайший типовой не меньше её (допуск 10 мм): 105 → 100, 235 → 250.
  return EXTENSION_WIDTHS.find((w) => wall <= w + 10) ?? EXTENSION_WIDTHS.at(-1) ?? null;
}

export function estimateKit(openings: Opening[]): KitEstimate {
  const lines: KitLine[] = openings.map((o, i) => {
    const qty = o.qty && o.qty > 0 ? Math.round(o.qty) : 1;
    const double = o.double ?? (o.width_mm !== null && o.width_mm >= 1200);
    const w = leafWidthForOpening(o.width_mm, o.leaf_width_mm);
    const h = leafHeightForOpening(o.height_mm);
    return {
      opening: o.label || o.room || `проём ${i + 1}`,
      double,
      qty,
      leaf_width_mm: w.width,
      leaf_height_mm: h.height,
      nonstandard: w.nonstandard || h.nonstandard,
      boxes: (double ? 3 : 2.5) * qty,
      casings: (double ? 6 : 5) * qty,
      extensions: o.wall_mm && o.wall_mm > 80 ? (double ? 3 : 2.5) * qty : 0,
      extension_width_mm: o.wall_mm && o.wall_mm > 80 ? extensionWidthForWall(o.wall_mm) : null,
    };
  });
  const sum = (k: 'boxes' | 'casings' | 'extensions') => lines.reduce((a, l) => a + l[k], 0);
  return { lines, totals: { doors: lines.reduce((a, l) => a + l.qty, 0), boxes: sum('boxes'), casings: sum('casings'), extensions: sum('extensions') } };
}
