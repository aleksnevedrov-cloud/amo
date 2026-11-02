import { describe, expect, it } from 'vitest';
import { addProjectItem, carryProjectAdds, positionToRequest, type KpPayload } from '../src/draft.ts';
import { letterScope, letterSpecs, markOf, marksIn, positionNumbersIn, type DocItem } from '../src/letter-select.ts';
import type { OptPosition } from '../src/table-parse.ts';

const pos = (name: string, w: number | null, h: number | null, qty: number | null, note: string | null = null, marking: string | null = null): OptPosition => ({ name, marking, width_mm: w, height_mm: h, qty, unit: 'шт', price_rub: null, material: null, color: null, fireproof: null, note });
const rows = (file: number, filename: string, ps: OptPosition[]): DocItem[] => ps.map((p, i) => ({ item: { ...positionToRequest(p), sourceFiles: [filename] }, file, no: i + 1 }));

/** Сделка 89518: ведомость наружных дверей (5 поз., Н×Ш) и план заполнения проёмов (18 поз., только ширина). */
const VED = rows(0, '28. Ведомость дверей.наружные.pdf', [
  pos('Дверь наружная металлическая остеклённая', 1010, 2070, 1, 'Марка: ДНО-1; Открывание: левое'),
  pos('Дверь наружная металлическая остеклённая', 1310, 2070, 1, 'Марка: ДНО-2; Открывание: правое'),
  pos('Дверь наружная металлическая остеклённая', 910, 2070, 1, 'Марка: ДНО-3'),
  pos('Дверь наружная металлическая глухая', 1010, 2070, 2, 'Марка: ДН-1'),
  pos('Дверь наружная металлическая глухая', 910, 2070, 1, 'Марка: ДН-2'),
]);
const PLAN = rows(1, '21.План заполнения проемов.pdf', [
  ...Array.from({ length: 12 }, (_, i) => pos(`Д${i + 1} Дверь внутренняя`, 800 + (i % 3) * 100, null, 1)),
  pos('ДНО-1 Дверь наружная', 1000, null, 1),
  pos('ДНО-2 Дверь наружная', 1300, null, 1),
  pos('ДНО-3 Дверь наружная', 900, null, 1),
  pos('ДН-1 Дверь наружная', 1000, null, 2),
  pos('ДН-2 Дверь наружная', 900, null, 1),
  pos('ОК-1 Окно', 1200, 1500, 4),
]);
const LETTER = 'Добрый день! Закупка 3 дверей для объекта. Нужны двери ДНО-1 — 1 шт; ДНО-2 — 1 шт; ДНО-3 — 1 шт.\nКаркас металлический, филёнка дуб/ламинация под дуб, цена изделие+фурнитура, доставка, установка.';

