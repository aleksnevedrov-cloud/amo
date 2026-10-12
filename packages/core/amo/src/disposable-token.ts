import { jwtVerify } from 'jose';
import { z } from 'zod';

/**
 * Одноразовый токен виджета: виджет вызывает `this.$authorizedAjax(...)`,
 * amo добавляет заголовок `X-Auth-Token` с JWT (HS256, ключ — client_secret,
 * aud — scheme://host redirect URI интеграции). Сверено с официальной
 * библиотекой amocrm/amocrm-api-php (AmoCRMOAuth::parseDisposableToken).
 */
const claimsSchema = z.object({
  jti: z.string(),
  iss: z.string(),
  subdomain: z.string(),
  account_id: z.coerce.number().int().positive(),
  user_id: z.coerce.number().int().positive(),
  client_uuid: z.string(),
  is_admin: z.coerce.boolean().optional().default(false),
});

export interface WidgetPrincipal {
  tokenId: string;
  accountId: number;
  userId: number;
  subdomain: string;
  accountDomain: string;
  isAdmin: boolean;
}

export async function verifyDisposableToken(
  token: string,
  opts: { clientSecret: string; clientId: string; audience: string; now?: Date },
): Promise<WidgetPrincipal> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(opts.clientSecret), {
    algorithms: ['HS256'],
    audience: opts.audience,
    clockTolerance: 30,
    ...(opts.now ? { currentDate: opts.now } : {}),
  });
  const c = claimsSchema.parse(payload);
  if (c.client_uuid !== opts.clientId) throw new Error('Токен выпущен для другой интеграции');
  return {
    tokenId: c.jti,
    accountId: c.account_id,
    userId: c.user_id,
    subdomain: c.subdomain,
    accountDomain: c.iss.replace(/^https?:\/\//, ''),
    isAdmin: c.is_admin,
  };
}

/** aud одноразового токена: scheme://host адреса перенаправления. */
export function disposableTokenAudience(redirectUri: string): string {
  const u = new URL(redirectUri);
  return `${u.protocol}//${u.host}`;
}
