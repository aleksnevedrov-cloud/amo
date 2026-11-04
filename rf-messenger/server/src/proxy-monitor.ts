import type { Logger } from './bridge.ts';
import type { MessengerProxy, ProxyRole, ProxySwitch } from './proxy.ts';

/** Результат последней проверки прокси — для /health. Адреса прокси здесь нет. */
export const PROXY_STATUS_KEY = 'rfm:proxy:status';
/** Проверка раз в 60 с; запись живёт 5 мин — если процесс connectors встал, /health покажет «stale». */
export const PROXY_CHECK_INTERVAL_MS = 60_000;
const STATUS_TTL_SEC = 300;
/** Сколько проверок подряд нужно для переключения на запасной и обратно. */
export const SWITCH_AFTER = 3;

export interface ProxyStatus {
  /** ok/fail — текущий прокси отвечает или нет; direct — прокси не задан, всё напрямую. */
  status: 'ok' | 'fail' | 'direct';
  active: ProxyRole;
  checkedAt: string;
  latencyMs: number | null;
  /** С какого времени держится этот статус. */
  since: string;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
}

export type ProxyProbe = (proxy: MessengerProxy) => Promise<ProbeResult>;

/**
 * Проверка через прокси: любой HTTP-ответ сервера (кроме 5xx) за 10 с — прокси работает.
 * Редирект не выполняем, тело не читаем: важно только, что туннель открылся и сервер ответил.
 */
export function httpProbe(url = 'https://api.telegram.org/', f: typeof fetch = fetch, timeoutMs = 10_000): ProxyProbe {
  return async (proxy) => {
    const t0 = Date.now();
    try {
      const res = await f(url, { dispatcher: proxy.dispatcher, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) } as RequestInit);
      await res.body?.cancel().catch(() => undefined);
      return { ok: res.status < 500, latencyMs: Date.now() - t0 };
    } catch {
      return { ok: false, latencyMs: Date.now() - t0 };
    }
  };
}

interface StatusStore {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
}

const ROLE_RU: Record<ProxyRole, string> = { primary: 'основной', fallback: 'запасной' };

/**
 * Раз в минуту проверяет основной прокси (и запасной, когда работает через него),
 * переключает Telegram и WhatsApp на запасной после 3 неудач основного подряд и обратно после 3 удач.
 */
export class ProxyMonitor {
  private primaryFails = 0;
  private primaryOks = 0;
  private last: ProxyStatus | null = null;

  constructor(
    private readonly d: {
      sw: ProxySwitch;
      probe: ProxyProbe;
      redis: StatusStore;
      log: Logger;
      now?: () => Date;
    },
  ) {}

  get status(): ProxyStatus | null {
    return this.last;
  }

  async tick(): Promise<ProxyStatus> {
    const { sw } = this.d;
    let result: ProbeResult | null = null;
    if (sw.primary) {
      const primary = await this.d.probe(sw.primary);
      if (primary.ok) {
        this.primaryOks++;
        this.primaryFails = 0;
      } else {
        this.primaryFails++;
        this.primaryOks = 0;
      }
      if (sw.active === 'primary' && this.primaryFails >= SWITCH_AFTER && sw.fallback) this.switchTo('fallback');
      else if (sw.active === 'fallback' && this.primaryOks >= SWITCH_AFTER) this.switchTo('primary');
      const fallback = sw.active === 'fallback' ? sw.fallback : null;
      result = fallback ? await this.d.probe(fallback) : primary;
    }

    const now = (this.d.now ?? (() => new Date()))().toISOString();
    const status: ProxyStatus['status'] = !result ? 'direct' : result.ok ? 'ok' : 'fail';
    const next: ProxyStatus = {
      status,
      active: sw.active,
      checkedAt: now,
      latencyMs: result ? result.latencyMs : null,
      since: this.last && this.last.status === status && this.last.active === sw.active ? this.last.since : now,
    };
    this.last = next;
    await this.d.redis.set(PROXY_STATUS_KEY, JSON.stringify(next), 'EX', STATUS_TTL_SEC).catch(() => undefined);
    return next;
  }

  private switchTo(role: ProxyRole): void {
    const from = this.d.sw.active;
    if (!this.d.sw.use(role)) return;
    // В журнал — только роль прокси, без адреса, логина и пароля.
    const fields = { from: ROLE_RU[from], to: ROLE_RU[role], checks: SWITCH_AFTER };
    if (role === 'fallback') this.d.log.warn(fields, 'прокси: основной не отвечает, переключение на запасной');
    else this.d.log.info(fields, 'прокси: основной снова отвечает, возврат на основной');
  }
}

/** Для /health: статус из Redis; запись старше 3 мин — «stale» (процесс connectors не проверяет прокси). */
export function readProxyStatus(raw: string | null, now = Date.now()): { proxy: string; proxyActive?: ProxyRole; proxyCheckedAt?: string; proxyLatencyMs?: number | null } {
  if (!raw) return { proxy: 'unknown' };
  try {
    const s = JSON.parse(raw) as ProxyStatus;
    const stale = now - Date.parse(s.checkedAt) > 3 * PROXY_CHECK_INTERVAL_MS;
    return { proxy: stale ? 'stale' : s.status, proxyActive: s.active, proxyCheckedAt: s.checkedAt, proxyLatencyMs: s.latencyMs };
  } catch {
    return { proxy: 'unknown' };
  }
}
