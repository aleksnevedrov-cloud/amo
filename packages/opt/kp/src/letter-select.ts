import type { KpRequestItem } from './draft.ts';

/**
 * Письмо задаёт объём (KP-LETTER-SCOPE, сделка 89518): «нужны двери ДНО-1 — 1 шт; ДНО-2 — 1 шт; ДНО-3 — 1 шт» при вложенном
 * проекте на 23 позиции. Позиции черновика — только названные в письме марки (или номера позиций «позиции 3, 5, 7»);
 * данные (размер, тип, остекление, открывание) — из вложений по марке. Одна марка в нескольких документах проекта (ведомость
 * дверей и план заполнения проёмов) — одна позиция с полным размером. Остальные строки проекта — «Ещё в проекте» с кнопкой
 * «добавить», в черновик не идут. Требования письма (каркас, филёнка, фурнитура, доставка, установка) — в характеристики
 * выбранных позиций и в требования заявки.
 */

/** Позиция проекта из файла: номер файла и номер строки в нём (1-based). */
export interface DocItem {
  item: KpRequestItem;
  file: number;
  no: number;
}

/** Слова, похожие на марку, но марками не являющиеся: стандарты, классы, прочность. */
const NOT_MARK = new Set(['ГОСТ', 'ТУ', 'СП', 'СНИП', 'EI', 'ЕI', 'ЕИ', 'EIW', 'М', 'МД', 'RAL', 'ПВХ', 'МДФ', 'ДПК', 'CPL', 'HPL', 'НПБ', 'РД', 'ИСО', 'ISO', 'СТО', 'ВСН', 'ПОЗ', 'П', 'Р']);
/** Латинские буквы, похожие на кириллицу: «ДHO-1» и «ДНО-1» — одна марка. */
const LATIN: Record<string, string> = { A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У' };
// Марка проекта — буквы и номер через дефис или слитно («ДНО-1», «Д12», «ОК-3а»). Через пробел и с ведущим нулём — это вид
// изделия по ГОСТ («ДПС 01», «ДВ 1Рп»), а не марка.
const MARK_RX = /(?<![А-ЯЁA-Zа-яёa-z0-9])([А-ЯЁA-Z]{1,4})[-‐–]?([1-9]\d{0,2})([а-яa-z])?(?![0-9]|[.,]\d|[а-яёa-z]{2})/giu;

/** Марка в каноническом виде: «ДНО-1», «дно 1», «ДHO1» → «ДНО1». */
export function normMark(letters: string, digits: string, suffix = ''): string {
  const l = letters.toUpperCase().replace(/Ё/g, 'Е').replace(/[A-Z]/g, (c) => LATIN[c] ?? c);
  return `${l}${Number(digits)}${suffix.toLowerCase()}`;
}

/** Все марки в тексте (по порядку, без повторов) с позицией вхождения. */
export function marksIn(text: string): { mark: string; at: number; end: number }[] {
  const out: { mark: string; at: number; end: number }[] = [];
  for (const m of text.matchAll(MARK_RX)) {
    const letters = (m[1] as string).toUpperCase();
    if (NOT_MARK.has(letters) || NOT_MARK.has(normMark(letters, '0').replace(/0$/, ''))) continue;
    const mark = normMark(m[1] as string, m[2] as string, m[3] ?? '');
    if (!out.some((x) => x.mark === mark)) out.push({ mark, at: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

/** Марка строки проекта: колонка «Марка / Обозначение / Поз.» → маркировка → название, если начинается с марки. */
export function markOf(p: { marking?: string | null; name: string; note?: string | null }): string | null {
  const labelled = /(?:^|;\s*)(?:марка|обозначение|поз(?:иция)?\.?|№ по плану)[^:;]{0,20}:\s*([^;]+)/i.exec(p.note ?? '');
  for (const text of [labelled?.[1] ?? '', p.marking ?? '']) {
    const m = marksIn(text)[0];
    if (m) return m.mark;
  }
  const head = marksIn(p.name)[0];
  return head && head.at <= 2 ? head.mark : null;
}

/** Номера позиций из письма: «позиции 3, 5, 7», «поз. 3–5 и 8», «пп. 2, 4». */
export function positionNumbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(?:позици[яиюей]|поз\.|пп?\.)\s*(?:№\s*)?((?:\d{1,3}(?:\s*[-–]\s*\d{1,3})?(?:\s*(?:,|и)\s*)?)+)/giu)) {
    for (const part of (m[1] as string).split(/\s*(?:,|и)\s*/)) {
      const r = /^(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?$/.exec(part.trim());
      if (!r) continue;
      const a = Number(r[1]);
      const b = r[2] ? Number(r[2]) : a;
      for (let n = Math.min(a, b); n <= Math.max(a, b) && n - Math.min(a, b) < 200; n += 1) if (!out.includes(n)) out.push(n);
    }
  }
  return out;
}

/** Количество сразу после марки в письме: «ДНО-1 — 1 шт», «ДНО-2 (2 шт.)», «ДНО-3: 3 компл.». */
function qtyAfter(text: string, end: number): number | null {
  const m = /^[\s—–\-:(]*(\d{1,4})\s*(?:шт|штук|ед|компл|к-т)/iu.exec(text.slice(end, end + 30));
  return m ? Number(m[1]) : null;
}

const KEEP = /каркас|филен|ламинац|шпон|покрыт|отделк|цвет|окрас|остеклен|стекл|материал|металл|сталь|дерев|массив|утепл|фурнитур|замок|ручк|петл|порог|доводчик|глазок|цена\s/iu;
const SERVICE = /доставк|установк|монтаж|демонтаж|подъ[её]м|разгрузк/iu;

/**
 * Требования письма — фразы о материале, отделке, фурнитуре, доставке и установке («каркас металлический», «филёнка дуб /
 * ламинация под дуб», «цена изделие+фурнитура»). product — к характеристикам выбранных позиций, all — в требования заявки.
 */
export function letterSpecs(text: string, marks: string[] = []): { product: string[]; all: string[] } {
  const product: string[] = [];
  const all: string[] = [];
  const clauses = text
    .replace(/\r/g, '')
    .split(/\n|;|\.\s|,\s(?=[а-яёa-z])/u)
    .map((c) => c.replace(/\s+/g, ' ').replace(/^[\s,.:—–-]+|[\s,.:—–-]+$/g, '').trim())
    .filter((c) => c.length >= 4 && c.length <= 160);
  for (const c of clauses) {
    // Строки с марками («ДНО-1 — 1 шт») и приветствия — не требования.
    if (marksIn(c).some((m) => marks.includes(m.mark)) || /^(добр|здравств|с уважени|спасиб)/iu.test(c)) continue;
    const service = SERVICE.test(c);
    if (!service && !KEEP.test(c)) continue;
    const t = c.charAt(0).toUpperCase() + c.slice(1);
    if (!all.includes(t)) all.push(t);
    if (!service && !product.includes(c)) product.push(c);
  }
  return { product: product.slice(0, 12), all: all.slice(0, 20) };
}

/** Одна марка из нескольких документов → одна позиция: полный размер (Н и Ш) — из того документа, где он есть. */
function mergeByMark(rows: DocItem[]): KpRequestItem {
  const full = rows.find((r) => r.item.width_mm && r.item.height_mm) ?? rows[0] as DocItem;
  const base = { ...full.item };
  for (const r of rows) {
    if (!base.width_mm && r.item.width_mm) base.width_mm = r.item.width_mm;
    if (!base.height_mm && r.item.height_mm) base.height_mm = r.item.height_mm;
    if (!base.tzEquipment && r.item.tzEquipment) base.tzEquipment = r.item.tzEquipment;
  }
  const details = [...new Set(rows.map((r) => r.item.details).filter((d): d is string => Boolean(d)))];
  if (details.length) base.details = details.join('; ').slice(0, 1000);
  const names = rows.map((r) => r.item.name).sort((a, b) => b.length - a.length);
  base.name = names[0] ?? base.name;
  // Количество: ведомость — итог по марке; если в документах разное, берётся большее (план проёмов — по одному проёму).
  const qtys = rows.filter((r) => !r.item.qtyUnknown).map((r) => r.item.qty);
  if (qtys.length) {
    base.qty = Math.max(...qtys);
    delete base.qtyUnknown;
  }
  base.sourceFiles = [...new Set(rows.flatMap((r) => r.item.sourceFiles ?? []))];
  return base;
}

/** Размеры, указанные в обоих документах, расходятся больше чем на 20 мм — это не одна позиция. */
const sizeConflict = (a: DocItem, b: DocItem): boolean =>
  (Boolean(a.item.width_mm && b.item.width_mm) && Math.abs((a.item.width_mm as number) - (b.item.width_mm as number)) > 20) ||
  (Boolean(a.item.height_mm && b.item.height_mm) && Math.abs((a.item.height_mm as number) - (b.item.height_mm as number)) > 20);

/** Объединение одинаковых марок из разных файлов; строки без марки и повторы марки внутри одного файла — как есть. */
export function mergeProject(rows: DocItem[]): DocItem[] {
  const out: DocItem[] = [];
  const byMark = new Map<string, DocItem[]>();
  for (const r of rows) {
    const mark = r.item.mark;
    if (!mark) {
      out.push(r);
      continue;
    }
    const group = byMark.get(mark);
    if (!group) {
      byMark.set(mark, [r]);
      out.push(r);
    } else if (!group.some((g) => g.file === r.file) && !sizeConflict(group[0] as DocItem, r)) group.push(r);
    else out.push(r);
  }
  return out.map((r) => {
    const group = r.item.mark ? byMark.get(r.item.mark) : null;
    return group && group[0] === r && group.length > 1 ? { ...r, item: mergeByMark(group) } : r;
  });
}

export interface LetterScope {
  /** marks — по маркам из письма; numbers — по номерам позиций; null — письмо объём не задаёт. */
  by: 'marks' | 'numbers' | null;
  selected: KpRequestItem[];
  /** Остальные строки проекта — «Ещё в проекте». */
  rest: KpRequestItem[];
  /** Марки / номера из письма, которых нет во вложениях. */
  missing: string[];
  specs: { product: string[]; all: string[] };
}

/**
 * Объём заявки по письму. Марки письма — только те, что есть среди марок вложений (случайные «М3», «ГОСТ 475» не мешают).
 * Позиции — в порядке письма, количество — из письма («ДНО-1 — 1 шт»), иначе из документа.
 */
export function letterScope(letter: string, rows: DocItem[]): LetterScope {
  const merged = mergeProject(rows);
  const projectMarks = new Set(merged.map((r) => r.item.mark).filter(Boolean));
  const inLetter = marksIn(letter);
  const named = inLetter.filter((m) => projectMarks.has(m.mark));
  const specs = letterSpecs(letter, [...projectMarks] as string[]);
  const withSpecs = (it: KpRequestItem): KpRequestItem => {
    if (!specs.product.length || it.kind === 'service') return it;
    const fromLetter = `из письма: ${specs.product.join(', ')}`;
    return { ...it, details: [it.details, fromLetter].filter(Boolean).join('; ').slice(0, 1200), letterSpec: specs.product.join(', ') };
  };
  if (named.length) {
    const selected: KpRequestItem[] = [];
    for (const m of named) {
      const r = merged.find((x) => x.item.mark === m.mark);
      if (!r) continue;
      const qty = qtyAfter(letter, m.end);
      const it: KpRequestItem = { ...r.item };
      if (qty) {
        it.qty = qty;
        delete it.qtyUnknown;
      }
      selected.push(withSpecs(it));
    }
    const rest = merged.filter((r) => !named.some((m) => m.mark === r.item.mark)).map((r) => r.item);
    // Марки письма, похожие на марки проекта (та же буквенная часть), но отсутствующие в нём, — менеджеру.
    const prefixes = new Set([...projectMarks].map((m) => (m as string).replace(/\d+[а-яa-z]?$/, '')));
    const missing = inLetter.filter((m) => !projectMarks.has(m.mark) && prefixes.has(m.mark.replace(/\d+[а-яa-z]?$/, ''))).map((m) => m.mark);
    return { by: 'marks', selected, rest, missing, specs };
  }
  const numbers = positionNumbersIn(letter);
  if (numbers.length) {
    // Номера — строки первого файла с позициями (обычно спецификация одна); нет такого номера — менеджеру.
    const first = merged.find((r) => r.no > 0)?.file ?? 0;
    const pool = merged.filter((r) => r.file === first);
    const pick = numbers.map((n) => pool.find((r) => r.no === n) ?? null);
    if (pick.some(Boolean)) {
      const selected = pick.filter((r): r is DocItem => Boolean(r)).map((r) => withSpecs(r.item));
      const rest = merged.filter((r) => !pick.includes(r)).map((r) => r.item);
      return { by: 'numbers', selected, rest, missing: numbers.filter((_, i) => !pick[i]).map(String), specs };
    }
  }
  return { by: null, selected: merged.map((r) => r.item), rest: [], missing: [], specs };
}
