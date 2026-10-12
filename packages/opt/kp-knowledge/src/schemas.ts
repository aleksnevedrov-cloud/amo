import { z } from 'zod';
import type { KnowledgeKind } from './kinds.ts';

/**
 * Схемы строк справочников. Заголовки колонок — русские, как в шаблонах; у каждой колонки есть
 * допустимые варианты написания (aliases), чтобы файл из Excel не отклонялся из-за регистра или «ё».
 */

const money = z.number().min(0).max(100_000_000);
const text = (max: number) => z.string().trim().min(1).max(max);
const optText = (max: number) => z.string().trim().max(max).default('');

export const deliveryRowSchema = z.object({
  zone: text(120).describe('зона'),
  description: optText(500).describe('описание зоны: районы, расстояние от МКАД'),
  priceRub: money.describe('цена доставки, ₽'),
  minOrderRub: money.nullable().default(null).describe('бесплатно от суммы заказа, ₽'),
  note: optText(300),
});

export const installationRowSchema = z.object({
  service: text(200).describe('услуга: замер, монтаж полотна, демонтаж…'),
  unit: text(30).describe('единица: шт, проём, выезд'),
  priceRub: money,
  note: optText(300),
});

export const analogRowSchema = z.object({
  factory: text(120).describe('фабрика'),
  model: text(200).describe('модель или серия'),
  analogFactory: text(120).describe('фабрика-аналог'),
  analogModel: text(200).describe('модель-аналог'),
  note: optText(300).describe('чем отличается'),
});

export const stoplistRowSchema = z.object({
  topic: text(120).describe('тема: сроки, сертификаты, монтаж, скидки…'),
  rule: text(500).describe('чего не обещаем и что писать вместо этого'),
  keywords: optText(300).describe('слова, по которым находить позицию или запрос; через запятую'),
});

/** Регламент — текст в Markdown с разделами «## Заголовок». */
export const b2bSchema = z.object({
  sections: z.array(z.object({ title: text(200), text: text(20_000) })).min(1).max(100),
});

export type DeliveryRow = z.infer<typeof deliveryRowSchema>;
export type InstallationRow = z.infer<typeof installationRowSchema>;
export type AnalogRow = z.infer<typeof analogRowSchema>;
export type StoplistRow = z.infer<typeof stoplistRowSchema>;
export type B2bData = z.infer<typeof b2bSchema>;

export interface KnowledgeData {
  delivery: DeliveryRow[];
  installation: InstallationRow[];
  b2b: B2bData;
  analogs: AnalogRow[];
  stoplist: StoplistRow[];
}

/** Колонки CSV по видам: ключ схемы → допустимые заголовки (в нижнем регистре), обязательна ли колонка, число ли. */
export interface ColumnSpec {
  key: string;
  aliases: string[];
  required: boolean;
  numeric?: boolean;
}

export const COLUMNS: Record<Exclude<KnowledgeKind, 'b2b'>, ColumnSpec[]> = {
  delivery: [
    { key: 'zone', aliases: ['зона', 'zone'], required: true },
    { key: 'description', aliases: ['описание', 'description'], required: false },
    { key: 'priceRub', aliases: ['цена', 'цена, ₽', 'цена руб', 'price'], required: true, numeric: true },
    { key: 'minOrderRub', aliases: ['бесплатно от', 'бесплатно от, ₽', 'min_order'], required: false, numeric: true },
    { key: 'note', aliases: ['примечание', 'note'], required: false },
  ],
  installation: [
    { key: 'service', aliases: ['услуга', 'service'], required: true },
    { key: 'unit', aliases: ['единица', 'ед.', 'unit'], required: true },
    { key: 'priceRub', aliases: ['цена', 'цена, ₽', 'цена руб', 'price'], required: true, numeric: true },
    { key: 'note', aliases: ['примечание', 'note'], required: false },
  ],
  analogs: [
    { key: 'factory', aliases: ['фабрика', 'factory'], required: true },
    { key: 'model', aliases: ['модель', 'model'], required: true },
    { key: 'analogFactory', aliases: ['фабрика-аналог', 'фабрика аналог', 'analog_factory'], required: true },
    { key: 'analogModel', aliases: ['модель-аналог', 'модель аналог', 'analog_model'], required: true },
    { key: 'note', aliases: ['отличия', 'примечание', 'note'], required: false },
  ],
  stoplist: [
    { key: 'topic', aliases: ['тема', 'topic'], required: true },
    { key: 'rule', aliases: ['правило', 'rule'], required: true },
    { key: 'keywords', aliases: ['ключевые слова', 'слова', 'keywords'], required: false },
  ],
};

export const ROW_SCHEMAS = {
  delivery: deliveryRowSchema,
  installation: installationRowSchema,
  analogs: analogRowSchema,
  stoplist: stoplistRowSchema,
} as const;
