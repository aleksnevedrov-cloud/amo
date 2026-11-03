// RFD-AI-AGENT-DEAL-FILES, часть А: событие attachment_note_added по сделке воронки «Двери» → файлы сделки в очередь отложенного
// разбора с ключом amo-file:<uuid>; тот же файл после files-defer — второй строки нет; сделка в «Отказ» или другой воронке —
// ничего; файл контакта — к открытой сделке контакта; аудио / слишком большой — отметка; окно событий с перекрытием — событие
// на границе не теряется и не дублируется; разобранный файл сделки — в контексте агента и ленте дня.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LeadFile } from '@core/amo';
import { AccountsRepo, DealFileLinksRepo, JournalRepo, MailAttachmentsRepo, SettingsRepo, widgetSettingsSchema, type Db } from '@core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb } from '../../../core/db/test/setup.ts';
import { DEAL_FILES_SYNC_ENTITY, deferredKeyId, otherCloudLinks, queueLeadFiles, runDealFiles, runDeferredMailFiles, yadiskLinks, type DealAmo, type DealFilesDeps } from '../src/index.ts';

const ACC = 1;
const PIPE = 1873498;
const at = (iso: string) => new Date(iso);
const unix = (d: Date) => Math.floor(d.getTime() / 1000);
const log = { info: () => undefined, warn: () => undefined };

const state = {
  events: [] as { id: string; type: string; entity_type: 'lead' | 'contact'; entity_id: number; created_at: number; note?: number }[],
  leads: {} as Record<number, { status_id: number; pipeline_id: number; updated_at?: number; closed_at?: number | null }>,
  contacts: {} as Record<number, number[]>,
  files: {} as Record<number, (LeadFile & { bytes: Uint8Array })[]>,
  downloads: [] as string[],
  sync: {} as Record<string, { lastUpdatedAt: Date; lastError: string | null }>,
  notes: {} as Record<number, { id: number; text: string }[]>,
  /** Ответы cloud-api Диска по адресу (без сети): JSON или { status } для ошибки; скачивание — по href. */
  disk: {} as Record<string, unknown>,
  diskCalls: [] as string[],
};
const file = (uuid: string, name: string, bytes: Uint8Array, mime = 'application/pdf'): LeadFile & { bytes: Uint8Array } => ({ uuid, name, size: bytes.byteLength, mime, createdAt: null, downloadUrl: `https://drive-b.amocrm.ru/download/${uuid}`, bytes });
const pdf = (text: string) => new TextEncoder().encode(`%PDF ${text}`);

