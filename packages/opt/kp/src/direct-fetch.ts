import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * RFD-AI-AGENT-OPT-DEAL-FILES-2, 2.4: запросы к Яндекс Диску идут напрямую, без прокси. Глобальный fetch Node при
 * NODE_USE_ENV_PROXY=1 ходит через HTTPS_PROXY, а список папки через прокси проходил, скачивание (downloader.disk.yandex.ru,
 * *.storage.yandex.net) — нет. Этот клиент собран на node:https, который переменные прокси не читает вовсе: прямое
 * соединение независимо от окружения (NO_PROXY в compose — дополнительно, для остального). Только GET, редиректы до 5,
 * ответ — обычный Response. Сетевая ошибка — TypeError('fetch failed') с cause.code, как у undici.
 */
const MAX_REDIRECTS = 5;

export const directFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => {
    headers[k] = v;
  });
  const signal = init?.signal ?? null;
  for (let hop = 0; ; hop++) {
    const res = await once(url, method, headers, signal);
    if ([301, 302, 303, 307, 308].includes(res.status) && res.location && hop < MAX_REDIRECTS) {
      const next = new URL(res.location, url);
      // На другой хост заголовок authorization не переносим.
      if (next.host !== url.host) delete headers.authorization;
      url.href = next.href;
      continue;
    }
    return new Response(res.body, { status: res.status, headers: res.headers });
  }
};

function once(url: URL, method: string, headers: Record<string, string>, signal: AbortSignal | null): Promise<{ status: number; headers: Record<string, string>; location: string | null; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'http:' ? httpRequest : httpsRequest)(url, { method, headers, ...(signal ? { signal } : {}) }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') out[k] = v;
        resolve({ status: res.statusCode ?? 0, headers: out, location: typeof res.headers.location === 'string' ? res.headers.location : null, body: Buffer.concat(chunks) });
      });
      res.on('error', (err) => reject(wrap(err)));
    });
    req.on('error', (err) => reject(wrap(err)));
    req.end();
  });
}

/** Как undici: TypeError('fetch failed') с причиной в cause (ECONNRESET, ENOTFOUND, ETIMEDOUT…). */
function wrap(err: Error): TypeError {
  return Object.assign(new TypeError('fetch failed'), { cause: err });
}
