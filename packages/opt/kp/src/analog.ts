/**
 * Подбор аналога по правилу (решения заказчика 12.10.2026, замена справочника «Замены и аналоги фабрик»).
 *
 * Источник кандидатов — интернет: сайты производителей в приоритете, маркетплейсы и агрегаторы —
 * только как дополнительные источники цены. Кандидатов находит поиск рыночных цен этапа 9
 * (web_search, docs/tz-kp-market-pricing.md); это правило — фильтр и ранжирование найденного.
 * Каталог розницы не используется.
 *
 * Критерии в порядке приоритета (заказчику порядок не принципиален, оставлен как есть):
 *   1. соответствие ГОСТ или техническим требованиям из заявки;
 *   2. соответствие дизайну (общие признаки: коллекция, покрытие, цвет, остекление);
 *   3. близость цены — не дальше допуска (по умолчанию ±10 %, задаётся в настройках КП).
 *
 * Цена аналога идёт в строку КП как предварительная — с пометкой «предварительно, по аналогу:
 * фабрика, модель, источник» в материалах расчёта и в needs_manager; если цена позиции посчитана
 * только по аналогам или по одному источнику — ещё пометка «ограничение расчёта» (research-notes.ts).
 * Саму цену строки считает расчёт этапа 9 (медиана × коэффициент); здесь — только выбор и пометки.
 *
 * Опорная цена для критерия «цена» (решение 12.10.2026, referencePrice): медиана по точной модели,
 * если она найдена; иначе цена, которую менеджер проставил в строке черновика; нет ни того,
 * ни другого — критерий пропускается, подбор только по ГОСТ и дизайну, в пометке «цена не сравнивалась».
 *
 * Вид источника определяет модель по домену и странице; домен из списка «Домены производителей»
 * в настройках КП всегда считается сайтом производителя (sourceKindOf).
 *
 * Доставка и монтаж в КП не считаются и не ставятся. Цена источника, в которую они включены,
 * в сравнение не берётся; вычитается только явно указанная у источника сумма.
 */

export type SourceKind = 'manufacturer' | 'retail' | 'marketplace' | 'aggregator';

/** Налоговый статус цены источника — как в ТЗ этапа 9, раздел 6.2. */
export type VatStated = 'included' | 'no_vat' | 'pre_net' | 'unknown';

export interface AnalogSource {
  url: string;
  /** Когда цена найдена. */
  foundAt: string;
  seller: string;
  kind: SourceKind;
  vatStated: VatStated;
}

export interface AnalogCandidate {
  id: string;
  name: string;
  vendor: string | null;
  /** Цена источника как найдена. */
  price: number | null;
  /** Признаки дизайна: коллекция, покрытие, цвет, остекление. */
  design: string[];
  /** Стандарты и техтребования, которым отвечает товар: ГОСТ, ТУ, класс. */
  standards: string[];
  /** Цена включает доставку или монтаж; null — у источника не сказано. */
  includesDelivery?: boolean | null;
  /** Сумма доставки/монтажа, явно указанная у источника; null — не указана. */
  deliveryRub?: number | null;
  /** Откуда взят кандидат; нет — источник неизвестен (ранжируется ниже сайтов производителей). */
  source?: AnalogSource | null;
}

/** Откуда взята опорная цена для критерия «цена». */
export type PriceBasis = 'exact_median' | 'manager';

export interface ReferencePrice {
  value: number;
  basis: PriceBasis;
}

export const PRICE_BASIS_TITLE: Record<PriceBasis, string> = {
  exact_median: 'медиана по точной модели',
  manager: 'цена менеджера в строке',
};

/**
 * Опорная цена по порядку заказчика: медиана по точной модели → цена менеджера → нет (критерий
 * пропускается). Нули и отрицательные значения считаются отсутствием цены.
 */
export function referencePrice(input: { exactMedian?: number | null; managerPrice?: number | null }): ReferencePrice | null {
  if (input.exactMedian !== null && input.exactMedian !== undefined && input.exactMedian > 0) return { value: input.exactMedian, basis: 'exact_median' };
  if (input.managerPrice !== null && input.managerPrice !== undefined && input.managerPrice > 0) return { value: input.managerPrice, basis: 'manager' };
  return null;
}

export interface AnalogRequest {
  name: string;
  raw: string;
  /** Опорная цена (referencePrice); null — критерий цены не применяется, в пометке «цена не сравнивалась». */
  price: ReferencePrice | null;
  /** ГОСТ, ТУ и прочие требования из заявки (письмо и разобранные спецификации). */
  requirements: string[];
}

