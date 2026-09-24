import { z } from 'zod';

/**
 * Правила расчёта стоимости (раздел 8 ТЗ, «Правила цен»). Заполняет заказчик при обучении:
 * таблицей в настройках или импортом XLSX.
 *
 * Модель выведена из накладных РФ-Двери: полотно × количество, коробка ~2,5 шт. и наличник ~5 шт.
 * на дверь (с округлением вверх), доборы по толщине стены, фурнитура, услуги.
 * Цены комплектующих зависят от серии двери.
 */
export const componentSchema = z
  .object({
    /** Код для инструмента и импорта: box, casing, ext_100… */
    code: z.string().regex(/^[a-z0-9_]{1,40}$/),
    name: z.string().min(1).max(200),
    /** Сколько штук на одну дверь; 0 — только по явному запросу (доборы). */
    qtyPerDoor: z.number().min(0).max(50),
    /** Добавлять автоматически в комплект («коробка», «наличник»). */
    inKit: z.boolean().default(true),
    /** Округлять общее количество вверх до целого. */
    roundUp: z.boolean().default(true),
    /** Цена по серии: подстрока в названии или категории двери, без учёта регистра. */
    prices: z.array(z.object({ series: z.string().min(1).max(200), price: z.number().min(0) }).strict()).default([]),
    /** Цена, если серия не найдена; null — цену уточняет менеджер. */
    defaultPrice: z.number().min(0).nullable().default(null),
  })
  .strict();

export const serviceSchema = z
  .object({
    code: z.string().regex(/^[a-z0-9_]{1,40}$/),
    name: z.string().min(1).max(200),
    /** fixed — за заказ; per_door — за дверь; per_km — за км (+ basePrice); per_door_per_floor — за дверь за этаж. */
    unit: z.enum(['fixed', 'per_door', 'per_km', 'per_door_per_floor']),
    price: z.number().min(0),
    basePrice: z.number().min(0).default(0),
  })
  .strict();

export const pricingRulesSchema = z
  .object({
    sizes: z
      .object({
        standardWidths: z.array(z.number().int().positive()).default([600, 700, 800, 900]),
        standardHeights: z.array(z.number().int().positive()).default([2000]),
        /** Наценка на нестандартный размер, %; null — нестандарт считает менеджер. */
        nonStandardMarkupPct: z.number().min(0).max(500).nullable().default(null),
      })
      .strict()
      .default({}),
    components: z.array(componentSchema).max(200).default([]),
    services: z.array(serviceSchema).max(100).default([]),
    /** Фраза, которую агент добавляет к предварительной сумме. */
    disclaimer: z.string().max(500).default('Расчёт предварительный, окончательную стоимость подтвердит менеджер.'),
  })
  .strict()
  .superRefine((r, ctx) => {
    const codes = [...r.components.map((c) => c.code), ...r.services.map((s) => s.code)];
    const dup = codes.find((c, i) => codes.indexOf(c) !== i);
    if (dup) ctx.addIssue({ code: 'custom', message: `Код «${dup}» повторяется` });
  });

export type PricingRules = z.infer<typeof pricingRulesSchema>;
export type Component = z.infer<typeof componentSchema>;
export type Service = z.infer<typeof serviceSchema>;

export const emptyRules = (): PricingRules => pricingRulesSchema.parse({});

export const isConfigured = (r: PricingRules) => r.components.length > 0 || r.services.length > 0;
