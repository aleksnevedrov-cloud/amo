import { z } from 'zod';
import { defineTool, TASK_KINDS } from './types.ts';

const LABEL: Record<(typeof TASK_KINDS)[number], string> = {
  callback: 'Перезвонить клиенту',
  send_offer: 'Отправить КП',
  check_availability: 'Проверить наличие',
  measure: 'Согласовать замер',
  other: 'Задача',
};

/** Срок по умолчанию, если тип не настроен: 60 минут, тип amo «Связаться». */
const DEFAULT = { taskTypeId: 1, deadlineMin: 60 };

export const crmCreateTask = defineTool({
  name: 'crm_create_task',
  specName: 'crm.create_task',
  description:
    'Поставить задачу менеджеру, не прерывая диалог: перезвонить клиенту (в удобное ему время), отправить КП, ' +
    'проверить наличие или срок поставки, согласовать замер. Задача уходит ответственному по сделке. ' +
    'Клиенту скажите, что менеджер свяжется, но не обещайте конкретное время, если его не назвал клиент.',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: [...TASK_KINDS] },
      text: { type: 'string', description: 'Что сделать менеджеру: коротко, с деталями (время звонка, модели, размеры).' },
    },
    required: ['type', 'text'],
    additionalProperties: false,
  },
  input: z.object({ type: z.enum(TASK_KINDS), text: z.string().min(3).max(1000) }),
  async run(ctx, i) {
    const cfg = ctx.tasks?.[i.type] ?? DEFAULT;
    await ctx.crm.createTask({ text: `AI: ${LABEL[i.type]}. ${i.text}`, ...cfg });
    return { content: { ok: true, task: LABEL[i.type] } };
  },
});
