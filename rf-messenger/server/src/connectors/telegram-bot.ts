import type { Dispatcher } from 'undici';
import type { AmojoMessageKind } from '../amojo/client.ts';
import {
  PermanentSendError,
  reconnectDelayMs,
  type Connector,
  type ConnectorSink,
  type InboundAttachment,
  type InboundEvent,
  type OutboundRequest,
} from './types.ts';

const API = 'https://api.telegram.org';

export class TelegramApiError extends Error {
  constructor(
    readonly code: number,
    description: string,
    readonly retryAfter: number | null = null,
  ) {
    super(`Telegram ${code}: ${description}`);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any -- ответы Bot API разбираются вручную */

export interface TelegramNetOptions {
  fetch?: typeof fetch;
  /** Прокси для api.telegram.org; не задан — напрямую. Функция — текущий прокси (основной или запасной) на момент запроса. */
  dispatcher?: Dispatcher | (() => Dispatcher | undefined);
  /** Повторы при сетевой ошибке, таймауте, 429 и 5xx. */
  retry?: RetryOptions;
}

export interface RetryOptions {
  /** Сколько раз повторить запрос после первой неудачи (по умолчанию 5). */
  retries?: number;
  /** Для тестов: пауза и источник случайности. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

/** Повторять имеет смысл: нет ответа (сеть, таймаут, прокси), 429 или ошибка сервера. 2xx и 4xx — не повторяем. */
export const isRetryable = (err: unknown): err is TelegramApiError =>
  err instanceof TelegramApiError && (err.code === 0 || err.code === 429 || err.code >= 500);

/** Пауза перед повтором номер attempt (0, 1, …): 1–2–4–8–16 с ±25 %; для 429 — retry_after из ответа. */
export function retryDelayMs(attempt: number, err: TelegramApiError, random: () => number = Math.random): number {
  if (err.code === 429 && err.retryAfter) return err.retryAfter * 1000;
  return Math.round(1000 * 2 ** attempt * (0.75 + random() * 0.5));
}

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/** Минимальный клиент Bot API на fetch, без сторонних библиотек. Токен не попадает в ошибки и логи. */
export class TelegramBotApi {
  private readonly f: typeof fetch;
  private readonly dispatcher: () => Dispatcher | undefined;
  private readonly retries: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;

  constructor(
    private readonly token: string,
    opts: TelegramNetOptions = {},
  ) {
    this.f = opts.fetch ?? fetch;
    const d = opts.dispatcher;
    this.dispatcher = typeof d === 'function' ? d : () => d;
    this.retries = opts.retry?.retries ?? 5;
    this.sleep = opts.retry?.sleep ?? pause;
    this.random = opts.retry?.random ?? Math.random;
  }

  /** Прокси (undici ProxyAgent) — передаётся в каждый запрос к api.telegram.org. */
  private via(): RequestInit {
    const d = this.dispatcher();
    return d ? ({ dispatcher: d } as RequestInit) : {};
  }

  /** Повтор при сбое сети, 429 и 5xx. Успешный ответ не повторяется — сообщение не уйдёт дважды. */
  private async withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (signal?.aborted || !isRetryable(err) || attempt >= this.retries) throw err;
        await this.sleep(retryDelayMs(attempt, err, this.random), signal);
        if (signal?.aborted) throw err;
      }
    }
  }

  call<T = any>(method: string, params: Record<string, unknown> | FormData = {}, timeoutMs = 30_000, signal?: AbortSignal): Promise<T> {
    return this.withRetry(() => this.callOnce<T>(method, params, timeoutMs, signal), signal);
  }

