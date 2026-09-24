import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const TTL_MS = 15 * 60_000;

/** Stateless state для OAuth: nonce.timestamp.hmac, подписан client_secret. */
export function createState(secret: string, now = Date.now()): string {
  const payload = `${randomBytes(12).toString('base64url')}.${now}`;
  return `${payload}.${sign(secret, payload)}`;
}

export function verifyState(secret: string, state: string, now = Date.now()): boolean {
  const parts = state.split('.');
  if (parts.length !== 3) return false;
  const [nonce, ts, mac] = parts as [string, string, string];
  const expected = sign(secret, `${nonce}.${ts}`);
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  const age = now - Number(ts);
  return Number.isFinite(age) && age >= 0 && age <= TTL_MS;
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(`oauth-state:${payload}`).digest('base64url');
}
