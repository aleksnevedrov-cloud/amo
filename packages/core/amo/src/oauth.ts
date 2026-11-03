import { z } from 'zod';
import { AmoAuthRevokedError, AmoError } from './errors.ts';

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: typeof fetch;
}

const tokenResponseSchema = z.object({
  token_type: z.string(),
  expires_in: z.number().int().positive(),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
});

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export class AmoOAuth {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: OAuthConfig) {
    this.fetchImpl = cfg.fetch ?? fetch;
  }

  /** Обмен кода авторизации (из redirect или из вкладки «Ключи и доступы») на токены. */
  exchangeCode(accountDomain: string, code: string, now = new Date()): Promise<TokenPair> {
    return this.request(accountDomain, { grant_type: 'authorization_code', code }, now);
  }

  /** Обновление пары токенов. Старый refresh-токен после этого недействителен. */
  refresh(accountDomain: string, refreshToken: string, now = new Date()): Promise<TokenPair> {
    return this.request(accountDomain, { grant_type: 'refresh_token', refresh_token: refreshToken }, now);
  }

  private async request(
    accountDomain: string,
    grant: Record<string, string>,
    now: Date,
  ): Promise<TokenPair> {
    const res = await this.fetchImpl(`https://${accountDomain}/oauth2/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        redirect_uri: this.cfg.redirectUri,
        ...grant,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = `amo OAuth ${grant.grant_type}: HTTP ${res.status}`;
      // 400/401 на refresh означает отозванный или уже использованный токен.
      if (grant.grant_type === 'refresh_token' && (res.status === 400 || res.status === 401)) {
        throw new AmoAuthRevokedError(msg, res.status, body);
      }
      throw new AmoError(msg, res.status, body);
    }
    const parsed = tokenResponseSchema.safeParse(body);
    if (!parsed.success) throw new AmoError('amo OAuth: неожиданный формат ответа', res.status);
    return {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      expiresAt: new Date(now.getTime() + parsed.data.expires_in * 1000),
    };
  }
}
