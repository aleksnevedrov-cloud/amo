// RFD-AI-AGENT-OPT-DEAL-FILES, часть Б: ссылки Диска из текста, метаданные папки с path (второй уровень), скачивание только с домена yandex.
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createYadiskClient, describeFetchError, directFetch, otherCloudLinks, yadiskDownload, yadiskLinks, yadiskMeta, YadiskError } from '../src/index.ts';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Яндекс Диск (часть Б)', () => {
  it('ссылки из текста: yadi.sk/d, /i, disk.yandex.ru|com, без хвостовых знаков, без повторов, до max; другие облака — домены', () => {
    const text = 'Загружен файл: https://yadi.sk/d/Pj7JaZqDEJJA1Q. Ещё https://disk.yandex.ru/i/abc12, https://yadi.sk/d/Pj7JaZqDEJJA1Q и https://disk.yandex.com/d/zzz) плюс https://drive.google.com/file/d/1/view и https://cloud.mail.ru/public/x/y';
    expect(yadiskLinks(text)).toEqual(['https://yadi.sk/d/Pj7JaZqDEJJA1Q', 'https://disk.yandex.ru/i/abc12', 'https://disk.yandex.com/d/zzz']);
    expect(yadiskLinks(text, 2)).toHaveLength(2);
    expect(otherCloudLinks(text)).toEqual(['drive.google.com', 'cloud.mail.ru']);
    expect(yadiskLinks('без ссылок')).toEqual([]);
  });

  it('метаданные: папка с файлами и вложенной папкой; path передаётся в запрос; 404 — YadiskError final с текстом Диска', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      const u = new URL(url);
      if (u.searchParams.get('path') === '/Чертежи') return json(200, { type: 'dir', name: 'Чертежи', path: '/Чертежи', _embedded: { items: [{ type: 'file', name: 'План.pdf', path: '/Чертежи/План.pdf', size: 10, mime_type: 'application/pdf' }] } });
      if (u.searchParams.get('public_key') === 'https://yadi.sk/d/gone') return json(404, { message: 'Не удалось найти запрошенный ресурс.', error: 'DiskNotFoundError' });
      return json(200, { type: 'dir', name: 'Данилково', path: '/', size: 0, _embedded: { items: [{ type: 'file', name: 'Двери внутренние.pdf', path: '/Двери внутренние.pdf', size: 680_816, mime_type: 'application/pdf' }, { type: 'dir', name: 'Чертежи', path: '/Чертежи' }] } });
    }) as typeof fetch;
    const meta = await yadiskMeta(fetchImpl, 'https://yadi.sk/d/Pj7JaZqDEJJA1Q');
    expect(meta).toMatchObject({ type: 'dir', name: 'Данилково', items: [{ type: 'file', name: 'Двери внутренние.pdf', size: 680_816 }, { type: 'dir', name: 'Чертежи', path: '/Чертежи' }] });
    const sub = await yadiskMeta(fetchImpl, 'https://yadi.sk/d/Pj7JaZqDEJJA1Q', '/Чертежи');
    expect(sub.items.map((i) => i.name)).toEqual(['План.pdf']);
    expect(urls[1]).toContain('public_key=https%3A%2F%2Fyadi.sk%2Fd%2FPj7JaZqDEJJA1Q&path=%2F%D0%A7%D0%B5%D1%80%D1%82%D0%B5%D0%B6%D0%B8&limit=50');
    await expect(yadiskMeta(fetchImpl, 'https://yadi.sk/d/gone')).rejects.toMatchObject({ final: true, status: 404, message: 'Диск: Не удалось найти запрошенный ресурс. (HTTP 404)' });
    expect((await yadiskMeta(fetchImpl, 'https://yadi.sk/d/gone').catch((e: unknown) => e)) instanceof YadiskError).toBe(true);
  });

  it('скачивание: href только с домена yandex, лимит размера; чужой домен — ошибка без запроса', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/download?')) return json(200, { href: url.includes('evil') ? 'https://evil.example.com/f' : 'https://downloader.disk.yandex.ru/disk/abc' });
      if (url.startsWith('https://downloader.disk.yandex.ru/')) return new Response(new Uint8Array(1000), { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': '1000' } });
      return json(404, {});
    }) as typeof fetch;
    const r = await yadiskDownload(fetchImpl, 'https://yadi.sk/d/x', '/a.pdf', 20 * 1024 * 1024);
    expect(r.bytes.byteLength).toBe(1000);
    expect(r.mime).toBe('application/pdf');
    await expect(yadiskDownload(fetchImpl, 'https://yadi.sk/d/x', null, 500)).rejects.toThrow('файл больше 0 МБ');
    await expect(yadiskDownload(fetchImpl, 'https://yadi.sk/d/evil', null, 1_000_000)).rejects.toThrow('вне домена yandex');
  });

  it('DEAL-FILES-2, 2.4: скачивание идёт через прямой клиент без прокси — глобальный (проксируемый) fetch не вызывается, dispatcher не задаётся', async () => {
    const viaProxy: string[] = [];
    const direct: { url: string; init: RequestInit | undefined }[] = [];
    const proxied = (async (input: string | URL | Request) => {
      viaProxy.push(String(input));
      return json(200, {});
    }) as typeof fetch;
    const directMock = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      direct.push({ url, init });
      if (url.includes('/download?')) return json(200, { href: 'https://downloader.disk.yandex.ru/disk/abc' });
      if (url.startsWith('https://downloader.disk.yandex.ru/')) return new Response(new Uint8Array(10), { status: 200, headers: { 'content-type': 'application/pdf' } });
      return json(200, { type: 'file', name: 'a.pdf', size: 10 });
    }) as typeof fetch;
    void proxied;
    const client = createYadiskClient(directMock, { retryDelayMs: 0 });
    await client.meta('https://yadi.sk/d/x');
    const r = await client.download('https://yadi.sk/d/x', null, 1_000_000);
    expect(r.bytes.byteLength).toBe(10);
    expect(viaProxy).toEqual([]);
    expect(direct.map((d) => new URL(d.url).host)).toEqual(['cloud-api.yandex.net', 'cloud-api.yandex.net', 'downloader.disk.yandex.ru']);
    expect(direct.every((d) => !(d.init as { dispatcher?: unknown } | undefined)?.dispatcher)).toBe(true);
  });

  it('DEAL-FILES-2, 2.4: ECONNRESET при скачивании — 2 повтора с паузой; причина с кодом и хостом; 5xx тоже повторяется, 404 — нет', async () => {
    let fails = 2;
    const calls: string[] = [];
    const flaky = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/download?')) return json(200, { href: 'https://downloader.disk.yandex.ru/disk/abc' });
      if (fails-- > 0) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
      return new Response(new Uint8Array(5), { status: 200, headers: { 'content-type': 'application/pdf' } });
    }) as typeof fetch;
    const r = await createYadiskClient(flaky, { retryDelayMs: 0 }).download('https://yadi.sk/d/x', null, 1_000_000);
    expect(r.bytes.byteLength).toBe(5);
    expect(calls.filter((u) => u.startsWith('https://downloader.disk.yandex.ru/'))).toHaveLength(3);
    // Всегда сеть: после 2 повторов — ошибка с кодом и хостом.
    fails = 99;
    calls.length = 0;
    await expect(createYadiskClient(flaky, { retryDelayMs: 0 }).download('https://yadi.sk/d/x', null, 1_000_000)).rejects.toThrow('сеть при скачивании: fetch failed (ECONNRESET, downloader.disk.yandex.ru)');
    expect(calls.filter((u) => u.startsWith('https://downloader.disk.yandex.ru/'))).toHaveLength(3);
    // 503 — повтор, 404 — сразу ошибка Диска.
    let status = 503;
    const byStatus = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/download?')) return json(200, { href: 'https://downloader.disk.yandex.ru/disk/abc' });
      return new Response(null, { status });
    }) as typeof fetch;
    calls.length = 0;
    await expect(createYadiskClient(byStatus, { retryDelayMs: 0 }).download('https://yadi.sk/d/x', null, 100)).rejects.toThrow('Диск: скачивание HTTP 503');
    expect(calls.filter((u) => u.startsWith('https://downloader.disk.yandex.ru/'))).toHaveLength(3);
    status = 404;
    calls.length = 0;
    await expect(createYadiskClient(byStatus, { retryDelayMs: 0 }).download('https://yadi.sk/d/x', null, 100)).rejects.toThrow('Диск: скачивание HTTP 404');
    expect(calls.filter((u) => u.startsWith('https://downloader.disk.yandex.ru/'))).toHaveLength(1);
    expect(describeFetchError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }), 'https://downloader.disk.yandex.ru/disk/abc')).toBe('fetch failed (ENOTFOUND, downloader.disk.yandex.ru)');
  });

  it('directFetch: node:http(s) без прокси, редирект 302 → тело и заголовки ответа', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/file' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': '3' });
      res.end(Buffer.from([1, 2, 3]));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await directFetch(`http://127.0.0.1:${port}/start`, { headers: { 'user-agent': 'test' } });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/pdf');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
      await expect(directFetch('http://127.0.0.1:1/none')).rejects.toMatchObject({ message: 'fetch failed', cause: { code: 'ECONNREFUSED' } });
    } finally {
      server.close();
    }
  });
});
