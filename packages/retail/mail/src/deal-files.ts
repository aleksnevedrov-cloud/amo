import type { AmoApiClient, LeadFile } from '@core/amo';
import type { JournalRepo, MailAttachmentsRepo, SettingsRepo, WidgetSettings } from '@core/db';
import type { DealFileLinksRepo } from '@core/db';
import { deferFileToDisk, deferredKeyId } from './deferred.ts';
import { otherCloudLinks, yadiskDownload, yadiskLinks, yadiskMeta, YadiskError } from './yadisk.ts';

/**
 * RFD-AI-AGENT-DEAL-FILES, часть А: агент сам читает файлы, которые менеджер прикрепил к сделке.
 *
 * Задание deal-files в очереди calls раз в 5 минут: события amoCRM attachment_note_added по сделкам и контактам
 * (GET /api/v4/events) с отметкой времени в calls_sync (entity deal-files), перекрытием окна в минуту и стартом за последний час
 * (старые файлы задним числом не берутся — для них files-defer). По сделке из события — listLeadFiles; ставятся только файлы,
 * которых ещё нет: ключ amo-file:<uuid> (тот же, что у files-defer), файлы, загруженные самим агентом (amo_file_uuid в
 * mail_attachments) и файлы с тем же именем и размером у сделки — пропускаются. Постановка — deferFileToDisk (источник deal_file),
 * разбор, лимит и очерёдность — существующий проход wazzup-files (runDeferredMailFiles), отдельного разбора нет.
 * Воронка — только из dealFiles.pipelineIds, этапы 142 / 143 — не берутся. В amo ничего не пишется.
 */

export const DEAL_FILES_JOB = 'deal-files';
export const DEAL_FILES_EVERY_MS = 5 * 60_000;
export const DEAL_FILES_SYNC_ENTITY = 'deal-files';
const EVENTS_OVERLAP_MS = 60_000;
const FIRST_RUN_BACK_MS = 60 * 60_000;
const EVENTS_PAGE = 100;
const MAX_EVENT_PAGES = 20;
/** Аудио и видео не разбираются — только отметка в журнале. */
const MEDIA_RE = /\.(mp3|wav|ogg|oga|opus|m4a|aac|amr|flac|mp4|mov|avi|mkv|webm|3gp|wmv)$/i;
/** Часть Б: ссылка Диска — не больше попыток при 429 / сетевых ошибках. */
const LINK_MAX_ATTEMPTS = 3;
/** Суммарно по одному примечанию скачиваем не больше (ТЗ Б5). */
const NOTE_TOTAL_MB = 60;

export type DealFilesSettings = WidgetSettings['dealFiles'];

export interface DealAmo {
  api: Pick<AmoApiClient, 'listLeadFiles' | 'downloadFile' | 'getNote'>;
  /** GET на домене аккаунта (события, сделки, контакты). */
  get<T>(path: string): Promise<T | null>;
}

export interface DealFilesDeps {
  attachments: Pick<MailAttachmentsRepo, 'insert' | 'setExtract' | 'hasMessageId' | 'findByNameSize' | 'findByAmoFileUuid'>;
  /** Часть Б: ссылки Яндекс Диска из примечаний (статус, попытки). Нет — ссылки не обрабатываются. */
  links?: Pick<DealFileLinksRepo, 'claim' | 'setDone' | 'setFailed' | 'listRetry'>;
  /** Сеть для cloud-api.yandex.net и скачивания (в тестах — заглушка). */
  fetch?: typeof fetch;
  settings: Pick<SettingsRepo, 'get' | 'listAccountIds'>;
  journal: Pick<JournalRepo, 'add'>;
  /** Отметка опроса (calls_sync). */
  sync: {
    get(accountId: number, entity: string): Promise<{ lastUpdatedAt: Date } | null>;
    set(accountId: number, entity: string, s: { lastUpdatedAt: Date; lastError: string | null }): Promise<void>;
  };
  amo(accountId: number): Promise<DealAmo>;
  /** Корень файлов на томе (MAIL_FILES_ROOT). */
  root: string;
  now?: () => Date;
}

