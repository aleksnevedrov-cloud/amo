import { describe, expect, it } from 'vitest';
import { buildKpNote, classifyKpRequest } from '../src/kp-request.ts';

const base = { fromAddress: 'a.popkova@gknova.com', subject: '', text: '' };

describe('письмо с запросом КП', () => {
  it('узнаёт запрос ТКП по теме', () => {
    const v = classifyKpRequest({ ...base, subject: 'Запрос ТКП на двери' });
    expect(v.isRequest).toBe(true);
    expect(v.isBulk).toBe(false);
    expect(v.matched).toContain('ткп');
  });

  it('узнаёт «коммерческое предложение» в теле письма', () => {
    const v = classifyKpRequest({
      ...base,
      subject: 'Двери',
      text: 'Добрый день! Просим направить коммерческое предложение на 12 дверей.',
    });
    expect(v.isRequest).toBe(true);
  });

  it('считает «КП» отдельным словом, но не частью другого', () => {
    expect(classifyKpRequest({ ...base, subject: 'Нужно КП до пятницы' }).isRequest).toBe(true);
    expect(classifyKpRequest({ ...base, subject: 'Договор КПП-12 на поставку' }).isRequest).toBe(
      false,
    );
  });

  it('не трогает рассылку: вложения скачаются, но разбора не будет', () => {
    const v = classifyKpRequest({
      ...base,
      fromAddress: 'noreply@shop.example',
      subject: 'Скидки недели: прайс внутри',
    });
    expect(v.isBulk).toBe(true);
    expect(v.isRequest).toBe(false);
  });

  it('отписку по теме тоже считает рассылкой', () => {
    const v = classifyKpRequest({
      ...base,
      subject: 'Наша рассылка: новые прайсы',
      text: 'отписаться',
    });
    expect(v.isBulk).toBe(true);
  });

  it('обычное письмо без признаков запросом не считает', () => {
    const v = classifyKpRequest({ ...base, subject: 'Отгрузили заказ', text: 'Машина вышла.' });
    expect(v.isRequest).toBe(false);
    expect(v.isBulk).toBe(false);
  });

  it('собирает примечание с темой, отправителем и вложениями', () => {
    const note = buildKpNote({
      subject: 'Запрос ТКП',
      fromName: 'Анастасия Попкова',
      fromAddress: 'a.popkova@gknova.com',
      text: 'Нужны двери 2100*900, 12 шт, цена с НДС.',
      matched: ['ткп'],
      files: [
        { filename: 'spec.pdf', text: 'ДВЕРЬ ДЕРЕВЯННАЯ 2100*900 — 12 шт' },
        { filename: 'scan.png', error: 'модель недоступна' },
      ],
    });
    expect(note).toContain('Запрос КП: Запрос ТКП');
    expect(note).toContain('Анастасия Попкова <a.popkova@gknova.com>');
    expect(note).toContain('spec.pdf: ДВЕРЬ ДЕРЕВЯННАЯ');
    expect(note).toContain('scan.png — разобрать не удалось');
    expect(note.length).toBeLessThanOrEqual(3000);
  });

  it('режет длинный текст письма', () => {
    const note = buildKpNote({
      subject: 'КП',
      fromName: '',
      fromAddress: 'x@y.z',
      text: 'я'.repeat(5000),
      matched: [],
      files: [],
    });
    expect(note.length).toBeLessThanOrEqual(3000);
    expect(note).toContain('…');
  });
});
