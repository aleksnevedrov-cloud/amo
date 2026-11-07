import type { AmojoMessageKind } from '../amojo/client.ts';
import { ApiError, fileForm, HttpClient, pause, type HttpOptions } from './http.ts';
import { splitText } from './telegram-bot.ts';
import { PermanentSendError, reconnectDelayMs, type Connector, type ConnectorSink, type InboundAttachment, type InboundEvent, type OutboundRequest } from './types.ts';

/**
 * MAX (бот): API ботов platform-api.max.ru. Получение — long polling GET /updates (внешний адрес не нужен),
 * отправка — POST /messages, файлы — POST /uploads + загрузка на выданный адрес.
 * Токен бота передаётся заголовком Authorization и не попадает в ошибки и журнал.
 */
export const MAX_API = 'https://platform-api.max.ru';

/* eslint-disable @typescript-eslint/no-explicit-any -- ответы API разбираются вручную */

export class MaxApi {
  readonly http: HttpClient;

  constructor(
    private readonly token: string,
    opts: HttpOptions = {},
  ) {
    this.http = new HttpClient(opts);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: this.token, ...extra };
  }

  /** Запрос к API; ошибки API — ApiError со статусом и кодом (verify.token, attachment.not.ready…). */
  async call<T = any>(method: 'GET' | 'POST' | 'DELETE' | 'PUT', path: string, query: Record<string, string | number> = {}, body?: unknown, timeoutMs = 30_000, signal?: AbortSignal): Promise<T> {
    const url = new URL(path, MAX_API);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    const res = await this.http.call(url.toString(), {
      method,
      headers: this.headers(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      timeoutMs,
      signal,
    });
    if (res.status >= 400) {
      const e = res.json as { code?: string; message?: string } | null;
      throw new ApiError(res.status, `MAX ${res.status}: ${String(e?.message ?? e?.code ?? 'error').slice(0, 200)}`, e?.code ?? null);
    }
    return res.json as T;
  }

  getMe(): Promise<{ user_id: number; name: string; username?: string }> {
    return this.call('GET', '/me', {}, undefined, 15_000);
  }

  /**
   * Загрузка файла: POST /uploads?type= выдаёт адрес, туда — multipart. Токен вложения — из ответа загрузки
   * (image → photos{…}.token, file → token) или из ответа /uploads (video, audio).
   */
  async upload(type: 'image' | 'video' | 'audio' | 'file', data: Buffer, name: string, mime: string): Promise<Record<string, unknown>> {
    const slot = await this.call<{ url: string; token?: string }>('POST', '/uploads', { type });
    const res = await this.http.call(slot.url, { method: 'POST', body: fileForm('data', data, name, mime), timeoutMs: 120_000 });
    if (res.status >= 400) throw new ApiError(res.status, `MAX upload: HTTP ${res.status}`);
    const r = (res.json ?? {}) as { token?: string; photos?: Record<string, { token: string }> };
    if (type === 'image' && r.photos) return { photos: r.photos };
    const token = r.token ?? slot.token;
    if (!token) throw new Error('MAX не вернул токен вложения');
    return { token };
  }
}

const fullName = (u: any): string => String(u?.name ?? '').trim() || (u?.username ? `@${u.username}` : `id${u?.user_id}`);

