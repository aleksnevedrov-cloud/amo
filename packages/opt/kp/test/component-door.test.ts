import type { KbPrice } from '@opt/kb';
import { describe, expect, it } from 'vitest';
import { componentGroupOf, explicitDoorRef, matchComponentDoor } from '../src/component-door.ts';
import type { KpLine, KpPayload } from '../src/draft.ts';

/** Строка двери прайса: только поля, которые читает сопоставление. */
const door = (id: number, productId: string, model: string, over: Partial<KbPrice> = {}): KbPrice =>
  ({ id, productId, model, modelKey: model.toLowerCase(), abbr: null, description: null, family: 'interior', features: { type: 'leaf', material: 'wood', glazing: 'solid', leaves: 1, threshold: null, opening: null, coating: null, fire: null, closer: null, lock: null }, sourceId: 32, category: 'door', origin: 'price_list', ...over }) as KbPrice;

const line = (request_index: number, name: string, size: string, qty: number, category: KpLine['category']): KpLine => ({ request_index, page_id: null, name, size, qty, price: null, lead_time: '', discount: 0, category });

function payloadOf(lines: KpLine[]): Partial<KpPayload> {
  return { items: lines, request_items: lines.map((l) => ({ raw: `${l.name} ${l.size} — ${l.qty} шт`, name: l.name, width_mm: null, height_mm: null, qty: l.qty, category: l.category })) };
}

// Заявка как 89813: две межкомнатные двери разных моделей и покрытий, стальная техническая дверь.
const items = [
  line(0, 'ДПГ усиленная ПВХ', '800×2000', 5, 'door'),
  line(1, 'ДПГ CPL', '910×2100', 3, 'door'),
  line(2, 'Дверь техническая ДМ-1 стальная', '860×2050', 2, 'door'),
  line(3, 'ДПГ CPL', '810×2100', 1, 'door'),
];
const rows = new Map<number, KbPrice | null>([
  [0, door(1, 'INT-002', 'ДПГ усиленная', { coating: 'ПВХ', features: { type: 'leaf', material: 'wood', glazing: 'solid', leaves: 1, threshold: null, opening: null, coating: 'pvc', fire: null, closer: null, lock: null } })],
  [1, door(2, 'INT-013', 'ДПГ CPL', { coating: 'CPL 0,2 мм', features: { type: 'block', material: 'wood', glazing: 'solid', leaves: 1, threshold: null, opening: null, coating: 'cpl', fire: null, closer: null, lock: null } })],
  [2, door(3, 'MET-001', 'Дверь техническая ДМ-1', { family: 'steel', features: { type: 'block', material: 'steel', glazing: 'solid', leaves: 1, threshold: null, opening: null, coating: null, fire: null, closer: null, lock: null } })],
  [3, door(2, 'INT-013', 'ДПГ CPL', { coating: 'CPL 0,2 мм', features: { type: 'block', material: 'wood', glazing: 'solid', leaves: 1, threshold: null, opening: null, coating: 'cpl', fire: null, closer: null, lock: null } })],
]);