export type AnalogCriterion = 'standard' | 'design' | 'price';

export interface AnalogOptions {
  /** Допуск по цене, доля: 0.1 — ±10 %. Больше MAX_PRICE_TOLERANCE не принимается. */
  priceTolerance?: number;
  /** Домены производителей из настроек КП: источник с таким доменом (или его поддоменом) — всегда сайт производителя. */
  manufacturerDomains?: string[];
}

export interface AnalogMatch {
  candidate: AnalogCandidate;
  /** Главный критерий (первый по приоритету из совпавших). */
  criterion: AnalogCriterion;
  /** Все совпавшие критерии — для материалов расчёта. */
  matched: AnalogCriterion[];
  /** Чем именно совпало: номер ГОСТ, общие признаки, разница в цене. */
  detail: string;
  /** Цена источника без доставки/монтажа; null — сравнивать нельзя. */
  comparablePrice: number | null;
  score: number;
}

export interface AnalogSuggestion extends AnalogMatch {
  /** Пометка для needs_manager и материалов расчёта. */
  reason: string;
}

export const CRITERION_TITLE: Record<AnalogCriterion, string> = {
  standard: 'по ГОСТ/техтребованиям',
  design: 'по дизайну',
  price: 'по цене',
};

/** Допуск по цене по умолчанию и его потолок: заказчик — не более ±10 %. */
export const DEFAULT_PRICE_TOLERANCE = 0.1;
export const MAX_PRICE_TOLERANCE = 0.1;

/** Приоритет источников: сайт производителя выше любого другого. */
const SOURCE_RANK: Record<SourceKind, number> = { manufacturer: 3, retail: 2, marketplace: 1, aggregator: 1 };

/** Домен в сравнимом виде: без схемы, пути, «www.» и регистра. */
export function normalizeDomain(s: string): string {
  let d = s.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, '').split('/')[0] ?? '';
  return d.replace(/^www\./, '');
}

/** Хост ссылки входит в список доменов производителей (точно или как поддомен). */
export function isManufacturerDomain(url: string, domains: string[] | undefined): boolean {
  if (!domains?.length) return false;
  const host = normalizeDomain(url);
  if (!host) return false;
  return domains.map(normalizeDomain).some((d) => d && (host === d || host.endsWith(`.${d}`)));
}

/** Вид источника: домен из списка производителей главнее оценки модели; без источника — агрегатор. */
export function sourceKindOf(source: AnalogSource | null | undefined, domains?: string[]): SourceKind {
  if (!source) return 'aggregator';
  return isManufacturerDomain(source.url, domains) ? 'manufacturer' : source.kind;
}

/** Слова, которые есть почти в каждой позиции и дизайн не описывают. */
const STOP_WORDS = new Set(['дверь', 'двери', 'дверей', 'дверное', 'полотно', 'полотна', 'блок', 'комплект', 'межкомнатная', 'межкомнатные', 'входная', 'входные', 'размер', 'штук']);

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

/** Признаки дизайна из текста: слова от 4 букв без чисел и общих слов. */
export function designTokens(text: string): string[] {
  const out = new Set<string>();
  for (const w of norm(text).split(/[^a-zа-я]+/)) {
    if (w.length >= 4 && !STOP_WORDS.has(w)) out.add(w);
  }
  return [...out];
}

/** Номер стандарта в сравнимом виде: «ГОСТ 475-2016», «ТУ 5361-001». */
const normStandard = (s: string) => norm(s).replace(/\s+/g, ' ').replace(/[–—]/g, '-').trim();

// \b перед кириллицей не работает (ASCII-граница слова): проверяем, что перед аббревиатурой нет буквы.
const STANDARD_RE = /(?<![a-zа-яё])(ГОСТ|ТУ|СТО|СНиП|СП)\s*Р?\s*\d+(?:[.\-–—]\d+)*/gi;

/** ГОСТ, ТУ и прочие стандарты, упомянутые в заявке. */
export function extractRequirements(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(STANDARD_RE)) out.add(m[0].toUpperCase().replace(/\s+/g, ' ').replace(/[–—]/g, '-').trim());
  return [...out];
}

