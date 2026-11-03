// RFD-AI-AGENT-OPT-DEAL-FILES, часть Б: ссылки Диска из текста, метаданные папки с path (второй уровень), скачивание только с домена yandex.
import { describe, expect, it } from 'vitest';
import { otherCloudLinks, yadiskDownload, yadiskLinks, yadiskMeta, YadiskError } from '../src/yadisk.ts';

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
});
