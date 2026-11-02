import { describe, expect, it } from 'vitest';
import { priceListKeyOf, priceListTitleOf } from '../src/price-key.ts';

describe('ключ прайса по имени файла (RFD-AI-AGENT-OPT-KB-MULTIPRICE)', () => {
  it('расширение, подчёркивания, версии и даты в хвосте не влияют на ключ', () => {
    expect(priceListKeyOf('Прайс_межкомнатные_двери_ГОСТ.xlsx')).toBe('прайс межкомнатные двери гост');
    expect(priceListKeyOf('Прайс_межкомнатные_двери_ГОСТ — обновил 16102026.xlsx')).toBe('прайс межкомнатные двери гост');
    expect(priceListKeyOf('Прайс_межкомнатные_двери_ГОСТ (2).xlsx')).toBe('прайс межкомнатные двери гост');
    expect(priceListKeyOf('Прайс межкомнатные двери ГОСТ v2.xlsx')).toBe('прайс межкомнатные двери гост');
    expect(priceListKeyOf('Прайс межкомнатные двери ГОСТ от 16.10.2026.xlsx')).toBe('прайс межкомнатные двери гост');
    expect(priceListKeyOf('Прайс межкомнатные двери ГОСТ 2026-10-16 копия.xlsx')).toBe('прайс межкомнатные двери гост');
    expect(priceListKeyOf('Прайс_металлические_двери_ГОСТ.xlsx')).toBe('прайс металлические двери гост');
    expect(priceListKeyOf('прайс ДВ v2.xlsx')).toBe('прайс дв');
    expect(priceListKeyOf('475-2016 CPL.xlsx')).toBe('475-2016 cpl');
    expect(priceListKeyOf('прайс Текона 01.10.2026.xlsx')).toBe('прайс текона');
    expect(priceListKeyOf('2026.xlsx')).toBe('2026');
    expect(priceListKeyOf('')).toBe('');
  });

  it('короткое название для сводки: без слов «прайс», «двери», «ГОСТ»', () => {
    expect(priceListTitleOf('прайс межкомнатные двери гост')).toBe('Межкомнатные');
    expect(priceListTitleOf('прайс металлические двери гост')).toBe('Металлические');
    expect(priceListTitleOf('475-2016 cpl')).toBe('475-2016 cpl');
    expect(priceListTitleOf('прайс текона')).toBe('Текона');
    expect(priceListTitleOf('прайс двери')).toBe('Прайс двери');
    expect(priceListTitleOf(null)).toBe('');
  });
});
