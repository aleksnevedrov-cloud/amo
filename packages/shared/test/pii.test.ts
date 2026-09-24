import { describe, expect, it } from 'vitest';
import { maskPii } from '../src/pii.ts';

describe('maskPii', () => {
  it('маскирует телефоны в разных форматах', () => {
    expect(maskPii('звоните +7 (916) 123-45-67')).toBe('звоните ***67');
    expect(maskPii('8 916 123 45 67, спасибо')).toBe('***67, спасибо');
    expect(maskPii('89161234567')).toBe('***67');
  });

  it('маскирует e-mail', () => {
    expect(maskPii('почта ivan.petrov@mail.ru')).toBe('почта i***@mail.ru');
  });

  it('не трогает размеры и цены', () => {
    const text = 'Проём 800x2000, дверь 12 500 ₽, 3 шт.';
    expect(maskPii(text)).toBe(text);
  });
});