export interface DealEvent {
  id: string;
  type: string;
  entityType: 'lead' | 'contact';
  entityId: number;
  createdBy: number;
  createdAt: Date;
  /** id примечания из события (value_after[].note.id), если amo его прислал. */
  noteId: number | null;
}

interface AmoEvent {
  id: string;
  type: string;
  entity_id: number;
  entity_type?: string;
  created_by?: number;
  created_at: number;
  value_after?: { note?: { id?: number } }[];
}

/** События примечаний (файлы и текст) по сделкам и контактам за окно, от старых к новым. */
export async function fetchDealEvents(amo: Pick<DealAmo, 'get'>, since: Date, until: Date, types: string[]): Promise<DealEvent[]> {
  const out: DealEvent[] = [];
  const from = Math.floor(since.getTime() / 1000);
  const to = Math.ceil(until.getTime() / 1000);
  for (let page = 1; page <= MAX_EVENT_PAGES; page++) {
    const q = `${types.map((t) => `filter[type][]=${t}`).join('&')}&filter[entity][]=lead&filter[entity][]=contact&filter[created_at][from]=${from}&filter[created_at][to]=${to}&limit=${EVENTS_PAGE}&page=${page}`;
    const res = await amo.get<{ _embedded?: { events?: AmoEvent[] } }>(`/api/v4/events?${q}`);
    const rows = res?._embedded?.events ?? [];
    for (const e of rows) {
      const entityType = e.entity_type === 'contact' ? 'contact' : e.entity_type === 'lead' ? 'lead' : null;
      if (!entityType) continue;
      const noteId = e.value_after?.map((v) => v.note?.id).find((x): x is number => typeof x === 'number') ?? null;
      out.push({ id: String(e.id), type: e.type, entityType, entityId: Number(e.entity_id), createdBy: Number(e.created_by ?? 0), createdAt: new Date(e.created_at * 1000), noteId });
    }
    if (rows.length < EVENTS_PAGE) break;
  }
  return out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
}

interface LeadBrief {
  id: number;
  status_id: number;
  pipeline_id: number;
  updated_at?: number;
  closed_at?: number | null;
}

/** Сделка события: сама сделка или открытая сделка контакта в воронке «Двери»; не подходит (воронка, этап) — причина. */
export async function resolveLead(amo: Pick<DealAmo, 'get'>, e: Pick<DealEvent, 'entityType' | 'entityId'>, s: DealFilesSettings, cache: Map<string, number | string>): Promise<{ leadId: number } | { skip: string }> {
  const key = `${e.entityType}:${e.entityId}`;
  const cached = cache.get(key);
  if (cached !== undefined) return typeof cached === 'number' ? { leadId: cached } : { skip: cached };
  const fits = (l: LeadBrief) => (s.pipelineIds.length === 0 || s.pipelineIds.includes(l.pipeline_id)) && !s.skipStatusIds.includes(l.status_id);
  let out: { leadId: number } | { skip: string };
  if (e.entityType === 'lead') {
    const lead = await amo.get<LeadBrief>(`/api/v4/leads/${e.entityId}`);
    out = !lead ? { skip: `сделка ${e.entityId} не найдена` } : !fits(lead) ? { skip: `сделка ${e.entityId}: воронка ${lead.pipeline_id}, этап ${lead.status_id} — не берём` } : { leadId: lead.id };
  } else {
    const contact = await amo.get<{ _embedded?: { leads?: { id: number }[] } }>(`/api/v4/contacts/${e.entityId}?with=leads`);
    const ids = (contact?._embedded?.leads ?? []).map((l) => l.id).slice(0, 50);
    const leads = ids.length ? ((await amo.get<{ _embedded?: { leads?: LeadBrief[] } }>(`/api/v4/leads?${ids.map((id) => `filter[id][]=${id}`).join('&')}`))?._embedded?.leads ?? []) : [];
    const open = leads.filter((l) => fits(l) && !l.closed_at).sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
    out = open[0] ? { leadId: open[0].id } : { skip: `у контакта ${e.entityId} нет открытой сделки в воронке` };
  }
  cache.set(key, 'leadId' in out ? out.leadId : out.skip);
  return out;
}

