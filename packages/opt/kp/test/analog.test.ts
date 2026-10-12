import { describe, expect, it } from 'vitest';
import { comparablePrice, designTokens, extractRequirements, priceToleranceOf, rankAnalogs, suggestAnalog, type AnalogCandidate, type SourceKind } from '../src/analog.ts';

const plain = (s: string) => s.replace(/\u00a0/g, ' ');
const cand = (over: Partial<AnalogCandidate>): AnalogCandidate => ({ id: 'x', name: 'Дверь', vendor: null, price: null, design: [], standards: [], ...over });
const site = (kind: SourceKind, seller: string) => ({ url: `https://${seller}.ru/p`, foundAt: '2026-10-12', seller, kind, vatStated: 'unknown' as const });

describe('подбор аналога по правилу: ГОСТ → дизайн → цена', () => {
  it('ГОСТ из заявки находится в стандартах товара и имеет приоритет над дизайном и ценой', () => {
    const req = { name: 'дверь белая эмаль', raw: 'Дверь белая эмаль 2000*800 по ГОСТ 475-2016', price: 10_000, requirements: extractRequirements('по ГОСТ 475-2016') };
    const s = suggestAnalog(req, [
      cand({ id: 'design', name: 'Турин белая эмаль', vendor: 'Фабрика А', price: 10_100, design: ['эмаль', 'белая'] }),
      cand({ id: 'gost', name: 'Блок дверной ДГ', vendor: 'Фабрика Б', price: 15_000, standards: ['ГОСТ 475-2016'], source: site('manufacturer', 'fabrika-b') }),
    ]);
    expect(s).toMatchObject({ criterion: 'standard', matched: ['standard'], detail: 'ГОСТ 475-2016', candidate: { id: 'gost' } });
    expect(plain(s!.reason)).toBe('предварительно, по аналогу: Фабрика Б Блок дверной ДГ, fabrika-b, https://fabrika-b.ru/p; 15 000 ₽; совпадение по ГОСТ/техтребованиям (ГОСТ 475-2016)');
  });

  it('без ГОСТ — по общим признакам дизайна; общие слова «дверь», «полотно» не считаются; совпавшие критерии перечисляются', () => {
    const req = { name: 'дверь межкомнатная, шпон, венге', raw: 'Дверь межкомнатная шпон венге 2000×700', price: 8_000, requirements: [] };
    expect(designTokens(req.name)).toEqual(['шпон', 'венге']);
    const s = suggestAnalog(req, [
      cand({ id: 'other', name: 'Полотно дверное', design: ['эмаль', 'белая'] }),
      cand({ id: 'venge', name: 'Милан', vendor: 'Фабрика В', price: 8_500, design: ['шпон', 'венге', 'остекление'] }),
    ]);
    expect(s).toMatchObject({ criterion: 'design', matched: ['design', 'price'], candidate: { id: 'venge' } });
    expect(plain(s!.detail)).toBe('общие признаки «шпон, венге»; 8 500 ₽ против 8 000 ₽ (±6 %)');
  });

  it('только цена: допуск по умолчанию ±10 %, из настроек меньше — уже, больше 10 % не принимается', () => {
    const req = { name: 'дверь', raw: 'Дверь 2000×800', price: 10_000, requirements: [] };
    expect(priceToleranceOf()).toBe(0.1);
    expect(priceToleranceOf({ priceTolerance: 0.05 })).toBe(0.05);
    expect(priceToleranceOf({ priceTolerance: 0.15 })).toBe(0.1);
    expect(priceToleranceOf({ priceTolerance: -1 })).toBe(0.1);
    const c = [cand({ id: 'far', price: 11_200 }), cand({ id: 'near', name: 'Прима', price: 10_800 })];
    expect(suggestAnalog(req, c)).toMatchObject({ criterion: 'price', candidate: { id: 'near' } });
    expect(suggestAnalog(req, c, { priceTolerance: 0.05 })).toBeNull();
    // 15 % в настройках не расширяет допуск: 11 200 (±12 %) всё равно не подходит.
    expect(rankAnalogs(req, c, { priceTolerance: 0.15 }).map((m) => m.candidate.id)).toEqual(['near']);
  });

  it('доставка и монтаж: цена с включённой доставкой без суммы не сравнивается, с указанной суммой — вычитается', () => {
    expect(comparablePrice(cand({ price: 12_000 }))).toBe(12_000);
    expect(comparablePrice(cand({ price: 12_000, includesDelivery: true }))).toBeNull();
    expect(comparablePrice(cand({ price: 12_000, includesDelivery: true, deliveryRub: 2_000 }))).toBe(10_000);
    const req = { name: 'дверь', raw: 'Дверь', price: 10_000, requirements: [] };
    expect(suggestAnalog(req, [cand({ id: 'incl', price: 10_000, includesDelivery: true })])).toBeNull();
    const s = suggestAnalog(req, [cand({ id: 'net', name: 'Прима', price: 12_000, includesDelivery: true, deliveryRub: 2_000 })]);
    expect(s).toMatchObject({ criterion: 'price', comparablePrice: 10_000, candidate: { id: 'net' } });
    expect(plain(s!.reason)).toContain('10 000 ₽; совпадение по цене');
  });

  it('сайт производителя выше маркетплейса при равных критериях; ранжирование отдаёт всех подходящих', () => {
    const req = { name: 'дверь шпон', raw: 'Дверь шпон', price: null, requirements: [] };
    const ranked = rankAnalogs(req, [
      cand({ id: 'market', name: 'Милан шпон', price: 9_000, source: site('marketplace', 'market') }),
      cand({ id: 'maker', name: 'Милан шпон', price: 9_500, source: site('manufacturer', 'fabrika') }),
      cand({ id: 'none', name: 'Эмаль белая', price: 9_000 }),
    ]);
    expect(ranked.map((m) => m.candidate.id)).toEqual(['maker', 'market']);
    expect(suggestAnalog(req, [])).toBeNull();
  });

  it('стандарты из текста заявки: ГОСТ, ТУ, СП; дефисы и пробелы приводятся к одному виду', () => {
    expect(extractRequirements('полотна по ГОСТ 475–2016 и ТУ 5361-001-12345678-2015, монтаж по СП 70.13330, срочно')).toEqual(['ГОСТ 475-2016', 'ТУ 5361-001-12345678-2015', 'СП 70.13330']);
    expect(extractRequirements('без требований')).toEqual([]);
  });
});
