import { z } from 'zod';
import { defineTool } from './types.ts';

export const knowledgeSearch = defineTool({
  name: 'knowledge_search',
  specName: 'knowledge.search',
  description:
    'Поиск в базе знаний магазина: покрытия (эмаль, экошпон, ПВХ, массив, шпон, CPL и др.), уход, доставка, ' +
    'установка, замер, оплата, гарантия, сроки. Сроки, условия и стоимость услуг сообщайте только из этих данных.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Вопрос своими словами' } },
    required: ['query'],
    additionalProperties: false,
  },
  input: z.object({ query: z.string().min(1).max(300) }),
  async run(ctx, i) {
    const hits = await ctx.knowledge.search(ctx.accountId, i.query);
    return {
      empty: hits.length === 0,
      content: hits.length
        ? { fragments: hits.map((h) => ({ id: `kb-${h.chunkId}`, title: h.title, text: h.content })) }
        : { fragments: [], note: 'В базе знаний ничего не найдено' },
      sources: hits.map((h) => ({
        type: 'knowledge' as const,
        id: `kb-${h.chunkId}`,
        title: h.title,
        url: h.source,
        date: h.createdAt.toISOString().slice(0, 10),
      })),
    };
  },
});
