import type { Logger } from './bridge.ts';
import type { ProxyStatus } from './proxy-monitor.ts';
import type { Channel, ChannelStatus } from './store.ts';

/** Сбой, замеченный при очередной проверке. key — одна и та же проблема между проверками. */
export interface Problem {
  key: string;
  /** Что сломалось: «Канал «…» (id 3, whatsapp)», «Прокси мессенджеров». */
  title: string;
  detail: string;
}

export interface AlertOptions {
  send(text: string): Promise<void>;
  log: Logger;
  now?: () => number;
  /** Сбой дольше этого — уведомление (по умолчанию 5 мин). */
  afterMs?: number;
  /** Не чаще одного уведомления о сбое по одной проблеме (по умолчанию 30 мин). */
  minIntervalMs?: number;
}

const STATUS_RU: Record<ChannelStatus, string> = {
  starting: 'подключается',
  connected: 'подключён',
  no_phone: 'нет связи',
  session_ended: 'сессия завершена',
  error: 'ошибка',
};

const KIND_RU: Record<string, string> = { telegram_bot: 'Telegram-бот', whatsapp: 'WhatsApp' };

/** Каналы, за которыми следим: Telegram-боты и WhatsApp. */
const WATCHED = new Set(['telegram_bot', 'whatsapp']);

const fmt = (ms: number) =>
  `${new Date(ms).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} МСК`;
const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

/** Текущие проблемы: прокси не отвечает; канал Telegram/WhatsApp не в статусе «подключён». */
export function collectProblems(proxy: ProxyStatus | null, channels: readonly Channel[]): Problem[] {
  const out: Problem[] = [];
  if (proxy?.status === 'fail') {
    out.push({
      key: 'proxy',
      title: `Прокси мессенджеров (${proxy.active === 'primary' ? 'основной' : 'запасной'})`,
      detail: 'Нет ответа через прокси — Telegram и WhatsApp без связи',
    });
  }
  for (const c of channels) {
    if (!WATCHED.has(c.kind) || c.status === 'connected') continue;
    out.push({
      key: `channel:${c.id}`,
      title: `Канал «${c.title}» (id ${c.id}, ${KIND_RU[c.kind] ?? c.kind})`,
      detail: `Статус: ${STATUS_RU[c.status] ?? c.status}${c.statusDetail ? ` — ${c.statusDetail}` : ''}`,
    });
  }
  return out;
}

/**
 * Уведомления о сбоях: сообщение, если проблема держится дольше 5 мин, и второе — при восстановлении.
 * По одной проблеме — не чаще одного сообщения о сбое в 30 мин. Состояние в памяти процесса connectors.
 */
export class AlertNotifier {
  private readonly open = new Map<string, { since: number; problem: Problem; alerted: boolean }>();
  private readonly lastAlert = new Map<string, number>();

  constructor(private readonly o: AlertOptions) {}

  async observe(problems: readonly Problem[]): Promise<void> {
    const now = (this.o.now ?? Date.now)();
    const afterMs = this.o.afterMs ?? 5 * 60_000;
    const minIntervalMs = this.o.minIntervalMs ?? 30 * 60_000;
    const seen = new Set<string>();

    for (const p of problems) {
      seen.add(p.key);
      const cur = this.open.get(p.key) ?? { since: now, problem: p, alerted: false };
      cur.problem = p;
      this.open.set(p.key, cur);
      if (cur.alerted || now - cur.since < afterMs) continue;
      const last = this.lastAlert.get(p.key);
      if (last !== undefined && now - last < minIntervalMs) continue;
      const text = `⚠️ РФ-Мессенджер: ${p.title} не работает с ${fmt(cur.since)} (${minutes(now - cur.since)} мин).\n${p.detail}`;
      if (await this.trySend(text, p.key)) {
        cur.alerted = true;
        this.lastAlert.set(p.key, now);
      }
    }

    for (const [key, cur] of [...this.open]) {
      if (seen.has(key)) continue;
      if (cur.alerted) {
        const text = `✅ РФ-Мессенджер: ${cur.problem.title} снова работает. Сбой с ${fmt(cur.since)} по ${fmt(now)} (${minutes(now - cur.since)} мин).`;
        // Не дошло — попробуем на следующей проверке.
        if (!(await this.trySend(text, key))) continue;
      }
      this.open.delete(key);
    }
  }

  private async trySend(text: string, key: string): Promise<boolean> {
    try {
      await this.o.send(text);
      this.o.log.info({ problem: key }, 'уведомление отправлено');
      return true;
    } catch (err) {
      this.o.log.warn({ problem: key, err: (err as Error).message }, 'уведомление не отправлено');
      return false;
    }
  }
}
