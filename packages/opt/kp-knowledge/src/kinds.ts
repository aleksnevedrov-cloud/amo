/**
 * База знаний «Агента опт» (ТЗ разделение, раздел 9): пять справочников, отдельных от базы розницы.
 * Содержимое — справочные материалы (usage = reference), а не готовые блоки текста: блоки уже есть
 * в константах kp_settings и вставляются шаблоном kp.docx. Заполняет заказчик по шаблонам из templates/.
 */
export const KNOWLEDGE_KINDS = ['delivery', 'installation', 'b2b', 'analogs', 'stoplist'] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export type KnowledgeUsage = 'reference' | 'block';

export interface KindInfo {
  kind: KnowledgeKind;
  title: string;
  purpose: string;
  /** Файл шаблона в templates/ и ожидаемый формат. */
  template: string;
  format: 'csv' | 'markdown';
}

export const KINDS: Record<KnowledgeKind, KindInfo> = {
  delivery: { kind: 'delivery', title: 'Прайс на доставку по зонам', purpose: 'расчёт строки доставки под адрес', template: 'delivery.csv', format: 'csv' },
  installation: { kind: 'installation', title: 'Прайс на замер и монтаж', purpose: 'строки замера и монтажа в КП', template: 'installation.csv', format: 'csv' },
  b2b: { kind: 'b2b', title: 'Регламент работы с юрлицами и тендерами', purpose: 'формулировки под ТКП', template: 'b2b.md', format: 'markdown' },
  analogs: { kind: 'analogs', title: 'Замены и аналоги фабрик', purpose: 'подбор, когда точной модели нет', template: 'analogs.csv', format: 'csv' },
  stoplist: { kind: 'stoplist', title: 'Стоп-лист: что не поставляем и чего не обещаем', purpose: 'защита от вымысла', template: 'stoplist.csv', format: 'csv' },
};

export const isKnowledgeKind = (v: unknown): v is KnowledgeKind => typeof v === 'string' && (KNOWLEDGE_KINDS as readonly string[]).includes(v);
