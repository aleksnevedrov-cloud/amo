import { assertPublicUrl, type Resolver } from './safe-url.ts';

/** Скачанная страница или файл по ссылке. */
export interface FetchedUrl {
  bytes: Uint8Array;
  /** MIME без параметров (text/html, application/pdf…); пусто — сервер не сказал. */
  mime: string;
  finalUrl: string;
  status: number;
}

export type UrlFetcher = (url: string) => Promise<FetchedUrl>;

export interface UrlFetcherOptions {
  fetch?: typeof fetch;
  resolve?: Resolver;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

export const USER_AGENT = 'AI-Door-Agent-Opt/1.0 (+https://rf-dveri.ru; knowledge)';

/**
 * Скачивание по ссылке с проверкой каждого адреса в цепочке редиректов (SSRF), лимитом размера и таймаутом.
 * Ошибки — текстом для источника: «HTTP 404», «ответ больше 50 МБ», «таймаут 30 с».
 */
export function createUrlFetcher(opts: UrlFetcherOptions = {}): UrlFetcher {
  const f = opts.fetch ?? fetch;
  const maxBytes = opts.maxBytes ?? 50 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxRedirects = opts.maxRedirects ?? 5;
  return async (raw) => {
    let url = (await assertPublicUrl(raw, opts.resolve)).toString();
    for (let hop = 0; ; hop++) {
      let res: Response;
      try {
        res = await f(url, { redirect: 'manual', headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/pdf,application/*;q=0.9,*/*;q=0.5' }, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        const e = err as Error & { name?: string };
        throw new Error(e.name === 'TimeoutError' ? `таймаут ${Math.round(timeoutMs / 1000)} с` : `сеть: ${e.message}`);
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error(`HTTP ${res.status} без адреса перенаправления`);
        if (hop >= maxRedirects) throw new Error('слишком много перенаправлений');
        url = (await assertPublicUrl(new URL(loc, url).toString(), opts.resolve)).toString();
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > maxBytes) throw new Error(`ответ больше ${Math.round(maxBytes / 1024 / 1024)} МБ`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > maxBytes) throw new Error(`ответ больше ${Math.round(maxBytes / 1024 / 1024)} МБ`);
      const mime = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      return { bytes, mime, finalUrl: url, status: res.status };
    }
  };
}
