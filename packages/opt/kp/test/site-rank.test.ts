import { profileOf } from '@opt/kb';
import { describe, expect, it } from 'vitest';
import { planSites, siteWhy } from '../src/site-rank.ts';

const site = (original: string, comment: string | null, isFactory = false) => ({ original, title: original, comment, isFactory });
const SITES = [
  site('https://metall-dveri.ru', 'Стальные противопожарные ДПС, EI60, ГОСТ Р 57327', true),
  site('https://aquadoor.ru', 'Межкомнатные ДПК Аква, влагостойкие, RAL; коробки и наличники Аква; ГОСТ 475. Стальных нет'),
  site('https://dveri-shop.ru', null),
  site('https://mezhkomnatnye.ru', 'Межкомнатные МДФ, ПВХ, CPL. Стальных нет'),
];

describe('сайты-источники по комментарию (KP-AGENT-V2, п. 4а)', () => {
  it('Аква (90091, 89813): сайт «ДПК Аква» первым, по комментарию; фабрика стальных дверей ниже, без исключения', () => {
    const text = 'Дверь AquaDoor (Аква ДПК ДГ-01), серый RAL 7035 2000×700';
    const plan = planSites(SITES, profileOf(text), text);
    expect(plan.prefer[0]).toMatchObject({ host: 'aquadoor.ru', why: 'по комментарию: «Межкомнатные ДПК Аква, влагостойкие, RAL; коробки и наличники Аква; ГОСТ 475. Стальных нет»' });
    expect(plan.prefer.map((s) => s.host)).toEqual(['aquadoor.ru', 'dveri-shop.ru']);
    expect(plan.excluded).toEqual([]);
    expect(siteWhy('https://www.aquadoor.ru/catalog/dg-01', plan)).toContain('по комментарию');
  });

  it('ДПС / ДСН: сайты со «Стальных нет» не используются; фабрика стальных — первой', () => {
    for (const text of ['Дверь ДПС 01 EI60 ГОСТ Р 57327-2016 2060×780', 'Блок ДСН двупольный 2300×1430 ГОСТ 31173-2016']) {
      const plan = planSites(SITES, profileOf(text), text);
      expect(plan.excluded.map((s) => s.host).sort()).toEqual(['aquadoor.ru', 'mezhkomnatnye.ru']);
      expect(plan.prefer[0]).toMatchObject({ host: 'metall-dveri.ru', factory: true });
      expect(plan.prefer.map((s) => s.host)).not.toContain('aquadoor.ru');
    }
  });

  it('межкомнатная МДФ: подходящий по комментарию — раньше сайта без комментария', () => {
    const text = 'Дверь межкомнатная МДФ ПВХ 2000×800';
    expect(planSites(SITES, profileOf(text), text).prefer.map((s) => s.host)).toEqual(['mezhkomnatnye.ru', 'aquadoor.ru', 'dveri-shop.ru']);
  });
});
