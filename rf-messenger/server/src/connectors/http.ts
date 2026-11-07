import { assertPublicUrl, type Resolver } from '../safe-fetch.ts';

/**
 * Общий HTTP-слой коннекторов MAX, VK и Авито: запрос с таймаутом, повторы при сетевой ошибке,
 * 429 и 5xx, скачивание файла с лимитом размера. Прокси нет: это российские сервисы, идут напрямую.
 */

export class ApiError extends Error {
  constructor(
    /** HTTP-статус; 0 — сеть или таймаут. */
    readonly status: number,
    message: string,
    /** Код ошибки самого API (VK error_code, MAX code, Авито code). */
    readonly apiCode: string | number | null = null,
    /** Сколько ждать перед повтором, с (из ответа 429). */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
  }
}

export interface RetryOptions {
  /** Сколько раз повторить после первой неудачи (по умолчанию 5). */
  retries?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export interface HttpOptions {
  fetch?: typeof fetch;
  retry?: RetryOptions;
  resolve?: Resolver;
}

/** Повторять имеет смысл: нет ответа, 429 или ошибка сервера. 2xx и остальные 4xx — нет. */
export const isRetryable = (err: unknown): err is ApiError => err instanceof ApiError && (err.status === 0 || err.status === 429 || err.status >= 500);

/** Пауза перед повтором номер attempt (0, 1, …): 1–2–4–8–16 с ±25 %; для 429 — retry_after из ответа. */
export function retryDelayMs(attempt: number, err: ApiError, random: () => number = Math.random): number {
  if (err.status === 429 && err.retryAfter) return Math.min(err.retryAfter, 120) * 1000;
  return Math.round(1000 * 2 ** attempt * (0.75 + random() * 0.5));
}

export const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

export interface HttpResponse {
  status: number;
  headers: Headers;
  /** Разобранный JSON; null — тело не JSON или пустое. */
  json: unknown;
  text: string;
}

export class HttpClient {
  readonly f: typeof fetch;
  private readonly retries: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly resolve: Resolver | undefined;

  constructor(opts: HttpOptions = {}) {
    this.f = opts.fetch ?? fetch;
    this.retries = opts.retry?.retries ?? 5;
    this.sleep = opts.retry?.sleep ?? pause;
    this.random = opts.retry?.random ?? Math.random;
    this.resolve = opts.resolve;
  }

  /** Повтор при сбое сети, 429 и 5xx. Успешный ответ не повторяется — сообщение не уйдёт дважды. */
  async withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
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

  /**
   * Один HTTP-запрос с таймаутом. Сетевая ошибка → ApiError(0) без адреса (в нём может быть токен).
   * 429 и 5xx → ApiError с retryAfter, чтобы withRetry повторил. Остальные статусы возвращаются как есть.
   */
  async request(url: string, init: RequestInit & { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<HttpResponse> {
    const { timeoutMs = 30_000, signal, ...rest } = init;
    const timeout = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await this.f(url, { ...rest, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch (err) {
      throw new ApiError(0, (err as Error).name === 'TimeoutError' || timeout.aborted ? 'timeout' : 'network error');
    }
    const text = await res.text().catch(() => {
      throw new ApiError(0, 'network error');
    });
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.status === 429 || res.status >= 500) {
      throw new ApiError(res.status, `HTTP ${res.status}`, null, Number(res.headers.get('retry-after')) || null);
    }
    return { status: res.status, headers: res.headers, json, text };
  }

  /** request + withRetry. */
  call(url: string, init: RequestInit & { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<HttpResponse> {
    return this.withRetry(() => this.request(url, init), init.signal);
  }

  /**
   * Скачивание файла по адресу, который прислал мессенджер: только http(s), не во внутреннюю сеть,
   * с лимитом размера и повтором при сбое. Таймаут — 90 с (раздел 4 ТЗ).
   */
  async download(raw: string, maxBytes: number, headers: Record<string, string> = {}): Promise<{ data: Buffer; mime: string }> {
    return this.withRetry(async () => {
      let current = raw;
      for (let hop = 0; hop < 4; hop++) {
        const url = await assertPublicUrl(current, this.resolve);
        let res: Response;
        try {
          res = await this.f(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(90_000) });
        } catch {
          throw new ApiError(0, 'network error');
        }
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          if (!loc) throw new Error('Редирект без адреса');
          current = new URL(loc, url).toString();
          continue;
        }
        if (res.status === 429 || res.status >= 500) throw new ApiError(res.status, `HTTP ${res.status}`, null, Number(res.headers.get('retry-after')) || null);
        if (!res.ok || !res.body) throw new Error(`Файл не скачан: HTTP ${res.status}`);
        if (Number(res.headers.get('content-length') ?? 0) > maxBytes) throw new Error('Файл больше допустимого размера');
        const chunks: Buffer[] = [];
        let size = 0;
        try {
          for await (const chunk of res.body) {
            size += chunk.length;
            if (size > maxBytes) throw new Error('Файл больше допустимого размера');
            chunks.push(Buffer.from(chunk));
          }
        } catch (err) {
          if ((err as Error).message.includes('допустимого')) throw err;
          throw new ApiError(0, 'network error');
        }
        return { data: Buffer.concat(chunks), mime: res.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream' };
      }
      throw new Error('Слишком много редиректов');
    });
  }
}

/** Multipart-форма с одним файлом. */
export function fileForm(field: string, data: Buffer, name: string, mime: string, extra: Record<string, string> = {}): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  form.set(field, new Blob([new Uint8Array(data)], { type: mime || 'application/octet-stream' }), name);
  return form;
}

/** Расширение файла по MIME для имён вложений. */
export function extOf(mime: string | undefined, fallback: string): string {
  const m = (mime ?? '').toLowerCase();
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'application/pdf': 'pdf',
  };
  return map[m] ?? fallback;
}
