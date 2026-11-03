import { describe, expect, it } from 'vitest';
import { completeProfile, gostDesignation, missingFields, profileConflicts, profileLine, profileOf, profileOfRow, profileSize } from '../src/gost-profile.ts';
import type { KbPrice } from '../src/prices.ts';

const row = (over: Partial<KbPrice> & { designation?: string; gosts?: string[]; fill?: 'solid' | 'glazed'; leafCount?: number; sizeBasis?: 'leaf' | 'block' | 'opening' | 'leaf_pair' }): KbPrice => {
  const { designation, gosts, fill, leafCount, sizeBasis, ...rest } = over;
  return {
    model: '', abbr: null, description: null, family: null, widthMm: null, heightMm: null,
    card: { unit: null, sizeBasis: sizeBasis ?? null, geometry: null, fill: fill ?? null, comment: null, gosts: gosts ?? [], leafCount: leafCount ?? null, colors: [], baseIncludes: null, note: null, technical: null, quoteNotes: [], priceConditions: null, designation: designation ?? null },
    ...rest,
  } as KbPrice;
};

describe('ГОСТ-профиль (KP-AGENT-V2, п. 3)', () => {
  it('обозначения из заявок разбираются в поля профиля', () => {
    expect(profileOf('ДМ 1 Рл Г ПрБ Мд1 2100×900, ВФД, замок, вентрешётка')).toMatchObject({ gost: '475-2016', kind: 'ДМ', leaves: 1, opening: 'left', fill: 'Г', threshold: 'ПрБ', strength: 'Мд1', fire: null, heightMm: 2100, widthMm: 900 });
    expect(profileOf('Дв Рп 1 Г ПрБ 2100×1000, размер по проёму, пластик серый')).toMatchObject({ gost: '475-2016', kind: 'ДВ', leaves: 1, opening: 'right', fill: 'Г', threshold: 'ПрБ', heightMm: 2100, widthMm: 1000, basis: 'opening' });
    expect(profileOf('Дверной блок деревянный внутренний глухой однопольный без порога ДВ 1Рп 2100-10 Г ПрБ М3 ГОСТ 475-2016')).toMatchObject({ gost: '475-2016', kind: 'ДВ', leaves: 1, opening: 'right', fill: 'Г', threshold: 'ПрБ', strength: 'М3', heightMm: 2100, widthMm: 1000, basis: 'frame', material: 'wood' });
    expect(profileOf('ДСН А Дп Пр Прг Н П2лс М1 О 2300×1430 ГОСТ 31173-2016')).toMatchObject({ gost: '31173-2016', kind: 'ДСН', leaves: 2, opening: 'right', fill: 'О', threshold: 'Прг', strength: 'М1', heightMm: 2300, widthMm: 1430, material: 'steel' });
    expect(profileOf('ДПС 01 2060-780 EI60')).toMatchObject({ gost: 'Р 57327-2016', kind: 'ДПС', leaves: 1, fire: 'EI60', heightMm: 2060, widthMm: 780, material: 'steel' });
    expect(profileOf('ДГ 21*9 финская')).toMatchObject({ kind: 'Д', fill: 'Г', heightMm: 2100, widthMm: 900 });
    // Двупольная неравнопольная — створки 2, флаг «неравнопольная» (решение человека).
    expect(profileOf('ДГ 21*12 (800+400)')).toMatchObject({ leaves: 2, unequal: true, heightMm: 2100, widthMm: 1200 });
    expect(profileOf('ДГ 21*12 (600+600)')).toMatchObject({ leaves: 2, unequal: false });
    // Бренд клиента.
    expect(profileOf('Дверь AquaDoor (Аква ДПК ДГ-01), серый RAL 7035')).toMatchObject({ brand: 'Аква', material: 'dpk' });
    expect(profileOf('Ставерн ПВХ дуб мадейра янтарь 900×2000')).toMatchObject({ brand: 'Ставерн', cover: 'ПВХ' });
  });

  it('без угадывания: «о поставке» не остеклённая, «не менее 30 мм» не EI30, «п. 15» не правая; ДМ-1 с дефисом — модель, сталь с кодом ГОСТ 475 — вид пустой', () => {
    expect(profileOf('Дверь межкомнатная, вопрос о поставке, толщина не менее 30 мм, см. п. 15')).toMatchObject({ fill: null, fire: null, opening: null, kind: null });
    expect(profileOf('Дверь техническая ДМ-1 860×2050')).toMatchObject({ kind: null, gost: null });
    expect(profileOf('Дверь стальная ДМ 1Рп 2050×860')).toMatchObject({ kind: null, material: 'steel' });
    expect(profileOf('ДДП Е-30 двухстворчатая')).toMatchObject({ fire: 'EI30', leaves: 2 });
    expect(profileOf('Дверь противопожарная однопольная')).toMatchObject({ fire: 'EI?', leaves: 1 });
  });

  it('размер: мм, дм, «2100-10», Н×Ш независимо от порядка', () => {
    expect(profileSize('2000×800')).toEqual({ heightMm: 2000, widthMm: 800 });
    expect(profileSize('800*2000')).toEqual({ heightMm: 2000, widthMm: 800 });
    expect(profileSize('2100-10')).toEqual({ heightMm: 2100, widthMm: 1000 });
    expect(profileSize('21-9')).toEqual({ heightMm: 2100, widthMm: 900 });
    expect(profileSize('ГОСТ 475-2016')).toBeNull();
  });

  it('профиль строки прайса — из шаблона обозначения и карточки; обязательные поля расходятся — строка не подходит', () => {
    const int013 = profileOfRow(row({ model: 'ДПГ CPL', abbr: 'ДПГ CPL', designation: 'ДВ 1Рп Г ПрБ М3 ГОСТ 475-2016. Мд3', gosts: ['ГОСТ 475-2016'], fill: 'solid', leafCount: 1, sizeBasis: 'block', family: 'interior' }));
    expect(int013).toMatchObject({ gost: '475-2016', kind: 'ДВ', leaves: 1, fill: 'Г', basis: 'frame' });
    const met006 = profileOfRow(row({ model: 'Входная дверь противопожарная EI60 ДМ-1', abbr: 'EI60, ДМ-1', designation: 'EI 60 по ГОСТ Р 57327-2016; 1-польная, Г (марку уточнить по сертификату)', gosts: ['ГОСТ Р 57327-2016'], fill: 'solid', leafCount: 1, family: 'steel' }));
    expect(met006).toMatchObject({ gost: 'Р 57327-2016', kind: 'ДПС', leaves: 1, fill: 'Г', fire: 'EI60', material: 'steel' });
    const met001 = profileOfRow(row({ model: 'Дверь техническая ДМ-1', abbr: 'ДМ-1', designation: 'ДСН или ДСВ … 1-польный, Г — ГОСТ 31173-2016 (полную марку уточнить по паспорту)', gosts: ['ГОСТ 31173-2016'], fill: 'solid', leafCount: 1, family: 'steel' }));
    expect(met001).toMatchObject({ gost: '31173-2016', kind: 'ДСН', kinds: ['ДСН', 'ДСВ'], fire: null });
    const int023 = profileOfRow(row({ model: 'ДДП Е-30 двухстворчатая', designation: 'ДМ 2Рп 21×9 Г ПрБ ГОСТ 475-2016; EI 30 по ГОСТ Р 53307-2009', gosts: ['ГОСТ Р 53307-2009', 'ГОСТ 475-2016'], fill: 'solid', leafCount: 2 }));
    expect(int023).toMatchObject({ gost: '475-2016', kind: 'ДМ', leaves: 2, fire: 'EI30' });
    // ДПС 01 EI60 (90091) → MET-006, не MET-001 и не двупольная; ДСН (31173) ≠ ДПС.
    const dps = profileOf('Дверь ДПС 01 EI60 ГОСТ Р 57327-2016 900×2100');
    expect(profileConflicts(dps, met006)).toEqual([]);
    expect(profileConflicts(dps, met001)).toEqual(['gost', 'kind', 'fire']);
    const dsn = profileOf('Блок ДСН двупольный 2300×1430 ГОСТ 31173-2016');
    expect(profileConflicts(dsn, met006)).toEqual(['gost', 'kind', 'leaves', 'fire']);
    expect(profileConflicts(dsn, met001)).toEqual(['leaves']);
    // Обычная ДПГ не берёт противопожарную двустворчатую.
    expect(profileConflicts(profileOf('ДПГ + УПД, сота'), int023)).toEqual(['leaves', 'fire']);
    expect(profileConflicts(profileOf('ДВ 1Рп 2100-10 Г ПрБ М3 ГОСТ 475-2016'), int013)).toEqual([]);
  });

  it('пустые обязательные поля — вопрос; дополнение из строки прайса; обозначение по шаблону прайса', () => {
    const q = profileOf('ДПГ CPL 910×2100');
    expect(missingFields(q)).toEqual(['gost', 'kind']);
    const r = profileOfRow(row({ model: 'ДПГ CPL', designation: 'ДВ 1Рп Г ПрБ М3 ГОСТ 475-2016. Мд3', gosts: ['ГОСТ 475-2016'], fill: 'solid', leafCount: 1, sizeBasis: 'block' }));
    const full = completeProfile(q, r);
    expect(missingFields(full)).toEqual([]);
    expect(gostDesignation('ДМ 1Рп 21×9 Г ПрБ Мд_ ГОСТ 475-2016', profileOf('ДМ 1 Рл Г ПрБ Мд1 2000×800'))).toBe('ДМ 1Рл 20×8 Г ПрБ Мд1 ГОСТ 475-2016');
    expect(gostDesignation('ДМ 1Рп 21×9 Г ПрБ Мд_ ГОСТ 475-2016', profileOf('ДПГ 2000×700'))).toBe('ДМ 1Рп 20×7 Г ПрБ ГОСТ 475-2016');
    expect(gostDesignation('EI 60 по ГОСТ Р 57327-2016; 1-польная, Г (марку уточнить по сертификату)', profileOf('ДПС 01 EI60'))).toBe('EI 60 по ГОСТ Р 57327-2016; 1-польная, Г');
    expect(gostDesignation(null, profileOf('ДСН А Дп Пр Прг Н П2лс М1 О 2300×1430 ГОСТ 31173-2016'))).toBe('ДСН 2Рп 23×14 О Прг М1 ГОСТ 31173-2016');
    expect(profileLine(profileOf('ДМ 1 Рл Г ПрБ Мд1 2100×900 по проёму'))).toBe('ГОСТ 475-2016 · ДМ · 1 створка · левая · Г · ПрБ · Мд1 · 2100×900 (по проёму)');
  });
});
