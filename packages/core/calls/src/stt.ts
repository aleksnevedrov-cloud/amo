/**
 * RFD-AI-AGENT-OPT-CALLS, этап 2 (шаг 1): расшифровка записи разговора. Основной провайдер — Яндекс SpeechKit, API v3
 * (recognizeFileAsync принимает байты файла в теле запроса, Object Storage не нужен): асинхронный режим — новые звонки
 * из опроса, отложенный (deferred-general, дешевле, до суток) — догрузка старых записей. Запасной — OpenAI
 * (gpt-4o-transcribe, файл целиком, без таймкодов). Запись ВАТС моно, поэтому говорящие размечаются SpeechKit
 * (speaker labeling), а роли «Менеджер» / «Клиент» расставляет модель на шаге анализа.
 */

export type SttMode = 'async' | 'deferred';
export type SttProviderName = 'speechkit' | 'openai';

export interface TranscriptSegment {
  /** Метка говорящего из расшифровки («1», «2»); null — провайдер не различает. */
  speaker: string | null;
  /** Роль по разметке модели (шаг анализа). */
  role?: 'manager' | 'client' | 'unknown';
  startMs: number | null;
  endMs: number | null;
  text: string;
}

export interface CallTranscript {
  provider: SttProviderName;
  mode: SttMode | 'sync';
  model: string;
  text: string;
  segments: TranscriptSegment[];
  /** Длительность по расшифровке (последняя метка времени), с; null — провайдер не дал. */
  durationSec: number | null;
  speakers: number;
  /** Стоимость расшифровки по тарифу провайдера. */
  cost: { rub: number; usd: number };
  startedAt: string;
  finishedAt: string;
  /** Начало сырого ответа провайдера — чтобы на первом реальном звонке проверить поле с меткой говорящего. */
  rawSample?: string;
  /** Запущенная, но не завершённая операция SpeechKit (хранится в transcript, пока статус downloaded). */
  pending?: undefined;
}

export interface PendingTranscription {
  provider: 'speechkit';
  mode: SttMode;
  operationId: string;
  startedAt: string;
  polls: number;
}

export type SttStart = { transcript: CallTranscript } | { pending: PendingTranscription };

export interface CallStt {
  readonly name: SttProviderName;
  start(bytes: Uint8Array, mime: string, opts: { mode: SttMode; durationSec: number }): Promise<SttStart>;
  /** Проверить операцию: расшифровка готова — вернуть; ещё идёт — null; ошибка операции — исключение. */
  poll(p: PendingTranscription, durationSec: number): Promise<CallTranscript | null>;
}

export class SttError extends Error {
  override name = 'SttError';
}

/**
 * Тарифы SpeechKit (RU, с НДС) на 10.2026: асинхронное распознавание 0,1515 ₽ за 15 с (0,606 ₽/мин), отложенный режим
 * 0,0381 ₽ за 15 с (0,1524 ₽/мин); тарификация блоками по 15 с. Сверять со страницей цен Yandex Cloud.
 */
export const SPEECHKIT_RUB_PER_MIN: Record<SttMode, number> = { async: 0.606, deferred: 0.1524 };
/** OpenAI gpt-4o-transcribe: $0.006 за минуту аудио. */
export const OPENAI_STT_USD_PER_MIN = 0.006;
export const OPENAI_STT_MODEL = 'gpt-4o-transcribe';

const SPEECHKIT_STT = 'https://stt.api.cloud.yandex.net/stt/v3';
const SPEECHKIT_OPS = 'https://operations.api.cloud.yandex.net/operations';

const bill15s = (durationSec: number): number => Math.max(1, Math.ceil(durationSec / 15)) * 15;

