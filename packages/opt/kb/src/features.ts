/**
 * Признаки двери (RFD-AI-AGENT-OPT-KB-MATCH): подбор цены идёт по смыслу позиции, а не по строке названия.
 * Признаки извлекаются кодом из текста заявки и из колонок прайса («Модель», «Сокращение», «Г/О», «Покрытие»,
 * «Материал», «Конструкция», «Назначение», «Огнестойкость»), модель разбора письма может дополнить их явно.
 * Обязательные для совпадения: тип, материал, глухая/остеклённая, покрытие, огнестойкость (если известны с обеих
 * сторон и различаются — строка не подходит); остальные повышают балл.
 */
export type DoorType = 'block' | 'leaf';
export type DoorMaterial = 'wood' | 'steel' | 'aluminium' | 'plastic';
export type DoorGlazing = 'solid' | 'glazed';
export type DoorThreshold = 'with' | 'without';
export type DoorOpening = 'swing' | 'sliding';
export type DoorCoating = 'cpl' | 'pvc' | 'enamel' | 'veneer' | 'ecoveneer' | 'laminate' | 'hpl' | 'melamine';
export type DoorFire = 'EI30' | 'EI60' | 'EI90' | 'yes';

export interface DoorFeatures {
  type: DoorType | null;
  material: DoorMaterial | null;
  glazing: DoorGlazing | null;
  leaves: 1 | 2 | null;
  threshold: DoorThreshold | null;
  opening: DoorOpening | null;
  coating: DoorCoating | null;
  fire: DoorFire | null;
  closer: boolean | null;
  lock: boolean | null;
}

export type FeatureKey = keyof DoorFeatures;
export const FEATURE_KEYS: FeatureKey[] = ['type', 'material', 'glazing', 'leaves', 'threshold', 'opening', 'coating', 'fire', 'closer', 'lock'];
/** Обязательные признаки: расхождение с обеих сторон известных значений отвергает строку прайса. */
export const MANDATORY_FEATURES: FeatureKey[] = ['type', 'material', 'glazing', 'coating', 'fire'];

export const EMPTY_FEATURES: DoorFeatures = { type: null, material: null, glazing: null, leaves: null, threshold: null, opening: null, coating: null, fire: null, closer: null, lock: null };

const norm = (s: string) => ` ${s.toLowerCase().replace(/ё/g, 'е').replace(/[«»"'()[\],;:/\\|—–+=#№%]+/g, ' ').replace(/\s+/g, ' ').trim()} `;

/** Признаки из свободного текста: название позиции в письме, строка прайса, сокращение по ГОСТ («ДВ 1Рп Г ПрБ», «ДПГ», «ДПО»). */
export function featuresOf(text: string | null | undefined): DoorFeatures {
  const f: DoorFeatures = { ...EMPTY_FEATURES };
  if (!text) return f;
  const t = norm(text);
  // Тип: дверной блок (или «блок дверной», ДБ; по ГОСТ 475-2016 «ДВ …» / «ДН …» — блок внутренний / наружный) /
  // полотно (ДПГ, ДПО — дверное полотно глухое/остеклённое).
  if (/дверн\w* блок|блок дверн|\sдб\s|\sдб-|\sблок\s|\sд[вн]\s|\sд[вн]\d/.test(t)) f.type = 'block';
  else if (/полотн|\sдп[го]\s|\sдп[го]\d|\sдп\s/.test(t)) f.type = 'leaf';
  // Материал.
  if (/деревян|массив|\sдерев|шпонирован|мдф/.test(t)) f.material = 'wood';
  else if (/стальн|\sсталь\s|металлич|\sметалл\s|железн/.test(t)) f.material = 'steel';
  else if (/алюмин/.test(t)) f.material = 'aluminium';
  else if (/пластик/.test(t)) f.material = 'plastic';
  // Глухая / остеклённая: слова, буквы Г/О в сокращении, ДПГ/ДПО.
  if (/глух|\sдпг|(^|\s)г(\s|$)/.test(t)) f.glazing = 'solid';
  else if (/остекл|со стекл|\sстекл|\sдпо|(^|\s)о(\s|$)/.test(t)) f.glazing = 'glazed';
  // Створки.
  if (/двупольн|двухпольн|двустворч|двухстворч|\s2[- ]?польн|\s2р?п\s|\s2р?п-|\s2 рп\s/.test(t)) f.leaves = 2;
  else if (/однопольн|одностворч|\s1[- ]?польн|\s1р?п\s|\s1р?п-|\s1 рп\s/.test(t)) f.leaves = 1;
  // Порог.
  if (/без\s*порог|\sб\/п\s|\sпрб\s|беспорог/.test(t)) f.threshold = 'without';
  else if (/с\s*порог|(?<!авто)порог/.test(t)) f.threshold = 'with';
  // Открывание.
  if (/раздвиж|откатн|\sкупе\s|сдвижн/.test(t)) f.opening = 'sliding';
  else if (/распашн|\sрп\s|\s[12]рп\s|\s[12]рп-/.test(t)) f.opening = 'swing';
  // Покрытие (экошпон раньше шпона, чтобы не спутать).
  if (/экошпон|eco\s?veneer|\sэко\s/.test(t)) f.coating = 'ecoveneer';
  else if (/\scpl|\sцпл\s|cpl/.test(t)) f.coating = 'cpl';
  else if (/\shpl|hpl/.test(t)) f.coating = 'hpl';
  else if (/\sпвх|pvc|\sпвх/.test(t)) f.coating = 'pvc';
  else if (/эмал/.test(t)) f.coating = 'enamel';
  else if (/шпон/.test(t)) f.coating = 'veneer';
  else if (/ламинат|ламинир/.test(t)) f.coating = 'laminate';
  else if (/меламин/.test(t)) f.coating = 'melamine';
  // Огнестойкость.
  const ei = /\sei\s?-?\s?(30|60|90)|ei(30|60|90)/.exec(t);
  if (ei) f.fire = `EI${ei[1] ?? ei[2]}` as DoorFire;
  else if (/противопожар|огнестойк|\sдпм|\sдпс\s/.test(t)) f.fire = 'yes';
  if (/доводчик/.test(t)) f.closer = true;
  if (/замк|замок/.test(t)) f.lock = true;
  return f;
}

