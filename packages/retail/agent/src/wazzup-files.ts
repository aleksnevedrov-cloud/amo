import type { JournalRepo, SettingsRepo, WazzupFileRow, WazzupRepo, WidgetSettings } from '@core/db';
import { assertPublicUrl } from '@retail/catalog';

/**
 * RFD-AI-AGENT-WA-FILES: разбор файлов Wazzup в обе стороны — документы и картинки клиента и менеджера (в т. ч. КП в
 * PDF / Word / Excel). Тем же кодом, что вложения писем и входящие файлы в диалоге: DocumentService.analyze (извлечение
 * текста PDF / DOCX / XLSX, OCR картинок по настройке vision.provider, разбор моделью в структурированный текст).
 * Результат — один раз на сообщение в wazzup_messages (file_text / file_status); аудио и видео не разбираются (отметка).
 * Фоновое задание воркера, не больше 2 файлов одновременно, размер — как у почты (25 МБ).
 * RFD-AI-AGENT-FILES-PRIORITY: новые файлы (за 24 часа) и отложенные по лимиту — первыми; догрузка старых — после и только в
 * пределах доли дня (vision.backlogShare); новый файл, упёршийся в лимит, помечается «отложено» и разбирается автоматически.
 */

export const WAZZUP_FILES_JOB = 'wazzup-files';
export const WAZZUP_FILES_EVERY_MS = 5 * 60_000;
export const WAZZUP_FILES_CONCURRENCY = 2;
/** Как у вложений писем (packages/retail/mail/src/attachments.ts MAX_FILE_BYTES). */
export const WAZZUP_FILE_MAX_BYTES = 25 * 1024 * 1024;
const PER_RUN = 20;

/** RFD-AI-AGENT-FILES-PRIORITY: новый файл (за 24 часа) / догрузка старого / отложенный по лимиту. */
export type FilePriority = 'new' | 'backlog' | 'deferred';
/** Файл новее этого — «новый», разбирается первым и на долю догрузки не смотрит. */
export const NEW_FILE_WINDOW_MS = 24 * 60 * 60_000;
export const PRIORITY_LABEL: Record<FilePriority, string> = { new: 'новый', backlog: 'догрузка', deferred: 'отложенный' };

export interface WazzupFileAnalyzer {
  analyze(input: { accountId: number; leadId: number | null; source: 'chat'; filename: string; mime: string; bytes: Uint8Array; settings: WidgetSettings; priority: FilePriority }): Promise<{ id: number; kind: string; text: string; costUsd: number; model: string }>;
}

export interface WazzupFilesDeps {
  wazzup: Pick<WazzupRepo, 'filesPending' | 'setFileResult'>;
  settings: Pick<SettingsRepo, 'get' | 'listAccountIds'>;
  journal: Pick<JournalRepo, 'add'>;
  /** Разбор файлов (DocumentService воркера); null — разбор недоступен. */
  documents: WazzupFileAnalyzer | null;
  /** Скачивание в тестах. */
  download?: (url: string) => Promise<{ bytes: Uint8Array; mime: string; filename: string | null }>;
  now?: () => Date;
}

export interface WazzupFilesResult {
  accounts: number;
  picked: number;
  done: number;
  skipped: number;
  failed: number;
  /** Новых файлов отложено по дневному лимиту (разберутся в следующие сутки или после повышения лимита). */
  deferred: number;
  /** Старых файлов оставлено в очереди: доля догрузки на день исчерпана. */
  backlogWait: number;
  /** Разобрано по группам. */
  byPriority: Record<FilePriority, number>;
}

export interface JobLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/** Имя файла: из вебхука (если прислал), иначе последний сегмент ссылки, иначе по типу. */
export function wazzupFileName(row: Pick<WazzupFileRow, 'contentUri' | 'contentType' | 'raw'>, fromHeader?: string | null): string {
  const raw = row.raw ?? {};
  for (const k of ['fileName', 'filename', 'name', 'contentName', 'documentName']) {
    const v = raw[k];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 200);
  }
  if (fromHeader?.trim()) return fromHeader.trim().slice(0, 200);
  try {
    const last = decodeURIComponent(new URL(row.contentUri).pathname.split('/').filter(Boolean).pop() ?? '');
    if (last) return last.slice(0, 200);
  } catch {
    // ссылка без пути
  }
  return row.contentType ?? 'файл';
}

/** MIME по типу Wazzup (точнее определит DocumentService по расширению и содержимому). */
export const wazzupMimeOf = (type: string | null, fromResponse: string | null): string => {
  if (fromResponse && fromResponse !== 'application/octet-stream' && !fromResponse.startsWith('text/html')) return fromResponse.split(';')[0]?.trim() ?? fromResponse;
  switch ((type ?? '').toLowerCase()) {
    case 'image':
      return 'image/jpeg';
    case 'audio':
      return 'audio/ogg';
    case 'video':
      return 'video/mp4';
    default:
      return 'application/octet-stream';
  }
};