  private async callOnce<T>(method: string, params: Record<string, unknown> | FormData, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    const isForm = params instanceof FormData;
    const timeout = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await this.f(`${API}/bot${this.token}/${method}`, {
        ...this.via(),
        method: 'POST',
        ...(isForm ? { body: params } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      // В тексте сетевой ошибки может оказаться адрес с токеном — заменяем.
      throw new TelegramApiError(0, (err as Error).name === 'TimeoutError' ? 'timeout' : 'network error');
    }
    const body = (await res.json().catch(() => null)) as any;
    if (!body?.ok) {
      throw new TelegramApiError(body?.error_code ?? res.status, String(body?.description ?? 'error').slice(0, 200), body?.parameters?.retry_after ?? null);
    }
    return body.result as T;
  }

  getMe(): Promise<{ id: number; username: string; first_name: string }> {
    return this.call('getMe', {}, 15_000);
  }

  async downloadFile(fileId: string, maxBytes: number): Promise<{ data: Buffer; path: string }> {
    const file = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId });
    if (!file.file_path) throw new Error('Файл недоступен (Bot API отдаёт файлы до 20 МБ)');
    if ((file.file_size ?? 0) > maxBytes) throw new Error('Файл больше допустимого размера');
    const data = await this.withRetry(async () => {
      const res = await this.f(`${API}/file/bot${this.token}/${file.file_path}`, { ...this.via(), signal: AbortSignal.timeout(120_000) }).catch(() => {
        throw new TelegramApiError(0, 'network error');
      });
      if (!res.ok) throw new TelegramApiError(res.status, 'file download failed', Number(res.headers.get('retry-after')) || null);
      return Buffer.from(await res.arrayBuffer().catch(() => {
        throw new TelegramApiError(0, 'network error');
      }));
    });
    if (data.length > maxBytes) throw new Error('Файл больше допустимого размера');
    return { data, path: file.file_path };
  }
}

const fullName = (u: any): string => [u?.first_name, u?.last_name].filter(Boolean).join(' ') || (u?.username ? `@${u.username}` : `id${u?.id}`);

function attachmentOf(m: any): InboundAttachment | null {
  if (Array.isArray(m.photo) && m.photo.length) {
    const p = m.photo[m.photo.length - 1];
    return { kind: 'picture', ref: p.file_id, name: `photo_${m.message_id}.jpg`, mime: 'image/jpeg', size: p.file_size };
  }
  const pick = (kind: InboundAttachment['kind'], o: any, ext: string): InboundAttachment => ({
    kind,
    ref: o.file_id,
    name: o.file_name ?? `${kind}_${m.message_id}.${ext}`,
    mime: o.mime_type,
    size: o.file_size,
  });
  if (m.voice) return pick('voice', m.voice, 'ogg');
  if (m.audio) return pick('audio', m.audio, 'mp3');
  if (m.video) return pick('video', m.video, 'mp4');
  if (m.video_note) return pick('video', m.video_note, 'mp4');
  if (m.animation) return pick('video', m.animation, 'mp4');
  if (m.sticker) return pick('sticker', m.sticker, m.sticker.is_video ? 'webm' : 'webp');
  if (m.document) return pick('file', m.document, 'bin');
  return null;
}

/** Update Bot API → общее событие. null — событие не для переписки (служебное, от бота, правка). */
export function normalizeTelegramUpdate(update: any): InboundEvent | null {
  const m = update?.message;
  if (!m || !m.chat || !m.from || m.from.is_bot) return null;
  const isGroup = m.chat.type === 'group' || m.chat.type === 'supergroup';
  if (!isGroup && m.chat.type !== 'private') return null;
  const attachment = attachmentOf(m);
  let text: string = m.text ?? m.caption ?? '';
  if (!text && !attachment) {
    if (m.contact) text = `Контакт: ${[m.contact.first_name, m.contact.last_name].filter(Boolean).join(' ')} ${m.contact.phone_number ?? ''}`.trim();
    else if (m.location) text = `Геопозиция: https://yandex.ru/maps/?pt=${m.location.longitude},${m.location.latitude}&z=16`;
    else return null;
  }
  const username = isGroup ? m.chat.username : m.from.username;
  return {
    externalChatId: String(m.chat.id),
    chatTitle: isGroup ? String(m.chat.title ?? `Группа ${m.chat.id}`) : fullName(m.from),
    isGroup,
    contact: username ? { username, link: `https://t.me/${username}` } : {},
    author: isGroup ? { id: String(m.from.id), name: fullName(m.from) } : null,
    externalMessageId: String(m.message_id),
    text,
    attachment,
    replyToExternalId: m.reply_to_message ? String(m.reply_to_message.message_id) : null,
    timestamp: Number(m.date) || Math.floor(Date.now() / 1000),
    fromMe: false,
  };
}

const SEND_METHOD: Record<Exclude<AmojoMessageKind, 'text'>, [string, string]> = {
  picture: ['sendPhoto', 'photo'],
  video: ['sendVideo', 'video'],
  voice: ['sendVoice', 'voice'],
  audio: ['sendAudio', 'audio'],
  file: ['sendDocument', 'document'],
  sticker: ['sendDocument', 'document'],
};

