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

export type Resolver = (host: string) => Promise<string[]>;
const dnsResolve: Resolver = async (h) => (await lookup(h, { all: true })).map((a) => a.address);

/** Запрет внутренних адресов (SSRF). */
export async function assertPublicUrl(raw: string, resolve: Resolver = dnsResolve): Promise<URL> {
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

export function hostAllowed(url: URL, allowedDomains: readonly string[]): boolean {
  const h = url.hostname.toLowerCase();
  return allowedDomains.some((d) => h === d || h.endsWith(`.${d}`));
}

/**
 * Скачивание вложения из amoCRM: только https, только домены amo, без внутренних адресов,
 * с проверкой каждого редиректа и лимитом размера.
 */
export async function downloadFromAmo(
  raw: string,
  opts: { allowedDomains: readonly string[]; maxBytes: number; fetch?: typeof fetch; resolve?: Resolver },
): Promise<{ data: Buffer; mime: string }> {
  const f = opts.fetch ?? fetch;
  let current = raw;
  for (let hop = 0; hop < 4; hop++) {
    const url = await assertPublicUrl(current, opts.resolve);
    if (url.protocol !== 'https:' || !hostAllowed(url, opts.allowedDomains)) throw new Error('Вложение не с домена amoCRM');
    const res = await f(url, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error('Редирект без адреса');
      current = new URL(loc, url).toString();
      continue;
    }
    if (!res.ok || !res.body) throw new Error(`Вложение не скачано: HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > opts.maxBytes) throw new Error('Вложение больше допустимого размера');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > opts.maxBytes) throw new Error('Вложение больше допустимого размера');
      chunks.push(Buffer.from(chunk));
    }
    return { data: Buffer.concat(chunks), mime: res.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream' };
  }
  throw new Error('Слишком много редиректов');
}
