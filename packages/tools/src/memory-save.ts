import { z } from 'zod';
import { defineTool } from './types.ts';

export const memorySave = defineTool({
  name: 'memory_save',
  specName: 'memory.save',
  description:
    'Запомнить о клиенте то, что пригодится в этом и следующих обращениях: проёмы (помещение, ширина и высота полотна, ' +
    'толщина стены, количество), бюджет, предпочтения (тип двери, покрытие, цвет, стиль), понравившиеся и отклонённые ' +
    'модели (id из каталога). Сохраняйте только то, что сказал клиент или выбрал из предложенного.',
  inputSchema: {
    type: 'object',
    properties: {
      openings: {
        type: 'array',
        description: 'Все проёмы целиком (заменяет прежний список).',
        items: {
          type: 'object',
          properties: {
            room: { type: 'string' },
            width_mm: { type: 'integer' },
            height_mm: { type: 'integer' },
            wall_mm: { type: 'integer' },
            qty: { type: 'integer' },
          },
          additionalProperties: false,
        },
      },
      budget_rub: { type: 'number' },
      preferences: {
        type: 'object',
        properties: {
          door_type: { type: 'string' },
          coating: { type: 'string' },
          color: { type: 'string' },
          style: { type: 'string' },
        },
        additionalProperties: false,
      },
      chosen: {
        type: 'array',
        items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id', 'name'], additionalProperties: false },
      },
      rejected: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, name: { type: 'string' }, reason: { type: 'string' } },
          required: ['id', 'name'],
          additionalProperties: false,
        },
      },
      notes: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: false,
  },
  input: z.object({
    openings: z
      .array(
        z.object({
          room: z.string().max(100).optional(),
          width_mm: z.number().int().min(300).max(3000).optional(),
          height_mm: z.number().int().min(1000).max(3500).optional(),
          wall_mm: z.number().int().min(50).max(1000).optional(),
          qty: z.number().int().min(1).max(100).optional(),
        }),
      )
      .max(50)
      .optional(),
    budget_rub: z.number().positive().optional(),
    preferences: z
      .object({ door_type: z.string().max(100).optional(), coating: z.string().max(100).optional(), color: z.string().max(100).optional(), style: z.string().max(100).optional() })
      .optional(),
    chosen: z.array(z.object({ id: z.string().max(100), name: z.string().max(300) })).max(10).optional(),
    rejected: z.array(z.object({ id: z.string().max(100), name: z.string().max(300), reason: z.string().max(300).optional() })).max(10).optional(),
    notes: z.array(z.string().max(500)).max(5).optional(),
  }),
  async run(ctx, i) {
    if (!ctx.memory) return { content: { ok: false, error: 'Память недоступна' }, empty: true };
    await ctx.memory.update(i);
    return { content: { ok: true } };
  },
});