const MEDIA_KIND: Record<string, string> = { audio: 'аудио', video: 'видео', voice: 'аудио', ptt: 'аудио', sticker: 'стикер' };

/** Скачивание файла хранилища Wazzup: проверка адреса, таймаут 30 с, лимит как у почты. */
export async function downloadWazzupFile(url: string, fetchImpl: typeof fetch = fetch): Promise<{ bytes: Uint8Array; mime: string; filename: string | null }> {
  const safe = await assertPublicUrl(url);
  const res = await fetchImpl(safe, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'ai-door-agent/1.0', accept: '*/*' } });
  if (!res.ok) throw Object.assign(new Error(`файл недоступен: HTTP ${res.status}`), { status: res.status });
  if (Number(res.headers.get('content-length') ?? 0) > WAZZUP_FILE_MAX_BYTES) throw new Error(`файл больше ${WAZZUP_FILE_MAX_BYTES / 1024 / 1024} МБ`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > WAZZUP_FILE_MAX_BYTES) throw new Error(`файл больше ${WAZZUP_FILE_MAX_BYTES / 1024 / 1024} МБ`);
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(cd);
  const filename = m ? decodeURIComponent((m[1] ?? m[2] ?? '').trim()) : null;
  return { bytes, mime: res.headers.get('content-type') ?? 'application/octet-stream', filename: filename || null };
}

/** Один проход: по всем аккаунтам, до PER_RUN файлов на аккаунт, пул на WAZZUP_FILES_CONCURRENCY. */
export async function runWazzupFiles(d: WazzupFilesDeps, log: JobLog): Promise<WazzupFilesResult> {
  const r: WazzupFilesResult = { accounts: 0, picked: 0, done: 0, skipped: 0, failed: 0, deferred: 0, backlogWait: 0, byPriority: { new: 0, backlog: 0, deferred: 0 } };
  for (const accountId of await d.settings.listAccountIds()) {
    r.accounts++;
    let settings: WidgetSettings;
    try {
      settings = (await d.settings.get(accountId)).settings;
    } catch (err) {
      log.warn({ accountId, err: (err as Error).message }, 'wazzup-files: настройки не прочитаны');
      continue;
    }
    const rows = await d.wazzup.filesPending(accountId, PER_RUN);
    r.picked += rows.length;
    const now = (d.now ?? (() => new Date()))();
    // Новые и отложенные — первыми; догрузка старых — после них и только пока не исчерпана её доля дня.
    const queue = rows.map((row) => ({ row, priority: priorityOf(row, now) })).sort((a, b) => (a.priority === 'backlog' ? 1 : 0) - (b.priority === 'backlog' ? 1 : 0));
    const state = { backlogExhausted: false };
    await Promise.all(Array.from({ length: Math.min(WAZZUP_FILES_CONCURRENCY, queue.length) }, async () => {
      for (let it = queue.shift(); it; it = queue.shift()) {
        if (it.priority === 'backlog' && state.backlogExhausted) {
          r.backlogWait++;
          continue;
        }
        const out = await processFile(d, accountId, settings, it.row, it.priority, log);
        if (out === 'backlogWait') state.backlogExhausted = true;
        r[out]++;
        if (out === 'done') r.byPriority[it.priority]++;
      }
    }));
  }
  if (r.picked) log.info({ ...r }, 'wazzup-files: файлы разобраны');
  return r;
}

/** Группа файла: отложенный по лимиту → отложенный; присланный за последние 24 часа → новый; иначе — догрузка. */
export const priorityOf = (row: Pick<WazzupFileRow, 'sentAt' | 'fileStatus'>, now: Date): FilePriority => (row.fileStatus === 'deferred' ? 'deferred' : now.getTime() - new Date(row.sentAt).getTime() <= NEW_FILE_WINDOW_MS ? 'new' : 'backlog');

