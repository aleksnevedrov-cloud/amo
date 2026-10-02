import { describe, expect, it } from 'vitest';
import { normalizePhone } from '../src/wazzup.ts';

describe('normalizePhone', () => {
  it('приводит номера к формату chatId Wazzup (7XXXXXXXXXX)', () => {
    expect(normalizePhone('+7 977 379-34-80')).toBe('79773793480');
    expect(normalizePhone('8 (929) 541-86-63')).toBe('79295418663');
    expect(normalizePhone('9295418663')).toBe('79295418663');
    expect(normalizePhone('79295418663')).toBe('79295418663');
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone('12345')).toBeNull();
  });
});
