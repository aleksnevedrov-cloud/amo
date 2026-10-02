import type { Db } from './pool.ts';

/** Сообщение мессенджера из Wazzup (вебхук или импорт). */
export interface WazzupMessage {
  messageId: string;
  channelId: string | null;
  chatId: string;
  chatType: string | null;
  phone: string | null;
  direction: 'in' | 'out';
  author: 'client' | 'manager' | 'agent' | 'unknown';
  text: string;
  status: string | null;
  isSystem: boolean;
  sentAt: Date;
  source: 'webhook' | 'dump';
  raw?: unknown;
}

export interface WazzupHistoryItem {
  direction: 'in' | 'out';
  author: string;
  text: string;
  sentAt: Date;
  chatType: string | null;
}

export interface WazzupState {
  webhookUri: string | null;
  subscribedAt: Date | null;
  lastEventAt: Date | null;
  eventsTotal: number;
  lastError: string | null;
  lastErrorAt: Date | null;
}

/** Телефон к виду 11 цифр (7XXXXXXXXXX); не телефон (Telegram username) — null. */
export function normalizePhone(v: string | null | undefined): string | null {
  if (!v) return null;
  let d = String(v).replace(/\D+/g, '');
  if (d.length === 10) d = '7' + d;
  if (d.length === 11 && d.startsWith('8')) d = '7' + d.slice(1);
  return d.length >= 11 && d.length <= 15 ? d : null;
}

export class WazzupRepo {
  constructor(private readonly db: Db) {}

  /** Вставка по message_id идемпотентна; повтор с тем же id обновляет только статус и пустой текст. */
  async upsert(accountId: number, m: WazzupMessage): Promise<boolean> {
    const { rows } = await this.db.query(
      `INSERT INTO wazzup_messages (account_id, message_id, channel_id, chat_id, chat_type, phone, direction, author, text, status, is_system, sent_at, source, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (account_id, message_id) DO UPDATE SET
         status = COALESCE(EXCLUDED.status, wazzup_messages.status),
         text = CASE WHEN wazzup_messages.text = '' THEN EXCLUDED.text ELSE wazzup_messages.text END
       RETURNING (xmax = 0) AS inserted`,
      [accountId, m.messageId, m.channelId, m.chatId, m.chatType, m.phone, m.direction, m.author, m.text, m.status, m.isSystem, m.sentAt, m.source, m.raw ?? null],
    );
    return Boolean(rows[0]?.inserted);
  }

  async setStatus(accountId: number, messageId: string, status: string): Promise<void> {
    await this.db.query('UPDATE wazzup_messages SET status = $3 WHERE account_id = $1 AND message_id = $2', [accountId, messageId, status]);
  }

  /** История по телефону — последние limit сообщений в хронологическом порядке, без системных. */
  async historyByPhone(accountId: number, phone: string, limit = 40): Promise<WazzupHistoryItem[]> {
    const { rows } = await this.db.query(
      `SELECT direction, author, text, sent_at, chat_type FROM (
         SELECT direction, author, text, sent_at, chat_type FROM wazzup_messages
         WHERE account_id = $1 AND phone = $2 AND NOT is_system AND text <> ''
         ORDER BY sent_at DESC LIMIT $3) t ORDER BY sent_at ASC`,
      [accountId, phone, limit],
    );
    return rows.map((r) => ({ direction: r.direction, author: r.author, text: r.text, sentAt: r.sent_at, chatType: r.chat_type }));
  }

  async countByPhone(accountId: number, phone: string): Promise<number> {
    const { rows } = await this.db.query('SELECT count(*)::int AS n FROM wazzup_messages WHERE account_id = $1 AND phone = $2 AND NOT is_system', [accountId, phone]);
    return rows[0]?.n ?? 0;
  }

  async setLead(accountId: number, phone: string, contactId: number | null, leadId: number | null): Promise<void> {
    await this.db.query('UPDATE wazzup_messages SET contact_id = $3, lead_id = $4 WHERE account_id = $1 AND phone = $2 AND lead_id IS NULL', [accountId, phone, contactId, leadId]);
  }

  async state(accountId: number): Promise<WazzupState> {
    const { rows } = await this.db.query('SELECT * FROM wazzup_state WHERE account_id = $1', [accountId]);
    const r = rows[0];
    return r
      ? { webhookUri: r.webhook_uri, subscribedAt: r.subscribed_at, lastEventAt: r.last_event_at, eventsTotal: Number(r.events_total), lastError: r.last_error, lastErrorAt: r.last_error_at }
      : { webhookUri: null, subscribedAt: null, lastEventAt: null, eventsTotal: 0, lastError: null, lastErrorAt: null };
  }

  async markSubscribed(accountId: number, webhookUri: string): Promise<void> {
    await this.db.query(
      `INSERT INTO wazzup_state (account_id, webhook_uri, subscribed_at) VALUES ($1, $2, now())
       ON CONFLICT (account_id) DO UPDATE SET webhook_uri = EXCLUDED.webhook_uri, subscribed_at = now(), last_error = NULL, last_error_at = NULL, updated_at = now()`,
      [accountId, webhookUri],
    );
  }

  async markEvent(accountId: number, n: number): Promise<void> {
    await this.db.query(
      `INSERT INTO wazzup_state (account_id, last_event_at, events_total) VALUES ($1, now(), $2)
       ON CONFLICT (account_id) DO UPDATE SET last_event_at = now(), events_total = wazzup_state.events_total + $2, updated_at = now()`,
      [accountId, n],
    );
  }

  async markError(accountId: number, error: string): Promise<void> {
    await this.db.query(
      `INSERT INTO wazzup_state (account_id, last_error, last_error_at) VALUES ($1, $2, now())
       ON CONFLICT (account_id) DO UPDATE SET last_error = $2, last_error_at = now(), updated_at = now()`,
      [accountId, error.slice(0, 500)],
    );
  }

  async stats(accountId: number): Promise<{ total: number; last24h: number; phones: number }> {
    const { rows } = await this.db.query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last24h, count(DISTINCT phone)::int AS phones FROM wazzup_messages WHERE account_id = $1`,
      [accountId],
    );
    return rows[0] ?? { total: 0, last24h: 0, phones: 0 };
  }
}

/** История мессенджера для промпта: строки «[дата] Клиент|Менеджер|AI: текст»; исходящие, совпадающие с ownTexts (ответы агента), опускаются. */
export function formatWazzupHistory(items: WazzupHistoryItem[], ownTexts: Set<string> = new Set()): { text: string | null; count: number } {
  const lines = items
    .filter((m) => !(m.direction === 'out' && ownTexts.has(m.text.trim())))
    .map((m) => {
      const who = m.direction === 'in' ? 'Клиент' : m.author === 'agent' ? 'AI' : 'Менеджер';
      const when = new Date(m.sentAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      return `[${when}] ${who}: ${m.text.replace(/\s+/g, ' ').slice(0, 400)}`;
    });
  return { text: lines.length ? lines.join('\n') : null, count: lines.length };
}