async function processFile(d: WazzupFilesDeps, accountId: number, settings: WidgetSettings, row: WazzupFileRow, priority: FilePriority, log: JobLog): Promise<'done' | 'skipped' | 'failed' | 'deferred' | 'backlogWait'> {
  const who = row.direction === 'in' ? 'клиент' : 'менеджер';
  const skip = async (note: string) => {
    await d.wazzup.setFileResult(accountId, row.messageId, { name: wazzupFileName(row), text: null, status: 'skipped', error: note });
    return 'skipped' as const;
  };
  const media = MEDIA_KIND[(row.contentType ?? '').toLowerCase()];
  if (media) return skip(media);
  // Входящий файл, который агент уже разобрал при получении сообщения (до этой доработки): текст есть в диалоге, не повторяем.
  if (row.consumedAt) return skip('разобран агентом при получении');
  if (!d.documents || !settings.vision.autoParse) return skip('разбор вложений выключен');
  const started = Date.now();
  let file: { bytes: Uint8Array; mime: string; filename: string | null };
  try {
    file = await (d.download ?? downloadWazzupFile)(row.contentUri);
  } catch (err) {
    const message = `скачивание: ${(err as Error).message}`;
    await d.wazzup.setFileResult(accountId, row.messageId, { name: wazzupFileName(row), text: null, status: 'failed', error: message });
    await d.journal.add({ accountId, ...(row.leadId ? { leadId: row.leadId } : {}), kind: 'error', summary: `Файл Wazzup «${wazzupFileName(row)}» (${who}, ${row.direction === 'in' ? 'входящий' : 'исходящий'}) не скачан: ${(err as Error).message}`, details: { messageId: row.messageId, contentUri: row.contentUri, type: row.contentType, status: (err as { status?: number }).status ?? null } });
    log.warn({ accountId, messageId: row.messageId, err: (err as Error).message }, 'wazzup-files: файл не скачан');
    return 'failed';
  }
  const filename = wazzupFileName(row, file.filename);
  const mime = wazzupMimeOf(row.contentType, file.mime);
  try {
    const res = await d.documents.analyze({ accountId, leadId: row.leadId, source: 'chat', filename, mime, bytes: file.bytes, settings, priority });
    await d.wazzup.setFileResult(accountId, row.messageId, { name: filename, text: res.text, status: 'done', error: null });
    await d.journal.add({ accountId, ...(row.leadId ? { leadId: row.leadId } : {}), kind: 'document', summary: `Разобран файл Wazzup «${filename}» от ${who === 'клиент' ? 'клиента' : 'менеджера'} (${res.kind}${priority === 'new' ? '' : `, ${PRIORITY_LABEL[priority]}`})`, details: { documentId: res.id, model: res.model, messageId: row.messageId, direction: row.direction, priority, mime, bytes: file.bytes.byteLength, ms: Date.now() - started, text: res.text.slice(0, 2000) }, costUsd: res.costUsd, costRub: res.costUsd * settings.billing.usdRubRate });
    return 'done';
  } catch (err) {
    const stage = (err as { stage?: string }).stage ?? 'analyze';
    const message = `${stage}: ${(err as Error).message}`;
    if (stage === 'limit') {
      // Доля догрузки или весь лимит исчерпаны старыми файлами — они ждут следующего дня в очереди (file_status не меняем).
      if (priority === 'backlog' || (err as { backlog?: boolean }).backlog) {
        log.info({ accountId, messageId: row.messageId, err: (err as Error).message }, 'wazzup-files: догрузка старых файлов ждёт следующего дня');
        return 'backlogWait';
      }
      // Новый файл упёрся в дневной лимит — «отложен по лимиту»: разберётся в следующие сутки или сразу после повышения лимита.
      if (row.fileStatus !== 'deferred') {
        await d.wazzup.setFileResult(accountId, row.messageId, { name: filename, text: null, status: 'deferred', error: `отложено по дневному лимиту: ${(err as Error).message}` });
        await d.journal.add({ accountId, ...(row.leadId ? { leadId: row.leadId } : {}), kind: 'skipped', summary: `Файл Wazzup «${filename}» (${who}) отложен по дневному лимиту — разберётся автоматически`, details: { messageId: row.messageId, direction: row.direction, priority, error: (err as Error).message } });
      }
      return 'deferred';
    }
    await d.wazzup.setFileResult(accountId, row.messageId, { name: filename, text: null, status: 'failed', error: message });
    await d.journal.add({ accountId, ...(row.leadId ? { leadId: row.leadId } : {}), kind: 'error', summary: `Файл Wazzup «${filename}» (${who}) не разобран — ${message}`, details: { messageId: row.messageId, contentUri: row.contentUri, mime, bytes: file.bytes.byteLength, stage } });
    return 'failed';
  }
}

/** Строки о файлах переписки для контекста агента: «Менеджер отправил файл «X»: текст» (RFD-AI-AGENT-WA-FILES, п. 2). */
export function formatWazzupFiles(items: { direction: 'in' | 'out'; sentAt: Date; file: { name: string | null; text: string | null; status: string | null; error: string | null; type?: string | null } }[], maxChars = 1500): string[] {
  return items.map((m) => {
    const when = new Date(m.sentAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const who = m.direction === 'in' ? 'Клиент прислал файл' : 'Менеджер отправил файл';
    const name = m.file.name ?? m.file.type ?? 'файл';
    const text = m.file.text ? m.file.text.replace(/\s+/g, ' ').trim() : '';
    const body = text ? `: ${text.length > maxChars ? `${text.slice(0, maxChars)}…` : text}` : m.file.status === 'skipped' ? ` (${m.file.error ?? 'не разбирается'})` : m.file.status === 'failed' ? ' (разобрать не удалось)' : m.file.status === 'deferred' ? ' (разбор отложен по дневному лимиту, будет позже)' : ' (разбор ещё идёт)';
    return `[${when}] ${who} «${name}»${body}`;
  });
}
