import { ApiError, fileForm, HttpClient, pause, type HttpOptions } from './http.ts';
import { PermanentSendError, reconnectDelayMs, type Connector, type ConnectorSink, type InboundAttachment, type InboundEvent, type OutboundRequest } from './types.ts';

/**
 * Авито (Messenger API): токен client_credentials с автообновлением; входящие — вебхук v3 на наш адрес
 * (секрет в адресе), при недоступности вебхука — опрос непрочитанных чатов. Текст и фото в обе стороны.
 * В amoCRM вместе с первым сообщением чата передаются название объявления и ссылка на него.
 */
export const AVITO_API = 'https://api.avito.ru';

/** Опрос чатов: раз в минуту, если вебхук не подписался; раз в 5 минут как подстраховка, если подписался. */
export const AVITO_POLL_MS = 60_000;
export const AVITO_SAFETY_POLL_MS = 5 * 60_000;

export interface AvitoCredentials {
  clientId: string;
  clientSecret: string;
  userId: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- ответы API разбираются вручную */

export class AvitoApi {
  readonly http: HttpClient;
  private cached: { token: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;

  constructor(
    private readonly creds: AvitoCredentials,
    opts: HttpOptions = {},
    private readonly now: () => number = Date.now,
  ) {
    this.http = new HttpClient(opts);
  }

  get userId(): number {
    return this.creds.userId;
  }

  /** Токен приложения; обновляется за минуту до истечения. Неверные client_id/secret → ApiError 401. */
  async token(force = false): Promise<string> {
    if (!force && this.cached && this.cached.expiresAt - 60_000 > this.now()) return this.cached.token;
    if (!this.pending) {
      this.pending = (async () => {
        const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.creds.clientId, client_secret: this.creds.clientSecret });
        const res = await this.http.call(`${AVITO_API}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(), timeoutMs: 15_000 });
        const j = res.json as { access_token?: string; expires_in?: number; error?: string } | null;
        if (res.status >= 400 || !j?.access_token) throw new ApiError(res.status === 429 ? 429 : 401, `Авито не выдал токен: ${String(j?.error ?? `HTTP ${res.status}`).slice(0, 100)}`, j?.error ?? null);
        this.cached = { token: j.access_token, expiresAt: this.now() + Math.max(60, Number(j.expires_in) || 86_400) * 1000 };
        return j.access_token;
      })().finally(() => (this.pending = null));
    }
    return this.pending;
  }

  /** Запрос к API с токеном. На 401 токен обновляется и запрос повторяется один раз. */
  async call<T = any>(method: 'GET' | 'POST', path: string, body?: unknown | FormData, timeoutMs = 30_000, retried = false): Promise<T> {
    const token = await this.token(retried);
    const isForm = body instanceof FormData;
    const res = await this.http.call(`${AVITO_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined || isForm ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: isForm ? body : JSON.stringify(body) }),
      timeoutMs,
    });
    if (res.status === 401 && !retried) return this.call<T>(method, path, body, timeoutMs, true);
    if (res.status >= 400) {
      const e = res.json as { error?: { code?: number; message?: string } | string; message?: string } | null;
      const msg = typeof e?.error === 'string' ? e.error : (e?.error?.message ?? e?.message ?? `HTTP ${res.status}`);
      throw new ApiError(res.status, `Авито ${res.status}: ${String(msg).slice(0, 200)}`, typeof e?.error === 'object' ? (e.error?.code ?? null) : null);
    }
    return res.json as T;
  }

  self(): Promise<{ id: number; name?: string; email?: string; profile_url?: string }> {
    return this.call('GET', '/core/v1/accounts/self', undefined, 15_000);
  }

  subscribeWebhook(url: string): Promise<unknown> {
    return this.call('POST', '/messenger/v3/webhook', { url });
  }

  unsubscribeWebhook(url: string): Promise<unknown> {
    return this.call('POST', '/messenger/v1/webhook/unsubscribe', { url });
  }

  async chats(unreadOnly: boolean): Promise<any[]> {
    const q = new URLSearchParams({ limit: '100', chat_types: 'u2i,u2u', ...(unreadOnly ? { unread_only: 'true' } : {}) });
    const r = await this.call<{ chats?: any[] }>('GET', `/messenger/v2/accounts/${this.userId}/chats?${q}`);
    return Array.isArray(r?.chats) ? r.chats : [];
  }

  chat(chatId: string): Promise<any> {
    return this.call('GET', `/messenger/v2/accounts/${this.userId}/chats/${encodeURIComponent(chatId)}`);
  }

