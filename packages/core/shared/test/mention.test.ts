import { describe, expect, it } from 'vitest';
import { hasMention, stripMention } from '../src/mention.ts';

const WORD = '@Амма';

describe('hasMention', () => {
  it('обращение с «@» в начале сообщения', () => {
    expect(hasMention('@Амма, какие покрытия влагостойкие?', WORD)).toBe(true);
  });

  it('без «@» и в другом регистре', () => {
    expect(hasMention('амма, посчитай дверь', WORD)).toBe(true);
    expect(hasMention('АММА посчитай дверь', WORD)).toBe(true);
  });

  it('обращение в середине сообщения', () => {
    expect(hasMention('Коллеги, @Амма подскажет по срокам', WORD)).toBe(true);
  });

  it('обращение в самом конце', () => {
    expect(hasMention('Посчитай, пожалуйста, @Амма', WORD)).toBe(true);
  });

  it('обращения нет', () => {
    expect(hasMention('Влад, созвонимся в 15:00', WORD)).toBe(false);
  });

  it('часть другого слова обращением не считается', () => {
    expect(hasMention('Аммиак привезли', WORD)).toBe(false);
    expect(hasMention('Гамма цветов', WORD)).toBe(false);
  });

  it('пустой текст и пустое слово-обращение', () => {
    expect(hasMention('', WORD)).toBe(false);
    expect(hasMention(null, WORD)).toBe(false);
    expect(hasMention('что угодно', '@')).toBe(false);
  });
});

describe('stripMention', () => {
  it('вырезает обращение из начала вместе с запятой', () => {
    expect(stripMention('@Амма, какие покрытия влагостойкие?', WORD)).toBe('какие покрытия влагостойкие?');
  });

  it('вырезает обращение без «@»', () => {
    expect(stripMention('амма, посчитай дверь', WORD)).toBe('посчитай дверь');
  });

  it('вырезает обращение из середины, не склеивая слова', () => {
    expect(stripMention('Коллеги, @Амма подскажет по срокам', WORD)).toBe('Коллеги, подскажет по срокам');
  });

  it('текст без обращения не меняется', () => {
    expect(stripMention('Влад, созвонимся в 15:00', WORD)).toBe('Влад, созвонимся в 15:00');
  });

  it('пустое слово-обращение оставляет текст как есть', () => {
    expect(stripMention('Амма, привет', '@')).toBe('Амма, привет');
  });

  it('сообщение из одного обращения превращается в пустую строку', () => {
    expect(stripMention('@Амма', WORD)).toBe('');
  });
});
