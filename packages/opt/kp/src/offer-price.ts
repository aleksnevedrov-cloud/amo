import { VAT_ASSUMED_NOTE, type MarketResearchResult } from './market-research.ts';
import { limitationNotes, priceStatus, type PriceStatus } from './research-notes.ts';

/**
 * Цена предложения и НДС (RFD-AI-AGENT-OPT-PRICE, этап 4). Все суммы — в целых копейках,
 * округление один раз на последнем шаге.
 *
 * Цена предложения = медиана сопоставимых конечных розничных цен × коэффициент (по умолчанию 1,00 —
 * автоматической скидки нет; наценка на закупку не применяется: розничная цена — не наша закупка).
 * Коэффициент: позиция в черновике → производитель (справочник в настройках КП) → общий.
 * Доставка и монтаж в КП не считаются. НДС источников учтён на этапе 2 (judgeOffer): pre_net со
 * ставкой доначислен; НДС не указан — цена принята как конечная с НДС (5.1) с пометкой.
 * Цена предложения — уже конечная цена с нашим НДС (vatRate, по умолчанию 22): без НДС = конечная / 1,22,
 * НДС = конечная − без НДС; повторно увеличивать конечную цену на 22 % запрещено.
 */

/** Сумма в целых копейках. */
export type Kopecks = number;

export const DEFAULT_VAT_RATE = 22;
export const DEFAULT_COEFFICIENT = 1;

