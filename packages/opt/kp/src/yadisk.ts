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
    throw new YadiskError(`сеть: ${(err as Error).message}`, false);
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

export function createYadiskClient(fetchImpl: typeof fetch): YadiskClient {
  return {
    meta: (publicKey, path = null) => yadiskMeta(fetchImpl, publicKey, path),
    download: (publicKey, path, maxBytes) => yadiskDownload(fetchImpl, publicKey, path, maxBytes),
  };
}

/** Скачать файл по публичной ссылке (и path внутри папки): href от Диска, только домен yandex, не больше maxBytes. */
export async function yadiskDownload(fetchImpl: typeof fetch, publicKey: string, path: string | null, maxBytes: number): Promise<{ bytes: Uint8Array; mime: string | null }> {
  const link = await apiJson<{ href?: string }>(fetchImpl, `${API}/download?public_key=${encodeURIComponent(publicKey)}${path ? `&path=${encodeURIComponent(path)}` : ''}`);
  if (!link.href) throw new YadiskError('Диск: не вернул ссылку на скачивание', true);
  const host = new URL(link.href).host;
  if (!DOWNLOAD_HOST_RE.test(host)) throw new YadiskError(`Диск: ссылка на скачивание вне домена yandex (${host})`, true);
  let res: Response;
  try {
    res = await fetchImpl(link.href, { headers: { 'user-agent': 'ai-door-opt-agent/1.0' }, signal: AbortSignal.timeout(120_000) });
  } catch (err) {
    throw new YadiskError(`сеть при скачивании: ${(err as Error).message}`, false);
  }
  if (!res.ok) throw new YadiskError(`Диск: скачивание HTTP ${res.status}`, res.status === 404 || res.status === 403 || res.status === 410, res.status);
  if (Number(res.headers.get('content-length') ?? 0) > maxBytes) throw new YadiskError(`файл больше ${Math.round(maxBytes / 1024 / 1024)} МБ`, true);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new YadiskError(`файл больше ${Math.round(maxBytes / 1024 / 1024)} МБ`, true);
  return { bytes, mime: res.headers.get('content-type')?.split(';')[0]?.trim() || null };
}