/** Яндекс SpeechKit API v3: recognizeFileAsync → операция → getRecognition (JSON построчно). */
export class SpeechKitStt implements CallStt {
  readonly name = 'speechkit' as const;
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async start(bytes: Uint8Array, mime: string, opts: { mode: SttMode; durationSec: number }): Promise<SttStart> {
    if (!/mpeg|mp3/i.test(mime)) throw new SttError(`SpeechKit: формат ${mime} не поддерживается, ожидается MP3`);
    const body = {
      content: Buffer.from(bytes).toString('base64'),
      recognitionModel: {
        model: opts.mode === 'deferred' ? 'deferred-general' : 'general',
        audioFormat: { containerAudio: { containerAudioType: 'MP3' } },
        languageRestriction: { restrictionType: 'WHITELIST', languageCode: ['ru-RU'] },
        audioProcessingType: 'FULL_DATA',
      },
      speakerLabeling: { speakerLabeling: 'SPEAKER_LABELING_ENABLED' },
    };
    const res = await this.fetchImpl(`${SPEECHKIT_STT}/recognizeFileAsync`, { method: 'POST', headers: { authorization: `Api-Key ${this.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
    const json = (await res.json().catch(() => null)) as { id?: string; done?: boolean; message?: string; error?: { message?: string } } | null;
    if (!res.ok || !json?.id) throw new SttError(`SpeechKit recognizeFileAsync: HTTP ${res.status} ${json?.message ?? json?.error?.message ?? ''}`.trim());
    return { pending: { provider: 'speechkit', mode: opts.mode, operationId: json.id, startedAt: new Date().toISOString(), polls: 0 } };
  }

  async poll(p: PendingTranscription, durationSec: number): Promise<CallTranscript | null> {
    const op = await this.fetchImpl(`${SPEECHKIT_OPS}/${encodeURIComponent(p.operationId)}`, { headers: { authorization: `Api-Key ${this.apiKey}` }, signal: AbortSignal.timeout(30_000) });
    const st = (await op.json().catch(() => null)) as { done?: boolean; error?: { code?: number; message?: string }; message?: string } | null;
    if (!op.ok) throw new SttError(`SpeechKit operation ${p.operationId}: HTTP ${op.status} ${st?.message ?? ''}`.trim());
    if (st?.error) throw new SttError(`SpeechKit operation ${p.operationId}: ${st.error.message ?? `код ${st.error.code}`}`);
    if (!st?.done) return null;
    const res = await this.fetchImpl(`${SPEECHKIT_STT}/getRecognition?operationId=${encodeURIComponent(p.operationId)}`, { headers: { authorization: `Api-Key ${this.apiKey}` }, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new SttError(`SpeechKit getRecognition: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`.trim());
    const rawText = await res.text();
    const parsed = parseSpeechKitLines(rawText);
    const minutes = bill15s(durationSec) / 60;
    return {
      rawSample: rawText.slice(0, 3000),
      provider: 'speechkit',
      mode: p.mode,
      model: p.mode === 'deferred' ? 'deferred-general' : 'general',
      text: parsed.segments.map((s) => s.text).join('\n'),
      segments: parsed.segments,
      durationSec: parsed.durationSec,
      speakers: parsed.speakers,
      cost: { rub: Math.round(minutes * SPEECHKIT_RUB_PER_MIN[p.mode] * 100) / 100, usd: 0 },
      startedAt: p.startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
}

interface SkWord {
  text?: string;
  startTimeMs?: string | number;
  endTimeMs?: string | number;
}
interface SkAlternative {
  text?: string;
  words?: SkWord[];
  startTimeMs?: string | number;
  endTimeMs?: string | number;
}
interface SkLine {
  result?: {
    channelTag?: string;
    speakerTag?: string;
    final?: { alternatives?: SkAlternative[]; channelTag?: string };
    finalRefinement?: { normalizedText?: { alternatives?: SkAlternative[] } };
    [k: string]: unknown;
  };
}

const ms = (v: string | number | undefined): number | null => (v === undefined || v === null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Ответ getRecognition — JSON построчно: на каждый фрагмент речи событие final (сырой текст) и следом finalRefinement
 * (нормализованный: цифры, пунктуация). Берём нормализованный, если он есть, иначе сырой; метка говорящего — channelTag
 * (при включённой разметке говорящих SpeechKit пишет туда номер говорящего) или speakerTag.
 */
export function parseSpeechKitLines(text: string): { segments: TranscriptSegment[]; durationSec: number | null; speakers: number } {
  const segments: TranscriptSegment[] = [];
  let lastFinal: TranscriptSegment | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let j: SkLine;
    try {
      j = JSON.parse(line) as SkLine;
    } catch {
      continue;
    }
    const r = j.result;
    if (!r) continue;
    const speaker = r.speakerTag ?? r.final?.channelTag ?? r.channelTag ?? null;
    const a = r.final?.alternatives?.[0];
    if (a) {
      const words = a.words ?? [];
      const seg: TranscriptSegment = { speaker: speaker === null ? null : String(speaker), startMs: ms(a.startTimeMs) ?? ms(words[0]?.startTimeMs), endMs: ms(a.endTimeMs) ?? ms(words[words.length - 1]?.endTimeMs), text: (a.text ?? '').trim() };
      if (seg.text) {
        segments.push(seg);
        lastFinal = seg;
      }
      continue;
    }
    if (r.finalRefinement?.normalizedText?.alternatives?.length && lastFinal) {
      const norm = (r.finalRefinement.normalizedText.alternatives[0]?.text ?? '').trim();
      if (norm) lastFinal.text = norm;
      lastFinal = null;
    }
  }
  const ends = segments.map((s) => s.endMs).filter((x): x is number => x !== null);
  const tags = new Set(segments.map((s) => s.speaker).filter((x): x is string => x !== null));
  return { segments, durationSec: ends.length ? Math.round(Math.max(...ends) / 1000) : null, speakers: tags.size };
}

/** OpenAI: файл целиком одним запросом, ответ текстом; таймкодов и говорящих нет — роли расставит модель на шаге анализа. */
export class OpenAiStt implements CallStt {
  readonly name = 'openai' as const;
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly model = OPENAI_STT_MODEL,
  ) {}

  async start(bytes: Uint8Array, mime: string, opts: { mode: SttMode; durationSec: number }): Promise<SttStart> {
    const startedAt = new Date().toISOString();
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime || 'audio/mpeg' }), 'call.mp3');
    form.append('model', this.model);
    form.append('language', 'ru');
    form.append('response_format', 'json');
    const res = await this.fetchImpl('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${this.apiKey}` }, body: form, signal: AbortSignal.timeout(180_000) });
    const json = (await res.json().catch(() => null)) as { text?: string; error?: { message?: string } } | null;
    if (!res.ok) throw new SttError(`OpenAI ${this.model}: HTTP ${res.status} ${json?.error?.message ?? ''}`.trim());
    const text = (json?.text ?? '').trim();
    const minutes = Math.max(1, Math.ceil(opts.durationSec / 60));
    return {
      transcript: {
        provider: 'openai',
        mode: 'sync',
        model: this.model,
        text,
        segments: text ? [{ speaker: null, startMs: null, endMs: null, text }] : [],
        durationSec: null,
        speakers: 0,
        cost: { rub: 0, usd: Math.round(minutes * OPENAI_STT_USD_PER_MIN * 10_000) / 10_000 },
        startedAt,
        finishedAt: new Date().toISOString(),
      },
    };
  }

  async poll(): Promise<CallTranscript | null> {
    throw new SttError('OpenAI: отложенных операций нет');
  }
}

/** Провайдер по настройке и ключам: нет ключа выбранного — другой с ключом; нет ни одного — null. */
export function pickStt(preferred: SttProviderName, keys: { speechkit?: string | null; openai?: string | null }, fetchImpl: typeof fetch = fetch): CallStt | null {
  const order: SttProviderName[] = preferred === 'openai' ? ['openai', 'speechkit'] : ['speechkit', 'openai'];
  for (const p of order) {
    if (p === 'speechkit' && keys.speechkit) return new SpeechKitStt(keys.speechkit, fetchImpl);
    if (p === 'openai' && keys.openai) return new OpenAiStt(keys.openai, fetchImpl);
  }
  return null;
}
