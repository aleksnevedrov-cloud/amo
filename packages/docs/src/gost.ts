/**
 * Разбор условных обозначений дверных блоков из спецификаций и тендеров
 * (ГОСТ 475-2016, 6629-88, 24698-81, 31173-2016, 53307/Р 57327 для противопожарных).
 * Расшифровываем только то, что однозначно; остальное остаётся в `unknown`.
 */
export interface DoorMarking {
  raw: string;
  /** дверь деревянная/алюминиевая/стальная/противопожарная и т. п. */
  material?: 'wood' | 'aluminium' | 'steel' | 'pvc' | 'unknown';
  location?: 'interior' | 'exterior';
  fireproof?: boolean;
  fireRating?: string;
  /** Г — глухая, О — остеклённая. */
  glazing?: 'solid' | 'glazed';
  opening?: 'swing' | 'sliding' | 'folding' | 'pendulum';
  side?: 'left' | 'right';
  threshold?: boolean;
  height_mm?: number;
  width_mm?: number;
  /** Размер проёма, если в строке указан отдельно. */
  opening_height_mm?: number;
  opening_width_mm?: number;
  /** Однопольная / двупольная. */
  leaves?: 1 | 2;
  unknown: string[];
}

const TYPE_CODES: Record<string, Partial<DoorMarking>> = {
  ДВ: { material: 'wood', location: 'interior' },
  ДН: { material: 'wood', location: 'exterior' },
  ДГ: { material: 'wood', glazing: 'solid' },
  ДО: { material: 'wood', glazing: 'glazed' },
  ДУ: { material: 'wood' },
  ДК: { material: 'wood', opening: 'pendulum' },
  ДАВ: { material: 'aluminium', location: 'interior' },
  ДАН: { material: 'aluminium', location: 'exterior' },
  ДСВ: { material: 'steel', location: 'interior' },
  ДСН: { material: 'steel', location: 'exterior' },
  ДПС: { material: 'steel', fireproof: true },
  ДПМ: { material: 'steel', fireproof: true },
  ДПД: { material: 'wood', fireproof: true },
  ДП: { fireproof: true },
  ДВП: { material: 'wood', location: 'interior', fireproof: true },
  ДПВ: { material: 'pvc' },
};

const SIZE = /(\d{1,2}(?:[.,]\d)?)\s*[xх×*-]\s*(\d{1,2}(?:[.,]\d)?)(?![\d])/u;
const SIZE_MM = /(\d{3,4})\s*[xхXХ×*]\s*(\d{3,4})/u;

/** Похоже ли на маркировку ГОСТ (чтобы не разбирать любую строку). */
export function looksLikeMarking(s: string): boolean {
  return /^\s*Д[А-Я]{1,2}(?!\p{L})/u.test(s) || /ГОСТ\s*\d/u.test(s) || /(?<!\p{L})EI\s?\d{2,3}(?!\d)/u.test(s);
}

