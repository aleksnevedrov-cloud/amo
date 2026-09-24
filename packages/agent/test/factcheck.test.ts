import { describe, expect, it } from 'vitest';
import { checkFacts, numbersIn } from '../src/factcheck.ts';

const tool = JSON.stringify({ products: [{ id: '1001', price_rub: 14900, availability: 'в наличии' }], fragments: [{ text: 'Доставка 1500 ₽, сроки 2-3 дня, под заказ 14-21 рабочий день' }] });
const base = { toolResults: [tool], clientTexts: ['Бюджет до 20 000 рублей'], catalogConsulted: true };

describe('numbersIn', () => {
  it('понимает разделители разрядов и диапазоны', () => {
    expect([...numbersIn('14 900 ₽ и 2–3 дня, 1500')]).toEqual(expect.arrayContaining([14900, 2, 3, 1500]));
  });
});

describe('checkFacts', () => {
  it.each([
    'Турин 1 стоит 14 900 ₽, есть в наличии.',
    'Цена — 14900 руб.',
    'Доставка 1500 рублей, привезём за 2-3 дня.',
    'Под заказ срок 14–21 рабочий день.',
    'В пределах вашего бюджета 20 000 ₽ подойдёт Турин 1.',
    'Цена 14,9 тыс. ₽',
    'Подберу дверь шириной 800 мм.',
    'Под заказ около 3 недель (21 рабочий день).',
  ])('пропускает подтверждённое: %s', (reply) => {
    expect(checkFacts({ ...base, reply })).toEqual([]);
  });

  it.each([
    ['Турин 1 стоит 12 900 ₽.', 'price'],
    ['Со скидкой будет 13000 р.', 'price'],
    ['Привезём за 5 дней.', 'term'],
    ['Изготовим за 5 недель.', 'term'],
    ['Гарантия 3 месяца.', 'term'],
    ['Установим за 3 часа.', 'term'],
  ])('ловит выдуманное: %s', (reply, kind) => {
    expect(checkFacts({ ...base, reply }).map((v) => v.kind)).toContain(kind);
  });

  it('наличие без обращения к каталогу — нарушение', () => {
    expect(checkFacts({ ...base, catalogConsulted: false, reply: 'Эта модель есть в наличии.' })[0]?.kind).toBe('availability');
    expect(checkFacts({ ...base, reply: 'Эта модель есть в наличии.' })).toEqual([]);
  });

  it('запрещённые темы', () => {
    const v = checkFacts({ ...base, reply: 'Кстати, у конкурентов дешевле', forbiddenTopics: ['конкурент'] });
    expect(v[0]?.kind).toBe('forbidden_topic');
  });

  it('номер модели перед тире не считается ценой', () => {
    const v = checkFacts({ toolResults: ['{"price_rub":14900}'], clientTexts: [], catalogConsulted: true, reply: 'Турин 1 — 14 900 ₽; Порта 50 – 14900 руб.' });
    expect(v).toEqual([]);
  });

  it('проверяет обе границы диапазона цены', () => {
    expect(checkFacts({ ...base, reply: 'Цены от 14 900 до 99 000 ₽' }).map((v) => v.value)).toEqual([99000]);
  });
});