function attachmentOf(body: any): { attachment: InboundAttachment | null; extraText: string } {
  const list: any[] = Array.isArray(body?.attachments) ? body.attachments : [];
  let attachment: InboundAttachment | null = null;
  const extra: string[] = [];
  for (const a of list) {
    const p = a?.payload ?? {};
    const ref = typeof p.url === 'string' ? p.url : null;
    if (attachment) {
      // Второе и дальнейшие вложения одного сообщения — ссылками в тексте.
      if (ref) extra.push(ref);
      continue;
    }
    switch (a?.type) {
      case 'image':
        if (ref) attachment = { kind: 'picture', ref, name: `photo_${body.mid}.jpg`, mime: 'image/jpeg' };
        break;
      case 'video':
        if (ref) attachment = { kind: 'video', ref, name: `video_${body.mid}.mp4`, mime: 'video/mp4' };
        else extra.push('[Видео]');
        break;
      case 'audio':
        if (ref) attachment = { kind: 'voice', ref, name: `voice_${body.mid}.ogg` };
        break;
      case 'file':
        if (ref) attachment = { kind: 'file', ref, name: String(a.filename || `file_${body.mid}`), size: Number(a.size) || undefined };
        break;
      case 'sticker':
        if (ref) attachment = { kind: 'sticker', ref, name: `sticker_${body.mid}.png` };
        break;
      case 'contact': {
        const i = p.max_info ?? {};
        extra.push(`Контакт: ${[i.name, i.username ? `@${i.username}` : ''].filter(Boolean).join(' ')}`.trim());
        if (typeof p.vcf_info === 'string') {
          const tel = /TEL[^:]*:([+\d][\d\s()-]{5,})/i.exec(p.vcf_info)?.[1];
          if (tel) extra.push(tel.trim());
        }
        break;
      }
      case 'location':
        extra.push(`Геопозиция: https://yandex.ru/maps/?pt=${a.longitude},${a.latitude}&z=16`);
        break;
      case 'share':
        if (ref) extra.push(ref);
        break;
      default:
        break;
    }
  }
  return { attachment, extraText: extra.join('\n') };
}

/** Update MAX → общее событие. null — не для переписки (служебное, от бота, канал). */
export function normalizeMaxUpdate(update: any, opts: { botId?: number; groupTitle?: (chatId: string) => string | undefined } = {}): InboundEvent | null {
  if (update?.update_type !== 'message_created') return null;
  const m = update.message;
  const sender = m?.sender;
  const r = m?.recipient;
  const body = m?.body;
  if (!m || !sender || !r || !body?.mid) return null;
  if (sender.is_bot || (opts.botId && Number(sender.user_id) === opts.botId)) return null;
  const chatId = r.chat_id ?? r.user_id;
  if (chatId === undefined || chatId === null) return null;
  const isGroup = r.chat_type === 'chat';
  if (!isGroup && r.chat_type !== 'dialog') return null;
  const { attachment, extraText } = attachmentOf(body);
  const text = [String(body.text ?? ''), extraText].filter(Boolean).join('\n');
  if (!text && !attachment) return null;
  const username = typeof sender.username === 'string' ? sender.username : undefined;
  const link = m.link?.type === 'reply' ? m.link?.message?.mid : null;
  const ts = Number(m.timestamp ?? update.timestamp ?? 0);
  return {
    externalChatId: String(chatId),
    chatTitle: isGroup ? (opts.groupTitle?.(String(chatId)) ?? 'Группа MAX') : fullName(sender),
    isGroup,
    contact: !isGroup && username ? { username } : {},
    author: isGroup ? { id: String(sender.user_id), name: fullName(sender) } : null,
    externalMessageId: String(body.mid),
    text,
    attachment,
    replyToExternalId: link ? String(link) : null,
    timestamp: ts > 1e12 ? Math.floor(ts / 1000) : ts || Math.floor(Date.now() / 1000),
    fromMe: false,
  };
}

const UPLOAD_TYPE: Record<Exclude<AmojoMessageKind, 'text'>, 'image' | 'video' | 'audio' | 'file'> = {
  picture: 'image',
  video: 'video',
  voice: 'audio',
  audio: 'audio',
  file: 'file',
  sticker: 'image',
};

/** Текст MAX — до 4000 символов. */
const TEXT_LIMIT = 4000;

export class MaxConnector implements Connector {
  readonly api: MaxApi;
  private readonly abort = new AbortController();
  private loop: Promise<void> | null = null;
  private botId = 0;
  private readonly groupTitles = new Map<string, string>();

  constructor(
    token: string,
    private readonly opts: HttpOptions & { onError?: (err: unknown) => void; sleep?: typeof pause } = {},
  ) {
    this.api = new MaxApi(token, opts);
  }

  async start(sink: ConnectorSink): Promise<void> {
    this.loop = this.poll(sink);
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop;
  }

  private async groupTitle(chatId: string): Promise<string | undefined> {
    const cached = this.groupTitles.get(chatId);
    if (cached) return cached;
    const chat = await this.api.call<{ title?: string }>('GET', `/chats/${encodeURIComponent(chatId)}`).catch(() => null);
    if (chat?.title) this.groupTitles.set(chatId, chat.title);
    return chat?.title ?? undefined;
  }

