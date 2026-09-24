import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox } from '../src/crypto.ts';

const key = randomBytes(32).toString('hex');

describe('SecretBox', () => {
  it('шифрует и расшифровывает', () => {
    const box = new SecretBox(key);
    const sealed = box.encrypt('refresh-token-значение');
    expect(sealed).not.toContain('refresh-token');
    expect(box.decrypt(sealed)).toBe('refresh-token-значение');
  });

  it('каждый раз даёт разный шифротекст', () => {
    const box = new SecretBox(key);
    expect(box.encrypt('x')).not.toBe(box.encrypt('x'));
  });

  it('отвергает подменённые данные', () => {
    const box = new SecretBox(key);
    const parts = box.encrypt('secret').split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => box.decrypt(parts.join(':'))).toThrow();
  });

  it('не расшифровывает чужим ключом', () => {
    const sealed = new SecretBox(key).encrypt('secret');
    expect(() => new SecretBox(randomBytes(32).toString('hex')).decrypt(sealed)).toThrow();
  });

  it('требует 32-байтовый ключ', () => {
    expect(() => new SecretBox('abcd')).toThrow();
  });
});