  async messages(chatId: string): Promise<any[]> {
    const r = await this.call<any>('GET', `/messenger/v3/accounts/${this.userId}/chats/${encodeURIComponent(chatId)}/messages/?limit=100`);
    return Array.isArray(r) ? r : Array.isArray(r?.messages) ? r.messages : [];
  }

  markRead(chatId: string): Promise<unknown> {
    return this.call('POST', `/messenger/v1/accounts/${this.userId}/chats/${encodeURIComponent(chatId)}/read`, {});
  }

  sendText(chatId: string, text: string): Promise<{ id: string }> {
    return this.call('POST', `/messenger/v1/accounts/${this.userId}/chats/${encodeURIComponent(chatId)}/messages`, { message: { text }, type: 'text' }, 60_000);
  }

  async uploadImage(data: Buffer, name: string, mime: string): Promise<string> {
    const r = await this.call<Record<string, unknown>>('POST', `/messenger/v1/accounts/${this.userId}/uploadImages`, fileForm('uploadfile[]', data, name, mime), 120_000);
    const id = Object.keys(r ?? {})[0];
    if (!id) throw new Error('Авито не принял изображение');
    return id;
  }

  sendImage(chatId: string, imageId: string): Promise<{ id: string }> {
    return this.call('POST', `/messenger/v1/accounts/${this.userId}/chats/${encodeURIComponent(chatId)}/messages/image`, { image_id: imageId }, 60_000);
  }

  async voiceUrl(voiceId: string): Promise<string | null> {
    const r = await this.call<{ voices_urls?: Record<string, string> }>('GET', `/messenger/v1/accounts/${this.userId}/getVoiceFiles?voice_ids=${encodeURIComponent(voiceId)}`);
    return r?.voices_urls?.[voiceId] ?? null;
  }
}

/** Самый крупный размер из content.image.sizes ({"1280x960": url, …}). */
function largestImage(sizes: Record<string, string> | undefined): string | null {
  if (!sizes) return null;
  let best: { area: number; url: string } | null = null;
  for (const [k, url] of Object.entries(sizes)) {
    const [w = 0, h = 0] = k.split('x').map(Number);
    const area = w * h || 1;
    if (!best || area > best.area) best = { area, url };
  }
  return best?.url ?? null;
}

export interface AvitoChatInfo {
  title: string;
  link?: string;
  item?: { title: string; url: string } | null;
}

/** Сведения о чате из ответа API: имя собеседника, ссылка на профиль, объявление. */
export function avitoChatInfo(chat: any, userId: number): AvitoChatInfo {
  const users: any[] = Array.isArray(chat?.users) ? chat.users : [];
  const other = users.find((u) => Number(u?.id) !== userId) ?? users[0];
  const ctx = chat?.context?.type === 'item' ? chat.context.value : null;
  return {
    title: String(other?.name ?? '').trim() || `Авито ${other?.id ?? chat?.id ?? ''}`.trim(),
    ...(other?.public_user_profile?.url ? { link: String(other.public_user_profile.url) } : {}),
    item: ctx?.title ? { title: String(ctx.title), url: String(ctx.url ?? '') } : null,
  };
}

/**
 * Сообщение Авито (из вебхука v3 или списка сообщений чата) → общее событие.
 * null — служебное (system, deleted, звонок без текста).
 */
export function normalizeAvitoMessage(
  v: any,
  opts: { userId: number; chat?: AvitoChatInfo; firstInChat?: boolean },
): InboundEvent | null {
  if (!v?.id || !v.chat_id) return null;
  const type = String(v.type ?? 'text');
  if (type === 'deleted' || type === 'system' || type === 'appCall') return null;
  const c = v.content ?? {};
  let text = '';
  let attachment: InboundAttachment | null = null;
  switch (type) {
    case 'text':
      text = String(c.text ?? '');
      break;
    case 'image': {
      const url = largestImage(c.image?.sizes);
      if (url) attachment = { kind: 'picture', ref: url, name: `photo_${v.id}.jpg`, mime: 'image/jpeg' };
      break;
    }
    case 'voice':
      if (c.voice?.voice_id) attachment = { kind: 'voice', ref: `voice:${c.voice.voice_id}`, name: `voice_${v.id}.mp4`, mime: 'audio/mp4' };
      break;
    case 'item':
      text = `[Объявление] ${c.item?.title ?? ''} ${c.item?.item_url ?? ''}`.trim();
      break;
    case 'link':
      text = String(c.link?.text ?? c.link?.url ?? '');
      break;
    case 'location':
      text = `Геопозиция: ${c.location?.text ?? ''} https://yandex.ru/maps/?pt=${c.location?.lon},${c.location?.lat}&z=16`;
      break;
    case 'call':
      text = c.call?.status === 'missed' ? '[Пропущенный звонок через Авито]' : '[Звонок через Авито]';
      break;
    default:
      text = String(c.text ?? '');
  }
  if (!text && !attachment) return null;
  const fromMe = v.direction ? v.direction === 'out' : Number(v.author_id) === opts.userId;
  if (opts.firstInChat && opts.chat?.item) {
    text = `Объявление: «${opts.chat.item.title}»${opts.chat.item.url ? `\n${opts.chat.item.url}` : ''}${text ? `\n\n${text}` : ''}`;
  }
  const created = Number(v.created ?? 0);
  return {
    externalChatId: String(v.chat_id),
    chatTitle: opts.chat?.title ?? `Авито ${v.author_id ?? ''}`.trim(),
    isGroup: false,
    contact: opts.chat?.link ? { link: opts.chat.link } : {},
    author: null,
    externalMessageId: String(v.id),
    text,
    attachment,
    replyToExternalId: null,
    timestamp: created > 1e12 ? Math.floor(created / 1000) : created || Math.floor(Date.now() / 1000),
    fromMe,
  };
}

/** Тело вебхука Авито v3: payload.type = message, payload.value — сообщение. */
export function avitoHookMessage(body: any): any | null {
  const p = body?.payload;
  if (p?.type !== 'message' || !p.value?.id) return null;
  return p.value;
}

export interface AvitoConnectorOptions extends HttpOptions {
  /** Адрес вебхука: https://chat.rf-dveri.ru/hooks/avito/<id>/<секрет>. Пусто — только опрос. */
  webhookUrl?: string;
  onError?: (err: unknown) => void;
  log?: (level: 'warn' | 'error', msg: string) => void;
  sleep?: typeof pause;
  /** Для тестов: интервалы опроса. */
  pollMs?: number;
  safetyPollMs?: number;
}

export class AvitoConnector implements Connector {
  readonly api: AvitoApi;
  private readonly abort = new AbortController();
  private loop: Promise<void> | null = null;
  private sink: ConnectorSink | null = null;
  private readonly chats = new Map<string, AvitoChatInfo>();
  /** Чаты, по которым уже передано объявление (в рамках процесса). */
  private readonly introduced = new Set<string>();
  /** Сообщения, отправленные нами: вебхук пришлёт их обратно с direction out. */
  private readonly sentIds = new Set<string>();
  webhookActive = false;