describe('комплектующее — к какой двери заявки (KB-COMPONENT-DOOR)', () => {
  it('без признаков — вопрос со списком дверей заявки (две строки INT-013 — одна дверь, количество суммируется по размеру)', () => {
    const c = line(10, 'Коробка ТЕЛЕСКОП, сэндвич', '74×2150', 35, 'component');
    const m = matchComponentDoor(payloadOf([...items, c]), c, rows);
    expect(m).toMatchObject({ kind: 'question', question: { kind: 'component_door', reason: 'many', text: 'К какой двери считать «Коробка ТЕЛЕСКОП, сэндвич 74×2150, 35 шт»?' } });
    if (m.kind !== 'question') throw new Error('ожидался вопрос');
    expect(m.question.options).toEqual([
      { requestIndex: 0, productId: 'INT-002', model: 'ДПГ усиленная', size: '800×2000', qty: 5 },
      { requestIndex: 1, productId: 'INT-013', model: 'ДПГ CPL', size: '910×2100', qty: 3 },
      { requestIndex: 2, productId: 'MET-001', model: 'Дверь техническая ДМ-1', size: '860×2050', qty: 2 },
      { requestIndex: 3, productId: 'INT-013', model: 'ДПГ CPL', size: '810×2100', qty: 1 },
    ]);
  });

  it('покрытие и семейство исключают двери: «Наличник ПВХ» — только INT-002; «Коробка CPL» — INT-013 (две строки заявки — одна дверь прайса)', () => {
    const n = line(11, 'Наличник ПВХ 70 мм', '', 10, 'component');
    expect(matchComponentDoor(payloadOf([...items, n]), n, rows)).toMatchObject({ kind: 'door', door: { request_index: 0 }, row: { productId: 'INT-002' } });
    const k = line(12, 'Коробка CPL', '', 4, 'component');
    expect(matchComponentDoor(payloadOf([...items, k]), k, rows)).toMatchObject({ kind: 'door', door: { request_index: 1 }, row: { productId: 'INT-013' } });
    // Стальная коробка — к стальной двери.
    const s = line(13, 'Коробка стальная', '', 2, 'component');
    expect(matchComponentDoor(payloadOf([...items, s]), s, rows)).toMatchObject({ kind: 'door', row: { productId: 'MET-001' } });
  });

  it('явная ссылка «к двери …» и размер двери в тексте', () => {
    expect(explicitDoorRef('Добор 150 мм к двери ДПГ CPL')).toBe('ДПГ CPL');
    expect(explicitDoorRef('Добор 150 мм')).toBeNull();
    const d = line(14, 'Добор 150 мм к двери ДПГ CPL', '', 4, 'component');
    expect(matchComponentDoor(payloadOf([...items, d]), d, rows)).toMatchObject({ kind: 'door', row: { productId: 'INT-013' } });
    const u = line(15, 'Добор для ДПГ усиленной', '', 4, 'component');
    expect(matchComponentDoor(payloadOf([...items, u]), u, rows)).toMatchObject({ kind: 'door', row: { productId: 'INT-002' } });
    // Размер двери 800×2000 в строке — только INT-002.
    const z = line(16, 'Порог к двери 800×2000', '', 5, 'component');
    expect(matchComponentDoor(payloadOf([...items, z]), z, rows)).toMatchObject({ kind: 'door', row: { productId: 'INT-002' } });
  });

  it('ни одна дверь не подходит — вопрос со всеми дверями заявки; дверей нет — no_doors; одна дверь — она', () => {
    const a = line(17, 'Наличник алюминиевый', '', 2, 'component');
    const m = matchComponentDoor(payloadOf([...items, a]), a, rows);
    expect(m).toMatchObject({ kind: 'question', question: { reason: 'none' } });
    if (m.kind === 'question') expect(m.question.options).toHaveLength(4);
    const solo = line(20, 'Коробка', '', 1, 'component');
    expect(matchComponentDoor(payloadOf([solo]), solo, new Map())).toEqual({ kind: 'no_doors' });
    expect(matchComponentDoor(payloadOf([items[1] as KpLine, solo]), solo, rows)).toMatchObject({ kind: 'door', row: { productId: 'INT-013' }, reason: 'единственная дверь в заявке' });
  });

  it('группа похожих строк (KB-COMPONENT-DOOR-GROUP): вид + исполнение (телескоп, комплект, сэндвич, ДПК, МДФ, цвет), размер не учитывается', () => {
    const g = (n: string) => componentGroupOf(n);
    // 89813: шесть групп.
    expect([g('Коробка ТЕЛЕСКОП, сэндвич 74×2150'), g('Коробка ТЕЛЕСКОП, сэндвич 74×2400'), g('Коробка ТЕЛЕСКОП сэндвич 92×2150 мм')].map((x) => x.key)).toEqual(['коробка|сэндвич|телескоп', 'коробка|сэндвич|телескоп', 'коробка|сэндвич|телескоп']);
    expect(g('Коробка ТЕЛЕСКОП, сэндвич 74×2150')).toEqual({ key: 'коробка|сэндвич|телескоп', title: 'Коробка ТЕЛЕСКОП, сэндвич' });
    expect(g('Коробка ТЕЛЕСКОП, ДПК 74×2150')).toEqual({ key: 'коробка|дпк|телескоп', title: 'Коробка ТЕЛЕСКОП, ДПК' });
    expect(g('Наличник телескопический, МДФ 70×2150')).toEqual({ key: 'наличник|мдф|телескоп', title: 'Наличник телескопический, МДФ' });
    expect(g('Наличник телескопический, ДПК 70×2200').key).toBe('наличник|дпк|телескоп');
    expect(g('Добор телескопический, МДФ 100 мм').key).toBe(g('Добор телескопический, МДФ 150×2150').key);
    expect(g('Добор телескопический, ДПК 100 мм').key).toBe('добор|дпк|телескоп');
    // Комплект: «ком-т», «комплект», «к-т» — один признак; цвет разделяет группы.
    expect(g('Наличник ком-т МДФ').key).toBe(g('Наличник комплект МДФ').key);
    expect(g('Наличник МДФ белый').key).not.toBe(g('Наличник МДФ дуб').key);
  });
});
