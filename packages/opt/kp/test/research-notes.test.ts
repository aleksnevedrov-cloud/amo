import { describe, expect, it } from 'vitest';
import { limitationNotes, priceStatus, TARGET_SOURCES } from '../src/research-notes.ts';

describe('статус цены и пометки ограничений (без блокировки при малом числе источников)', () => {
  it('один источник — цена ставится с пометкой «ограничение расчёта: 1 источник»; три и больше — без пометки', () => {
    expect(TARGET_SOURCES).toBe(3);
    expect(priceStatus({ sources: 1 })).toBe('ok');
    expect(limitationNotes({ sources: 1 })).toEqual(['ограничение расчёта: 1 источник']);
    expect(limitationNotes({ sources: 2 })).toEqual(['ограничение расчёта: 2 источника']);
    expect(limitationNotes({ sources: 3 })).toEqual([]);
    expect(limitationNotes({ sources: 5 })).toEqual([]);
  });

  it('цена только по аналогу ставится с пометкой «предварительно, по аналогу»', () => {
    expect(limitationNotes({ sources: 4, byAnalog: true })).toEqual(['предварительно, по аналогу']);
    expect(limitationNotes({ sources: 1, byAnalog: true })).toEqual(['ограничение расчёта: 1 источник', 'предварительно, по аналогу']);
  });

  it('нет источников или поиск упал — цена не ставится, пометок нет', () => {
    expect(priceStatus({ sources: 0 })).toBe('none');
    expect(priceStatus({ sources: 2, failed: true })).toBe('failed');
    expect(limitationNotes({ sources: 0 })).toEqual([]);
    expect(limitationNotes({ sources: 2, failed: true })).toEqual([]);
  });
});
