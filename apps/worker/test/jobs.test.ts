import { describe, expect, it, vi } from 'vitest';
import type { TokenService } from '@ai-door/amo';
import { runRefreshTokens } from '../src/jobs.ts';

const log = () => ({ info: vi.fn(), warn: vi.fn() });

describe('runRefreshTokens', () => {
  it('логирует успешное обновление', async () => {
    const svc = { refreshExpiring: async () => ({ refreshed: [1], failed: [] }) } as unknown as TokenService;
    const l = log();
    await expect(runRefreshTokens(svc, l)).resolves.toEqual({ refreshed: [1], failed: [] });
    expect(l.info).toHaveBeenCalled();
  });

  it('предупреждает о сбоях', async () => {
    const svc = { refreshExpiring: async () => ({ refreshed: [], failed: [2] }) } as unknown as TokenService;
    const l = log();
    await runRefreshTokens(svc, l);
    expect(l.warn).toHaveBeenCalled();
  });
});