export interface QueueLeadFilesResult {
  files: number;
  queued: { name: string; bytes: number; id: number }[];
  skipped: { name: string; reason: string }[];
  failed: { name: string; error: string }[];
}

/**
 * Файлы сделки из «Файлов» amo — в очередь отложенного разбора (общая часть задания deal-files и команды files-defer).
 * Пропускаются: уже в очереди / разобранные по ключу amo-file:<uuid>, загруженные самим агентом (amo_file_uuid), файлы с тем же
 * именем и размером у сделки (письма, ссылки Диска), больше maxFileMb, аудио и видео.
 */
export async function queueLeadFiles(d: Pick<DealFilesDeps, 'attachments' | 'journal' | 'root' | 'now'>, accountId: number, leadId: number, api: Pick<AmoApiClient, 'listLeadFiles' | 'downloadFile'>, o: { reason: string; maxFileMb: number; nameFilter?: string | null; journal?: boolean }): Promise<QueueLeadFilesResult> {
  const r: QueueLeadFilesResult = { files: 0, queued: [], skipped: [], failed: [] };
  const files = await api.listLeadFiles(leadId, 100);
  const picked = files.filter((f) => !o.nameFilter || f.name.toLowerCase().includes(o.nameFilter.toLowerCase()));
  r.files = picked.length;
  for (const f of picked) {
    const skip = async (reason: string, journal = o.journal !== false) => {
      r.skipped.push({ name: f.name, reason });
      if (journal) await d.journal.add({ accountId, leadId, kind: 'deal_file', summary: `Файл сделки «${f.name}» пропущен: ${reason}`, details: { uuid: f.uuid, size: f.size, leadId } });
    };
    if (await d.attachments.hasMessageId(accountId, deferredKeyId(`amo-file:${f.uuid}`))) {
      r.skipped.push({ name: f.name, reason: 'уже поставлен (ключ amo-file)' });
      continue;
    }
    if (await d.attachments.findByAmoFileUuid(accountId, f.uuid)) {
      r.skipped.push({ name: f.name, reason: 'загружен в сделку самим агентом (вложение письма)' });
      continue;
    }
    if (f.size > 0 && (await d.attachments.findByNameSize(accountId, leadId, f.name, f.size))) {
      r.skipped.push({ name: f.name, reason: 'файл с тем же именем и размером у сделки уже разобран' });
      continue;
    }
    if (MEDIA_RE.test(f.name)) {
      await skip('аудио и видео не разбираются');
      continue;
    }
    if (f.size > o.maxFileMb * 1024 * 1024) {
      await skip(`файл больше ${o.maxFileMb} МБ (${Math.round(f.size / 1024 / 1024)} МБ)`);
      continue;
    }
    try {
      const { bytes, mime } = await api.downloadFile(f);
      if (bytes.byteLength > o.maxFileMb * 1024 * 1024) {
        await skip(`файл больше ${o.maxFileMb} МБ (${Math.round(bytes.byteLength / 1024 / 1024)} МБ)`);
        continue;
      }
      if (bytes.byteLength > 0 && (await d.attachments.findByNameSize(accountId, leadId, f.name, bytes.byteLength))) {
        r.skipped.push({ name: f.name, reason: 'файл с тем же именем и размером у сделки уже разобран' });
        continue;
      }
      const row = await deferFileToDisk({ attachments: d.attachments, root: d.root, ...(d.now ? { now: d.now } : {}) }, { accountId, leadId, filename: f.name, mime: mime ?? f.mime ?? 'application/octet-stream', bytes, key: `amo-file:${f.uuid}`, error: o.reason, source: 'deal_file' });
      if (!row.created) {
        r.skipped.push({ name: f.name, reason: 'уже поставлен (ключ amo-file)' });
        continue;
      }
      r.queued.push({ name: f.name, bytes: bytes.byteLength, id: row.id });
      if (o.journal !== false) await d.journal.add({ accountId, leadId, kind: 'deal_file', summary: `Файл сделки «${f.name}» поставлен в разбор (${o.reason})`, details: { uuid: f.uuid, bytes: bytes.byteLength, mime: mime ?? f.mime, attachmentId: row.id, leadId } });
    } catch (err) {
      r.failed.push({ name: f.name, error: (err as Error).message });
      if (o.journal !== false) await d.journal.add({ accountId, leadId, kind: 'deal_file_error', summary: `Файл сделки «${f.name}» не скачан: ${(err as Error).message}`, details: { uuid: f.uuid, leadId } });
    }
  }
  return r;
}