  constructor(
    creds: AvitoCredentials,
    private readonly opts: AvitoConnectorOptions = {},
  ) {
    this.api = new AvitoApi(creds, opts);
  }

  async start(sink: ConnectorSink): Promise<void> {
    this.sink = sink;
    this.loop = this.run(sink);
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop;
  }

  /** Канал удалён: снять вебхук. */
  async logout(): Promise<void> {
    await this.stop();
    if (this.opts.webhookUrl) await this.api.unsubscribeWebhook(this.opts.webhookUrl).catch(() => undefined);
  }

  private async chatInfo(chatId: string): Promise<AvitoChatInfo | undefined> {
    const cached = this.chats.get(chatId);
    if (cached) return cached;
    const chat = await this.api.chat(chatId).catch(() => null);
    if (!chat) return undefined;
    const info = avitoChatInfo(chat, this.api.userId);
    this.chats.set(chatId, info);
    if (this.chats.size > 500) this.chats.delete(this.chats.keys().next().value as string);
    return info;
  }

  /** Одно сообщение (из вебхука или опроса) → в мост. */
  private async handle(sink: ConnectorSink, v: any): Promise<boolean> {
    if (!v?.id || this.sentIds.has(String(v.id))) return false;
    const chatId = String(v.chat_id);
    const chat = await this.chatInfo(chatId);
    const ev = normalizeAvitoMessage(v, { userId: this.api.userId, ...(chat ? { chat } : {}), firstInChat: !this.introduced.has(chatId) });
    if (!ev) return false;
    this.introduced.add(chatId);
    await sink.inbound(ev);
    return true;
  }

  /** Вебхук Авито (тело уже проверено по секрету в адресе). */
  async onWebhook(body: unknown): Promise<void> {
    const sink = this.sink;
    if (!sink) throw new Error('Коннектор Авито ещё не запущен');
    const v = avitoHookMessage(body);
    if (!v) return;
    await this.handle(sink, v);
  }

