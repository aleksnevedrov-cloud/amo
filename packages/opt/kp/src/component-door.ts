/**
 * KB-COMPONENT-DOOR: к какой двери заявки относится комплектующее (коробка, наличник, добор, порог).
 * Цена комплектующего берётся только из строки прайса этой двери; дверь определить однозначно нельзя — вопрос менеджеру
 * со списком дверей заявки, без цены. Порядок:
 *  1. исключаются двери, которые явно не подходят: семейство (деревянная / стальная / алюминиевая), материал, покрытие,
 *     цвет, размер двери в тексте комплектующего («к двери 800×2000»);
 *  2. явная ссылка «к двери …» / «для …» — дверь, чья модель или название совпали со словами ссылки;
 *  3. осталась одна дверь (одна строка прайса) — она;
 *  4. модель / серия двери прайса названа в строке комплектующего — эта дверь, если она одна такая;
 *  5. иначе — вопрос.
 * Несколько строк заявки с одной строкой прайса (30 × «ДВ CPL» разных номеров) — одна дверь.
 */
import { categoryOf, colorOf, componentKindOf, familyOfRow, familyOfText, featuresOf, modelKeyOf, rowFeatures, sizeOf, type ComponentKind, type KbPrice } from '@opt/kb';
import { lineCategory, tidyName, type KpLine, type KpPayload } from './draft.ts';

export interface ComponentDoorOption {
  /** Строка заявки двери (request_index) — её номер уходит в ответ менеджера. */
  requestIndex: number;
  productId: string | null;
  model: string;
  size: string;
  qty: number;
}

export interface ComponentDoorQuestion {
  kind: 'component_door';
  text: string;
  /** many — подходит несколько дверей; none — не подходит ни одна (в списке все двери заявки). */
  reason: 'many' | 'none';
  options: ComponentDoorOption[];
}

export type ComponentDoorMatch =
  | { kind: 'door'; door: KpLine; row: KbPrice | null; reason: string }
  | { kind: 'question'; question: ComponentDoorQuestion }
  | { kind: 'no_doors' };

/** Слова, которые ничего не говорят о модели двери: виды комплектующих, отделка, общие слова. */
const NOT_MODEL = /^(коробк|наличн|добор|порог|планк|телескоп|сэндвич|сендвич|комплект|двер|блок|полотн|межкомнат|деревян|мдф|хдф|cpl|пвх|шпон|экошпон|эмал|ламин|белый|белая|серый|серая|черн|дуб|орех|венге|мм|шт|для|глух|остекл|внутрен|однопол|двупол)/;
const words = (text: string): string[] => modelKeyOf(text).split(' ').filter((w) => w && (w.length >= 3 || /\d/.test(w)) && !NOT_MODEL.test(w));
/** Слова совпадают с учётом окончаний: «финской» = «финская» по первым пяти буквам, артикулы — целиком. */
const same = (a: string, b: string) => (/\d/.test(a) || /\d/.test(b) ? a === b : a.slice(0, 5) === b.slice(0, 5));
const overlap = (a: string[], b: string[]) => a.filter((x) => b.some((y) => same(x, y))).length;