export interface DealFilesResult {
  accountId: number;
  enabled: boolean;
  events: number;
  leads: number;
  queued: number;
  skipped: number;
  failed: number;
  /** Часть Б: ссылки Яндекс Диска из примечаний. */
  links: number;
  linkFiles: number;
  errors: string[];
}

export interface DealFilesRunOptions {
  now?: () => Date;
}

/** Один проход по аккаунту: события за окно → сделки → файлы в очередь. */
export async function runDealFiles(d: DealFilesDeps, accountId: number, o: DealFilesRunOptions = {}): Promise<DealFilesResult> {
  const now = o.now ?? d.now ?? (() => new Date());
  const { settings } = await d.settings.get(accountId);
  const s = settings.dealFiles;
  const r: DealFilesResult = { accountId, enabled: s.enabled, events: 0, leads: 0, queued: 0, skipped: 0, failed: 0, links: 0, linkFiles: 0, errors: [] };
  if (!s.enabled) return r;
  const started = now();
  const sync = await d.sync.get(accountId, DEAL_FILES_SYNC_ENTITY);
  const since = new Date((sync?.lastUpdatedAt ?? new Date(started.getTime() - FIRST_RUN_BACK_MS)).getTime() - EVENTS_OVERLAP_MS);
  const amo = await d.amo(accountId);
  let events: DealEvent[];
  try {
    events = await fetchDealEvents(amo, since, started, s.yandexDisk && d.links ? ['attachment_note_added', 'common_note_added'] : ['attachment_note_added']);
  } catch (err) {
    await d.sync.set(accountId, DEAL_FILES_SYNC_ENTITY, { lastUpdatedAt: sync?.lastUpdatedAt ?? started, lastError: (err as Error).message });
    throw err;
  }
  r.events = events.length;
  // Отметка — до разбора: файлы в очереди защищены ключом, повтор события их не дублирует.
  await d.sync.set(accountId, DEAL_FILES_SYNC_ENTITY, { lastUpdatedAt: started, lastError: null });
  const cache = new Map<string, number | string>();
  const seenLeads = new Set<number>();
  for (const e of events.filter((x) => x.type === 'attachment_note_added')) {
    const lead = await resolveLead(amo, e, s, cache).catch((err: Error) => ({ skip: `сделка не определена: ${err.message}` }));
    if ('skip' in lead) {
      if (!cache.has(`skip:${lead.skip}`)) {
        cache.set(`skip:${lead.skip}`, 1);
        await d.journal.add({ accountId, ...(e.entityType === 'lead' ? { leadId: e.entityId } : {}), kind: 'deal_file', summary: `Файлы по событию amo пропущены: ${lead.skip}`, details: { eventId: e.id, entityType: e.entityType, entityId: e.entityId } });
      }
      continue;
    }
    if (seenLeads.has(lead.leadId)) continue;
    seenLeads.add(lead.leadId);
    r.leads++;
    try {
      const q = await queueLeadFiles(d, accountId, lead.leadId, amo.api, { reason: 'файл сделки, загружен менеджером', maxFileMb: s.maxFileMb });
      r.queued += q.queued.length;
      r.skipped += q.skipped.length;
      r.failed += q.failed.length;
    } catch (err) {
      r.errors.push(`сделка ${lead.leadId}: ${(err as Error).message}`);
      await d.journal.add({ accountId, leadId: lead.leadId, kind: 'deal_file_error', summary: `Файлы сделки не прочитаны: ${(err as Error).message}`, details: { eventId: e.id } });
    }
  }
  // Часть Б: ссылки Яндекс Диска в текстовых примечаниях + повтор ссылок с 429 / сетевыми ошибками.
  if (s.yandexDisk && d.links) {
    // Ссылки, тронутые в этом проходе, на повтор в нём же не идут (429 — следующим проходом).
    const touched = new Set<number>();
    for (const e of events.filter((x) => x.type === 'common_note_added')) {
      const lead = await resolveLead(amo, e, s, cache).catch((err: Error) => ({ skip: `сделка не определена: ${err.message}` }));
      if ('skip' in lead) continue;
      try {
        const text = await noteText(amo, e);
        if (!text) continue;
        for (const host of otherCloudLinks(text)) await d.journal.add({ accountId, leadId: lead.leadId, kind: 'deal_file', summary: `ссылка на облако не поддерживается: ${host}`, details: { noteId: e.noteId, eventId: e.id } });
        for (const url of yadiskLinks(text, s.maxFilesPerNote)) {
          const { row, created } = await d.links.claim({ accountId, leadId: lead.leadId, noteId: e.noteId, url });
          if (!created) continue;
          touched.add(row.id);
          r.links++;
          r.linkFiles += await processLink(d, d.links, accountId, s, row, now);
        }
      } catch (err) {
        r.errors.push(`примечание ${e.noteId ?? e.id}: ${(err as Error).message}`);
        await d.journal.add({ accountId, leadId: lead.leadId, kind: 'deal_file_error', summary: `Примечание со ссылками не прочитано: ${(err as Error).message}`, details: { eventId: e.id, noteId: e.noteId } });
      }
    }
    for (const row of await d.links.listRetry(accountId, LINK_MAX_ATTEMPTS)) {
      if (touched.has(row.id)) continue;
      r.links++;
      r.linkFiles += await processLink(d, d.links, accountId, s, row, now);
    }
  }
  return r;
}

