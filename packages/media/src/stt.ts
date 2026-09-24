import { assertPublicUrl } from '@ai-door/catalog';

/** Распознавание речи (media.transcribe, раздел 4 ТЗ). */
export interface SttProvider {
  readonly name: string;
  transcribe(audio: Uint8Array, mime: string): Promise<string>;
}

export class SttError extends Error {
  override name = 'SttError';
}

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

/**
 * Yandex SpeechKit, синхронное распознавание (до 30 с и 1 МБ, формат OGG Opus — как у голосовых WhatsApp).
 * Данные обрабатываются в РФ (152-ФЗ).
 */
export class YandexStt implements SttProvider {
  readonly name = 'yandex';
  constructor(
    private readonly apiKey: string,
    private readonly folderId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async transcribe(audio: Uint8Array, mime: string): Promise<string> {
    if (!/ogg|opus/i.test(mime)) throw new SttError(`SpeechKit: формат ${mime} не поддерживается, нужен OGG Opus`);
    if (audio.byteLength > 1024 * 1024) throw new SttError('SpeechKit: голосовое длиннее ~30 секунд');
    const url = new URL('https://stt.api.cloud.yandex.net/speech/v1/stt:recognize');
    url.searchParams.set('lang', 'ru-RU');
    url.searchParams.set('folderId', this.folderId);
    url.searchParams.set('format', 'oggopus');
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Api-Key ${this.apiKey}` },
      body: audio,
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => null)) as { result?: string; error_message?: string } | null;
    if (!res.ok) throw new SttError(`SpeechKit: HTTP ${res.status} ${body?.error_message ?? ''}`.trim());
    return (body?.result ?? '').trim();
  }
}

/** OpenAI Whisper — альтернатива; данные уходят за пределы РФ. */
export class WhisperStt implements SttProvider {
  readonly name = 'openai';
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async transcribe(audio: Uint8Array, mime: string): Promise<string> {
    const form = new FormData();
    const ext = /ogg|opus/i.test(mime) ? 'ogg' : /mpeg|mp3/i.test(mime) ? 'mp3' : /mp4|m4a|aac/i.test(mime) ? 'm4a' : 'wav';
    form.append('file', new Blob([audio], { type: mime }), `voice.${ext}`);
    form.append('model', 'whisper-1');
    form.append('language', 'ru');
    const res = await this.fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await res.json().catch(() => null)) as { text?: string } | null;
    if (!res.ok) throw new SttError(`Whisper: HTTP ${res.status}`);
    return (body?.text ?? '').trim();
  }
}

/** Скачивает вложение по ссылке из amo с проверкой адреса и размера. */
export async function downloadAttachment(
  url: string,
  opts: { fetch?: typeof fetch; resolve?: (host: string) => Promise<string[]> } = {},
): Promise<{ bytes: Uint8Array; mime: string }> {
  const safe = await assertPublicUrl(url, opts.resolve);
  const res = await (opts.fetch ?? fetch)(safe, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new SttError(`Вложение недоступно: HTTP ${res.status}`);
  if (Number(res.headers.get('content-length') ?? 0) > MAX_AUDIO_BYTES) throw new SttError('Вложение больше 10 МБ');
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_AUDIO_BYTES) throw new SttError('Вложение больше 10 МБ');
  return { bytes, mime: res.headers.get('content-type') ?? 'application/octet-stream' };
}

export const isAudio = (type: string | null | undefined, mime?: string) =>
  /voice|audio/i.test(type ?? '') || /^audio\//i.test(mime ?? '');
