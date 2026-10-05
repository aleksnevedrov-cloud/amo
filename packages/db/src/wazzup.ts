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
  /** Ссылка и тип вложения из вебхука (image, audio, document, video…). */
  contentUri?: string | null;
  contentType?: string | null;
}

/** Входящее вложение клиента для подхвата в диалог агента. */
export interface WazzupContentItem {
  id: number;
  contentUri: string;
  contentType: string | null;
  text: string;
  sentAt: Date;
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

export interface WazzupGroupItem {
  chatId: string;
  chatName: string | null;
  chatType: string | null;
  messages: number;
  lastAt: Date | null;
  skipped: number;
}

export type WazzupChatKindName = 'direct' | 'group' | 'unknown';

export interface WazzupChatKind {
  kind: WazzupChatKindName;
  chatType: string | null;
  chatId: string | null;
  chatName: string | null;
}

/** whatsgroup / telegroup - групповые беседы Wazzup. */
export function isGroupChatType(v: string | null | undefined): boolean {
  return typeof v === 'string' && v.toLowerCase().endsWith('group');
}

const UNKNOWN_CHAT: WazzupChatKind = { kind: 'unknown', chatType: null, chatId: null, chatName: null };

function toChatKind(r: { chat_type: string | null; chat_id: string | null; chat_name: string | null }): WazzupChatKind {
  return {
    kind: isGroupChatType(r.chat_type) ? 'group' : 'direct',
    chatType: r.chat_type ?? null,
    chatId: r.chat_id ?? null,
    chatName: r.chat_name ?? null,
  };
}

export class WazzupRepo {
  constructor(private readonly db: Db) {}

  /** Вставка по message_id идемпотентна; повтор с тем же id обновляет только статус и пустой текст. */
  async upsert(accountId: number, m: WazzupMessage): Promise<boolean> {
    const { rows } = await this.db.query(
      `INSERT INTO wazzup_messages (account_id, message_id, channel_id, chat_id, chat_type, phone, direction, author, text, status, is_system, sent_at, source, raw, content_uri, content_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (account_id, message_id) DO UPDATE SET
         status = COALESCE(EXCLUDED.status, wazzup_messages.status),
         text = CASE WHEN wazzup_messages.text = '' THEN EXCLUDED.text ELSE wazzup_messages.text END
       RETURNING (xmax = 0) AS inserted`,
      [accountId, m.messageId, m.channelId, m.chatId, m.chatType, m.phone, m.direction, m.author, m.text, m.status, m.isSystem, m.sentAt, m.source, m.raw ?? null, m.contentUri ?? null, m.contentType ?? null],
    );
    return Boolean(rows[0]?.inserted);
  }

  /** Входящие вложения клиента в окне времени, ещё не использованные агентом. */
  async incomingContent(accountId: number, phones: string[], from: Date, to: Date): Promise<WazzupContentItem[]> {
    if (!phones.length) return [];
    const { rows } = await this.db.query<{ id: string; content_uri: string; content_type: string | null; text: string; sent_at: Date }>(
      `SELECT id, content_uri, content_type, text, sent_at FROM wazzup_messages
       WHERE account_id = $1 AND phone = ANY($2::text[]) AND direction = 'in' AND content_uri IS NOT NULL AND consumed_at IS NULL
         AND sent_at BETWEEN $3 AND $4
       ORDER BY sent_at, id`,
      [accountId, phones, from, to],
    );
    return rows.map((r) => ({ id: Number(r.id), contentUri: r.content_uri, contentType: r.content_type, text: r.text, sentAt: r.sent_at }));
  }

