import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describeFsError, resolveKpPath } from '../paths.ts';
import { recordHostAllowed } from './notes.ts';

/**
 * Скачивание записи разговора с ВАТС (этап 1, шаг 3). Прямой GET по ссылке из примечания; таймаут 60 с, до 3 попыток
 * при сетевой ошибке и 5xx. 403 / 404 / 410 и ответ не-аудио (страница входа) — «недоступно», без повторов.
 * Прокси: в образе Node 22 глобальный fetch переменные HTTPS_PROXY / NO_PROXY не читает, запрос идёт напрямую с IP сервера.
 */

export const CALLS_DIR = 'calls';
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_RECORD_BYTES = 100 * 1024 * 1024;
export const DOWNLOAD_ATTEMPTS = 3;

export class RecordUnavailableError extends Error {}

export interface DownloadedRecord {
  bytes: Uint8Array;
  mime: string;
  attempts: number;
}

/** MP3: заголовок ID3 или синхрослово кадра MPEG (FF Ex / FF Fx). */
export function looksLikeMp3(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;
  return bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0;
}

export async function downloadRecord(link: string, deps: { fetch: typeof fetch; sleep?: (ms: number) => Promise<void> }): Promise<DownloadedRecord> {
  if (!recordHostAllowed(link)) throw new RecordUnavailableError('ссылка не на сервер записей ВАТС (megapbx.ru / onpbx.ru) или не https');
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  // Старые ссылки OnlinePBX (до перехода на МегаФон) пробуем один раз: любая ошибка — «недоступно», без повторов.
  const legacy = /(^|\.)onpbx\.ru$/i.test(new URL(link).hostname);
  const attemptsMax = legacy ? 1 : DOWNLOAD_ATTEMPTS;
  let lastError = '';
  for (let attempt = 1; attempt <= attemptsMax; attempt++) {
    try {
      const res = await deps.fetch(link, { method: 'GET', redirect: 'follow', headers: { accept: 'audio/mpeg, audio/*;q=0.9, */*;q=0.1' }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (res.status === 403 || res.status === 404 || res.status === 410) throw new RecordUnavailableError(`сервер записей ответил HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const mime = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > MAX_RECORD_BYTES) throw new RecordUnavailableError(`запись больше ${Math.round(MAX_RECORD_BYTES / 1024 / 1024)} МБ`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > MAX_RECORD_BYTES) throw new RecordUnavailableError(`запись больше ${Math.round(MAX_RECORD_BYTES / 1024 / 1024)} МБ`);
      if (!bytes.byteLength) throw new RecordUnavailableError('пустой ответ сервера записей');
      if (!mime.startsWith('audio/') && !looksLikeMp3(bytes)) throw new RecordUnavailableError(`ответ не аудио (${mime || 'без content-type'}) — вероятно, запись требует ключ или удалена`);
      return { bytes, mime: mime.startsWith('audio/') ? mime : 'audio/mpeg', attempts: attempt };
    } catch (err) {
      if (err instanceof RecordUnavailableError) throw err;
      lastError = (err as Error).name === 'TimeoutError' ? `таймаут ${DOWNLOAD_TIMEOUT_MS / 1000} с` : (err as Error).message;
      if (attempt < attemptsMax) await sleep(1000 * attempt);
    }
  }
  if (legacy) throw new RecordUnavailableError(`старая ссылка OnlinePBX, запись не отдаётся: ${lastError}`);
  throw new Error(`не скачалось за ${DOWNLOAD_ATTEMPTS} попытки: ${lastError}`);
}

/** Путь MP3 на томе относительно KP_FILES_ROOT: calls/<аккаунт>/<год-месяц звонка>/<id>_<ключ записи>.mp3. */
export function callFileRel(accountId: number, callId: number, recordKey: string, calledAt: Date): string {
  const ym = calledAt.toISOString().slice(0, 7);
  const key = recordKey.replace(/[^a-z0-9_-]/gi, '_').slice(0, 64);
  return `${CALLS_DIR}/${accountId}/${ym}/${callId}_${key}.mp3`;
}

/** Записать байты по относительному пути; ошибки файловой системы — понятным текстом (как у файлов КП). */
export async function saveRecordFile(filesRoot: string, rel: string, bytes: Uint8Array): Promise<string> {
  const abs = resolveKpPath(filesRoot, rel);
  try {
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, bytes);
  } catch (err) {
    throw new Error(describeFsError(err, join(filesRoot, dirname(rel))));
  }
  return abs;
}
