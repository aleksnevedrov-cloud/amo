import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Проверка адреса источника-ссылки: только http/https, без логина и пароля, не во внутреннюю сеть (SSRF).
 * Своя копия правила розницы (@retail/catalog): пакеты опта не зависят от розницы (ТЗ разделение, раздел 3).
 */
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const [a = 0, b = 0] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export type Resolver = (host: string) => Promise<string[]>;

export const dnsResolver: Resolver = async (h) => (await lookup(h, { all: true })).map((a) => a.address);

/** Проверка без обращения к DNS (при добавлении ссылки): схема, логин, буквальный внутренний IP, localhost. */
export function parsePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('Некорректный адрес');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Разрешены только http и https');
  if (url.username || url.password) throw new Error('Адрес не должен содержать логин и пароль');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || (isIP(host) && isPrivateIp(host))) throw new Error('Адрес указывает во внутреннюю сеть');
  return url;
}

/** Полная проверка перед скачиванием: то же плюс разрешение имени — все адреса должны быть публичными. */
export async function assertPublicUrl(raw: string, resolve: Resolver = dnsResolver): Promise<URL> {
  const url = parsePublicUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addrs: string[];
  try {
    addrs = isIP(host) ? [host] : await resolve(host);
  } catch {
    throw new Error(`Адрес ${host} не найден (DNS)`);
  }
  if (!addrs.length || addrs.some(isPrivateIp)) throw new Error('Адрес указывает во внутреннюю сеть');
  return url;
}
