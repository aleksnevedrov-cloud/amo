/**
 * RFD-AI-AGENT-OPT-DEAL-FILES, часть Б: открытый API Яндекс Диска без ключа (свой код опта, как в рознице, но без импорта
 * @retail/*). Ссылки yadi.sk/d, yadi.sk/i, disk.yandex.ru|com/d, /i. Метаданные — GET cloud-api.yandex.net/v1/disk/public/resources
 * ?public_key=<ссылка>[&path=/папка]; файл — …/resources/download → href; папка — элементы первого уровня из _embedded.items
 * (limit=50), вложенная папка читается ещё раз с path (второй уровень, не глубже), скачивание по public_key + path.
 * Ходим только на cloud-api.yandex.net и на href скачивания в домене yandex (downloader.disk.yandex.ru и подобные).
 */

export const YADISK_LINK_RE = /https?:\/\/(?:yadi\.sk|disk\.yandex\.(?:ru|com|by|kz|ua))\/[^\s<>"'()\]]+/giu;
/** Другие облака — не поддерживаются, только отметка в журнале с доменом. */
export const OTHER_CLOUD_RE = /https?:\/\/(?:(?:www\.)?(?:drive|docs)\.google\.com|cloud\.mail\.ru|(?:www\.)?dropbox\.com|1drv\.ms|onedrive\.live\.com|(?:www\.)?icloud\.com)\/[^\s<>"'()\]]*/giu;
const API = 'https://cloud-api.yandex.net/v1/disk/public/resources';
const DOWNLOAD_HOST_RE = /(^|\.)yandex\.(net|ru|com|by|kz)$/i;
/** DEAL-FILES-2, 2.4.3: повтор скачивания при сетевой ошибке и 5xx — 2 попытки с паузой 3 с. */
export const DOWNLOAD_RETRIES = 2;
export const DOWNLOAD_RETRY_DELAY_MS = 3000;

/**
 * DEAL-FILES-2, 2.4.1: сетевая ошибка с кодом и хостом — «fetch failed (ECONNRESET, downloader.disk.yandex.ru)», а не просто
 * «fetch failed» (код — из err.cause.code undici / node:https).
 */
export function describeFetchError(err: unknown, url: string): string {
  const e = err as { message?: string; cause?: { code?: string; message?: string } | null; code?: string };
  const code = e.cause?.code ?? e.code ?? (e.cause?.message ? e.cause.message.split(' ')[0] : null) ?? null;
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // не URL — оставляем как есть
  }
  return `${e.message ?? 'ошибка сети'} (${code ?? 'без кода'}, ${host})`;
}

export interface YadiskItem {
  type: 'file' | 'dir';
  name: string;
  path: string;
  size: number;
  mime: string | null;
}

export interface YadiskMeta {
  type: 'file' | 'dir';
  name: string;
  path: string;
  size: number;
  mime: string | null;
  /** Элементы первого уровня папки (type = dir): файлы и вложенные папки. */
  items: YadiskItem[];
}

/** Ошибка Диска: final — повторять нет смысла (404, удалено, закрыт доступ); иначе — 429 / сеть, повтор следующим проходом. */
export class YadiskError extends Error {
  constructor(
    message: string,
    readonly final: boolean,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

/** Ссылки Диска из текста примечания (без хвостовых знаков препинания), до max штук, без повторов. */
export function yadiskLinks(text: string, max = 10): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(YADISK_LINK_RE)) {
    const url = m[0].replace(/[.,;:!?]+$/u, '');
    if (!out.includes(url)) out.push(url);
    if (out.length >= max) break;
  }
  return out;
}

/** Домены других облаков из текста — для отметки «не поддерживается». */
export function otherCloudLinks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(OTHER_CLOUD_RE)) {
    const host = new URL(m[0]).host.toLowerCase();
    if (!out.includes(host)) out.push(host);
  }
  return out;
}

async function apiJson<T>(fetchImpl: typeof fetch, url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'ai-door-opt-agent/1.0' }, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new YadiskError(`сеть: ${describeFetchError(err, url)}`, false);
  }
  if (res.ok) return (await res.json()) as T;
  const body = (await res.json().catch(() => null)) as { message?: string; description?: string; error?: string } | null;
  const text = body?.message || body?.description || body?.error || `HTTP ${res.status}`;
  // 404 — ссылка удалена или не существует, 403 — доступ закрыт, 410 — удалено; 429 и 5xx — повтор позже.
  const final = res.status === 404 || res.status === 403 || res.status === 410 || res.status === 400;
  throw new YadiskError(`Диск: ${text} (HTTP ${res.status})`, final, res.status);
}

