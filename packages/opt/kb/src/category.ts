/**
 * Категория позиции (RFD-AI-AGENT-OPT-KB-COMPONENTS): дверь / комплектующее (коробка, наличник, добор, порог) /
 * фурнитура (замок, цилиндр, накладки, ручка, петля, доводчик) / работы (монтаж, установка, врезка, разгрузка, доставка).
 * Определяется по тексту: побеждает категория, чьё слово встретилось в названии раньше всех («Коробка дверная» — комплектующее,
 * «Дверной блок … с коробкой» — дверь, «Монтаж дверного блока» — работы). Без ключевых слов — null, вызывающий подставляет
 * своё значение (в заявке — дверь, в прайсе фурнитуры — фурнитура).
 */
export type PositionCategory = 'door' | 'component' | 'hardware' | 'service';
export const CATEGORIES: PositionCategory[] = ['door', 'component', 'hardware', 'service'];

export type ComponentKind = 'коробка' | 'наличник' | 'добор' | 'порог';
export const COMPONENT_KINDS: ComponentKind[] = ['коробка', 'наличник', 'добор', 'порог'];

const norm = (s: string) => ` ${s.toLowerCase().replace(/ё/g, 'е').replace(/[«»"'()[\],;:/\\|—–+=#№%]+/g, ' ').replace(/\s+/g, ' ').trim()} `;

const RX: Record<PositionCategory, RegExp> = {
  service: /\s(врезк|монтаж|демонтаж|установк|разгрузк|погрузк|доставк|подъем|сборк|замер|работ[аы]\s|услуг)/,
  component: /\s(коробк|наличник|добор|порог|притворн|капител|карниз|телескоп)/,
  // KB-PRICE-SHEETS: типы тарифов вкладки «Дополнения» (фрамуга, вентиляционная решётка, крепёж, уплотнитель, стеклопакет…).
  hardware: /\s(замок|замк|цилиндр|накладк|ручк|петл|доводчик|защелк|фиксатор|ограничител|стопор|упор\s|шпингалет|заверт|броненакладк|глазок|магнитн|автопорог|фрамуг|вентиляц|вентрешетк|решетк|крепеж|уплотнител|стеклопакет|задвижк|цепочк|шумоизоляц|окраск|шаблон|комплект фурнитур|комплект петел)/,
  door: /\s(дверь|двери|дверн|блок|полотн|дп[гос]|пг\s|по\s\+|дв\s|дн\s|дм\s|двер\s)/,
};

/** До какого слова названия ключевое слово ещё задаёт категорию: «Монтаж дверного блока» — работы, «Аква 01 ПГ … /врезка замка…» — нет. */
const HEAD_WORDS: Record<PositionCategory, number> = { service: 2, component: 3, hardware: 3, door: Infinity };

/**
 * Категория по первому встретившемуся ключевому слову; null — слов нет. Работы, комплектующие и фурнитура считаются
 * только по первым словам названия (главное существительное стоит впереди), дверь — по слову в любом месте: иначе
 * «врезка замка под цилиндр» в описании двери делала бы её работой или фурнитурой.
 */
export function detectCategory(text: string | null | undefined): PositionCategory | null {
  if (!text) return null;
  const t = norm(text);
  let best: { cat: PositionCategory; at: number } | null = null;
  for (const cat of CATEGORIES) {
    const m = RX[cat].exec(t);
    if (!m) continue;
    const wordIndex = t.slice(0, m.index + 1).trim().split(' ').filter(Boolean).length;
    if (wordIndex + 1 > HEAD_WORDS[cat]) continue;
    if (best === null || m.index < best.at) best = { cat, at: m.index };
  }
  return best?.cat ?? null;
}

export const categoryOf = (text: string | null | undefined, fallback: PositionCategory = 'door'): PositionCategory => detectCategory(text) ?? fallback;

/** Вид комплектующего (для подбора цены комплектующего к модели двери). */
export function componentKindOf(text: string | null | undefined): ComponentKind | null {
  if (!text) return null;
  const t = norm(text);
  let best: { kind: ComponentKind; at: number } | null = null;
  for (const kind of COMPONENT_KINDS) {
    const at = t.indexOf(` ${kind.slice(0, -1)}`);
    if (at >= 0 && (best === null || at < best.at)) best = { kind, at };
  }
  return best?.kind ?? null;
}

/** Колонка прайса дверей с ценой комплектующего: «Коробка, руб.» → коробка. */
export function componentColumnKind(header: string | null | undefined): ComponentKind | null {
  const h = (header ?? '').toLowerCase().replace(/ё/g, 'е');
  if (/коробк/.test(h)) return 'коробка';
  if (/наличник/.test(h)) return 'наличник';
  if (/добор/.test(h)) return 'добор';
  if (/порог/.test(h)) return 'порог';
  return null;
}

/** Категория по умолчанию для строк прайса без ключевых слов — по имени файла: «Прайс_фурнитура…» → фурнитура. */
export function defaultCategoryOfPriceKey(priceKey: string | null | undefined): PositionCategory {
  const k = (priceKey ?? '').toLowerCase();
  if (/фурнитур/.test(k)) return 'hardware';
  if (/комплектующ|погонаж/.test(k)) return 'component';
  return 'door';
}

export const CATEGORY_WORDS: Record<PositionCategory, string> = { door: 'дверь', component: 'комплектующее', hardware: 'фурнитура', service: 'работы' };
