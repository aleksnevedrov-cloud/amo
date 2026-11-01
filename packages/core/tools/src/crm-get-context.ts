import { z } from 'zod';
import { defineTool } from './types.ts';

export const crmGetContext = defineTool({
  name: 'crm_get_context',
  specName: 'crm.get_context',
  description: 'Данные сделки в CRM: название, бюджет, имя клиента, теги, последние примечания менеджеров.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  input: z.object({}).strict(),
  async run(ctx) {
    const lead = await ctx.crm.getContext();
    if (!lead) return { empty: true, content: { error: 'Сделка не найдена' } };
    return { content: lead };
  },
});
