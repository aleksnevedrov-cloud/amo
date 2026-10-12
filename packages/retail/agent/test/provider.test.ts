import { describe, expect, it } from 'vitest';
import type { LlmClient } from '../src/llm.ts';
import { createAiProvider } from '../src/provider.ts';

describe('createAiProvider', () => {
  const made: string[] = [];
  const make = (key: string): LlmClient => {
    made.push(key);
    return { create: async () => ({}) as never };
  };

  it('ключ аккаунта приоритетнее серверного; клиенты кэшируются по ключу', async () => {
    const keys = new Map([[1, 'sk-acc-1']]);
    const ai = createAiProvider(async (id) => keys.get(id) ?? null, 'sk-server', make);
    const a = await ai(1);
    const b = await ai(2);
    expect(a?.source).toBe('account');
    expect(b?.source).toBe('server');
    expect(await ai(1)).toBe(a);
    expect(await ai(3)).toBe(b);
    expect(made).toEqual(['sk-acc-1', 'sk-server']);
  });

  it('без ключей — null', async () => {
    const ai = createAiProvider(async () => null, undefined, make);
    expect(await ai(1)).toBeNull();
  });
});