const amo: DealAmo = {
  api: {
    async listLeadFiles(leadId) {
      return (state.files[leadId] ?? []).map(({ bytes: _b, ...f }) => f);
    },
    async downloadFile(f) {
      state.downloads.push(f.uuid);
      const found = Object.values(state.files).flat().find((x) => x.uuid === f.uuid);
      if (!found) throw new Error(`amo: файл ${f.name} не найден`);
      return { bytes: found.bytes, mime: found.mime };
    },
    async getNote(_entity, entityId, noteId) {
      const n = (state.notes[entityId] ?? []).find((x) => x.id === noteId);
      return n ? { id: n.id, note_type: 'common', created_at: 0, created_by: 3571888, params: { text: n.text } } : null;
    },
  },
  async get<T>(path: string): Promise<T | null> {
    const notes = /^\/api\/v4\/(leads|contacts)\/(\d+)\/notes\?filter\[note_type\]\[\]=common/.exec(path);
    if (notes) return { _embedded: { notes: (state.notes[Number(notes[2])] ?? []).map((n) => ({ id: n.id, note_type: 'common', params: { text: n.text } })) } } as T;
    if (path.startsWith('/api/v4/events?')) {
      const from = Number(/from\]=(\d+)/.exec(path)?.[1] ?? 0);
      const to = Number(/to\]=(\d+)/.exec(path)?.[1] ?? 0);
      const types = [...path.matchAll(/filter\[type\]\[\]=([a-z_]+)/g)].map((m) => m[1]);
      return { _embedded: { events: state.events.filter((e) => e.created_at >= from && e.created_at <= to && types.includes(e.type)).map((e) => ({ id: e.id, type: e.type, entity_id: e.entity_id, entity_type: e.entity_type, created_by: 3571888, created_at: e.created_at, value_after: e.note ? [{ note: { id: e.note } }] : [] })) } } as T;
    }
    let m = /^\/api\/v4\/leads\/(\d+)$/.exec(path);
    if (m) {
      const l = state.leads[Number(m[1])];
      return l ? ({ id: Number(m[1]), ...l } as T) : null;
    }
    if (path.startsWith('/api/v4/leads?filter')) {
      const ids = [...path.matchAll(/filter\[id\]\[\]=(\d+)/g)].map((x) => Number(x[1]));
      return { _embedded: { leads: ids.filter((id) => state.leads[id]).map((id) => ({ id, ...state.leads[id] })) } } as T;
    }
    m = /^\/api\/v4\/contacts\/(\d+)\?with=leads$/.exec(path);
    if (m) return { id: Number(m[1]), _embedded: { leads: (state.contacts[Number(m[1])] ?? []).map((id) => ({ id })) } } as T;
    return null;
  },
};