/** Текст примечания из события: по id примечания, иначе — последние текстовые примечания сущности в окне события. */
async function noteText(amo: DealAmo, e: DealEvent): Promise<string | null> {
  const entity = e.entityType === 'lead' ? 'leads' : 'contacts';
  if (e.noteId) {
    const note = await amo.api.getNote(entity, e.entityId, e.noteId);
    const text = note?.params?.text;
    return typeof text === 'string' ? text : null;
  }
  const from = Math.floor(e.createdAt.getTime() / 1000) - 120;
  const res = await amo.get<{ _embedded?: { notes?: { id: number; note_type: string; params?: { text?: string } }[] } }>(`/api/v4/${entity}/${e.entityId}/notes?filter[note_type][]=common&filter[updated_at][from]=${from}&order[updated_at]=asc&limit=50`);
  return (res?._embedded?.notes ?? []).map((n) => n.params?.text).filter((t): t is string => typeof t === 'string').join('\n') || null;
}

/** Одна ссылка Диска: метаданные → файл или файлы первого уровня папки → в очередь. Возвращает число поставленных файлов. */
async function processLink(d: DealFilesDeps, links: NonNullable<DealFilesDeps['links']>, accountId: number, s: DealFilesSettings, row: { id: number; leadId: number; url: string; noteId: number | null; attempts: number }, now: () => Date): Promise<number> {
  const fetchImpl = d.fetch ?? fetch;
  const maxBytes = s.maxFileMb * 1024 * 1024;
  let queued = 0;
  try {
    const meta = await yadiskMeta(fetchImpl, row.url);
    const items = meta.type === 'file' ? [{ name: meta.name, path: null as string | null, size: meta.size, mime: meta.mime }] : meta.items.slice(0, s.maxFilesPerNote).map((i) => ({ name: i.name, path: i.path as string | null, size: i.size, mime: i.mime }));
    if (meta.type === 'dir' && meta.items.length > s.maxFilesPerNote) await d.journal.add({ accountId, leadId: row.leadId, kind: 'deal_file', summary: `Папка Диска «${meta.name}»: файлов ${meta.items.length}, берём первые ${s.maxFilesPerNote}`, details: { url: row.url } });
    let total = 0;
    for (const it of items) {
      const key = `yadisk:${row.url}:${it.path ?? ''}`;
      if (await d.attachments.hasMessageId(accountId, deferredKeyId(key))) continue;
      if (it.size > 0 && (await d.attachments.findByNameSize(accountId, row.leadId, it.name, it.size))) {
        await d.journal.add({ accountId, leadId: row.leadId, kind: 'deal_file', summary: `Файл по ссылке Диска «${it.name}» пропущен: файл с тем же именем и размером у сделки уже разобран`, details: { url: row.url, path: it.path } });
        continue;
      }
      if (MEDIA_RE.test(it.name)) {
        await d.journal.add({ accountId, leadId: row.leadId, kind: 'deal_file', summary: `Файл по ссылке Диска «${it.name}» пропущен: аудио и видео не разбираются`, details: { url: row.url, path: it.path } });
        continue;
      }
      if (it.size > maxBytes) {
        await d.journal.add({ accountId, leadId: row.leadId, kind: 'deal_file', summary: `Файл по ссылке Диска «${it.name}» не скачан: файл больше ${s.maxFileMb} МБ (${Math.round(it.size / 1024 / 1024)} МБ)`, details: { url: row.url, path: it.path, size: it.size } });
        continue;
      }
      if (total + it.size > NOTE_TOTAL_MB * 1024 * 1024) {
        await d.journal.add({ accountId, leadId: row.leadId, kind: 'deal_file', summary: `Файл по ссылке Диска «${it.name}» не скачан: по примечанию уже ${Math.round(total / 1024 / 1024)} МБ из ${NOTE_TOTAL_MB}`, details: { url: row.url, path: it.path } });
        continue;
      }
      const { bytes, mime } = await yadiskDownload(fetchImpl, row.url, it.path, maxBytes);
      total += bytes.byteLength;
      if (bytes.byteLength > 0 && (await d.attachments.findByNameSize(accountId, row.leadId, it.name, bytes.byteLength))) {
        await d.journal.add({ accountId, leadId: row.leadId, kind: 'deal_file', summary: `Файл по ссылке Диска «${it.name}» пропущен: файл с тем же именем и размером у сделки уже разобран`, details: { url: row.url, path: it.path } });
        continue;
      }
      const saved = await deferFileToDisk({ attachments: d.attachments, root: d.root, now }, { accountId, leadId: row.leadId, filename: it.name, mime: mime ?? it.mime ?? 'application/octet-stream', bytes, key, error: 'файл по ссылке Яндекс Диска из примечания', source: 'yadisk' });
      if (!saved.created) continue;
      queued++;
      await d.journal.add({ accountId, leadId: row.leadId, kind: 'deal_file', summary: `Файл по ссылке Диска «${it.name}» поставлен в разбор`, details: { url: row.url, path: it.path, bytes: bytes.byteLength, attachmentId: saved.id, noteId: row.noteId } });
    }
    await links.setDone(row.id, queued);
  } catch (err) {
    const e = err instanceof YadiskError ? err : new YadiskError((err as Error).message, false);
    const retry = !e.final && row.attempts + 1 < LINK_MAX_ATTEMPTS;
    await links.setFailed(row.id, e.message, retry);
    await d.journal.add({ accountId, leadId: row.leadId, kind: 'deal_file_error', summary: `Ссылка Диска ${row.url}: ${e.message}${retry ? ' — повтор следующим проходом' : e.final ? '' : ' — попытки исчерпаны'}`, details: { url: row.url, status: e.status, attempts: row.attempts + 1, retry } });
  }
  return queued;
}

export async function runDealFilesAll(d: DealFilesDeps, log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void }, o: DealFilesRunOptions = {}): Promise<DealFilesResult[]> {
  const out: DealFilesResult[] = [];
  for (const accountId of await d.settings.listAccountIds()) {
    try {
      const r = await runDealFiles(d, accountId, o);
      if (r.events || r.queued || r.failed || r.errors.length) log.info({ ...r }, 'deal-files: файлы сделок');
      out.push(r);
    } catch (err) {
      log.warn({ accountId, err: (err as Error).message }, 'deal-files: сбой опроса');
      await d.journal.add({ accountId, kind: 'deal_file_error', summary: `Опрос файлов сделок не выполнен — ${(err as Error).message}` }).catch(() => undefined);
    }
  }
  return out;
}

export type { LeadFile };
