import { describe, expect, it } from 'vitest';
import { downloadAttachment, isAudio, SttError, WhisperStt, YandexStt } from '../src/index.ts';

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

  it('isAudio', () => {
    expect(isAudio('voice')).toBe(true);
    expect(isAudio(null, 'audio/ogg')).toBe(true);
    expect(isAudio('picture', 'image/jpeg')).toBe(false);
  });
});
