/**
 * Нестандарт по сетке размеров (RFD-AI-AGENT-OPT-KB-PRICE-SHEETS, п. 2): точное совпадение с размером той же модели — 0 %;
 * любое отличие (в том числе меньше) — +regular (30 %) к базе; ширина ИЛИ высота больше эталона строго более чем на
 * large_threshold (30 %) — +large (100 %) вместо regular; ровно на порог — остаётся regular. Один коэффициент только к базе;
 * компоненты и фурнитура не индексируются. Эталон — ближайшая пара Ш×В той же модели (наименьшее отклонение).
 */
import type { BookRule, Geometry } from './price-book.ts';

export interface SizeRef {
  widthMm: number;
  heightMm: number;
  leafWidthsMm?: number[] | null;
}

export interface NonstandardResult {
  /** 0 — точный размер; 30 — обычный нестандарт; 100 — крупный (значения из правила прайса). */
  surchargePercent: number;
  factor: number;
  reference: SizeRef | null;
  basis: 'exact' | 'rules' | 'base';
  notes: string[];
}

const EPS = 1e-9;

/** Ширина для сравнения по режиму геометрии: pair — сумма створок, each_leaf — самая широкая створка, иначе габарит. */
function widthOf(ref: SizeRef, geometry: Geometry | null): number {
  const leaves = ref.leafWidthsMm?.filter((x) => x > 0) ?? [];
  if (geometry === 'pair' && leaves.length) return leaves.reduce((a, b) => a + b, 0);
  if (geometry === 'each_leaf' && leaves.length) return Math.max(...leaves);
  return ref.widthMm;
}

export function nonstandardBySizes(sizes: SizeRef[], q: { widthMm: number | null; heightMm: number | null }, rule: BookRule, geometry: Geometry | null = null, fire = false): NonstandardResult {
  const notes: string[] = [];
  if (!sizes.length || q.widthMm === null || q.heightMm === null) {
    if (q.widthMm === null || q.heightMm === null) notes.push('размер позиции не указан — базовая цена');
    else notes.push('у модели нет сетки размеров — базовая цена');
    return { surchargePercent: 0, factor: 1, reference: null, basis: 'base', notes };
  }
  const w = q.widthMm;
  const h = q.heightMm;
  // Точное совпадение — строго: любое отличие хотя бы на 1 мм уже нестандарт (п. 2 задания).
  const exact = sizes.find((s) => widthOf(s, geometry) === w && s.heightMm === h);
  if (exact) return { surchargePercent: 0, factor: 1, reference: exact, basis: 'exact', notes };
  // Эталон — ближайший размер сетки: наименьшее относительное отклонение по большему из двух измерений (899×2000 при
  // 800 и 900 → 900×2000; 1171×2000 → 900×2000: +30,1 % — крупный). При равенстве — размер с меньшим превышением.
  const scored = sizes.map((s) => {
    const rw = widthOf(s, geometry);
    const dw = (w - rw) / rw;
    const dh = (h - s.heightMm) / s.heightMm;
    return { s, rw, exceed: Math.max(dw, dh), distance: Math.max(Math.abs(dw), Math.abs(dh)), total: Math.abs(dw) + Math.abs(dh) };
  });
  // Ближайший по большему отклонению; при равенстве — по сумме отклонений (900×2601 при 800 и 900 → 900), затем по превышению.
  scored.sort((a, b) => a.distance - b.distance || a.total - b.total || a.exceed - b.exceed);
  const chosen = scored[0] as (typeof scored)[number];
  const ref = chosen.s;
  const rw = chosen.rw;
  const thr = rule.largeThresholdPercent / 100;
  const large = (w - rw) / rw > thr + EPS || (h - ref.heightMm) / ref.heightMm > thr + EPS;
  const pct = large ? rule.largeSurchargePercent : rule.regularSurchargePercent;
  notes.push(`нестандарт ${w}×${h} при эталоне ${rw}×${ref.heightMm}: +${pct} % к базе${large ? ` (превышение больше ${rule.largeThresholdPercent} %)` : ''}`);
  notes.push(rule.productionNote?.trim() || 'Нестандартные позиции подлежат уточнению на производстве.');
  if (fire) notes.push('размер и огнестойкость исполнения уточняются');
  return { surchargePercent: pct, factor: 1 + pct / 100, reference: ref, basis: 'rules', notes };
}
