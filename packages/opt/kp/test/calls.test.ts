// RFD-AI-AGENT-OPT-CALLS, этап 1: примечания-звонки amo → таблица calls (дедупликация, привязка к сделке через контакт,
// короткие и пропущенные не берутся), скачивание MP3 на том (повтор при 5xx, 404 / не-аудио / OnlinePBX — «недоступно»),
// отметка сбора, удаление MP3 по сроку, журнал call_fetch / call_error. amoCRM и ВАТС — поддельный fetch.
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsRepo, JournalRepo, type Db } from '@core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CALL_ERROR_KIND, CALL_FETCH_KIND, CallsRepo, callFileRel, callsSettingsSchema, downloadRecord, looksLikeMp3, OptSettingsRepo, parseCallNote, recordHostAllowed, recordKeyOf, RecordUnavailableError, runCallsPoll, runCallsPollAll, type CallsCore } from '../src/index.ts';
import { freshOptDb } from './setup.ts';

const ACCOUNT = 31337;
const UUID = '54dd41f6-7d7d-433b-9253-102849f4deb8';
const LINK = `https://rfdveri.megapbx.ru/api/v2/call-records/record/2026-10-21/${UUID}/79099500381_in_79295418663_2026_10_21-15_05_51_zxb7.mp3`;
const LINK_ONPBX = 'https://rfdveri.onpbx.ru/records/2024/old_call.mp3';
const LINK_404 = 'https://records.megapbx.ru/record/2026-10-20/missing.mp3';
const LINK_HTML = 'https://records.megapbx.ru/record/2026-10-20/login-page.mp3';
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0a, 0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4, 5, 6, 7, 8]);
const T0 = Math.floor(Date.parse('2026-10-21T12:05:51Z') / 1000);

const note = (id: number, entityId: number, type: 'call_in' | 'call_out', params: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id, entity_id: entityId, created_by: 3, updated_by: 3, created_at: T0 + id, updated_at: T0 + id + 60, responsible_user_id: 3, note_type: type, params, ...extra });

interface Fake {
  contactNotes: unknown[];
  leadNotes: unknown[];
  records: Record<string, () => Response>;
  calls: string[];
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeFetch(f: Fake): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    f.calls.push(url);
    if (url.includes('/api/v4/contacts/notes?')) return url.includes('page=1') && f.contactNotes.length ? json(200, { _embedded: { notes: f.contactNotes } }) : new Response(null, { status: 204 });
    if (url.includes('/api/v4/leads/notes?')) return url.includes('page=1') && f.leadNotes.length ? json(200, { _embedded: { notes: f.leadNotes } }) : new Response(null, { status: 204 });
    if (url.endsWith('/api/v4/contacts/501?with=leads')) return json(200, { id: 501, _embedded: { leads: [{ id: 90141 }, { id: 80000 }, { id: 70000 }] } });
    if (url.endsWith('/api/v4/contacts/502?with=leads')) return json(200, { id: 502, _embedded: { leads: [] } });
    if (url.includes('/api/v4/leads?filter')) {
      return json(200, {
        _embedded: {
          leads: [
            { id: 90141, status_id: 10, pipeline_id: 1, updated_at: T0 - 100, closed_at: null },
            { id: 80000, status_id: 11, pipeline_id: 1, updated_at: T0 - 50_000, closed_at: null },
            { id: 70000, status_id: 142, pipeline_id: 1, updated_at: T0 + 1000, closed_at: T0 + 1000 },
          ],
        },
      });
    }
    const rec = f.records[url];
    if (rec) return rec();
    return json(404, { error: `нет ответа для ${url}` });
  }) as typeof fetch;
}

function coreOf(db: Db, f: Fake, filesRoot: string): CallsCore {
  return {
    calls: new CallsRepo(db),
    journal: new JournalRepo(db),
    settings: new OptSettingsRepo(db),
    accounts: new AccountsRepo(db),
    tokenService: { getAccessToken: async () => 'TOKEN' } as unknown as CallsCore['tokenService'],
    fetch: fakeFetch(f),
    filesRoot,
  };
}

