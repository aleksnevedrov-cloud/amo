import { signAmojoRequest } from './signature.ts';

export interface AmojoUser {
  id: string;
  name: string;
  avatar?: string;
  profile?: { phone?: string; email?: string };
  profile_link?: string;
}

export type AmojoMessageKind = 'text' | 'picture' | 'file' | 'video' | 'voice' | 'audio' | 'sticker';

export interface AmojoMessage {
  type: AmojoMessageKind;
  text?: string;
  media?: string;
  file_name?: string;
  file_size?: number;
  /** Цитата: наш msgid или id сообщения в amo. */
  reply_to?: { message: { msgid: string } | { id: string } };
}

export interface NewMessagePayload {
  timestamp: number;
  msec_timestamp: number;
  /** Наш id сообщения: amo вернёт его в ответах и в reply_to. */
  msgid: string;
  conversation_id: string;
  sender: AmojoUser;
  receiver?: AmojoUser;
  message: AmojoMessage;
  silent: boolean;
}

/** Статусы доставки API чатов: 1 — доставлено, 2 — прочитано, -1 — ошибка. */
export type DeliveryStatus = 1 | 2 | -1;

export class AmojoError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }

  /** 4xx (кроме 429) повторять бессмысленно. */
  get permanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

export interface AmojoClientOptions {
  baseUrl: string;
  channelId: string;
  secret: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Клиент API чатов amoCRM (https://www.amocrm.ru/developers/content/chats/chat-api-reference). */
export class AmojoClient {
  private readonly f: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly opts: AmojoClientOptions) {
    this.f = opts.fetch ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  private async request<T>(method: 'POST' | 'DELETE', path: string, body: unknown): Promise<T> {
    const json = JSON.stringify(body);
    const headers = signAmojoRequest(this.opts.secret, { method, path, body: json, date: this.now().toUTCString() });
    const res = await this.f(new URL(path, this.opts.baseUrl), {
      method,
      headers,
      body: json,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) throw new AmojoError(`amojo ${method} ${path.replace(/\/[0-9a-f-]{20,}/gi, '/…')}: HTTP ${res.status}`, res.status);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Подключение канала к аккаунту: amojo_id аккаунта → scope_id. */
  async connect(amojoAccountId: string, title: string): Promise<{ scopeId: string }> {
    const r = await this.request<{ scope_id?: string }>('POST', `/v2/origin/custom/${this.opts.channelId}/connect`, {
      account_id: amojoAccountId,
      title,
      hook_api_version: 'v2',
    });
    if (!r.scope_id) throw new AmojoError('amojo не вернул scope_id', 502);
    return { scopeId: r.scope_id };
  }

  async disconnect(amojoAccountId: string): Promise<void> {
    await this.request('DELETE', `/v2/origin/custom/${this.opts.channelId}/disconnect`, { account_id: amojoAccountId });
  }

  async sendMessage(scopeId: string, payload: NewMessagePayload): Promise<{ msgid: string; chatId: string | null }> {
    const r = await this.request<{ new_message?: { msgid?: string; chat_id?: string } }>('POST', `/v2/origin/custom/${scopeId}`, {
      event_type: 'new_message',
      payload,
    });
    const msgid = r.new_message?.msgid;
    if (!msgid) throw new AmojoError('amojo не вернул msgid', 502);
    return { msgid, chatId: r.new_message?.chat_id ?? null };
  }

  async deliveryStatus(scopeId: string, amojoMsgid: string, status: DeliveryStatus, error?: string): Promise<void> {
    await this.request('POST', `/v2/origin/custom/${scopeId}/${amojoMsgid}/delivery_status`, {
      msgid: amojoMsgid,
      delivery_status: status,
      ...(status === -1 ? { error_code: 905, error: (error ?? 'Не удалось доставить').slice(0, 250) } : {}),
    });
  }
}