export function decodeMarking(raw: string): DoorMarking {
  const m: DoorMarking = { raw: raw.trim(), unknown: [] };
  const text = raw.replace(/\s*\/?\s*ГОСТ.*$/iu, '').replace(/[,;]+$/, '');
  const tokens = text.split(/\s+/).filter(Boolean);
  let sizeSeen = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    const up = t.toUpperCase().replace(/[.,;]+$/, '');
    if (i === 0 && TYPE_CODES[up]) {
      Object.assign(m, TYPE_CODES[up]);
      continue;
    }
    const ei = up.match(/^EI(?:S|W)?\s?(\d{2,3})$/) ?? (up === 'EI' && /^\d{2,3}$/.test(tokens[i + 1] ?? '') ? [null, tokens[++i]] : null);
    if (ei) {
      m.fireproof = true;
      m.fireRating = `EI${ei[1]}`;
      continue;
    }
    if (/^(РП|РАСП\.?|РАСПАШНАЯ)$/u.test(up)) {
      m.opening = 'swing';
      continue;
    }
    if (/^(РЛ)$/u.test(up)) {
      // Встречается как «Рл» — распашная левая.
      m.opening = 'swing';
      m.side = 'left';
      continue;
    }
    if (/^(РЗ|РАЗДВ\.?|РАЗДВИЖНАЯ)$/u.test(up)) {
      m.opening = 'sliding';
      continue;
    }
    if (/^(СК|СКЛАДНАЯ)$/u.test(up)) {
      m.opening = 'folding';
      continue;
    }
    if (/^(КЧ|КАЧАЮЩАЯСЯ)$/u.test(up)) {
      m.opening = 'pendulum';
      continue;
    }
    if (up === 'Г' || up === 'ГЛУХАЯ') {
      m.glazing = 'solid';
      continue;
    }
    if (up === 'О' || up === 'ОСТ' || up === 'ОСТЕКЛЁННАЯ' || up === 'ОСТЕКЛЕННАЯ') {
      m.glazing = 'glazed';
      continue;
    }
    if (/^(Л|ЛЕВ\.?|ЛЕВАЯ|ЛЕВОЕ)$/u.test(up)) {
      m.side = 'left';
      continue;
    }
    if (/^(ПР|ПРАВ\.?|ПРАВАЯ|ПРАВОЕ)$/u.test(up)) {
      m.side = 'right';
      continue;
    }
    // ПрБ / ЛБ — правая/левая без порога (Б — без порога, П — с порогом).
    const sideThreshold = up.match(/^(ПР|Л)(Б|П)$/u);
    if (sideThreshold) {
      m.side = sideThreshold[1] === 'Л' ? 'left' : 'right';
      m.threshold = sideThreshold[2] === 'П';
      continue;
    }
    // Бпр — без порога, Прг — с порогом (стальные и алюминиевые блоки).
    if (up === 'БПР') {
      m.threshold = false;
      continue;
    }
    if (up === 'ПРГ') {
      m.threshold = true;
      continue;
    }
    if (up === 'ОП' || up === 'ОДНОПОЛЬНАЯ') {
      m.leaves = 1;
      continue;
    }
    if (up === 'ДП' || up === 'ДВУПОЛЬНАЯ' || up === 'ДВУХПОЛЬНАЯ') {
      m.leaves = 2;
      continue;
    }
    // Размер в дециметрах: 21-9, 23,8х10, 2З,8х10 (OCR путает 3 и З).
    const fixed = t.replace(/З/gu, '3').replace(/О/gu, '0');
    const joined = i + 2 < tokens.length && /^[xх×*]$/u.test(tokens[i + 1] ?? '') ? `${fixed}${tokens[i + 1]}${tokens[i + 2]}` : fixed;
    const mm = joined.match(SIZE_MM);
    if (mm && sizeSeen && !m.opening_height_mm) {
      // Второй размер в строке — обычно проём.
      const [a, b] = [Number(mm[1]), Number(mm[2])];
      m.opening_height_mm = Math.max(a, b);
      m.opening_width_mm = Math.min(a, b);
      if (joined !== fixed) i += 2;
      continue;
    }
    if (mm && !sizeSeen) {
      m.height_mm = Number(mm[1]);
      m.width_mm = Number(mm[2]);
      sizeSeen = true;
      if (joined !== fixed) i += 2;
      continue;
    }
    const dm = joined.match(SIZE);
    if (dm && !sizeSeen) {
      m.height_mm = Math.round(Number((dm[1] as string).replace(',', '.')) * 100);
      m.width_mm = Math.round(Number((dm[2] as string).replace(',', '.')) * 100);
      sizeSeen = true;
      if (joined !== fixed) i += 2;
      continue;
    }
    if (/^\d{1,2}$/.test(up) && i === 1) continue; // номер типа (ДВ 1 …)
    m.unknown.push(t);
  }
  if (m.height_mm && m.width_mm && m.height_mm < m.width_mm) [m.height_mm, m.width_mm] = [m.width_mm, m.height_mm];
  if (m.width_mm && m.width_mm >= 1200 && !m.leaves) m.leaves = 2;
  return m;
}

export function markingToText(m: DoorMarking): string {
  const parts: string[] = [];
  parts.push(
    {
      wood: 'деревянная',
      aluminium: 'алюминиевая',
      steel: 'стальная',
      pvc: 'ПВХ',
      unknown: '',
    }[m.material ?? 'unknown'],
  );
  if (m.location) parts.push(m.location === 'interior' ? 'внутренняя' : 'наружная');
  if (m.fireproof) parts.push(`противопожарная${m.fireRating ? ` ${m.fireRating}` : ''}`);
  if (m.glazing) parts.push(m.glazing === 'solid' ? 'глухая' : 'остеклённая');
  if (m.opening) parts.push({ swing: 'распашная', sliding: 'раздвижная', folding: 'складная', pendulum: 'качающаяся' }[m.opening]);
  if (m.leaves) parts.push(m.leaves === 1 ? 'однопольная' : 'двупольная');
  if (m.height_mm && m.width_mm) parts.push(`${m.height_mm}×${m.width_mm} мм (В×Ш)`);
  if (m.opening_height_mm && m.opening_width_mm) parts.push(`проём ${m.opening_height_mm}×${m.opening_width_mm} мм`);
  if (m.side) parts.push(m.side === 'left' ? 'левая' : 'правая');
  if (m.threshold !== undefined) parts.push(m.threshold ? 'с порогом' : 'без порога');
  const text = parts.filter(Boolean).join(', ');
  return m.unknown.length ? `${text}; не расшифровано: ${m.unknown.join(' ')}` : text;
}

/** Ищет маркировки в тексте документа. */
export function findMarkings(text: string, limit = 50): DoorMarking[] {
  const out = new Map<string, DoorMarking>();
  const re = /(?<!\p{L})Д(?:АВ|АН|СВ|СН|ПС|ПМ|ПД|ВП|ПВ|БВ|[ВНГОУКП])(?!\p{L})[^\n\t;]{0,60}/gu;
  for (const line of text.split('\n')) {
    for (const cell of line.split('\t')) {
      const m = cell.match(re);
      if (!m) continue;
      for (const raw of m) {
        const d = decodeMarking(raw);
        // Бесполезно без хоть какого-то признака.
        if (!d.material && !d.fireproof && !d.height_mm) continue;
        const key = d.raw.toLowerCase();
        if (!out.has(key)) out.set(key, d);
        if (out.size >= limit) return [...out.values()];
      }
    }
  }
  return [...out.values()];
}