describe('разбор примечаний-звонков (без БД)', () => {
  it('ссылка ВАТС → uuid, направление, телефон, длительность; без ссылки — не звонок; хосты записей', () => {
    const c = parseCallNote(note(1, 501, 'call_in', { link: LINK, duration: 185, phone: '79099500381', call_status: 4, uniq: 'x' }) as never, 'contact');
    expect(c).toMatchObject({ noteId: 1, entity: 'contact', entityId: 501, direction: 'in', recordKey: UUID, phone: '79099500381', durationSec: 185, callStatus: 4, managerId: 3 });
    expect(c?.calledAt.toISOString()).toBe('2026-10-21T12:05:52.000Z');
    expect(parseCallNote(note(2, 501, 'call_out', { duration: 30 }) as never, 'contact')).toBeNull();
    expect(parseCallNote({ ...note(3, 501, 'call_in', { link: LINK }), note_type: 'common' } as never, 'contact')).toBeNull();
    expect(parseCallNote(note(4, 9, 'call_out', { link: LINK, duration: '42', phone: 79295418663 }, { responsible_user_id: undefined }) as never, 'lead')).toMatchObject({ direction: 'out', durationSec: 42, phone: '79295418663', managerId: 3 });
    expect(recordKeyOf(LINK_ONPBX)).toBe('old_call');
    expect(recordHostAllowed(LINK)).toBe(true);
    expect(recordHostAllowed('https://records.megapbx.ru/x.mp3')).toBe(true);
    expect(recordHostAllowed(LINK_ONPBX)).toBe(true);
    expect(recordHostAllowed('http://rfdveri.megapbx.ru/x.mp3')).toBe(false);
    expect(recordHostAllowed('https://evil.ru/megapbx.ru/x.mp3')).toBe(false);
    expect(looksLikeMp3(MP3)).toBe(true);
    expect(looksLikeMp3(new TextEncoder().encode('<html>'))).toBe(false);
    expect(callFileRel(31337, 7, UUID, new Date('2026-10-21T12:05:52Z'))).toBe(`calls/31337/2026-10/7_${UUID}.mp3`);
  });

  it('скачивание: 503 → повтор → 200; 404 и страница входа — недоступно без повторов', async () => {
    let n = 0;
    const f: Fake = { contactNotes: [], leadNotes: [], calls: [], records: { [LINK]: () => (++n === 1 ? new Response('busy', { status: 503 }) : new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } })) } };
    const fetch = fakeFetch(f);
    const r = await downloadRecord(LINK, { fetch, sleep: async () => undefined });
    expect([r.attempts, r.mime, r.bytes.byteLength]).toEqual([2, 'audio/mpeg', MP3.byteLength]);
    const e404 = await downloadRecord(LINK_404, { fetch, sleep: async () => undefined }).catch((e: unknown) => e);
    expect(e404).toBeInstanceOf(RecordUnavailableError);
    expect((e404 as Error).message).toBe('сервер записей ответил HTTP 404');
    f.records[LINK_HTML] = () => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    const eHtml = await downloadRecord(LINK_HTML, { fetch, sleep: async () => undefined }).catch((e: unknown) => e);
    expect((eHtml as Error).message).toContain('ответ не аудио (text/html)');
    expect(f.calls.filter((u) => u === LINK_404)).toHaveLength(1);
    const settings = callsSettingsSchema.parse({});
    expect(settings).toMatchObject({ enabled: false, minDurationSec: 20, keepMp3Days: 30, sttProvider: 'speechkit', createTasks: true });
    expect(settings.checklist.reduce((s, c) => s + c.weight, 0)).toBe(100);
  });
});