export const toKopecks = (rub: number): Kopecks => Math.round(rub * 100);
export const toRub = (k: Kopecks): number => k / 100;
/** «12 345,67 ₽» из копеек. */
export const formatKopecks = (k: Kopecks): string => `${(k / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;

export interface CoefficientSources {
  /** Коэффициент, заданный менеджером в строке черновика. */
  line?: number | null;
  /** Коэффициент производителя из справочника в настройках КП. */
  manufacturer?: number | null;
  /** Общий коэффициент из настроек КП. */
  general?: number | null;
}

const validCoefficient = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Коэффициент по приоритету: позиция → производитель → общий → 1,00. */
export function pickCoefficient(src: CoefficientSources = {}): { value: number; source: 'line' | 'manufacturer' | 'general' | 'default' } {
  if (validCoefficient(src.line)) return { value: src.line, source: 'line' };
  if (validCoefficient(src.manufacturer)) return { value: src.manufacturer, source: 'manufacturer' };
  if (validCoefficient(src.general)) return { value: src.general, source: 'general' };
  return { value: DEFAULT_COEFFICIENT, source: 'default' };
}

/** Коэффициент производителя из справочника настроек КП (ключ — название фабрики без учёта регистра). */
export function manufacturerCoefficient(factory: string | null | undefined, table: Record<string, number> | undefined): number | null {
  if (!factory || !table) return null;
  const want = factory.trim().toLowerCase().replace(/ё/g, 'е');
  for (const [name, value] of Object.entries(table)) {
    if (name.trim().toLowerCase().replace(/ё/g, 'е') === want) return validCoefficient(value) ? value : null;
  }
  return null;
}

export interface OfferPrice {
  status: PriceStatus;
  /** Цена предложения за единицу позиции, копейки; null — не ставится. */
  priceKopecks: Kopecks | null;
  /** То же в рублях с копейками — для строки черновика. */
  price: number | null;
  /** По медиане точной модели или по аналогу. */
  basis: 'median' | 'analog' | null;
  medianKopecks: Kopecks | null;
  /** Сколько подтверждённых предложений вошло в медиану. */
  sources: number;
  coefficient: { value: number; source: 'line' | 'manufacturer' | 'general' | 'default' };
  /** Пометки для needs_manager и материалов расчёта (ограничение расчёта, аналог по площади, НДС по умолчанию, причина отсутствия цены). */
  notes: string[];
  /** Формула расчёта строкой. */
  formula: string | null;
}

/** Цена предложения по результату исследования. */
export function offerPrice(research: MarketResearchResult, coefficient: CoefficientSources = {}): OfferPrice {
  const coef = pickCoefficient(coefficient);
  const sources = research.stats?.count ?? 0;
  const byAnalog = research.stats === null && research.analog !== null;
  const status = priceStatus({ sources: byAnalog ? 1 : sources, byAnalog, failed: research.status === 'failed' });
  const base: Omit<OfferPrice, 'priceKopecks' | 'price' | 'basis' | 'medianKopecks' | 'formula' | 'notes'> = { status, sources, coefficient: coef };

  if (research.status === 'failed') return { ...base, priceKopecks: null, price: null, basis: null, medianKopecks: null, formula: null, notes: [research.error ? research.error : 'ошибка поиска'] };
  if (research.stats) {
    const medianKopecks = toKopecks(research.stats.median);
    const priceKopecks = Math.round(medianKopecks * coef.value);
    const accepted = research.offers.filter((o) => o.accepted);
    const notes = limitationNotes({ sources });
    // Аналог по площади (5.1): пометка с размерами источников; НДС по умолчанию — если хоть у одного принятого НДС не был указан.
    if (research.areaScaled) notes.push(`аналог, пересчёт по площади с ${[...new Set(accepted.filter((o) => o.areaScaled).map((o) => o.sourceSize ?? '?'))].join(', ')}`);
    if (accepted.some((o) => o.vatAssumed)) notes.push(VAT_ASSUMED_NOTE);
    return {
      ...base,
      priceKopecks,
      price: toRub(priceKopecks),
      basis: research.areaScaled ? 'analog' : 'median',
      medianKopecks,
      formula: `медиана ${formatKopecks(medianKopecks)} (${sources} ${plural(sources, 'источник', 'источника', 'источников')}${research.areaScaled ? ', пересчёт по площади' : ''})${coef.value === 1 ? '' : ` × ${coef.value}`} = ${formatKopecks(priceKopecks)}`,
      notes,
    };
  }
  if (research.analog && research.analog.unitPrice !== null) {
    const baseKopecks = toKopecks(research.analog.unitPrice);
    const priceKopecks = Math.round(baseKopecks * coef.value);
    const reason = research.analog.suggestion.reason;
    return {
      ...base,
      priceKopecks,
      price: toRub(priceKopecks),
      basis: 'analog',
      medianKopecks: null,
      formula: `аналог ${formatKopecks(baseKopecks)}${coef.value === 1 ? '' : ` × ${coef.value}`} = ${formatKopecks(priceKopecks)}`,
      // Пометка аналога уже содержит «предварительно, по аналогу: фабрика, модель, источник; цена; совпадение» и «цена не сравнивалась».
      notes: [reason],
    };
  }
  return { ...base, status: 'none', priceKopecks: null, price: null, basis: null, medianKopecks: null, formula: null, notes: ['цены не найдены'] };
}

export interface VatSplit {
  /** Конечная цена с НДС. */
  grossKopecks: Kopecks;
  /** Цена без НДС = конечная / (1 + ставка). */
  netKopecks: Kopecks;
  /** НДС = конечная − без НДС. */
  vatKopecks: Kopecks;
  vatRate: number;
}

/**
 * НДС нашего КП из конечной цены: цена предложения уже включает НДС, выделяем его, а не начисляем сверху.
 * 10 000 ₽ при 22 % → без НДС 8 196,72 ₽, НДС 1 803,28 ₽, итого 10 000 ₽.
 */
export function splitVat(grossKopecks: Kopecks, vatRate = DEFAULT_VAT_RATE): VatSplit {
  const gross = Math.round(grossKopecks);
  if (!(vatRate > 0)) return { grossKopecks: gross, netKopecks: gross, vatKopecks: 0, vatRate: 0 };
  const netKopecks = Math.round(gross / (1 + vatRate / 100));
  return { grossKopecks: gross, netKopecks, vatKopecks: gross - netKopecks, vatRate };
}

/** Сумма строки КП в копейках: цена × количество × (1 − скидка), округление один раз. */
export function lineSumKopecks(l: { price: number | null; qty: number; discount: number }): Kopecks {
  if (l.price === null) return 0;
  return Math.round(toKopecks(l.price) * l.qty * (1 - l.discount / 100));
}

const plural = (n: number, one: string, few: string, many: string) => {
  const a = n % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
};
