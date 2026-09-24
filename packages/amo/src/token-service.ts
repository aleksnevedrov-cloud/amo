import type { Alerter } from '@ai-door/shared';
import { AmoAuthRevokedError } from './errors.ts';
import type { AmoOAuth, TokenPair } from './oauth.ts';

export interface StoredTokens extends TokenPair {
  accountId: number;
  accountDomain: string;
}

/**
 * Хранилище токенов. `withLock` обязан сериализовать доступ по аккаунту
 * (например, SELECT ... FOR UPDATE): refresh-токен amo одноразовый,
 * два параллельных обновления = потерянная авторизация.
 */
export interface TokenStore {
  withLock<T>(accountId: number, fn: (current: StoredTokens | null, save: (t: TokenPair) => Promise<void>) => Promise<T>): Promise<T>;
  markError(accountId: number, error: string): Promise<void>;
  listExpiring(before: Date): Promise<number[]>;
}

export class TokenService {
  constructor(
    private readonly store: TokenStore,
    private readonly oauth: AmoOAuth,
    private readonly marginMs: number,
    private readonly alerter?: Alerter,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Возвращает действующий access-токен, при необходимости обновив пару. */
  async getAccessToken(accountId: number): Promise<string> {
    // Ошибку обновления фиксируем уже после выхода из withLock: запись в заблокированную
    // строку из другого соединения внутри блокировки привела бы к дедлоку.
    type Outcome = { token: string } | { error: unknown; accountDomain: string };
    const result = await this.store.withLock<Outcome>(accountId, async (current, save) => {
      if (!current) throw new Error(`Нет токенов amo для аккаунта ${accountId}`);
      if (current.expiresAt.getTime() - this.clock().getTime() > this.marginMs) {
        return { token: current.accessToken };
      }
      let fresh: TokenPair;
      try {
        fresh = await this.oauth.refresh(current.accountDomain, current.refreshToken, this.clock());
      } catch (error) {
        return { error, accountDomain: current.accountDomain };
      }
      await save(fresh);
      return { token: fresh.accessToken };
    });
    if ('token' in result) return result.token;
    await this.reportFailure(accountId, result.accountDomain, result.error);
    throw result.error;
  }

  /** Плановое обновление всех токенов, срок которых подходит к концу. */
  async refreshExpiring(): Promise<{ refreshed: number[]; failed: number[] }> {
    const ids = await this.store.listExpiring(new Date(this.clock().getTime() + this.marginMs));
    const refreshed: number[] = [];
    const failed: number[] = [];
    for (const id of ids) {
      try {
        await this.getAccessToken(id);
        refreshed.push(id);
      } catch {
        failed.push(id);
      }
    }
    return { refreshed, failed };
  }

  private async reportFailure(accountId: number, accountDomain: string, err: unknown): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    await this.store.markError(accountId, msg).catch(() => undefined);
    const revoked = err instanceof AmoAuthRevokedError;
    await this.alerter
      ?.alert(
        revoked
          ? `amo ${accountDomain}: refresh-токен отклонён, нужна повторная авторизация интеграции`
          : `amo ${accountDomain}: ошибка обновления токена: ${msg}`,
      )
      .catch(() => undefined);
  }
}
