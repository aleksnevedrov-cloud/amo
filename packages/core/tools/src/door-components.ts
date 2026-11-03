import { z } from 'zod';
import { defineTool } from './types.ts';

/**
 * Комплектующие именно этой двери (RFD-AI-AGENT-KOMPLEKTUYUWIE).
 * У каждой двери свой набор и свои цены: та же коробка в разделе комплектующих стоит 1 430 ₽,
 * а в карточке двери - 1 156 ₽. Общие «Правила цен» для этого не годятся.
 */
export const doorComponents = defineTool({
  name: 'door_components',
  specName: 'door_components',
  description:
    'Комплектующие конкретной двери с ценами из её карточки: коробка, наличник, добор, карниз, розетка, цоколь, плинтус, капитель, портал. У каждой двери набор и цены свои - брать только отсюда, не из общих правил цен.',
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
    if (!ctx.components || !p.url) {
      return { empty: true, content: { error: 'Связка комплектующих недоступна' } };
    }
    let items: { group: string; name: string; price: number }[] = [];
    try {
      items = await ctx.components.forProduct(ctx.accountId, String(p.id ?? i.id), p.url);
    } catch {
      return { empty: true, content: { error: 'Карточка не прочитана' } };
    }
    if (items.length === 0) {
      return {
        empty: true,
        content: { product: p.name, note: 'У этой двери комплектующие на сайте не указаны' },
      };
    }
    const groups: Record<string, { name: string; price: number }[]> = {};
    for (const it of items) {
      (groups[it.group] ??= []).push({ name: it.name, price: it.price });
    }
    return {
      content: { product: p.name, groups },
      sources: [{ type: 'product', id: p.id, title: p.name, url: p.url }],
    };
  },
});