describe('опрос звонков на БД опта (миграции с нуля)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let filesRoot: string;
  const f: Fake = { contactNotes: [], leadNotes: [], calls: [], records: {} };
  let core: CallsCore;
  const now = () => new Date('2026-10-21T13:00:00Z');

  beforeAll(async () => {
    ({ db, drop } = await freshOptDb());
    await new AccountsRepo(db).upsertInstalled({ id: ACCOUNT, subdomain: 'acc', accountDomain: 'acc.amocrm.ru' });
    await new AccountsRepo(db).upsertInstalled({ id: 2, subdomain: 'other', accountDomain: 'other.amocrm.ru' });
    filesRoot = mkdtempSync(join(tmpdir(), 'calls-'));
    core = coreOf(db, f, filesRoot);
  });
  afterAll(() => drop());

  it('выключено — amo не опрашивается; включили — первый опрос с момента включения', async () => {
    f.contactNotes = [note(1, 501, 'call_in', { link: LINK, duration: 185, phone: '79099500381', call_status: 4 })];
    const off = await runCallsPoll(core, ACCOUNT, { now });
    expect(off).toMatchObject({ enabled: false, found: 0 });
    expect(f.calls).toHaveLength(0);
    const s = new OptSettingsRepo(db);
    await s.save(ACCOUNT, 1, { ...(await s.get(ACCOUNT)).settings, calls: callsSettingsSchema.parse({ enabled: true }) });
    expect((await s.get(ACCOUNT)).settings.calls?.enabled).toBe(true);
  });

  it('сбор: новые в calls со сделкой контакта (открытая, самая свежая, закрытая не считается), короткие и пропущенные — мимо; MP3 на томе', async () => {
    f.records[LINK] = () => new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    f.records[LINK_ONPBX] = () => {
      throw new TypeError('fetch failed');
    };
    f.contactNotes = [
      note(1, 501, 'call_in', { link: LINK, duration: 185, phone: '79099500381', call_status: 4 }),
      note(2, 501, 'call_out', { link: 'https://rfdveri.megapbx.ru/api/v2/call-records/record/2026-10-21/aaaaaaaa-0000-0000-0000-000000000002/x.mp3', duration: 0, phone: '79099500381', call_status: 6 }),
      note(3, 501, 'call_in', { link: 'https://rfdveri.megapbx.ru/api/v2/call-records/record/2026-10-21/aaaaaaaa-0000-0000-0000-000000000003/x.mp3', duration: 12, phone: '79099500381' }),
      note(4, 502, 'call_out', { link: LINK_ONPBX, duration: 60, phone: '79000000004' }),
      note(5, 501, 'call_in', { duration: 90, phone: '79099500381' }),
    ];
    f.leadNotes = [note(6, 90025, 'call_out', { link: LINK_404, duration: 75, phone: '79000000006' })];
    const r = await runCallsPoll(core, ACCOUNT, { now, sleep: async () => undefined });
    expect(r).toMatchObject({ enabled: true, found: 6, inserted: 3, skippedShort: 2, noLink: 1, downloaded: 1, unavailable: 2, failed: 0, errors: [] });
    // Запрос примечаний — с отметки «сейчас минус 5 минут», страницами по 250, от старых к новым.
    const notesUrl = f.calls.find((u) => u.includes('/api/v4/contacts/notes?'))!;
    expect(notesUrl).toContain('filter[note_type][]=call_in&filter[note_type][]=call_out');
    expect(notesUrl).toContain(`filter[updated_at][from]=${Math.floor(now().getTime() / 1000) - 300}`);
    expect(notesUrl).toContain('order[updated_at]=asc&limit=250&page=1');
    const rows = await core.calls.list(ACCOUNT);
    expect(rows.map((c) => [c.noteId, c.entity, c.leadId, c.status, c.direction, c.durationSec])).toEqual([
      [6, 'lead', 90025, 'unavailable', 'out', 75],
      [4, 'contact', null, 'unavailable', 'out', 60],
      [1, 'contact', 90141, 'downloaded', 'in', 185],
    ]);
    const ok = rows.find((c) => c.noteId === 1)!;
    expect(ok.filePath).toBe(`calls/${ACCOUNT}/2026-10/${ok.id}_${UUID}.mp3`);
    expect(ok).toMatchObject({ fileBytes: MP3.byteLength, fileMime: 'audio/mpeg', recordKey: UUID, phone: '79099500381', managerId: 3, callStatus: 4 });
    expect(new Uint8Array(readFileSync(join(filesRoot, ok.filePath!)))).toEqual(MP3);
    expect(rows.find((c) => c.noteId === 4)?.error).toBe('старая ссылка OnlinePBX, запись не отдаётся: fetch failed');
    expect(f.calls.filter((u) => u === LINK_ONPBX)).toHaveLength(1);
    expect(rows.find((c) => c.noteId === 6)?.error).toBe('сервер записей ответил HTTP 404');
    // Сделки контакта запрошены один раз на контакт.
    expect(f.calls.filter((u) => u.endsWith('/api/v4/contacts/501?with=leads'))).toHaveLength(1);
    const j = await new JournalRepo(db).list(ACCOUNT, { limit: 10 });
    const fetchEntry = j.find((e) => e.kind === CALL_FETCH_KIND);
    expect(fetchEntry?.summary).toBe('Звонки: найдено 6, новых 3, коротких и пропущенных 2, без записи 1, скачано 1, недоступно 2');
    expect(j.filter((e) => e.kind === CALL_ERROR_KIND).map((e) => e.leadId)).toEqual(expect.arrayContaining([90025, null]));
    const sync = await core.calls.getSync(ACCOUNT, 'contact');
    expect(sync?.lastUpdatedAt.toISOString()).toBe('2026-10-21T12:55:00.000Z');
    expect(sync?.lastError).toBeNull();
  });

  it('повторный опрос: дублей нет, записи журнала нет, отметка — с прошлого раза; сбой amo по сделкам не ломает контакты', async () => {
    const before = (await core.calls.list(ACCOUNT)).length;
    const calls0 = f.calls.length;
    const r = await runCallsPoll(core, ACCOUNT, { now: () => new Date('2026-10-21T13:10:00Z'), sleep: async () => undefined });
    expect(r).toMatchObject({ found: 6, inserted: 0, downloaded: 0, unavailable: 0, failed: 0 });
    expect((await core.calls.list(ACCOUNT)).length).toBe(before);
    expect(f.calls.slice(calls0).find((u) => u.includes('/api/v4/contacts/notes?'))).toContain(`filter[updated_at][from]=${Math.floor(Date.parse('2026-10-21T12:55:00Z') / 1000)}`);
    expect((await new JournalRepo(db).list(ACCOUNT, { limit: 20 })).filter((e) => e.kind === CALL_FETCH_KIND)).toHaveLength(1);
    // Сделки: amo отвечает 500 — ошибка в результате и в calls_sync, звонки контактов всё равно собраны.
    const saved = core.fetch;
    core.fetch = (async (input: string | URL | Request, init?: RequestInit) => (String(input).includes('/api/v4/leads/notes?') ? new Response('boom', { status: 500 }) : saved(input, init))) as typeof fetch;
    const r2 = await runCallsPoll(core, ACCOUNT, { now: () => new Date('2026-10-21T13:20:00Z') });
    expect(r2.errors).toEqual(['сделки: amo API GET /api/v4/leads/notes: HTTP 500']);
    expect((await core.calls.getSync(ACCOUNT, 'lead'))?.lastError).toContain('HTTP 500');
    core.fetch = saved;
  });

  it('фильтр воронок: сделка не в списке — звонок без сделки; «Загрузить историю» — запрос за N дней назад', async () => {
    const s = new OptSettingsRepo(db);
    await s.save(ACCOUNT, 1, { ...(await s.get(ACCOUNT)).settings, calls: callsSettingsSchema.parse({ enabled: true, pipelineIds: [2] }) });
    f.contactNotes = [note(7, 501, 'call_in', { link: 'https://rfdveri.megapbx.ru/api/v2/call-records/record/2026-10-21/aaaaaaaa-0000-0000-0000-000000000007/x.mp3', duration: 40, phone: '79099500381' })];
    f.leadNotes = [];
    const calls0 = f.calls.length;
    const r = await runCallsPoll(core, ACCOUNT, { now, sinceDays: 30, sleep: async () => undefined });
    expect(r).toMatchObject({ inserted: 1, found: 1 });
    expect(f.calls.slice(calls0).find((u) => u.includes('/api/v4/contacts/notes?'))).toContain(`filter[updated_at][from]=${Math.floor(now().getTime() / 1000) - 30 * 86_400}`);
    const row = (await core.calls.list(ACCOUNT, { limit: 1 }))[0]!;
    expect([row.noteId, row.leadId, row.status]).toEqual([7, null, 'unavailable']);
    expect(row.error).toBe('сервер записей ответил HTTP 404');
  });

  it('удаление MP3 по сроку хранения: файл с тома удалён, путь в базе снят, запись осталась; все аккаунты — runCallsPollAll', async () => {
    const ok = (await core.calls.list(ACCOUNT)).find((c) => c.status === 'downloaded')!;
    const abs = join(filesRoot, ok.filePath!);
    expect(existsSync(abs)).toBe(true);
    await db.query(`UPDATE calls SET downloaded_at = now() - interval '40 days' WHERE id = $1`, [ok.id]);
    f.contactNotes = [];
    const all = await runCallsPollAll(core, { now, sleep: async () => undefined });
    expect(all.map((r) => [r.accountId, r.enabled, r.filesDeleted])).toEqual([[2, false, 0], [ACCOUNT, true, 1]]);
    expect(existsSync(abs)).toBe(false);
    const after = await core.calls.get(ACCOUNT, ok.id);
    expect([after?.status, after?.filePath, after?.fileDeletedAt !== null]).toEqual(['downloaded', null, true]);
    expect(await core.calls.countByStatus(ACCOUNT)).toEqual({ downloaded: 1, unavailable: 3 });
  });
});
