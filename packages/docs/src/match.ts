import type { CatalogRepo, ProductSummary } from '@ai-door/catalog';
import type { DocumentData, Position } from './schema.ts';

/** Оценка позиции относительно ассортимента магазина. */
export interface PositionMatch {
  index: number;
  /** Найденные похожие товары каталога. */
  products: Pick<ProductSummary, 'id' | 'name' | 'price' | 'url'>[];
  flags: PositionFlag[];
}

export type PositionFlag =
  | 'fireproof' // противопожарные — не ассортимент
  | 'steel' // стальные/алюминиевые блоки — только под заказ / не ассортимент
  | 'nonstandard_size' // размер вне типовых
  | 'not_found'; // в каталоге ничего похожего

const STANDARD_WIDTHS = new Set([600, 700, 800, 900]);
const STANDARD_HEIGHT = 2000;

/** Нестандарт — то, что не сводится к типовому полотну (ширина 600–900, высота 2000) с обычным запасом на коробку. */
export function isStandardLeaf(width: number | null, height: number | null): boolean | null {
  if (width === null && height === null) return null;
  const w = width ?? 800;
  const h = height ?? 2000;
  // Размер полотна или проёма: проём обычно на 60–100 мм больше полотна.
  const leafW = [...STANDARD_WIDTHS].some((s) => w === s || (w >= s + 50 && w <= s + 120));
  const leafH = h === STANDARD_HEIGHT || (h >= STANDARD_HEIGHT + 30 && h <= STANDARD_HEIGHT + 100);
  return leafW && leafH;
}

export function flagsFor(p: Position): PositionFlag[] {
  const flags: PositionFlag[] = [];
  const text = `${p.name} ${p.marking ?? ''} ${p.material ?? ''} ${p.note ?? ''}`.toLowerCase();
  if (p.fireproof || /противопожар|(?<!\p{L})ei\s?\d{2}/u.test(text)) flags.push('fireproof');
  if (/сталь|металл|алюмин|(?<!\p{L})(дсв|дсн|дав|дан|дпс|дпм)(?!\p{L})/u.test(text)) flags.push('steel');
  if (isStandardLeaf(p.width_mm, p.height_mm) === false) flags.push('nonstandard_size');
  return flags;
}

/** Ищет позиции в каталоге (по названию без марок и размеров) и размечает нестандарт. */
export async function matchPositions(catalog: CatalogRepo, accountId: number, data: DocumentData, limit = 30): Promise<PositionMatch[]> {
  const out: PositionMatch[] = [];
  for (const [index, p] of data.positions.slice(0, limit).entries()) {
    const flags = flagsFor(p);
    let products: PositionMatch['products'] = [];
    if (!flags.includes('fireproof') && !flags.includes('steel')) {
      const query = searchQuery(p);
      if (query) {
        try {
          products = (await catalog.search(accountId, { query, limit: 3 })).map((x) => ({ id: x.id, name: x.name, price: x.price, url: x.url }));
        } catch {
          products = [];
        }
      }
      if (!products.length) flags.push('not_found');
    }
    out.push({ index, products, flags });
  }
  return out;
}

/** Из «Дверь межкомнатная AquaDoor 700х2000 мм влагостойкая ПВХ белый глухая» → «AquaDoor влагостойкая ПВХ белый глухая». */
export function searchQuery(p: Position): string {
  return [p.name, p.material, p.color]
    .filter((x): x is string => Boolean(x))
    .join(' ')
    .replace(/\d{3,4}\s*[xхXХ×*]\s*\d{3,4}(\s*\(h\))?(\s*мм)?/gu, ' ')
    .replace(/(?<!\p{L})(дверь|дверной|блок|межкомнатн\p{L}*|шт\.?|мм|компл\.?)(?!\p{L})/giu, ' ')
    .replace(/[«»"()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}
