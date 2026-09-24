import { describe, expect, it } from 'vitest';
import { amoRedirectUri, loadEnv } from '../src/env.ts';

const base = {
  PUBLIC_URL: 'https://ai.example.ru',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  AMO_CLIENT_ID: '8b4f5e3a-2c1d-4e5f-9a8b-7c6d5e4f3a2b',
  AMO_CLIENT_SECRET: 'x'.repeat(32),
  TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
};

describe('loadEnv', () => {
  it('разбирает корректную конфигурацию и ставит значения по умолчанию', () => {
    const env = loadEnv(base);
    expect(env.API_PORT).toBe(3000);
    expect(env.AMO_ALLOWED_DOMAINS).toEqual(['amocrm.ru', 'amocrm.com', 'kommo.com']);
  });

  it('падает с понятной ошибкой без секрета', () => {
    expect(() => loadEnv({ ...base, AMO_CLIENT_SECRET: undefined })).toThrow(/AMO_CLIENT_SECRET/);
  });

  it('проверяет длину ключа шифрования', () => {
    expect(() => loadEnv({ ...base, TOKEN_ENCRYPTION_KEY: 'abc' })).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it('строит redirect URI', () => {
    expect(amoRedirectUri({ PUBLIC_URL: 'https://ai.example.ru/' })).toBe(
      'https://ai.example.ru/oauth/amo/callback',
    );
  });
});