export async function yadiskMeta(fetchImpl: typeof fetch, publicKey: string, path: string | null = null, limit = 50): Promise<YadiskMeta> {
  const r = await apiJson<{ type?: string; name?: string; path?: string; size?: number; mime_type?: string | null; _embedded?: { items?: { type?: string; name?: string; path?: string; size?: number; mime_type?: string | null }[] } }>(fetchImpl, `${API}?public_key=${encodeURIComponent(publicKey)}${path ? `&path=${encodeURIComponent(path)}` : ''}&limit=${limit}`);
  const type = r.type === 'dir' ? 'dir' : 'file';
  const items = (r._embedded?.items ?? [])
    .filter((i) => (i.type === 'file' || i.type === 'dir') && i.name)
    .map((i) => ({ type: i.type === 'dir' ? ('dir' as const) : ('file' as const), name: String(i.name), path: String(i.path ?? `/${i.name}`), size: Number(i.size ?? 0), mime: i.mime_type ?? null }));
  return { type, name: String(r.name ?? ''), path: String(r.path ?? '/'), size: Number(r.size ?? 0), mime: r.mime_type ?? null, items };
}

/** Клиент Диска для сборки черновика (в тестах — фикстура cloud-api через fetch). */
export interface YadiskClient {
  meta(publicKey: string, path?: string | null): Promise<YadiskMeta>;
  download(publicKey: string, path: string | null, maxBytes: number): Promise<{ bytes: Uint8Array; mime: string | null }>;
}

export interface YadiskClientOptions {
  /** Пауза между повторами скачивания (в тестах — 0). */
  retryDelayMs?: number;
}

/**
 * DEAL-FILES-2, 2.4.2: все запросы к Диску — через прямой клиент без прокси (node:https; в тестах — фикстура), а не через
 * глобальный fetch с HTTPS_PROXY: сервер в России, Диск — российский сервис.
 */
export function createYadiskClient(direct: typeof fetch, opts: YadiskClientOptions = {}): YadiskClient {
  return {
    meta: (publicKey, path = null) => yadiskMeta(direct, publicKey, path),
    download: (publicKey, path, maxBytes) => yadiskDownload(direct, publicKey, path, maxBytes, opts),
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 2 повтора с паузой при сетевой ошибке (YadiskError final = false) и 5xx. */
async function withDownloadRetry<T>(fn: () => Promise<T>, delayMs: number): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retriable = err instanceof YadiskError && !err.final;
      if (!retriable || attempt >= DOWNLOAD_RETRIES) throw err;
      if (delayMs > 0) await sleep(delayMs);
    }
  }
}

/** Скачать файл по публичной ссылке (и path внутри папки): href от Диска, только домен yandex, не больше maxBytes. */
export async function yadiskDownload(fetchImpl: typeof fetch, publicKey: string, path: string | null, maxBytes: number, opts: YadiskClientOptions = {}): Promise<{ bytes: Uint8Array; mime: string | null }> {
  return withDownloadRetry(async () => {
    const link = await apiJson<{ href?: string }>(fetchImpl, `${API}/download?public_key=${encodeURIComponent(publicKey)}${path ? `&path=${encodeURIComponent(path)}` : ''}`);
    if (!link.href) throw new YadiskError('Диск: не вернул ссылку на скачивание', true);
    const host = new URL(link.href).host;
    if (!DOWNLOAD_HOST_RE.test(host)) throw new YadiskError(`Диск: ссылка на скачивание вне домена yandex (${host})`, true);
    return downloadHref(fetchImpl, link.href, maxBytes);
  }, opts.retryDelayMs ?? DOWNLOAD_RETRY_DELAY_MS);
}

async function downloadHref(fetchImpl: typeof fetch, href: string, maxBytes: number): Promise<{ bytes: Uint8Array; mime: string | null }> {
  let res: Response;
  try {
    res = await fetchImpl(href, { headers: { 'user-agent': 'ai-door-opt-agent/1.0' }, signal: AbortSignal.timeout(120_000) });
  } catch (err) {
    throw new YadiskError(`сеть при скачивании: ${describeFetchError(err, href)}`, false);
  }
  if (!res.ok) throw new YadiskError(`Диск: скачивание HTTP ${res.status}`, res.status === 404 || res.status === 403 || res.status === 410, res.status);
  if (Number(res.headers.get('content-length') ?? 0) > maxBytes) throw new YadiskError(`файл больше ${Math.round(maxBytes / 1024 / 1024)} МБ`, true);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new YadiskError(`файл больше ${Math.round(maxBytes / 1024 / 1024)} МБ`, true);
  return { bytes, mime: res.headers.get('content-type')?.split(';')[0]?.trim() || null };
}
