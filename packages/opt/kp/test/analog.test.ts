import { describe, expect, it } from 'vitest';
import { designTokens, extractRequirements, suggestAnalog, type AnalogCandidate } from '../src/analog.ts';

const cand = (over: Partial<AnalogCandidate>): AnalogCandidate => ({ id: 'x', name: 'Дверь', vendor: null, price: null, design: [], standards: [], ...over });

describe('подбор аналога по правилу: ГОСТ → дизайн → цена', () => {
  it('ГОСТ из заявки находится в стандартах товара и имеет приоритет над дизайном и ценой', () => {
    const req = { name: 'дверь белая эмаль', raw: 'Дверь белая эмаль 2000*800 по ГОСТ 475-2016', price: 10_000, requirements: extractRequirements('по ГОСТ 475-2016') };
    const s = suggestAnalog(req, [
      cand({ id: 'design', name: 'Турин белая эмаль', vendor: 'Фабрика А', price: 10_100, design: ['эмаль', 'белая'] }),
      cand({ id: 'gost', name: 'Блок дверной ДГ', vendor: 'Фабрика Б', price: 15_000, standards: ['ГОСТ 475-2016'] }),
    ]);
    expect(s).toMatchObject({ criterion: 'standard', detail: 'ГОСТ 475-2016', candidate: { id: 'gost' } });
    expect(s?.reason.replace(/\u00a0/g, ' ')).toBe('аналог по ГОСТ/техтребованиям (ГОСТ 475-2016): Фабрика Б Блок дверной ДГ, 15 000 ₽ — предложение, в КП не подставлено');
  });

  it('без ГОСТ — по общим признакам дизайна; общие слова «дверь», «полотно» не считаются', () => {
    const req = { name: 'дверь межкомнатная, шпон, венге', raw: 'Дверь межкомнатная шпон венге 2000×700', price: null, requirements: [] };
    expect(designTokens(req.name)).toEqual(['шпон', 'венге']);
    const s = suggestAnalog(req, [
      cand({ id: 'other', name: 'Полотно дверное', design: ['эмаль', 'белая'] }),
      cand({ id: 'venge', name: 'Милан', vendor: 'Фабрика В', price: 8_500, design: ['шпон', 'венге', 'остекление'] }),
    ]);
    expect(s).toMatchObject({ criterion: 'design', detail: 'общие признаки «шпон, венге»', candidate: { id: 'venge' } });
  });

  it('только цена: в пределах ±15 % — предложение, дальше — ничего', () => {
    const req = { name: 'дверь', raw: 'Дверь 2000×800', price: 10_000, requirements: [] };
    expect(suggestAnalog(req, [cand({ id: 'far', price: 12_000 })])).toBeNull();
    const s = suggestAnalog(req, [cand({ id: 'far', price: 12_000 }), cand({ id: 'near', name: 'Прима', price: 10_800 })]);
    expect(s).toMatchObject({ criterion: 'price', candidate: { id: 'near' } });
    expect(s?.detail.replace(/\u00a0/g, ' ')).toBe('10 800 ₽ против 10 000 ₽ (±8 %)');
  });

  it('нет цены заявки и общих признаков — аналога нет; пустой список кандидатов — null', () => {
    const req = { name: 'дверь', raw: 'Дверь', price: null, requirements: [] };
    expect(suggestAnalog(req, [cand({ price: 5_000 })])).toBeNull();
    expect(suggestAnalog(req, [])).toBeNull();
  });

  it('стандарты из текста заявки: ГОСТ, ТУ, СП; дефисы и пробелы приводятся к одному виду', () => {
    expect(extractRequirements('полотна по ГОСТ 475–2016 и ТУ 5361-001-12345678-2015, монтаж по СП 70.13330, срочно')).toEqual(['ГОСТ 475-2016', 'ТУ 5361-001-12345678-2015', 'СП 70.13330']);
    expect(extractRequirements('без требований')).toEqual([]);
  });
});