  /** Вложения из чата, уже связанного с этой сделкой: телефона клиента может не быть в карточке amo. */
  async incomingContentByLead(accountId: number, leadId: number, from: Date, to: Date): Promise<WazzupContentItem[]> {
    const { rows } = await this.db.query<{ id: string; content_uri: string; content_type: string | null; text: string; sent_at: Date }>(
      `SELECT id, content_uri, content_type, text, sent_at FROM wazzup_messages
        WHERE account_id = $1 AND direction = 'in' AND content_uri IS NOT NULL AND consumed_at IS NULL
          AND sent_at BETWEEN $3 AND $4
          AND chat_id IN (SELECT chat_id FROM wazzup_messages WHERE account_id = $1 AND lead_id = $2)
        ORDER BY sent_at, id`,
      [accountId, leadId, from, to],
    );
    return rows.map((r) => ({ id: Number(r.id), contentUri: r.content_uri, contentType: r.content_type, text: r.text, sentAt: r.sent_at }));
  }
  async markConsumed(accountId: number, ids: number[]): Promise<void> {
    if (!ids.length) return;
    await this.db.query('UPDATE wazzup_messages SET consumed_at = now() WHERE account_id = $1 AND id = ANY($2::bigint[])', [accountId, ids]);
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

  /**
   * Писал ли клиенту сотрудник после `since` — кроме самого агента.
   *
   * Менеджеры отвечают из WhatsApp, и в amoCRM такое исходящее создаёт интеграция
   * с created_by = 0, поэтому по событиям чата amo их не видно. author у ответа агента
   * такой же (manager), так что свои ответы отсеиваются сверкой с dialog_messages.
   */
  async managerWroteSince(accountId: number, phone: string, since: Date): Promise<Date | null> {
    const { rows } = await this.db.query(
      `SELECT w.sent_at FROM wazzup_messages w
         WHERE w.account_id = $1 AND w.phone = $2 AND w.direction = 'out'
           AND NOT w.is_system AND w.text <> '' AND w.sent_at > $3
           AND NOT EXISTS (
             SELECT 1 FROM dialog_messages d
              WHERE d.account_id = w.account_id AND d.role = 'ai'
                AND left(d.text, 300) = left(w.text, 300)
           )
         ORDER BY w.sent_at DESC LIMIT 1`,
      [accountId, phone, since],
    );
    return rows[0] ? new Date(rows[0].sent_at as string) : null;
  }

  /** История переписки конкретного чата — для групп, где нет телефона контакта. */
  async historyByChat(accountId: number, chatId: string, limit = 40): Promise<WazzupHistoryItem[]> {
    const { rows } = await this.db.query(
      `SELECT direction, author, text, sent_at, chat_type FROM (
         SELECT direction, author, text, sent_at, chat_type FROM wazzup_messages
         WHERE account_id = $1 AND chat_id = $2 AND NOT is_system AND text <> ''
         ORDER BY sent_at DESC LIMIT $3) t ORDER BY sent_at ASC`,
      [accountId, chatId, limit],
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

  /**
   * Чат, из которого пришло сообщение клиента. Salesbot тип чата не передаёт,
   * поэтому ищем сообщение в данных Wazzup: сначала по уже связанной сделке,
   * иначе по тексту в окне +-3 мин (приём из темы вложений). Найденная связка
   * сохраняется в lead_id, чтобы следующие сообщения решались без поиска по тексту.
   */
  async resolveChatKind(accountId: number, leadId: number | null, text: string): Promise<WazzupChatKind> {
    if (leadId) {
      const { rows } = await this.db.query(
        `SELECT chat_type, chat_id, raw->'contact'->>'name' AS chat_name FROM wazzup_messages
          WHERE account_id = $1 AND lead_id = $2 AND direction = 'in'
          ORDER BY sent_at DESC LIMIT 1`,
        [accountId, leadId],
      );
      if (rows[0]) return toChatKind(rows[0]);
    }
    const needle = (text ?? '').trim();
    if (!needle) return UNKNOWN_CHAT;
    const { rows } = await this.db.query(
      `SELECT chat_type, chat_id, raw->'contact'->>'name' AS chat_name FROM wazzup_messages
        WHERE account_id = $1 AND direction = 'in' AND NOT is_system
          AND (btrim(text) = $2 OR (length(btrim(text)) >= 8 AND position(btrim(text) in $2) > 0))
          AND sent_at > now() - interval '3 minutes' AND sent_at < now() + interval '1 minute'
        ORDER BY sent_at DESC LIMIT 1`,
      [accountId, needle],
    );
    const r = rows[0];
    if (!r) return UNKNOWN_CHAT;
    if (leadId && r.chat_id) {
      await this.db.query(
        'UPDATE wazzup_messages SET lead_id = $3 WHERE account_id = $1 AND chat_id = $2 AND lead_id IS NULL',
        [accountId, r.chat_id, leadId],
      );
    }
    return toChatKind(r);
  }

  /** Групповые чаты с названиями и числом пропусков агента (вкладка «Где работает»). */
  async groups(accountId: number): Promise<WazzupGroupItem[]> {
    const { rows } = await this.db.query(
      `SELECT m.chat_id,
              max(m.raw->'contact'->>'name') AS chat_name,
              max(m.chat_type) AS chat_type,
              count(*)::int AS messages,
              max(m.sent_at) AS last_at,
              (SELECT count(*)::int FROM ai_journal j
                WHERE j.account_id = $1 AND j.kind = 'skipped' AND j.details->>'chatId' = m.chat_id) AS skipped
         FROM wazzup_messages m
        WHERE m.account_id = $1 AND m.chat_type LIKE '%group'
        GROUP BY m.chat_id
        ORDER BY max(m.sent_at) DESC
        LIMIT 100`,
      [accountId],
    );
    return rows.map((r) => ({
      chatId: String(r.chat_id),
      chatName: r.chat_name ?? null,
      chatType: r.chat_type ?? null,
      messages: Number(r.messages),
      lastAt: r.last_at ?? null,
      skipped: Number(r.skipped ?? 0),
    }));
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
