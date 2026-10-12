/**
 * Проверяет, что referer из redirect amo — домен аккаунта amo.
 * Критично: на этот домен мы отправляем client_secret, поэтому
 * произвольный хост (SSRF / утечка секрета) недопустим.
 */
export function normalizeAccountDomain(referer: string, allowed: readonly string[]): string | null {
  let host = referer.trim().toLowerCase();
  if (host.includes('://')) {
    try {
      host = new URL(host).host;
    } catch {
      return null;
    }
  }
  // Только поддомен вида <subdomain>.<allowed>, без порта, пути и пользователя.
  if (!/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9-]+)+$/.test(host)) return null;
  const ok = allowed.some((d) => {
    if (!host.endsWith(`.${d}`)) return false;
    const sub = host.slice(0, -d.length - 1);
    return sub.length > 0 && !sub.includes('.');
  });
  return ok ? host : null;
}