  private async poll(sink: ConnectorSink): Promise<void> {
    const signal = this.abort.signal;
    const sleep = this.opts.sleep ?? pause;
    let marker: number | null = null;
    let failures = 0;
    let connected = false;
    while (!signal.aborted) {
      try {
        if (!this.botId) this.botId = (await this.api.getMe()).user_id;
        const q: Record<string, string | number> = { limit: 100, timeout: 30, types: 'message_created' };
        if (marker !== null) q.marker = marker;
        const r = await this.api.call<{ updates?: any[]; marker?: number | null }>('GET', '/updates', q, undefined, 45_000, signal);
        if (!connected) {
          await sink.status('connected');
          connected = true;
        }
        failures = 0;
        for (const u of r.updates ?? []) {
          const chatId = String(u?.message?.recipient?.chat_id ?? '');
          if (u?.message?.recipient?.chat_type === 'chat' && chatId && !this.groupTitles.has(chatId)) await this.groupTitle(chatId);
          const ev = normalizeMaxUpdate(u, { botId: this.botId, groupTitle: (id) => this.groupTitles.get(id) });
          if (ev) await sink.inbound(ev);
        }
        // Маркер двигаем после обработки: при сбое пачка придёт снова, дубли отсечёт БД.
        if (typeof r.marker === 'number') marker = r.marker;
      } catch (err) {
        if (signal.aborted) break;
        if (err instanceof ApiError && err.status === 401) {
          await sink.status('error', 'MAX не принял токен бота — подключите бота заново');
          return;
        }
        failures++;
        connected = false;
        const detail =
          err instanceof ApiError && err.status === 403
            ? 'MAX отказал боту в доступе: проверьте, что бот не отключён в @MasterBot'
            : 'Нет связи с MAX, повторное подключение';
        await sink.status('error', detail).catch(() => undefined);
        this.opts.onError?.(err);
        await sleep(err instanceof ApiError && err.retryAfter ? err.retryAfter * 1000 : reconnectDelayMs(failures), signal);
      }
    }
  }

  async typing(externalChatId: string): Promise<void> {
    await this.api.call('POST', '/actions', { chat_id: externalChatId }, { action: 'typing_on' }, 10_000).catch(() => undefined);
  }

  private async sendOnce(chatId: string, body: Record<string, unknown>): Promise<{ mid: string }> {
    // После загрузки файл обрабатывается; пока не готов — API отвечает 400 attachment.not.ready.
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await this.api.call<{ message?: { body?: { mid?: string } } }>('POST', '/messages', { chat_id: chatId }, body, 60_000);
        const mid = r.message?.body?.mid;
        if (!mid) throw new Error('MAX не вернул id сообщения');
        return { mid };
      } catch (err) {
        if (err instanceof ApiError && err.apiCode === 'attachment.not.ready' && attempt < 5) {
          await (this.opts.sleep ?? pause)(1000 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
  }

  async send(req: OutboundRequest): Promise<{ externalMessageId: string }> {
    const link = req.replyToExternalId ? { link: { type: 'reply', mid: req.replyToExternalId } } : {};
    try {
      const parts = splitText(req.text, TEXT_LIMIT);
      let first: Record<string, unknown> = { ...link, text: parts[0] ?? '' };
      if (req.file) {
        const payload = await this.api.upload(UPLOAD_TYPE[req.file.kind], req.file.data, req.file.name, req.file.mime);
        first = { ...first, attachments: [{ type: UPLOAD_TYPE[req.file.kind], payload }] };
      }
      const { mid } = await this.sendOnce(req.externalChatId, first);
      for (const part of parts.slice(1)) await this.sendOnce(req.externalChatId, { text: part });
      return { externalMessageId: mid };
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        throw new PermanentSendError(err.status === 403 ? 'Клиент заблокировал бота или покинул чат' : 'Чат MAX не найден');
      }
      throw err;
    }
  }

  download(ref: string, maxBytes: number): Promise<{ data: Buffer; mime: string }> {
    return this.api.http.download(ref, maxBytes);
  }
}
