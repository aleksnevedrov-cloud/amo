import { describe, expect, it } from 'vitest';
import { colorOf, describeFeatures, featureKeyOf, featuresFromColumns, featuresFromModel, featuresOf, keysCompatible, matchFeatures, mergeFeatures, priceListMedian, webPriceRealistic, priceModelOf } from '../src/features.ts';

describe('признаки двери (RFD-AI-AGENT-OPT-KB-MATCH)', () => {
  it('из текста позиции письма: тип, материал, Г/О, створки, порог, открывание, покрытие, доводчик, замок', () => {
    const f = featuresOf('Дверной блок деревянный внутренний глухой однопольный без порога распашной с доводчиком, внутренним механическим замком, облицовка CPL светлосерый 1010×2100');
    expect(f).toEqual({ type: 'block', material: 'wood', glazing: 'solid', leaves: 1, threshold: 'without', opening: 'swing', coating: 'cpl', fire: null, closer: true, lock: true });
    expect(describeFeatures(f)).toBe('дверной блок, деревянный, глухой, однопольный, без порога, распашной, CPL, с доводчиком, с замком');
  });

  it('из сокращения по ГОСТ «ДВ 1Рп Г ПрБ» и из ДПГ/ДПО', () => {
    expect(featuresOf('ДВ 1Рп Г ПрБ')).toMatchObject({ type: 'block', leaves: 1, opening: 'swing', glazing: 'solid', threshold: 'without' });
    expect(featuresOf('ДВ 2Рп О')).toMatchObject({ type: 'block', leaves: 2, opening: 'swing', glazing: 'glazed' });
    expect(featuresOf('ДПГ + УПД, сота 2000×800')).toMatchObject({ type: 'leaf', glazing: 'solid' });
    expect(featuresOf('ДПО сота')).toMatchObject({ type: 'leaf', glazing: 'glazed' });
    expect(featuresOf('Дверь алюминиевая остеклённая с порогом')).toMatchObject({ material: 'aluminium', glazing: 'glazed', threshold: 'with' });
    expect(featuresOf('Дверь противопожарная металлическая EI 60 двупольная')).toMatchObject({ material: 'steel', fire: 'EI60', leaves: 2 });
    expect(featuresOf('Полотно экошпон остеклённое')).toMatchObject({ type: 'leaf', coating: 'ecoveneer', glazing: 'glazed' });
    expect(featuresOf('Полотно шпон дуба')).toMatchObject({ coating: 'veneer' });
    expect(featuresOf('Дверь ПВХ с автопорогом')).toMatchObject({ coating: 'pvc', threshold: null });
    expect(featuresOf('Турин')).toEqual({ type: null, material: null, glazing: null, leaves: null, threshold: null, opening: null, coating: null, fire: null, closer: null, lock: null });
  });

  it('из колонок прайса: «Г/О» одной буквой, покрытие, материал, конструкция, назначение, огнестойкость', () => {
    const f = featuresFromColumns({ go: 'Г', coating: 'CPL 0,2 мм', material: 'дерево', construction: 'полнозаполненная, однопольная, распашная, без порога', purpose: 'внутренняя, общественные помещения', fire: 'нет' });
    expect(f).toMatchObject({ glazing: 'solid', coating: 'cpl', material: 'wood', leaves: 1, opening: 'swing', threshold: 'without', fire: null });
    expect(featuresFromColumns({ go: 'О', fire: 'EI 30' })).toMatchObject({ glazing: 'glazed', fire: 'EI30' });
    expect(featuresFromColumns({ go: 'остеклённая', material: 'сталь' })).toMatchObject({ glazing: 'glazed', material: 'steel' });
  });

  it('слияние: явные признаки от модели перекрывают извлечённые; ответ модели словами и кодами', () => {
    const base = featuresOf('Дверной блок глухой CPL');
    expect(mergeFeatures(base, { material: 'wood', glazing: null })).toMatchObject({ type: 'block', material: 'wood', glazing: 'solid', coating: 'cpl' });
    expect(featuresFromModel({ type: 'block', material: 'деревянная', glazing: 'glazed', leaves: '2', threshold: 'без порога', coating: 'CPL', fire: 'EI30', closer: true, lock: 'да' })).toEqual({ type: 'block', material: 'wood', glazing: 'glazed', leaves: 2, threshold: 'without', coating: 'cpl', fire: 'EI30', closer: true });
    expect(featuresFromModel({ type: null, material: '' })).toBeNull();
    expect(featuresFromModel('x')).toBeNull();
  });

  it('совпадение: обязательный признак расходится — строка отвергнута; необязательный — штраф; меньше двух совпавших — не подходит', () => {
    const q = featuresOf('Дверной блок деревянный глухой однопольный без порога CPL');
    const cpl = featuresOf('Дверной блок деревянный внутренний глухой однопольный без порога, покрытие CPL');
    expect(matchFeatures(q, cpl)).toMatchObject({ ok: true, matched: ['type', 'material', 'glazing', 'leaves', 'threshold', 'coating'], mismatched: [], conflict: null, score: 6 });
    expect(matchFeatures(q, featuresOf('Дверной блок деревянный остеклённый однопольный без порога CPL'))).toMatchObject({ ok: false, conflict: 'glazing' });
    expect(matchFeatures(q, featuresOf('Дверной блок деревянный глухой однопольный без порога ПВХ'))).toMatchObject({ ok: false, conflict: 'coating' });
    expect(matchFeatures(q, featuresOf('Дверной блок алюминиевый глухой'))).toMatchObject({ ok: false, conflict: 'material' });
    // Двупольная с порогом: обязательные совпали, две необязательные разошлись — подходит, но балл ниже.
    expect(matchFeatures(q, featuresOf('Дверной блок деревянный глухой двупольный с порогом CPL'))).toMatchObject({ ok: true, mismatched: ['leaves', 'threshold'], score: 2 });
    // Строка без признаков или только с одним общим — не подходит по смыслу.
    expect(matchFeatures(q, featuresOf('Турин')).ok).toBe(false);
    expect(matchFeatures(q, featuresOf('полотно CPL')).ok).toBe(false);
    // Только необязательные совпали (створки и порог) — тоже нет: нужен хотя бы один обязательный.
    expect(matchFeatures(featuresOf('однопольная без порога'), featuresOf('однопольная без порога')).ok).toBe(false);
  });

  it('ключ группы, совместимость ключей, медиана прайса по группе и диапазон веб-цены 40–300 %', () => {
    const q = featuresOf('Дверной блок деревянный глухой CPL');
    expect(featureKeyOf(q)).toBe('block|wood|solid|cpl|*');
    expect(keysCompatible('block|wood|solid|cpl|*', 'block|*|solid|cpl|*')).toBe(true);
    expect(keysCompatible('block|wood|solid|cpl|*', 'block|wood|glazed|cpl|*')).toBe(false);
    const rows = [
      { featureKey: 'block|wood|solid|cpl|*', price: 23_900 },
      { featureKey: 'block|wood|solid|cpl|*', price: 25_000 },
      { featureKey: 'block|wood|glazed|pvc|*', price: 19_900 },
      { featureKey: null, price: 1 },
    ];
    expect(priceListMedian(rows, featureKeyOf(q))).toBe(24_450);
    expect(priceListMedian(rows, 'block|steel|*|*|*')).toBeNull();
    expect(priceListMedian(rows, '*|*|*|*|*')).toBeNull();
    expect(webPriceRealistic(5683, 23_900)).toBe(false);
    expect(webPriceRealistic(9560, 23_900)).toBe(true);
    expect(webPriceRealistic(71_700, 23_900)).toBe(true);
    expect(webPriceRealistic(80_000, 23_900)).toBe(false);
    expect(webPriceRealistic(5683, null)).toBe(true);
  });

  it('KP-NAME: цвет из письма и модель с покрытием из прайса', () => {
    expect(colorOf('облицовка CPL светлосерый 1010×2100')).toBe('светло-серый');
    expect(colorOf('Дверь, покрытие CPL светло-серый')).toBe('светло-серый');
    expect(colorOf('полотно экошпон дуб сонома')).toBe('дуб сонома');
    expect(colorOf('эмаль белый матовый')).toBe('белый матовый');
    expect(colorOf('эмаль RAL 7035, глухая')).toBe('RAL 7035');
    expect(colorOf('цвет: капучино')).toBe('капучино');
    expect(colorOf('Дверной блок деревянный глухой')).toBeNull();
    expect(priceModelOf({ model: 'ДВ CPL', coating: 'CPL 0,2 мм' })).toBe('ДВ CPL 0,2 мм');
    expect(priceModelOf({ model: 'ДВ CPL', coating: 'cpl' })).toBe('ДВ CPL');
    expect(priceModelOf({ model: 'ДПГ сота', coating: 'ламинат' })).toBe('ДПГ сота ламинат');
    expect(priceModelOf({ model: 'ДПГ сота', coating: null })).toBe('ДПГ сота');
  });
});
