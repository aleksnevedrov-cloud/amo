import type { TokenService } from '@ai-door/amo';

export const MAINTENANCE_QUEUE = 'maintenance';
export const REFRESH_TOKENS_JOB = 'refresh-tokens';
export const REFRESH_EVERY_MS = 30 * 60_000;

export interface JobLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/** Плановое обновление токенов amo, которые скоро истекут. */
export async function runRefreshTokens(tokenService: TokenService, log: JobLogger) {
  const result = await tokenService.refreshExpiring();
  if (result.failed.length) log.warn(result, 'amo: часть токенов не обновилась');
  else log.info(result, 'amo: плановое обновление токенов');
  return result;
}
