import { createHash } from 'node:crypto';
import { hmacHex, safeEqualHex } from '../crypto.ts';

/**
 * Подпись запросов к API чатов amoCRM (amojo), версия v2:
 * X-Signature = HMAC-SHA1(секрет канала, METHOD \n Content-MD5 \n Content-Type \n Date \n path), hex в нижнем регистре.
 * Content-MD5 — md5 тела в hex нижнего регистра.
 */
export function signAmojoRequest(
  secret: string,
  req: { method: string; path: string; body: string; date: string; contentType?: string },
): { 'Content-Type': string; 'Content-MD5': string; Date: string; 'X-Signature': string } {
  const contentType = req.contentType ?? 'application/json';
  const md5 = createHash('md5').update(req.body, 'utf8').digest('hex');
  const canonical = [req.method.toUpperCase(), md5, contentType, req.date, req.path].join('\n');
  return { 'Content-Type': contentType, 'Content-MD5': md5, Date: req.date, 'X-Signature': hmacHex('sha1', secret, canonical) };
}

/** Подпись вебхука amo об исходящем сообщении: X-Signature = HMAC-SHA1(секрет канала, сырое тело). */
export function verifyAmojoHook(secret: string, rawBody: string | Buffer, signature: string | undefined): boolean {
  if (!signature || !/^[0-9a-fA-F]{40}$/.test(signature)) return false;
  if (safeEqualHex(hmacHex('sha1', secret, rawBody), signature)) return true;
  // amoCRM присылает JSON с завершающим переводом строки, а подписывает тело без него
  // (замер на боевом вебхуке 04.11.2026). Проверяем и этот вариант.
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  let end = buf.length;
  while (end > 0 && (buf[end - 1] === 0x0a || buf[end - 1] === 0x0d || buf[end - 1] === 0x20)) end--;
  return end !== buf.length && safeEqualHex(hmacHex('sha1', secret, buf.subarray(0, end)), signature);
}
