import { describe, expect, it } from 'vitest';
import { knownTopics, parseQuestion } from '../src/question.ts';

describe('parseQuestion', () => {
  it('вырезает метку и возвращает тему', () => {
    const r = parseQuestion('Какие у вас размеры проёма? [Q: razmery]');
    expect(r).toEqual({ topic: 'razmery', text: 'Какие у вас размеры проёма?' });
  });

  it('[Q: none] — вопроса нет, метка убрана', () => {
    const r = parseQuestion('Дверь в наличии.  [Q: none]');
    expect(r).toEqual({ topic: null, text: 'Дверь в наличии.' });
  });

  it('неизвестная тема не блокирует ответ', () => {
    expect(parseQuestion('Текст [Q: pogoda]').topic).toBe(null);
  });

  it('без метки текст не меняется', () => {
    expect(parseQuestion('Ответ без метки')).toEqual({ topic: null, text: 'Ответ без метки' });
  });
});

describe('knownTopics', () => {
  it('пустая память — спрашивать можно всё', () => {
    expect(knownTopics({})).toEqual([]);
    expect(knownTopics(null)).toEqual([]);
  });

  it('проём с размерами закрывает размеры, количество и помещение', () => {
    const t = knownTopics({ openings: [{ room: 'спальня', width_mm: 800, height_mm: 2000 }] });
    expect(t).toEqual(['razmery', 'kolichestvo', 'pomeschenie']);
  });

  it('проём без размеров закрывает только количество', () => {
    expect(knownTopics({ openings: [{ width_mm: 800 }] })).toEqual(['kolichestvo']);
  });

  it('бюджет и предпочтения', () => {
    const t = knownTopics({ budget_rub: 60000, preferences: { coating: 'экошпон', color: 'белый' } });
    expect(t).toEqual(['byudzhet', 'pokrytie', 'cvet']);
  });
});
