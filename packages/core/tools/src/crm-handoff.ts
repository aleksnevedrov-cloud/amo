import { z } from 'zod';
import { defineTool, HANDOFF_REASONS } from './types.ts';

export const crmHandoff = defineTool({
  name: 'crm_handoff',
  specName: 'crm.handoff',
  description:
    'Передать диалог менеджеру. Вызывайте, если клиент просит живого человека, жалуется или недоволен; ' +
    'спрашивает о скидке, нестандартном заказе (размеры, цвет, конструкция вне каталога), покупке на юрлицо, опте, ' +
    'возврате или рекламации; или если ответа нет ни в каталоге, ни в базе знаний. После вызова AI больше не пишет ' +
    'клиенту — менеджер получит задачу и резюме.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: { type: 'string', enum: [...HANDOFF_REASONS], description: 'Причина передачи' },
      summary: {
        type: 'string',
        description: 'Резюме для менеджера: потребность, размеры, бюджет, рассмотренные модели, открытые вопросы.',
      },
    },
    required: ['reason', 'summary'],
    additionalProperties: false,
  },
  input: z.object({ reason: z.enum(HANDOFF_REASONS), summary: z.string().min(1).max(4000) }),
  async run(_ctx, i) {
    return { content: { ok: true }, handoff: { reason: i.reason, summary: i.summary } };
  },
});
