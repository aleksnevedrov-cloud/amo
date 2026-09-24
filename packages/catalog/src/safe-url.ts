import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function isPrivate(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivate(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const [a = 0, b = 0] = ip.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

/**
 * Адрес фида задаёт администратор аккаунта. Запрещаем внутренние адреса,
 * иначе через импорт можно было бы обращаться к сервисам нашей сети (SSRF).
 */
export async function assertPublicUrl(
  raw: string,
  resolve: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((a) => a.address),
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Некорректный адрес');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Разрешены только http и https');
  if (url.username || url.password) throw new Error('Адрес не должен содержать логин и пароль');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : await resolve(host);
  if (!addrs.length || addrs.some(isPrivate)) throw new Error('Адрес указывает во внутреннюю сеть');
  return url;
}