describe('файлы сделки (deal-files, часть А)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let attachments: MailAttachmentsRepo;
  let journal: JournalRepo;
  let deps: DealFilesDeps;
  const root = mkdtempSync(join(tmpdir(), 'deal-files-'));
  const poll = (now: Date) => runDealFiles(deps, ACC, { now: () => now });

  beforeAll(async () => {
    ({ db, drop } = await freshDb());
    await new AccountsRepo(db).upsertInstalled({ id: ACC, subdomain: 'acc', accountDomain: 'acc.amocrm.ru' });
    await new SettingsRepo(db).save(ACC, 1, widgetSettingsSchema.parse({}));
    attachments = new MailAttachmentsRepo(db);
    journal = new JournalRepo(db);
    deps = {
      attachments,
      settings: new SettingsRepo(db),
      journal,
      sync: { get: async (_a, e) => state.sync[e] ?? null, set: async (_a, e, s) => void (state.sync[e] = s) },
      amo: async () => amo,
      root,
    };
    // «90287»: сделка «Двери», этап «Памятка»; менеджер приложил три файла в 12:16 МСК (09:16 UTC).
    state.leads[30038356] = { status_id: 28643038, pipeline_id: PIPE };
    state.contacts[65978358] = [30038356];
    state.files[30038356] = [file('u-1', 'Двери внутренние Данилково (4).pdf', pdf('внутренние')), file('u-2', 'Двери наружные Данилково (4).pdf', pdf('наружные')), file('u-3', 'Счет покупателю № 126 от 3 ноября 2026 г.pdf', pdf('счёт'))];
    state.events.push({ id: 'e1', type: 'attachment_note_added', entity_type: 'lead', entity_id: 30038356, created_at: unix(at('2026-11-03T09:16:00Z')), note: 501 });
  });
  afterAll(() => drop());

  it('событие по сделке «Двери» → три файла сделки в очереди с ключом amo-file:<uuid>, файлы на томе, журнал deal_file', async () => {
    const r = await poll(at('2026-11-03T09:20:00Z'));
    expect(r).toMatchObject({ enabled: true, events: 1, leads: 1, queued: 3, skipped: 0, failed: 0, errors: [] });
    const rows = await attachments.listDeferred(ACC);
    expect(rows.map((a) => [a.leadId, a.filename, a.source, a.extractStatus, a.messageId])).toEqual([
      [30038356, 'Двери внутренние Данилково (4).pdf', 'deal_file', 'deferred', deferredKeyId('amo-file:u-1')],
      [30038356, 'Двери наружные Данилково (4).pdf', 'deal_file', 'deferred', deferredKeyId('amo-file:u-2')],
      [30038356, 'Счет покупателю № 126 от 3 ноября 2026 г.pdf', 'deal_file', 'deferred', deferredKeyId('amo-file:u-3')],
    ]);
    expect(readFileSync(rows[0]!.storagePath).toString()).toBe('%PDF внутренние');
    expect(state.sync[DEAL_FILES_SYNC_ENTITY]?.lastUpdatedAt).toEqual(at('2026-11-03T09:20:00Z'));
    const log1 = await journal.list(ACC, { kind: 'deal_file', leadId: 30038356 });
    expect(log1.map((e) => e.summary).sort()).toEqual(['Файл сделки «Двери внутренние Данилково (4).pdf» поставлен в разбор (файл сделки, загружен менеджером)', 'Файл сделки «Двери наружные Данилково (4).pdf» поставлен в разбор (файл сделки, загружен менеджером)', 'Файл сделки «Счет покупателю № 126 от 3 ноября 2026 г.pdf» поставлен в разбор (файл сделки, загружен менеджером)']);
  });

  it('окно с перекрытием: событие на границе читается снова, но файлы не дублируются; тот же файл после files-defer — второй строки нет', async () => {
    // Следующий проход через 5 минут: окно с перекрытием 60 с снова покрывает e1 (09:16 ≥ 09:19) — ничего нового.
    state.events.push({ id: 'e2', type: 'attachment_note_added', entity_type: 'lead', entity_id: 30038356, created_at: unix(at('2026-11-03T09:19:30Z')) });
    const r = await poll(at('2026-11-03T09:25:00Z'));
    expect(r).toMatchObject({ events: 1, leads: 1, queued: 0, skipped: 3 });
    expect(await attachments.listDeferred(ACC)).toHaveLength(3);
    // Ручная команда files-defer по той же сделке — те же ключи, строк не прибавляется.
    const q = await queueLeadFiles(deps, ACC, 30038356, amo.api, { reason: 'поставлен в очередь командой files-defer', maxFileMb: 25, nameFilter: null, journal: false });
    expect(q).toMatchObject({ files: 3, queued: [], failed: [] });
    expect(q.skipped.map((x) => x.reason)).toEqual(['уже поставлен (ключ amo-file)', 'уже поставлен (ключ amo-file)', 'уже поставлен (ключ amo-file)']);
    expect(await attachments.listDeferred(ACC)).toHaveLength(3);
  });

  it('сделка в «Отказ» (143) или другой воронке — ничего не ставится; файл контакта — к открытой сделке контакта в воронке', async () => {
    state.leads[700] = { status_id: 143, pipeline_id: PIPE };
    state.leads[701] = { status_id: 10, pipeline_id: 2 };
    state.files[700] = [file('u-7', 'отказ.pdf', pdf('x'))];
    state.files[701] = [file('u-8', 'другая.pdf', pdf('y'))];
    state.events.push({ id: 'e3', type: 'attachment_note_added', entity_type: 'lead', entity_id: 700, created_at: unix(at('2026-11-03T09:30:00Z')) });
    state.events.push({ id: 'e4', type: 'attachment_note_added', entity_type: 'lead', entity_id: 701, created_at: unix(at('2026-11-03T09:31:00Z')) });
    // Контакт 65978358: сделка 30038356 открыта в «Дверях», плюс закрытая 700 → файл контакта уходит в 30038356.
    state.contacts[65978358] = [700, 30038356];
    state.leads[30038356] = { status_id: 28643038, pipeline_id: PIPE, updated_at: 100 };
    state.files[30038356]!.push(file('u-4', 'Паспорт объекта.pdf', pdf('паспорт')));
    state.events.push({ id: 'e5', type: 'attachment_note_added', entity_type: 'contact', entity_id: 65978358, created_at: unix(at('2026-11-03T09:32:00Z')) });
    const r = await poll(at('2026-11-03T09:35:00Z'));
    expect(r).toMatchObject({ events: 3, leads: 1, queued: 1 });
    expect((await attachments.listDeferred(ACC)).map((a) => a.filename)).toContain('Паспорт объекта.pdf');
    expect(state.downloads).not.toContain('u-7');
    expect(state.downloads).not.toContain('u-8');
    const skipped = await journal.list(ACC, { kind: 'deal_file' });
    expect(skipped.some((e) => e.summary === 'Файлы по событию amo пропущены: сделка 700: воронка 1873498, этап 143 — не берём')).toBe(true);
    expect(skipped.some((e) => e.summary === 'Файлы по событию amo пропущены: сделка 701: воронка 2, этап 10 — не берём')).toBe(true);
  });

  it('аудио и файл больше лимита — отметка без скачивания; файл, загруженный самим агентом (amo_file_uuid), и файл с тем же именем и размером — пропуск', async () => {
    const big = new Uint8Array(26 * 1024 * 1024);
    state.files[30038356]!.push(file('u-5', 'Запись звонка.mp3', new Uint8Array([1, 2, 3]), 'audio/mpeg'), file('u-6', 'Проект.pdf', big));
    // Вложение письма, которое агент сам прикрепил к сделке: uuid известен в mail_attachments.
    const own = await attachments.insert({ accountId: ACC, leadId: 30038356, messageUid: 1, messageId: '<m@client.ru>', filename: 'Запрос.docx', mime: 'application/msword', sizeBytes: 9, storagePath: join(root, 'own.docx') });
    await attachments.markUploaded(own.id, 'u-own');
    state.files[30038356]!.push(file('u-own', 'Запрос.docx', new Uint8Array(9), 'application/msword'));
    // Тот же файл под другим uuid (менеджер приложил копию письма): имя и размер совпадают → не разбираем второй раз.
    state.files[30038356]!.push(file('u-copy', 'Запрос.docx', new Uint8Array(9), 'application/msword'));
    state.events.push({ id: 'e6', type: 'attachment_note_added', entity_type: 'lead', entity_id: 30038356, created_at: unix(at('2026-11-03T09:40:00Z')) });
    const before = state.downloads.length;
    const r = await poll(at('2026-11-03T09:45:00Z'));
    expect(r).toMatchObject({ queued: 0, failed: 0 });
    expect(state.downloads.slice(before)).toEqual([]); // ни аудио, ни большой, ни свои файлы не скачивались
    const log1 = await journal.list(ACC, { kind: 'deal_file', leadId: 30038356 });
    expect(log1.some((e) => e.summary === 'Файл сделки «Запись звонка.mp3» пропущен: аудио и видео не разбираются')).toBe(true);
    expect(log1.some((e) => e.summary === 'Файл сделки «Проект.pdf» пропущен: файл больше 25 МБ (26 МБ)')).toBe(true);
    expect((await attachments.listDeferred(ACC)).filter((a) => a.filename === 'Запрос.docx')).toHaveLength(0);
  });

  it('разбор — очередью wazzup-files: свежий файл сделки идёт как «новый», журнал deal_file, в историю и задачу не пишется; файл виден в контексте агента и ленте дня', async () => {
    const analyzed: { filename: string; priority: string }[] = [];
    const r = await runDeferredMailFiles(
      {
        attachments,
        settings: new SettingsRepo(db),
        journal,
        dialog: { clientMessagesMentioning: async () => [], updateText: async () => undefined, addMessage: async () => { throw new Error('в историю писать не должны'); } },
        amo: async () => ({ openLeadTasks: async () => { throw new Error('задачи трогать не должны'); }, updateTaskText: async () => undefined }),
        documents: { analyze: async (input) => (analyzed.push({ filename: input.filename, priority: input.priority }), { id: analyzed.length, kind: 'project', text: `[Документ «${input.filename}»] 12 дверей, размеры по проекту`, costUsd: 0.02, model: 'test-docs' }) },
      },
      log,
    );
    expect(r).toMatchObject({ picked: 4, done: 4, failed: 0, tasksUpdated: 0 });
    expect(analyzed.every((a) => a.priority === 'new')).toBe(true);
    expect((await journal.list(ACC, { kind: 'deal_file', leadId: 30038356 })).filter((e) => e.summary.startsWith('Разобран файл сделки «'))).toHaveLength(4);
    const ctx = await attachments.listDealFiles(ACC, 30038356, at('2026-10-01T00:00:00Z'));
    expect(ctx.map((a) => [a.filename, a.source, a.extractStatus])).toEqual([
      ['Двери внутренние Данилково (4).pdf', 'deal_file', 'done'],
      ['Двери наружные Данилково (4).pdf', 'deal_file', 'done'],
      ['Счет покупателю № 126 от 3 ноября 2026 г.pdf', 'deal_file', 'done'],
      ['Паспорт объекта.pdf', 'deal_file', 'done'],
    ]);
    expect(ctx[0]?.extractedText).toBe('[Документ «Двери внутренние Данилково (4).pdf»] 12 дверей, размеры по проекту');
  });
});

