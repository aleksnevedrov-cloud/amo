import { jwtVerify } from 'jose';
import { z } from 'zod';

/**
 * Одноразовый токен виджета: `self.$authorizedAjax` добавляет заголовок X-Auth-Token —
 * JWT HS256, ключ — client_secret интеграции, aud — scheme://host адреса перенаправления.
 */
const claimsSchema = z.object({
  jti: z.string(),
  iss: z.string(),
  account_id: z.coerce.number().int().positive(),
  user_id: z.coerce.number().int().positive(),
  client_uuid: z.string(),
  is_admin: z.coerce.boolean().optional().default(false),
});

export interface Principal {
  tokenId: string;
  accountId: number;
  userId: number;
  isAdmin: boolean;
}

export async function verifyWidgetToken(
  token: string,
  opts: { clientSecret: string; clientId: string; audience: string; now?: Date },
): Promise<Principal> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(opts.clientSecret), {
    algorithms: ['HS256'],
    audience: opts.audience,
    clockTolerance: 30,
    ...(opts.now ? { currentDate: opts.now } : {}),
  });
  const c = claimsSchema.parse(payload);
  if (c.client_uuid !== opts.clientId) throw new Error('Токен выпущен для другой интеграции');
  return { tokenId: c.jti, accountId: c.account_id, userId: c.user_id, isAdmin: c.is_admin };
}

export function tokenAudience(publicUrl: string): string {
  const u = new URL(publicUrl);
  return `${u.protocol}//${u.host}`;
}

/** Origin виджета — домен аккаунта amo из allowlist. */
export function isAmoOrigin(origin: string, allowed: readonly string[]): boolean {
  let host: string;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'https:') return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowed.some((d) => host.endsWith(`.${d}`));
}