describe('объём заявки по письму (KP-LETTER-SCOPE, сделка 89518)', () => {
  it('марка: дефис или слитно; «ДПС 01», «ДВ 1Рп», «ГОСТ 475», «EI60», «М3» — не марки; латиница как кириллица', () => {
    expect(marksIn('ДНО-1, дно-2, ДHO-3, Д12, ОК-3а').map((m) => m.mark)).toEqual(['ДНО1', 'ДНО2', 'ДНО3', 'Д12', 'ОК3а']);
    expect(marksIn('Дверь ДПС 01 EI60, ДВ 1Рп 21-9, ГОСТ 475-2016, М3, ПВХ-2')).toEqual([]);
    expect(markOf({ name: 'Дверь наружная', note: 'Марка: ДНО-1; Открывание: левое' })).toBe('ДНО1');
    expect(markOf({ name: 'ДНО-2 Дверь наружная' })).toBe('ДНО2');
    expect(markOf({ name: 'Дверь противопожарная', marking: 'ДПС 01 EI30' })).toBeNull();
    expect(markOf({ name: 'Дверь ДНО-1 по ведомости' })).toBeNull();
    expect(positionNumbersIn('нужны позиции 3, 5, 7 и поз. 10–12')).toEqual([3, 5, 7, 10, 11, 12]);
  });

  it('89518: только ДНО-1/2/3 по 1 шт, размер Н×Ш — из ведомости (в плане только ширина); 20 строк проекта — «Ещё в проекте»', () => {
    const s = letterScope(LETTER, [...VED, ...PLAN]);
    expect(s.by).toBe('marks');
    expect(s.selected.map((it) => [it.mark, it.width_mm, it.height_mm, it.qty])).toEqual([['ДНО1', 1010, 2070, 1], ['ДНО2', 1310, 2070, 1], ['ДНО3', 910, 2070, 1]]);
    expect(s.selected[0]?.sourceFiles).toEqual(['28. Ведомость дверей.наружные.pdf', '21.План заполнения проемов.pdf']);
    expect(s.selected[0]?.details).toContain('Открывание: левое');
    // Требования письма — в характеристики позиций и в требования заявки (доставка, установка — только в требования).
    expect(s.selected[0]?.letterSpec).toBe('Каркас металлический, филёнка дуб/ламинация под дуб, цена изделие+фурнитура');
    expect(s.selected[0]?.details).toContain('из письма: Каркас металлический, филёнка дуб/ламинация под дуб, цена изделие+фурнитура');
    expect(s.specs.all).toEqual(['Каркас металлический', 'Филёнка дуб/ламинация под дуб', 'Цена изделие+фурнитура', 'Доставка', 'Установка']);
    // Остальное: ДН-1, ДН-2 — одна позиция на марку (ведомость + план), Д1–Д12, ОК-1.
    expect(s.rest).toHaveLength(15);
    expect(s.rest.filter((it) => it.mark === 'ДН1').map((it) => [it.width_mm, it.height_mm, it.qty])).toEqual([[1010, 2070, 2]]);
    expect(s.missing).toEqual([]);
  });

  it('письмо объём не задаёт — все строки, одна марка из двух файлов — одна позиция; размеры расходятся — не объединяются', () => {
    const s = letterScope('Прошу КП по проекту во вложении', [...VED, ...PLAN]);
    expect(s.by).toBeNull();
    expect(s.selected).toHaveLength(18);
    expect(s.selected.filter((it) => it.mark === 'ДНО1').map((it) => [it.width_mm, it.height_mm])).toEqual([[1010, 2070]]);
    const conflict = letterScope('', [...rows(0, 'a', [pos('ДНО-1', 1010, 2070, 1)]), ...rows(1, 'b', [pos('ДНО-1', 1500, 2400, 1)])]);
    expect(conflict.selected).toHaveLength(2);
  });

  it('номера позиций из письма; марка письма, которой нет во вложениях, — менеджеру', () => {
    const s = letterScope('Посчитайте, пожалуйста, позиции 2, 4', VED);
    expect(s.by).toBe('numbers');
    expect(s.selected.map((it) => it.mark)).toEqual(['ДНО2', 'ДН1']);
    expect(s.rest).toHaveLength(3);
    const m = letterScope('Нужны ДНО-1 и ДНО-7', VED);
    expect(m.selected.map((it) => it.mark)).toEqual(['ДНО1']);
    expect(m.missing).toEqual(['ДНО7']);
  });

  it('«добавить» из «Ещё в проекте» — в позиции с «цена не задана»; «Собрать заново» добавляет снова', () => {
    const s = letterScope(LETTER, [...VED, ...PLAN]);
    const base: Partial<KpPayload> = { request_items: s.selected, items: [], needs_manager: [], projectRest: s.rest, scope: { by: 'marks', selected: 3, project: 18, missing: [] } };
    const i = s.rest.findIndex((it) => it.mark === 'ДН1');
    const r = addProjectItem(base, i);
    expect(r.requestIndex).toBe(3);
    expect(r.payload.items?.at(-1)).toMatchObject({ request_index: 3, mark: 'ДН1', size: '1010×2070 мм', qty: 2 });
    expect(r.payload.projectRest).toHaveLength(14);
    expect(r.payload.projectAdded).toEqual(['ДН1']);
    expect(r.payload.scope).toMatchObject({ selected: 4 });
    expect(r.payload.needs_manager).toEqual([{ request_index: 3, reason: 'цена не задана' }]);
    const again = carryProjectAdds(base, r.payload);
    expect(again.request_items?.map((it) => it.mark)).toEqual(['ДНО1', 'ДНО2', 'ДНО3', 'ДН1']);
    expect(addProjectItem(base, 99).requestIndex).toBeNull();
  });

  it('требования письма: фразы о материале и отделке — к позициям, доставка и монтаж — только в требования, марки и приветствие — нет', () => {
    expect(letterSpecs('Здравствуйте!\nДНО-1 — 1 шт\nМонтаж и доставка до объекта. Цвет RAL 8017, порог алюминиевый', ['ДНО1'])).toEqual({ product: ['Цвет RAL 8017', 'порог алюминиевый'], all: ['Монтаж и доставка до объекта', 'Цвет RAL 8017', 'Порог алюминиевый'] });
  });
});