/** Явная ссылка на дверь в строке комплектующего: «… к двери ДПГ CPL», «… для Финской». */
export function explicitDoorRef(text: string): string | null {
  const m = /(?:^|[\s,(])(?:к|для)\s+(?:двер\S*\s+)?(.+)$/i.exec(text.split(/[|—;]/)[0] ?? text);
  // Хвост ссылки без размера самого комплектующего («… 150 мм», «… 4 шт»); размер двери «800×2000» остаётся.
  const tail = (m?.[1] ?? '').replace(/\s+\d+(?:[.,]\d+)?\s*(?:мм|см|шт)\.?(?:\s.*)?$/i, '').replace(/[\s,.;:]+$/, '').trim();
  return words(tail).length ? tail : null;
}

interface DoorGroup {
  key: string;
  row: KbPrice | null;
  lines: KpLine[];
}

const textOf = (payload: Partial<KpPayload>, l: KpLine) => {
  const it = payload.request_items?.[l.request_index];
  return `${it?.name ?? l.name} | ${it?.raw ?? ''}`;
};

/** Двери заявки, сгруппированные по строке прайса (без строки — по названию). */
function doorGroups(payload: Partial<KpPayload>, doorRows: Map<number, KbPrice | null>): DoorGroup[] {
  const doors = (payload.items ?? []).filter((l) => lineCategory(l) === 'door').sort((a, b) => a.request_index - b.request_index);
  const groups = new Map<string, DoorGroup>();
  for (const l of doors) {
    const row = doorRows.get(l.request_index) ?? null;
    const key = row ? (row.productId ?? `row:${row.sourceId ?? 0}:${row.modelKey}`) : `name:${modelKeyOf(l.name)}`;
    const g = groups.get(key) ?? { key, row, lines: [] };
    g.lines.push(l);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** Варианты для вопроса: по двери прайса и размеру, количество суммируется. */
export function doorOptions(groups: { row: KbPrice | null; lines: KpLine[] }[]): ComponentDoorOption[] {
  const out = new Map<string, ComponentDoorOption>();
  for (const g of groups) {
    for (const l of g.lines) {
      const k = `${g.row?.productId ?? g.row?.id ?? modelKeyOf(l.name)}|${l.size}`;
      const cur = out.get(k);
      if (cur) cur.qty += l.qty;
      else out.set(k, { requestIndex: l.request_index, productId: g.row?.productId ?? null, model: g.row?.model ?? tidyName(l.name), size: l.size, qty: l.qty });
    }
  }
  return [...out.values()].sort((a, b) => a.requestIndex - b.requestIndex);
}

/** Текст вопроса: «К какой двери считать „Коробка ТЕЛЕСКОП, сэндвич 74×2150, 35 шт“?». */
export function componentQuestionText(payload: Partial<KpPayload>, line: KpLine): string {
  const it = payload.request_items?.[line.request_index];
  const name = tidyName(it?.name ?? line.name);
  const size = line.size && !name.includes(line.size) ? ` ${line.size}` : '';
  return `К какой двери считать «${name}${size}, ${line.qty.toLocaleString('ru-RU')} шт»?`;
}

/** Сопоставление строки комплектующего с дверью этой же заявки (см. порядок в шапке файла). */
export function matchComponentDoor(payload: Partial<KpPayload>, line: KpLine, doorRows: Map<number, KbPrice | null>): ComponentDoorMatch {
  const groups = doorGroups(payload, doorRows);
  if (!groups.length) return { kind: 'no_doors' };
  const text = textOf(payload, line);
  const cf = featuresOf(text);
  const cFamily = familyOfText(text);
  const cColor = colorOf(text);
  const cSize = sizeOf(text);
  const doorSize = cSize && cSize.widthMm >= 500 ? cSize : null;
  const fits = (g: DoorGroup): boolean => {
    const dText = g.lines.map((l) => textOf(payload, l)).join(' | ');
    const df = g.row ? rowFeatures(g.row) : featuresOf(dText);
    const dFamily = g.row ? familyOfRow(g.row) : familyOfText(dText);
    if (cFamily && dFamily && cFamily !== dFamily) return false;
    if (cf.material && df.material && cf.material !== df.material) return false;
    if (cf.coating && df.coating && cf.coating !== df.coating) return false;
    const dColor = colorOf(dText);
    if (cColor && dColor && cColor.toLowerCase() !== dColor.toLowerCase()) return false;
    if (doorSize) {
      const ok = g.lines.some((l) => {
        const s = sizeOf(l.size);
        return s && Math.abs(s.widthMm - doorSize.widthMm) <= 10 && Math.abs(s.heightMm - doorSize.heightMm) <= 10;
      });
      if (!ok) return false;
    }
    return true;
  };
  const modelWords = (g: DoorGroup) => [...new Set([...(g.row ? words(`${g.row.model} ${g.row.abbr ?? ''}`) : []), ...(g.row?.productId ? [g.row.productId.toLowerCase()] : [])])];
  const pick = (g: DoorGroup, reason: string): ComponentDoorMatch => ({ kind: 'door', door: g.lines[0] as KpLine, row: g.row, reason });
  const candidates = groups.filter(fits);
  // Явная ссылка: слова после «к двери» / «для» — с моделью прайса или названием двери в заявке.
  const ref = explicitDoorRef(payload.request_items?.[line.request_index]?.name ?? line.name);
  if (ref) {
    const rw = [...words(ref), ...(/[a-zа-я]{2,4}-\d{3}/i.exec(ref) ? [(/[a-zа-я]{2,4}-\d{3}/i.exec(ref) as RegExpExecArray)[0].toLowerCase()] : [])];
    const scored = (candidates.length ? candidates : groups).map((g) => ({ g, n: overlap(rw, [...modelWords(g), ...g.lines.flatMap((l) => words(l.name))]) }));
    const max = Math.max(...scored.map((x) => x.n));
    const top = scored.filter((x) => x.n === max && max > 0);
    if (top.length === 1) return pick((top[0] as { g: DoorGroup }).g, `в строке указано «${ref}»`);
  }
  if (candidates.length === 1) return pick(candidates[0] as DoorGroup, groups.length === 1 ? 'единственная дверь в заявке' : 'единственная подходящая дверь заявки (материал, покрытие, цвет, размер)');
  if (candidates.length > 1) {
    const cw = words(text);
    const scored = candidates.map((g) => ({ g, n: overlap(cw, modelWords(g)) }));
    const max = Math.max(...scored.map((x) => x.n));
    const top = scored.filter((x) => x.n === max && max > 0);
    if (top.length === 1) return pick((top[0] as { g: DoorGroup }).g, 'модель двери названа в строке');
  }
  const reason = candidates.length ? 'many' : 'none';
  return { kind: 'question', question: { kind: 'component_door', text: componentQuestionText(payload, line), reason, options: doorOptions(candidates.length ? candidates : groups) } };
}

/** Вид комплектующего строки, если это коробка / наличник / добор / порог; иначе null (обычный подбор). */
export function doorComponentKind(payload: Partial<KpPayload>, line: KpLine): ComponentKind | null {
  if (lineCategory(line) !== 'component') return null;
  const t = textOf(payload, line);
  return categoryOf(t) === 'component' || lineCategory(line) === 'component' ? componentKindOf(t) : null;
}
