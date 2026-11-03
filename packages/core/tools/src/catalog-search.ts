import { z } from 'zod';
import { defineTool } from './types.ts';

export const catalogSearch = defineTool({
  name: 'catalog_search',
  specName: 'catalog.search',
  description:
    'Поиск товаров в каталоге магазина по названию, артикулу, коллекции, покрытию, цвету, типу двери. ' +
    'Возвращает до 10 товаров с ценой, наличием и ссылкой. Для похожих моделей передайте similar_to с id товара. ' +
    'Используйте перед любым упоминанием модели, цены или наличия.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Что ищем, своими словами: «белая дверь эмаль», «входная с терморазрывом», артикул.' },
      min_price: { type: 'number', description: 'Минимальная цена, ₽' },
      max_price: { type: 'number', description: 'Максимальная цена, ₽' },
      available_only: { type: 'boolean', description: 'Только в наличии' },
      similar_to: { type: 'string', description: 'id товара, к которому подобрать похожие' },
      limit: { type: 'integer', minimum: 1, maximum: 10 },
    },
    additionalProperties: false,
  },
  input: z.object({
    query: z.string().max(300).optional(),
    min_price: z.number().nonnegative().optional(),
    max_price: z.number().positive().optional(),
    available_only: z.boolean().optional(),
    similar_to: z.string().max(100).optional(),
    limit: z.number().int().min(1).max(10).optional(),
  }),
  async run(ctx, i) {
    const items = await ctx.catalog.search(ctx.accountId, {
      query: i.query,
      minPrice: i.min_price,
      maxPrice: i.max_price,
      availableOnly: i.available_only,
      similarTo: i.similar_to,
      limit: i.limit ?? 5,
    });
    return {
      empty: items.length === 0,
      content: items.length ? { products: items.map(productView) } : { products: [], note: 'Ничего не найдено' },
      sources: items.map((p) => ({ type: 'product' as const, id: p.id, title: p.name, url: p.url })),
    };
  },
});

export function productView(p: {
  id: string;
  name: string;
  price: number | null;
  oldPrice: number | null;
  currency: string | null;
  available: boolean | null;
  url: string | null;
  category: string | null;
  vendorCode: string | null;
  params: { name: string; value: string; unit?: string }[];
}) {
  return {
    id: p.id,
    name: p.name,
    price_rub: p.price,
    old_price_rub: p.oldPrice,
    availability: p.available === null ? 'нет данных' : p.available ? 'в наличии' : 'нет в наличии',
    url: p.url,
    category: p.category,
    article: p.vendorCode,
    params: Object.fromEntries(p.params.map((x) => [x.name, x.unit ? `${x.value} ${x.unit}` : x.value])),
  };
}
