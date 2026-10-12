import { XMLParser } from 'fast-xml-parser';

export interface FeedCategory {
  id: string;
  parentId: string | null;
  name: string;
}

export interface FeedParam {
  name: string;
  value: string;
  unit?: string;
}

export interface FeedProduct {
  id: string;
  name: string;
  url: string | null;
  price: number | null;
  oldPrice: number | null;
  currency: string | null;
  available: boolean | null;
  categoryId: string | null;
  vendor: string | null;
  vendorCode: string | null;
  description: string | null;
  params: FeedParam[];
  pictures: string[];
}

export interface Feed {
  shopName: string | null;
  categories: FeedCategory[];
  products: FeedProduct[];
}

export class FeedError extends Error {
  override name = 'FeedError';
}

/** Декодирует байты фида с учётом кодировки из XML-декларации (UMI часто отдаёт windows-1251). */
export function decodeFeed(bytes: Uint8Array): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
  const enc = /encoding=["']([\w-]+)["']/i.exec(head)?.[1]?.toLowerCase() ?? 'utf-8';
  try {
    return new TextDecoder(enc).decode(bytes);
  } catch {
    throw new FeedError(`Неподдерживаемая кодировка фида: ${enc}`);
  }
}

const asArray = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

function text(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'object') {
    const t = (v as Record<string, unknown>)['#text'];
    return t == null ? null : String(t).trim() || null;
  }
  const s = String(v).trim();
  return s || null;
}

function num(v: unknown): number | null {
  const s = text(v);
  if (s == null) return null;
  const n = Number(s.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Убирает HTML-теги из описания (в YML оно часто в CDATA с разметкой). */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|div|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** Разбор YML (формат Яндекс.Маркета), который выгружает UMI.CMS. */
export function parseYml(xml: string): Feed {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    isArray: (name) => ['category', 'offer', 'param', 'picture'].includes(name),
    processEntities: true,
  });
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    throw new FeedError(`Фид не является корректным XML: ${(err as Error).message}`);
  }
  const shop = (doc.yml_catalog as Record<string, unknown> | undefined)?.shop as Record<string, unknown> | undefined;
  if (!shop) throw new FeedError('В фиде нет yml_catalog/shop — ожидается формат YML');

  const categories: FeedCategory[] = asArray((shop.categories as Record<string, unknown> | undefined)?.category).map(
    (c) => {
      const o = c as Record<string, unknown>;
      return { id: String(o['@id']), parentId: o['@parentId'] ? String(o['@parentId']) : null, name: text(o) ?? '' };
    },
  );

  const products: FeedProduct[] = [];
  for (const raw of asArray((shop.offers as Record<string, unknown> | undefined)?.offer)) {
    const o = raw as Record<string, unknown>;
    const id = o['@id'] ? String(o['@id']) : null;
    const name =
      text(o.name) ??
      ([text(o.typePrefix), text(o.vendor), text(o.model)].filter(Boolean).join(' ').trim() || null);
    if (!id || !name) continue;
    const availableAttr = o['@available'];
    const desc = text(o.description);
    products.push({
      id,
      name,
      url: text(o.url),
      price: num(o.price),
      oldPrice: num(o.oldprice),
      currency: text(o.currencyId),
      available: availableAttr == null ? null : String(availableAttr).toLowerCase() === 'true',
      categoryId: text(o.categoryId),
      vendor: text(o.vendor),
      vendorCode: text(o.vendorCode),
      description: desc ? stripHtml(desc).slice(0, 4000) : null,
      params: asArray(o.param)
        .map((p) => {
          const po = p as Record<string, unknown>;
          const value = text(po);
          const param: FeedParam = { name: String(po['@name'] ?? '').trim(), value: value ?? '' };
          if (po['@unit']) param.unit = String(po['@unit']);
          return param;
        })
        .filter((p) => p.name && p.value),
      pictures: asArray(o.picture)
        .map((p) => text(p))
        .filter((p): p is string => Boolean(p)),
    });
  }
  return { shopName: text(shop.name), categories, products };
}

/** Путь категории «Двери › Межкомнатные › Эмаль». */
export function categoryPaths(categories: FeedCategory[]): Map<string, string> {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const paths = new Map<string, string>();
  for (const c of categories) {
    const names: string[] = [];
    const seen = new Set<string>();
    let cur: FeedCategory | undefined = c;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      names.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    paths.set(c.id, names.join(' › '));
  }
  return paths;
}
