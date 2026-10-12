/**
 * Пометки ограничений расчёта цены (решения заказчика 12.10.2026, ТЗ этапа 9, раздел 6.1).
 *
 * Порога «мало источников — цену не ставить» нет: цена ставится и при одном источнике,
 * с пометкой «ограничение расчёта: N источник(ов)», пока источников меньше целевых 3–5.
 * Цена только по аналогу тоже ставится — с пометкой «предварительно, по аналогу».
 * Цена не ставится только когда источников нет совсем или поиск упал.
 */

/** Цель «по возможности 3–5 источников»: ниже — пометка, не блокировка. */
export const TARGET_SOURCES = 3;

export type PriceStatus = 'ok' | 'none' | 'failed';

export interface ResearchOutcome {
  /** Сколько подтверждённых предложений вошло в расчёт. */
  sources: number;
  /** Цена позиции посчитана по аналогу (точной модели не нашлось). */
  byAnalog?: boolean;
  /** Поиск завершился ошибкой — цена не ставится. */
  failed?: boolean;
}

/** Статус позиции: ok — цена ставится (возможно, с пометками); none — источников нет; failed — ошибка поиска. */
export function priceStatus(o: ResearchOutcome): PriceStatus {
  if (o.failed) return 'failed';
  return o.sources > 0 ? 'ok' : 'none';
}

const plural = (n: number, one: string, few: string, many: string) => {
  const a = n % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
};

/** Пометки для материалов расчёта и needs_manager; пустой список — ограничений нет. */
export function limitationNotes(o: ResearchOutcome): string[] {
  const notes: string[] = [];
  if (priceStatus(o) !== 'ok') return notes;
  if (o.sources < TARGET_SOURCES) notes.push(`ограничение расчёта: ${o.sources} ${plural(o.sources, 'источник', 'источника', 'источников')}`);
  if (o.byAnalog) notes.push('предварительно, по аналогу');
  return notes;
}