/** Сеть Диска в тестах: cloud-api и ссылки скачивания — из state.disk; всё остальное — запрещено. */
const diskFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  state.diskCalls.push(url);
  const key = decodeURIComponent(url);
  const r = state.disk[key] ?? state.disk[url];
  if (r === undefined) throw new Error(`нет ответа для ${key}`);
  if (r instanceof Uint8Array) return new Response(r, { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': String(r.byteLength) } });
  const o = r as { status?: number; body?: unknown };
  if (o.status && o.status !== 200) return new Response(JSON.stringify(o.body ?? { message: 'Не удалось найти запрошенный ресурс.', error: 'DiskNotFoundError' }), { status: o.status, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify(o.body ?? r), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
const API = 'https://cloud-api.yandex.net/v1/disk/public/resources';
const meta = (link: string, body: unknown) => void (state.disk[`${API}?public_key=${link}&limit=50`] = { body });
const dl = (link: string, path: string | null, href: string, bytes: Uint8Array) => {
  state.disk[`${API}/download?public_key=${link}${path ? `&path=${path}` : ''}`] = { body: { href, method: 'GET', templated: false } };
  state.disk[href] = bytes;
};

describe('ссылки Яндекс Диска в примечаниях (deal-files, часть Б)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let attachments: MailAttachmentsRepo;
  let journal: JournalRepo;
  let links: DealFileLinksRepo;
  let deps: DealFilesDeps;
  const root = mkdtempSync(join(tmpdir(), 'deal-links-'));
  const poll = (now: Date) => runDealFiles(deps, ACC, { now: () => now });
  const L1 = 'https://yadi.sk/d/Pt38kxURjV3Fkg';
  const L2 = 'https://yadi.sk/d/AaBbCcDdEe1122';
  const L3 = 'https://disk.yandex.ru/i/ZzYyXx9988';
  const DIR = 'https://disk.yandex.ru/d/FolderKey777';

  beforeAll(async () => {
    ({ db, drop } = await freshDb());
    await new AccountsRepo(db).upsertInstalled({ id: ACC, subdomain: 'acc', accountDomain: 'acc.amocrm.ru' });
    await new SettingsRepo(db).save(ACC, 1, widgetSettingsSchema.parse({}));
    attachments = new MailAttachmentsRepo(db);
    journal = new JournalRepo(db);
    links = new DealFileLinksRepo(db);
    state.events.length = 0;
    state.sync = {};
    state.files = {};
    state.downloads.length = 0;
    state.leads = { 30038356: { status_id: 28643038, pipeline_id: PIPE } };
    deps = { attachments, links, settings: new SettingsRepo(db), journal, sync: { get: async (_a, e) => state.sync[e] ?? null, set: async (_a, e, s) => void (state.sync[e] = s) }, amo: async () => amo, root, fetch: diskFetch };
    // «90287», 12:14 МСК: примечание «Робота» с тремя ссылками yadi.sk и одной на Google Drive.
    state.notes[30038356] = [{ id: 601, text: `Загружен файл: Двери наружные Данилково (4).pdf ${L1}\nЗагружен файл: Двери внутренние Данилково (4).pdf ${L2}.\nСчёт: ${L3}\nЕщё: https://drive.google.com/file/d/abc/view` }];
    state.events.push({ id: 'n1', type: 'common_note_added', entity_type: 'lead', entity_id: 30038356, created_at: unix(at('2026-11-03T09:14:00Z')), note: 601 });
    meta(L1, { type: 'file', name: 'Двери наружные Данилково (4).pdf', size: 11, mime_type: 'application/pdf' });
    dl(L1, null, 'https://downloader.disk.yandex.ru/disk/aaa/Двери наружные.pdf', pdf('наружн'));
    meta(L2, { type: 'file', name: 'Двери внутренние Данилково (4).pdf', size: 12, mime_type: 'application/pdf' });
    dl(L2, null, 'https://downloader.disk.yandex.ru/disk/bbb/Двери внутренние.pdf', pdf('внутренн'));
    meta(L3, { type: 'file', name: 'Счет покупателю № 126.pdf', size: 9, mime_type: 'application/pdf' });
    dl(L3, null, 'https://downloader.disk.yandex.ru/disk/ccc/Счет.pdf', pdf('счёт'));
  });
  afterAll(() => drop());

  it('разбор ссылок из текста: yadi.sk / disk.yandex.*, без хвостовых знаков, до 10; другие облака — только домен', () => {
    expect(yadiskLinks(state.notes[30038356]![0]!.text)).toEqual([L1, L2, L3]);
    expect(yadiskLinks(Array.from({ length: 12 }, (_, i) => `https://yadi.sk/d/k${i}`).join(' '))).toHaveLength(10);
    expect(otherCloudLinks(state.notes[30038356]![0]!.text)).toEqual(['drive.google.com']);
  });

  it('примечание с 3 ссылками → 3 файла в очереди с именами из Диска (ключ yadisk:<key>:<path>), Google Drive — отметка «не поддерживается»', async () => {
    const r = await poll(at('2026-11-03T09:20:00Z'));
    expect(r).toMatchObject({ events: 1, links: 3, linkFiles: 3, errors: [] });
    const rows = await attachments.listDeferred(ACC);
    // Размер строки — фактические байты файла (по ним же отсекаются дубли с файлами сделки).
    expect(rows.map((a) => [a.filename, a.source, a.sizeBytes, a.messageId])).toEqual([
      ['Двери наружные Данилково (4).pdf', 'yadisk', pdf('наружн').byteLength, deferredKeyId(`yadisk:${L1}:`)],
      ['Двери внутренние Данилково (4).pdf', 'yadisk', pdf('внутренн').byteLength, deferredKeyId(`yadisk:${L2}:`)],
      ['Счет покупателю № 126.pdf', 'yadisk', pdf('счёт').byteLength, deferredKeyId(`yadisk:${L3}:`)],
    ]);
    expect(readFileSync(rows[2]!.storagePath).toString()).toBe('%PDF счёт');
    expect((await links.forLead(ACC, 30038356)).map((l) => [l.url, l.status, l.files])).toEqual([[L1, 'done', 1], [L2, 'done', 1], [L3, 'done', 1]]);
    const log1 = await journal.list(ACC, { kind: 'deal_file', leadId: 30038356 });
    expect(log1.some((e) => e.summary === 'ссылка на облако не поддерживается: drive.google.com')).toBe(true);
    // Ходили только на cloud-api и на href скачивания Диска.
    expect(state.diskCalls.every((u) => u.startsWith(API) || u.startsWith('https://downloader.disk.yandex.ru/'))).toBe(true);
    // Повтор того же события (окно с перекрытием) — ссылки уже заняты, ничего нового.
    expect(await poll(at('2026-11-03T09:25:00Z'))).toMatchObject({ links: 0, linkFiles: 0 });
    expect(await attachments.listDeferred(ACC)).toHaveLength(3);
  });

  it('3 ссылки + 3 тех же файла сделки (часть А) → разбор 3 раза, не 6: совпадение по имени и размеру', async () => {
    state.files[30038356] = [file('u-1', 'Двери наружные Данилково (4).pdf', pdf('наружн')), file('u-2', 'Двери внутренние Данилково (4).pdf', pdf('внутренн')), file('u-3', 'Счет покупателю № 126.pdf', pdf('счёт'))];
    state.events.push({ id: 'a1', type: 'attachment_note_added', entity_type: 'lead', entity_id: 30038356, created_at: unix(at('2026-11-03T09:28:00Z')) });
    const r = await poll(at('2026-11-03T09:30:00Z'));
    expect(r).toMatchObject({ leads: 1, queued: 0, skipped: 3 });
    expect(await attachments.listDeferred(ACC)).toHaveLength(3);
    expect(state.downloads).toEqual([]); // файлы сделки даже не скачивались
  });

  it('ссылка на папку → файлы первого уровня, не больше maxFilesPerNote (10); аудио — отметка', async () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ type: 'file', name: `лист-${i + 1}.pdf`, path: `/лист-${i + 1}.pdf`, size: 5, mime_type: 'application/pdf' }));
    items.push({ type: 'dir', name: 'вложенная', path: '/вложенная', size: 0, mime_type: null as unknown as string });
    items.push({ type: 'file', name: 'голос.mp3', path: '/голос.mp3', size: 5, mime_type: 'audio/mpeg' });
    meta(DIR, { type: 'dir', name: 'Проект Данилково', size: 0, _embedded: { items, limit: 50, total: items.length } });
    for (let i = 1; i <= 12; i++) dl(DIR, `/лист-${i}.pdf`, `https://downloader.disk.yandex.ru/disk/dir/${i}.pdf`, new TextEncoder().encode(`л-${i}`));
    state.notes[30038356]!.push({ id: 602, text: `Папка проекта: ${DIR}` });
    state.events.push({ id: 'n2', type: 'common_note_added', entity_type: 'lead', entity_id: 30038356, created_at: unix(at('2026-11-03T09:40:00Z')), note: 602 });
    const r = await poll(at('2026-11-03T09:45:00Z'));
    expect(r).toMatchObject({ links: 1, linkFiles: 10 });
    expect((await attachments.listDeferred(ACC)).filter((a) => a.filename.startsWith('лист-'))).toHaveLength(10);
    expect((await journal.list(ACC, { kind: 'deal_file', leadId: 30038356 })).some((e) => e.summary === 'Папка Диска «Проект Данилково»: файлов 13, берём первые 10')).toBe(true);
  });

  it('файл 40 МБ — не скачан, причина в журнале; 404 — журнал с текстом Диска, без повторов; 429 — повтор следующим проходом, не больше 3 раз', async () => {
    const BIG = 'https://yadi.sk/d/BigFile40';
    const GONE = 'https://yadi.sk/d/GoneFile404';
    const BUSY = 'https://yadi.sk/d/Busy429';
    meta(BIG, { type: 'file', name: 'Большой проект.pdf', size: 40 * 1024 * 1024, mime_type: 'application/pdf' });
    state.disk[`${API}?public_key=${GONE}&limit=50`] = { status: 404, body: { message: 'Не удалось найти запрошенный ресурс.', description: 'Resource not found.', error: 'DiskNotFoundError' } };
    state.disk[`${API}?public_key=${BUSY}&limit=50`] = { status: 429, body: { message: 'Слишком много запросов.', error: 'TooManyRequestsError' } };
    state.notes[30038356]!.push({ id: 603, text: `${BIG} ${GONE} ${BUSY}` });
    state.events.push({ id: 'n3', type: 'common_note_added', entity_type: 'lead', entity_id: 30038356, created_at: unix(at('2026-11-03T10:00:00Z')), note: 603 });
    const downloadsBefore = state.diskCalls.filter((u) => u.includes('/download')).length;
    const r = await poll(at('2026-11-03T10:05:00Z'));
    expect(r).toMatchObject({ links: 3, linkFiles: 0 });
    expect(state.diskCalls.filter((u) => u.includes('/download')).length).toBe(downloadsBefore); // большой файл не качали
    const byUrl = async () => Object.fromEntries((await links.forLead(ACC, 30038356)).map((l) => [l.url, [l.status, l.attempts, l.error]]));
    expect((await byUrl())[BIG]).toEqual(['done', 0, null]);
    expect((await byUrl())[GONE]).toEqual(['failed', 1, 'Диск: Не удалось найти запрошенный ресурс. (HTTP 404)']);
    expect((await byUrl())[BUSY]).toEqual(['retry', 1, 'Диск: Слишком много запросов. (HTTP 429)']);
    const log1 = await journal.list(ACC, { leadId: 30038356 });
    expect(log1.some((e) => e.kind === 'deal_file' && e.summary === 'Файл по ссылке Диска «Большой проект.pdf» не скачан: файл больше 25 МБ (40 МБ)')).toBe(true);
    expect(log1.some((e) => e.kind === 'deal_file_error' && e.summary === `Ссылка Диска ${GONE}: Диск: Не удалось найти запрошенный ресурс. (HTTP 404)`)).toBe(true);
    // Следующие проходы: 404 не трогаем, 429 повторяем до 3 попыток, затем — попытки исчерпаны.
    const metaCalls = () => state.diskCalls.filter((u) => u.includes(GONE)).length;
    const gone = metaCalls();
    await poll(at('2026-11-03T10:10:00Z'));
    expect((await byUrl())[BUSY]).toEqual(['retry', 2, 'Диск: Слишком много запросов. (HTTP 429)']);
    await poll(at('2026-11-03T10:15:00Z'));
    expect((await byUrl())[BUSY]).toEqual(['failed', 3, 'Диск: Слишком много запросов. (HTTP 429)']);
    await poll(at('2026-11-03T10:20:00Z'));
    expect((await byUrl())[BUSY]?.[1]).toBe(3);
    expect(metaCalls()).toBe(gone);
    // Диск ожил после 429 → ссылка сработала бы с первого же повтора: проверяем на новой ссылке.
    const LATE = 'https://yadi.sk/d/LateOk';
    state.disk[`${API}?public_key=${LATE}&limit=50`] = { status: 429, body: { message: 'Слишком много запросов.' } };
    state.notes[30038356]!.push({ id: 604, text: LATE });
    state.events.push({ id: 'n4', type: 'common_note_added', entity_type: 'lead', entity_id: 30038356, created_at: unix(at('2026-11-03T10:25:00Z')), note: 604 });
    await poll(at('2026-11-03T10:30:00Z'));
    expect((await byUrl())[LATE]?.[0]).toBe('retry');
    meta(LATE, { type: 'file', name: 'Поздний.pdf', size: 7, mime_type: 'application/pdf' });
    dl(LATE, null, 'https://downloader.disk.yandex.ru/disk/late/Поздний.pdf', pdf('п'));
    const r2 = await poll(at('2026-11-03T10:35:00Z'));
    expect(r2).toMatchObject({ linkFiles: 1 });
    expect((await byUrl())[LATE]).toEqual(['done', 1, null]);
  });
});