/** Колонки прайса: «Г/О» — одна буква; покрытие, материал, конструкция, назначение, огнестойкость — текст. */
export function featuresFromColumns(c: { go?: string | null; coating?: string | null; material?: string | null; construction?: string | null; purpose?: string | null; fire?: string | null }): DoorFeatures {
  const f = featuresOf([c.coating, c.material, c.construction, c.purpose, c.fire].filter(Boolean).join(' | '));
  const go = (c.go ?? '').trim().toLowerCase().replace(/ё/g, 'е');
  if (go === 'г' || go.startsWith('глух')) f.glazing = 'solid';
  else if (go === 'о' || go.startsWith('остекл')) f.glazing = 'glazed';
  if (c.coating) {
    const only = featuresOf(c.coating).coating;
    if (only) f.coating = only;
  }
  if (c.material) {
    const only = featuresOf(c.material).material;
    if (only) f.material = only;
  }
  if (c.fire) {
    const only = featuresOf(c.fire).fire;
    if (only) f.fire = only;
    else if (/нет|без|-/.test(c.fire.toLowerCase())) f.fire = null;
  }
  return f;
}

/** Слияние: явные значения (из колонок или от модели) перекрывают извлечённые из текста. */
export function mergeFeatures(base: DoorFeatures, over: Partial<DoorFeatures> | null | undefined): DoorFeatures {
  const out = { ...base };
  if (!over) return out;
  for (const k of FEATURE_KEYS) {
    const v = over[k];
    if (v !== null && v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Ответ модели разбора письма → признаки: значения словами («деревянный», «глухая», «CPL») или кодами. */
export function featuresFromModel(raw: unknown): Partial<DoorFeatures> | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const text = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : typeof o[k] === 'number' ? String(o[k]) : '');
  const parsed = featuresOf(FEATURE_KEYS.map((k) => text(k)).join(' | '));
  const out: Partial<DoorFeatures> = {};
  const codes: Record<string, string[]> = { type: ['block', 'leaf'], material: ['wood', 'steel', 'aluminium', 'plastic'], glazing: ['solid', 'glazed'], threshold: ['with', 'without'], opening: ['swing', 'sliding'], coating: ['cpl', 'pvc', 'enamel', 'veneer', 'ecoveneer', 'laminate', 'hpl', 'melamine'], fire: ['EI30', 'EI60', 'EI90', 'yes'] };
  for (const k of FEATURE_KEYS) {
    const v = o[k];
    if (k === 'leaves') {
      if (v === 1 || v === 2 || v === '1' || v === '2') out.leaves = Number(v) as 1 | 2;
      else if (parsed.leaves) out.leaves = parsed.leaves;
      continue;
    }
    if (k === 'closer' || k === 'lock') {
      if (typeof v === 'boolean') out[k] = v;
      continue;
    }
    if (typeof v === 'string' && codes[k]?.includes(v)) (out as Record<string, unknown>)[k] = v;
    else if (typeof v === 'string' && v.trim()) {
      const p = featuresOf(v)[k];
      if (p !== null) (out as Record<string, unknown>)[k] = p;
    }
  }
  return Object.keys(out).length ? out : null;
}

/** Есть ли хоть один известный признак. */
export const hasFeatures = (f: DoorFeatures | null | undefined): boolean => Boolean(f) && FEATURE_KEYS.some((k) => (f as DoorFeatures)[k] !== null && (f as DoorFeatures)[k] !== undefined);

/** Ключ группы по обязательным признакам («block|wood|solid|cpl|*») — для медианы прайса по группе; «*» — неизвестно. */
export function featureKeyOf(f: DoorFeatures | null | undefined): string {
  return MANDATORY_FEATURES.map((k) => (f && f[k] !== null && f[k] !== undefined ? String(f[k]) : '*')).join('|');
}

/** Ключи групп совместимы: по каждому обязательному признаку значения равны или одно из них неизвестно. */
export function keysCompatible(a: string, b: string): boolean {
  const x = a.split('|');
  const y = b.split('|');
  return x.length === y.length && x.every((v, i) => v === '*' || y[i] === '*' || v === y[i]);
}

export interface FeatureMatch {
  ok: boolean;
  /** Совпавшие признаки (известны с обеих сторон и равны). */
  matched: FeatureKey[];
  /** Расхождения по необязательным признакам (штраф к баллу). */
  mismatched: FeatureKey[];
  /** Расхождение по обязательному признаку — строка отвергнута. */
  conflict: FeatureKey | null;
  score: number;
}

/** Минимум совпавших признаков, чтобы строка прайса считалась подходящей по смыслу. */
export const MIN_MATCHED_FEATURES = 2;

/** Совпадение признаков позиции и строки прайса: обязательные не должны расходиться, остальные дают балл. */
export function matchFeatures(q: DoorFeatures, r: DoorFeatures): FeatureMatch {
  const matched: FeatureKey[] = [];
  const mismatched: FeatureKey[] = [];
  let conflict: FeatureKey | null = null;
  for (const k of FEATURE_KEYS) {
    const a = q[k];
    const b = r[k];
    if (a === null || a === undefined || b === null || b === undefined) continue;
    if (a === b) matched.push(k);
    else if (MANDATORY_FEATURES.includes(k)) {
      conflict = k;
      break;
    } else mismatched.push(k);
  }
  const mandatoryMatched = matched.some((k) => MANDATORY_FEATURES.includes(k));
  const score = matched.length - mismatched.length;
  return { ok: conflict === null && matched.length >= MIN_MATCHED_FEATURES && mandatoryMatched, matched, mismatched, conflict, score };
}

const WORDS: Record<FeatureKey, (v: unknown) => string> = {
  type: (v) => (v === 'block' ? 'дверной блок' : 'полотно'),
  material: (v) => ({ wood: 'деревянный', steel: 'стальной', aluminium: 'алюминиевый', plastic: 'пластиковый' })[String(v)] ?? String(v),
  glazing: (v) => (v === 'solid' ? 'глухой' : 'остеклённый'),
  leaves: (v) => (v === 2 ? 'двупольный' : 'однопольный'),
  threshold: (v) => (v === 'without' ? 'без порога' : 'с порогом'),
  opening: (v) => (v === 'sliding' ? 'раздвижной' : 'распашной'),
  coating: (v) => ({ cpl: 'CPL', pvc: 'ПВХ', enamel: 'эмаль', veneer: 'шпон', ecoveneer: 'экошпон', laminate: 'ламинат', hpl: 'HPL', melamine: 'меламин' })[String(v)] ?? String(v),
  fire: (v) => (v === 'yes' ? 'противопожарный' : String(v)),
  closer: () => 'с доводчиком',
  lock: () => 'с замком',
};

/** Признаки словами для менеджера: «деревянный, глухой, однопольный, без порога, CPL». */
export function describeFeatures(f: DoorFeatures, keys: FeatureKey[] = FEATURE_KEYS): string {
  return keys
    .filter((k) => f[k] !== null && f[k] !== undefined && f[k] !== false)
    .map((k) => WORDS[k](f[k]))
    .join(', ');
}

/** Веб-цена реалистична, если в пределах 40 %–300 % медианы прайса по той же группе признаков. */
export const WEB_BAND = { min: 0.4, max: 3 } as const;
export const webPriceRealistic = (price: number, median: number | null): boolean => median === null || median <= 0 || (price >= median * WEB_BAND.min && price <= median * WEB_BAND.max);

/** Медиана цен прайса по группе признаков запроса (совместимые ключи); null — в прайсе нет такой группы. */
export function priceListMedian(rows: { featureKey: string | null; price: number }[], queryKey: string): number | null {
  if (queryKey.split('|').every((v) => v === '*')) return null;
  const prices = rows.filter((r) => r.featureKey && keysCompatible(r.featureKey, queryKey)).map((r) => r.price).sort((a, b) => a - b);
  if (!prices.length) return null;
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 ? (prices[mid] as number) : ((prices[mid - 1] as number) + (prices[mid] as number)) / 2;
}