/** Допуск из настроек: доля в [0; MAX], иначе значение по умолчанию. */
export function priceToleranceOf(opts?: AnalogOptions): number {
  const t = opts?.priceTolerance;
  if (t === undefined || !Number.isFinite(t) || t < 0) return DEFAULT_PRICE_TOLERANCE;
  return Math.min(t, MAX_PRICE_TOLERANCE);
}

/**
 * Цена кандидата для сравнения. Доставка и монтаж в КП не считаются: если они включены в цену
 * и сумма у источника не указана — цена несравнима (null); указана — вычитается.
 */
export function comparablePrice(c: AnalogCandidate): number | null {
  if (c.price === null) return null;
  if (!c.includesDelivery) return c.price;
  if (c.deliveryRub === null || c.deliveryRub === undefined) return null;
  return Math.max(c.price - c.deliveryRub, 0);
}

const money = (v: number) => `${Math.round(v).toLocaleString('ru-RU')} ₽`;

function matchOne(req: AnalogRequest, c: AnalogCandidate, reqTokens: string[], tolerance: number, domains: string[] | undefined): AnalogMatch | null {
  const matched: AnalogCriterion[] = [];
  const details: string[] = [];
  let score = 0;
  // 1. Стандарт: требование заявки встречается среди стандартов товара или в его названии.
  const haystack = [...c.standards, c.name].map(normStandard);
  const std = req.requirements.map(normStandard).find((r) => r && haystack.some((h) => h.includes(r)));
  if (std) {
    matched.push('standard');
    details.push(std.toUpperCase());
    score += 100;
  }
  // 2. Дизайн: общие признаки в описании товара и в позиции заявки.
  const cTokens = new Set(designTokens([...c.design, c.name].join(' ')));
  const shared = reqTokens.filter((t) => cTokens.has(t));
  if (shared.length) {
    matched.push('design');
    details.push(`общие признаки «${shared.join(', ')}»`);
    score += 10 + shared.length / 10;
  }
  // 3. Цена: в пределах допуска от цены заявки; цена с включённой доставкой без суммы не сравнивается.
  const price = comparablePrice(c);
  if (req.price !== null && price !== null) {
    const ratio = Math.abs(price - req.price.value) / req.price.value;
    if (ratio <= tolerance) {
      matched.push('price');
      details.push(`${money(price)} против ${money(req.price.value)} (±${Math.round(ratio * 100)} %, ${PRICE_BASIS_TITLE[req.price.basis]})`);
      score += 1 + (tolerance - ratio);
    }
  }
  if (!matched.length) return null;
  // Сайт производителя — выше при равных критериях (веса критериев 100 / 10 / 1 не дают источнику их перебить).
  score += SOURCE_RANK[sourceKindOf(c.source, domains)] / 10;
  return { candidate: c, criterion: matched[0] ?? 'price', matched, detail: details.join('; '), comparablePrice: price, score };
}

/** Все подходящие кандидаты, лучшие первыми: по критериям, затем сайт производителя выше остальных. */
export function rankAnalogs(req: AnalogRequest, candidates: AnalogCandidate[], opts?: AnalogOptions): AnalogMatch[] {
  const tolerance = priceToleranceOf(opts);
  const reqTokens = designTokens(`${req.name} ${req.raw}`);
  return candidates
    .map((c) => matchOne(req, c, reqTokens, tolerance, opts?.manufacturerDomains))
    .filter((m): m is AnalogMatch => m !== null)
    .sort((a, b) => b.score - a.score);
}

/**
 * Лучший аналог или null; пометка — «предварительно, по аналогу: фабрика, модель, источник; цена;
 * совпадение …». Без опорной цены — «цена не сравнивалась».
 */
export function suggestAnalog(req: AnalogRequest, candidates: AnalogCandidate[], opts?: AnalogOptions): AnalogSuggestion | null {
  const best = rankAnalogs(req, candidates, opts)[0];
  if (!best) return null;
  const c = best.candidate;
  const title = [c.vendor, c.name].filter(Boolean).join(' ');
  const source = c.source ? `${c.source.seller}, ${c.source.url}` : 'источник не указан';
  const price = best.comparablePrice === null ? 'цена для сравнения не определена' : money(best.comparablePrice);
  const criteria = best.matched.map((m) => CRITERION_TITLE[m]).join(', ');
  const noPrice = req.price === null ? '; цена не сравнивалась' : '';
  return { ...best, reason: `предварительно, по аналогу: ${title}, ${source}; ${price}; совпадение ${criteria} (${best.detail})${noPrice}` };
}