  /** Опрос непрочитанных чатов; прочитанными помечаются только переданные в amo. */
  private async pollOnce(sink: ConnectorSink): Promise<void> {
    const since = Math.floor(Date.now() / 1000) - 7 * 86400;
    for (const chat of await this.api.chats(true)) {
      const chatId = String(chat?.id ?? '');
      if (!chatId) continue;
      if (!this.chats.has(chatId)) this.chats.set(chatId, avitoChatInfo(chat, this.api.userId));
      const list = (await this.api.messages(chatId)).filter((m) => Number(m?.created ?? 0) >= since && Number(m?.author_id) !== this.api.userId);
      list.sort((a, b) => Number(a.created) - Number(b.created));
      // В списке сообщений чата chat_id не приходит — подставляем из чата.
      for (const m of list) await this.handle(sink, { ...m, chat_id: m.chat_id ?? chatId });
      await this.api.markRead(chatId).catch(() => undefined);
    }
  }

  private async run(sink: ConnectorSink): Promise<void> {
    const signal = this.abort.signal;
    const sleep = this.opts.sleep ?? pause;
    let failures = 0;
    let connected = false;
    while (!signal.aborted) {
      try {
        if (!connected) {
          await this.api.self();
          if (this.opts.webhookUrl) {
            this.webhookActive = await this.api.subscribeWebhook(this.opts.webhookUrl).then(
              () => true,
              (err: Error) => (this.opts.log?.('warn', `avito: вебхук не подписан (${err.message}), работает опрос`), false),
            );
          }
          await sink.status('connected', this.webhookActive ? null : 'Без вебхука: новые сообщения проверяются раз в минуту');
          connected = true;
          failures = 0;
        }
        await this.pollOnce(sink);
        await sleep(this.webhookActive ? (this.opts.safetyPollMs ?? AVITO_SAFETY_POLL_MS) : (this.opts.pollMs ?? AVITO_POLL_MS), signal);
      } catch (err) {
        if (signal.aborted) break;
        if (err instanceof ApiError && (err.status === 401 || err.status === 400 && /invalid_client|unauthorized/i.test(err.message))) {
          await sink.status('error', 'Авито не принял client_id и client_secret — проверьте ключи приложения и подключите заново');
          return;
        }
        if (err instanceof ApiError && err.status === 403) {
          await sink.status('error', 'У приложения Авито нет доступа к мессенджеру: включите доступ к Messenger API в личном кабинете разработчика');
          return;
        }
        failures++;
        connected = false;
        await sink.status('error', 'Нет связи с Авито, повторное подключение').catch(() => undefined);
        this.opts.onError?.(err);
        await sleep(err instanceof ApiError && err.retryAfter ? err.retryAfter * 1000 : reconnectDelayMs(failures), signal);
      }
    }
  }

  async typing(): Promise<void> {
    // У Messenger API Авито нет статуса «печатает».
  }

  async send(req: OutboundRequest): Promise<{ externalMessageId: string }> {
    const f = req.file;
    if (f && f.kind !== 'picture' && f.kind !== 'sticker') throw new PermanentSendError('Авито принимает только текст и фото — отправьте файл другим способом');
    try {
      let id: string | null = null;
      if (req.text) {
        const r = await this.api.sendText(req.externalChatId, req.text.slice(0, 4000));
        id = String(r.id);
        this.sentIds.add(id);
      }
      if (f) {
        const imageId = await this.api.uploadImage(f.data, f.name, f.mime);
        const r = await this.api.sendImage(req.externalChatId, imageId);
        this.sentIds.add(String(r.id));
        id ??= String(r.id);
      }
      if (!id) throw new PermanentSendError('Пустое сообщение');
      if (this.sentIds.size > 1000) this.sentIds.delete(this.sentIds.values().next().value as string);
      return { externalMessageId: id };
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        throw new PermanentSendError(err.status === 403 ? 'Авито не разрешил писать в этот чат (чат заблокирован или объявление снято)' : 'Чат Авито не найден');
      }
      throw err;
    }
  }

  async download(ref: string, maxBytes: number): Promise<{ data: Buffer; mime: string }> {
    let url = ref;
    if (ref.startsWith('voice:')) {
      const u = await this.api.voiceUrl(ref.slice(6));
      if (!u) throw new Error('Голосовое Авито недоступно');
      url = u;
    }
    return this.api.http.download(url, maxBytes);
  }
}
