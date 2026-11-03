import { z } from 'zod';
import { defineTool } from './types.ts';

export const crmAddNote = defineTool({
  name: 'crm_add_note',
  specName: 'crm.add_note',
  description:
    'Записать примечание в сделку для менеджера: выясненные потребности, размеры проёмов, выбранные модели. ' +
    'Клиент примечание не видит.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: 'Текст примечания' } },
    required: ['text'],
    additionalProperties: false,
  },
  input: z.object({ text: z.string().min(1).max(4000) }),
  async run(ctx, i) {
    await ctx.crm.addNote(`[AI] ${i.text}`);
    return { content: { ok: true } };
  },
});
