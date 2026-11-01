import { z } from 'zod/v4';

/**
 * Структура разобранного документа. Для structured outputs все поля обязательны,
 * «неизвестно» — null. zod/v4 — ради toJSONSchema.
 */
const mm = z.number().nullable().describe('в миллиметрах; null, если в документе нет');

export const openingSchema = z.object({
  room: z.string().nullable().describe('помещение / место установки'),
  label: z.string().nullable().describe('номер или марка проёма в документе (Д-1, №3)'),
  width_mm: mm.describe('ширина проёма, мм'),
  height_mm: mm.describe('высота проёма, мм'),
  wall_mm: mm.describe('толщина стены, мм'),
  leaf_width_mm: mm.describe('ширина полотна, если замерщик указал'),
  qty: z.number().nullable().describe('количество таких проёмов'),
  double: z.boolean().nullable().describe('двупольная (двустворчатая) дверь'),
  side: z.enum(['left', 'right']).nullable().describe('сторона открывания'),
  note: z.string().nullable().describe('особенности: порог, доборы, наличники, стена и т. п.'),
});

export const positionSchema = z.object({
  name: z.string().describe('наименование позиции как в документе, коротко'),
  marking: z.string().nullable().describe('условное обозначение (ДВ 1 Рп 23,8х10 Г ПрБ, ДПС 01 EI30…), если есть'),
  width_mm: mm,
  height_mm: mm,
  qty: z.number().nullable(),
  unit: z.string().nullable().describe('шт., компл., м²'),
  price_rub: z.number().nullable().describe('цена за единицу, если указана в документе'),
  material: z.string().nullable().describe('дерево, МДФ, ПВХ, сталь, алюминий, CPL…'),
  color: z.string().nullable().describe('цвет / RAL'),
  fireproof: z.boolean().nullable(),
  note: z.string().nullable().describe('комплектация, фурнитура, требования'),
});

export const documentSchema = z.object({
  kind: z
    .enum(['measurement', 'request', 'estimate', 'catalog', 'photo', 'other'])
    .describe('measurement — замерный лист или отчёт о замере; request — запрос КП, тендер, спецификация, заявка клиента; estimate — смета, КП, накладная с ценами; catalog — рекламный материал; photo — фото без документа; other'),
  title: z.string().describe('название документа в 3–8 словах'),
  summary: z.string().describe('2–4 предложения для менеджера: что это, сколько дверей, что важно'),
  customer_type: z.enum(['b2c', 'b2b', 'unknown']).describe('b2b — организация, тендер, 44-ФЗ/223-ФЗ, реквизиты'),
  openings: z.array(openingSchema).describe('проёмы из замерного листа; для спецификаций — пусто'),
  positions: z.array(positionSchema).describe('позиции спецификации, запроса или сметы'),
  requirements: z.array(z.string()).describe('сроки, условия поставки, оплата, сертификаты, монтаж — как в документе'),
  questions: z.array(z.string()).describe('что нужно уточнить у клиента, чтобы посчитать'),
  photo: z
    .object({
      subject: z.string().describe('что на фото: дверь, проём, интерьер, документ'),
      door_type: z.string().nullable(),
      color: z.string().nullable(),
      style: z.string().nullable(),
      note: z.string().nullable(),
    })
    .nullable()
    .describe('только для фото двери/проёма/интерьера'),
});

export type DocumentData = z.infer<typeof documentSchema>;
export type Opening = z.infer<typeof openingSchema>;
export type Position = z.infer<typeof positionSchema>;

/** JSON Schema для output_config.format (без служебного $schema). */
export function documentJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(documentSchema, { target: 'draft-2020-12' }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}
