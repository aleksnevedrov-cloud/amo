import { describe, expect, it } from 'vitest';
import { normalizeAccountDomain } from '../src/domain.ts';

const allowed = ['amocrm.ru', 'amocrm.com', 'kommo.com'];

describe('normalizeAccountDomain', () => {
  it.each([
    ['aleksnevedrov.amocrm.ru', 'aleksnevedrov.amocrm.ru'],
    ['ALEKSNEVEDROV.amocrm.ru', 'aleksnevedrov.amocrm.ru'],
    ['https://aleksnevedrov.amocrm.ru', 'aleksnevedrov.amocrm.ru'],
    ['test.kommo.com', 'test.kommo.com'],
  ])('принимает %s', (input, expected) => {
    expect(normalizeAccountDomain(input, allowed)).toBe(expected);
  });

  it.each([
    'evil.com',
    'amocrm.ru',
    'aleksnevedrov.amocrm.ru.evil.com',
    'evilamocrm.ru',
    'a.b.amocrm.ru',
    'aleksnevedrov.amocrm.ru:8080',
    'user@aleksnevedrov.amocrm.ru',
    'aleksnevedrov.amocrm.ru/path',
    '',
  ])('отклоняет %s', (input) => {
    expect(normalizeAccountDomain(input, allowed)).toBeNull();
  });
});
