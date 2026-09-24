import { z } from 'zod';
import { productView } from './catalog-search.ts';
import { defineTool } from './types.ts';

export const catalogGetProduct = defineTool({
  name: 'catalog_get_product',
  specName: 'catalog.get_product',
  description: 'Полная карточка товара по id из каталога или артикулу: характеристики, цена, наличие, описание, ссылка, фото.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'id товара или артикул' } },
    required: ['id'],
    additionalProperties: false,
  },
  input: z.object({ id: z.string().min(1).max(100) }),
  async run(ctx, i) {
    const p = await ctx.catalog.get(ctx.accountId, i.id);
    if (!p) return { empty: true, content: { error: 'Товар не найден' } };
    return {
      content: {
        ...productView(p),
        description: p.description,
        pictures: p.pictures.slice(0, 3),
        data_updated_at: p.updatedAt.toISOString(),
      },
      sources: [{ type: 'product', id: p.id, title: p.name, url: p.url }],
    };
  },
});
