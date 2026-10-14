import { describe, expect, it } from 'vitest';
import { AttachmentError, downloadAttachment, isAudio, SttError, WhisperStt, YandexStt } from '../src/index.ts';

const audio = new Uint8Array([1, 2, 3]);

describe('YandexStt', () => {
  it('отправляет OGG и возвращает текст', async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const f = (async (u: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(u), auth: new Headers(init?.headers).get('authorization') };
      return new Response(JSON.stringify({ result: ' Нужна дверь в ванную ' }));
    }) as typeof fetch;
    const t = await new YandexStt('KEY', 'FOLDER', f).transcribe(audio, 'audio/ogg');
    expect(t).toBe('Нужна дверь в ванную');
    expect(seen!.auth).toBe('Api-Key KEY');
    expect(seen!.url).toContain('folderId=FOLDER');
    expect(seen!.url).toContain('lang=ru-RU');
  });

  it('отказ на неподдерживаемом формате и ошибке API', async () => {
    const f = (async () => new Response(JSON.stringify({ error_message: 'bad' }), { status: 400 })) as typeof fetch;
    await expect(new YandexStt('K', 'F', f).transcribe(audio, 'audio/mpeg')).rejects.toBeInstanceOf(SttError);
    await expect(new YandexStt('K', 'F', f).transcribe(audio, 'audio/ogg')).rejects.toThrow(/400 bad/);
  });
});

describe('WhisperStt', () => {
  it('multipart с моделью whisper-1', async () => {
    let form: FormData | null = null;
    const f = (async (_u: string | URL | Request, init?: RequestInit) => {
      form = init?.body as FormData;
      return new Response(JSON.stringify({ text: 'Привет' }));
    }) as typeof fetch;
    expect(await new WhisperStt('K', f).transcribe(audio, 'audio/ogg')).toBe('Привет');
    expect(form!.get('model')).toBe('whisper-1');
    expect(form!.get('language')).toBe('ru');
  });
});

describe('downloadAttachment', () => {
  it('качает публичный адрес и отказывает внутреннему', async () => {
    const f = (async () => new Response(audio, { headers: { 'content-type': 'audio/ogg' } })) as typeof fetch;
    const r = await downloadAttachment('https://drive.amocrm.ru/v.ogg', { fetch: f, resolve: async () => ['93.158.134.3'] });
    expect(r).toEqual({ bytes: audio, mime: 'audio/ogg' });
    await expect(downloadAttachment('https://x/v.ogg', { fetch: f, resolve: async () => ['10.0.0.1'] })).rejects.toThrow(/внутреннюю/);
  });

  it('ответ 403/404 или обрыв сети — одна повторная попытка; в ошибке код ответа и признак повтора (RFD-AI-AGENT-WA-PHOTO)', async () => {
    const resolve = async () => ['93.158.134.3'];
    const calls: Record<string, unknown>[] = [];
    let n = 0;
    const flaky = (async (_u: unknown, init?: RequestInit) => {
      calls.push({ headers: init?.headers });
      n += 1;
      return n === 1 ? new Response('', { status: 404, statusText: 'Not Found' }) : new Response(audio, { headers: { 'content-type': 'image/jpeg' } });
    }) as typeof fetch;
    const ok = await downloadAttachment('https://store.wazzup24.com/x.jpeg', { fetch: flaky, resolve, retryMs: 1 });
    expect(ok.mime).toBe('image/jpeg');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers).toMatchObject({ 'user-agent': expect.stringContaining('ai-door') });
    const gone = (async () => new Response('', { status: 404 })) as typeof fetch;
    const err = await downloadAttachment('https://store.wazzup24.com/x.jpeg', { fetch: gone, resolve, retryMs: 1 }).catch((e: AttachmentError) => e);
    expect(err).toBeInstanceOf(AttachmentError);
    expect(err).toMatchObject({ status: 404, retried: true });
    expect((err as Error).message).toMatch(/HTTP 404.*повтор через 0 с не помог/);
    // 401 не повторяется: ссылка требует права, второй запрос их не даст.
    let tries = 0;
    const denied = (async () => {
      tries += 1;
      return new Response('', { status: 401 });
    }) as typeof fetch;
    await expect(downloadAttachment('https://store.wazzup24.com/x.jpeg', { fetch: denied, resolve, retryMs: 1 })).rejects.toMatchObject({ status: 401, retried: false });
    expect(tries).toBe(1);
    // Обрыв сети — статус 0, повтор.
    let net = 0;
    const broken = (async () => {
      net += 1;
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(downloadAttachment('https://store.wazzup24.com/x.jpeg', { fetch: broken, resolve, retryMs: 1 })).rejects.toMatchObject({ status: 0, retried: true, message: expect.stringContaining('fetch failed') });
    expect(net).toBe(2);
  });

  it('isAudio', () => {
    expect(isAudio('voice')).toBe(true);
    expect(isAudio(null, 'audio/ogg')).toBe(true);
    expect(isAudio('picture', 'image/jpeg')).toBe(false);
  });
});