/** Длинный текст — на части по лимиту Telegram, по возможности по переводу строки. */
export function splitText(text: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const cut = rest.lastIndexOf('\n', limit);
    const at = cut > limit / 2 ? cut : limit;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, '');
  }
  parts.push(rest);
  return parts;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/** Telegram-бот: long polling getUpdates (вебхук не нужен), отправка через Bot API. */
export class TelegramBotConnector implements Connector {
  private readonly api: TelegramBotApi;
  private readonly abort = new AbortController();
  private loop: Promise<void> | null = null;

  constructor(
    token: string,
    private readonly opts: TelegramNetOptions & { onError?: (err: unknown) => void } = {},
  ) {
    this.api = new TelegramBotApi(token, opts);
  }

  async start(sink: ConnectorSink): Promise<void> {
    this.loop = this.poll(sink);
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop;
  }

  private async poll(sink: ConnectorSink): Promise<void> {
    const signal = this.abort.signal;
    let offset = 0;
    let failures = 0;
    let connected = false;
    while (!signal.aborted) {
      try {
        const updates = await this.api.call<any[]>('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, 40_000, signal);
        if (!connected) {
          await sink.status('connected');
          connected = true;
        }
        failures = 0;
        for (const u of updates) {
          const ev = normalizeTelegramUpdate(u);
          if (ev) await sink.inbound(ev);
          // Смещение двигаем только после обработки: при сбое событие придёт снова, дубль отсечёт БД.
          offset = Number(u.update_id) + 1;
        }
      } catch (err) {
        if (signal.aborted) break;
        if (err instanceof TelegramApiError && err.code === 401) {
          await sink.status('error', 'Токен бота недействителен — подключите бота заново');
          return;
        }
        failures++;
        connected = false;
        const detail =
          err instanceof TelegramApiError && err.code === 409
            ? 'Бот уже получает сообщения в другом сервисе (вебхук). Отключите его там'
            : 'Нет связи с Telegram, повторное подключение';
        await sink.status('error', detail).catch(() => undefined);
        this.opts.onError?.(err);
        await sleep(err instanceof TelegramApiError && err.retryAfter ? err.retryAfter * 1000 : reconnectDelayMs(failures), signal);
      }
    }
  }

  async typing(externalChatId: string): Promise<void> {
    await this.api.call('sendChatAction', { chat_id: externalChatId, action: 'typing' }, 10_000).catch(() => undefined);
  }

  async send(req: OutboundRequest): Promise<{ externalMessageId: string }> {
    const reply = req.replyToExternalId
      ? { reply_parameters: { message_id: Number(req.replyToExternalId), allow_sending_without_reply: true } }
      : {};
    try {
      let result: { message_id: number };
      if (req.file) {
        const [method, field] = SEND_METHOD[req.file.kind];
        const form = new FormData();
        form.set('chat_id', req.externalChatId);
        if (req.text) form.set('caption', req.text.slice(0, 1024));
        if (reply.reply_parameters) form.set('reply_parameters', JSON.stringify(reply.reply_parameters));
        form.set(field, new Blob([new Uint8Array(req.file.data)], { type: req.file.mime }), req.file.name);
        result = await this.api.call(method, form, 120_000);
        // Подпись длиннее лимита Telegram дописываем отдельным сообщением.
        if (req.text.length > 1024) await this.api.call('sendMessage', { chat_id: req.externalChatId, text: req.text.slice(1024) });
      } else {
        const parts = splitText(req.text, 4096);
        result = await this.api.call('sendMessage', { chat_id: req.externalChatId, text: parts[0] ?? '', ...reply });
        for (const part of parts.slice(1)) await this.api.call('sendMessage', { chat_id: req.externalChatId, text: part });
      }
      return { externalMessageId: String(result.message_id) };
    } catch (err) {
      if (err instanceof TelegramApiError && (err.code === 403 || err.code === 400)) {
        throw new PermanentSendError(err.code === 403 ? 'Клиент заблокировал бота или удалил чат' : err.message);
      }
      throw err;
    }
  }

  async download(ref: string, maxBytes: number): Promise<{ data: Buffer; mime: string }> {
    const { data } = await this.api.downloadFile(ref, maxBytes);
    return { data, mime: 'application/octet-stream' };
  }
}
