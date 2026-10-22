// RFD-AI-AGENT-CALLS-RETAIL, пп. 1–6: после расшифровки примечание не публикуется; три звонка сделки за день → одно
// примечание «Итог разговоров за день»; звонок без делового содержания не входит; сделки других воронок и этапов 142/143
// не обрабатываются; без сделки — примечание в контакт; повторный запуск не дублирует; нерасшифрованный уходит в следующий
// день с пометкой даты; догрузка → итоги по дням; оценка без --yes ничего не пишет; ошибка → повтор через 30 мин → алерт.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AccountsRepo, JournalRepo, SettingsRepo, widgetSettingsSchema, type Db } from '@core/db';
import type { LlmGateway, RoutedResponse } from '@core/llm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb } from '../../db/test/setup.ts';
import { CALL_DAY_KIND, CALL_DAY_RUN_KIND, daySummaryDue, formatDayNote, groupCalls, MAX_ATTEMPTS, previewCallsBackfill, runCallsPoll, runDaySummary, type AmoRaw, type CallRow, type CallsDeps, type CallStt, type CallTranscript, type PendingTranscription, type SttMode } from '../src/index.ts';
import { depsOf } from './helpers.ts';

const ACC = 1;
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0x0a, 0xff, 0xfb, 0x90, 0x64, 1, 2, 3]);
const NOW = new Date('2026-10-22T13:00:00Z'); // 16:00 МСК, итог за 22.10.2026
const at = (iso: string) => new Date(iso);

const segs = (n: number) => [
  { speaker: '1', startMs: 0, endMs: 4000, text: `Компания РФ-Двери, здравствуйте (${n}).` },
  { speaker: '2', startMs: 4500, endMs: 15000, text: 'Нужны три межкомнатные двери, замер на неделе.' },
];
const transcript = (n: number, mode: SttMode = 'async'): CallTranscript => ({ provider: 'speechkit', mode, model: 'general', text: segs(n).map((s) => s.text).join('\n'), segments: segs(n), durationSec: 15, speakers: 2, cost: { rub: 0.61, usd: 0 }, startedAt: NOW.toISOString(), finishedAt: NOW.toISOString() });

class FakeSpeechKit implements CallStt {
  readonly name = 'speechkit' as const;
  started = 0;
  polls = 0;
  constructor(
    private readyAfter: number,
    private fail = false,
  ) {}
  async start(_b: Uint8Array, _m: string, o: { mode: SttMode }) {
    if (this.fail) throw new Error('SpeechKit: HTTP 500');
    this.started++;
    return { pending: { provider: 'speechkit' as const, mode: o.mode, operationId: `op-${this.started}`, startedAt: NOW.toISOString(), polls: 0 } };
  }
  async poll(p: PendingTranscription) {
    this.polls++;
    return this.polls >= this.readyAfter ? transcript(this.polls, p.mode) : null;
  }
}

/** Мок модели: берёт id звонков из подсказки (<call id="N">), исключает заданные; очередь ошибок / невалидных ответов. */
function fakeLlm(opts: { exclude?: number[]; first?: (string | Error)[] } = {}) {
  const asked: string[] = [];
  const queue = [...(opts.first ?? [])];
  const llm: LlmGateway = {
    async chat(req, r) {
      const content = String(req.messages[0]?.content ?? '');
      asked.push(content);
      const q = queue.shift();
      if (q instanceof Error) throw q;
      const ids = [...content.matchAll(/<call id="(\d+)"/g)].map((m) => Number(m[1]));
      const business = ids.filter((id) => !(opts.exclude ?? []).includes(id));
      const text = q ?? JSON.stringify({ summary: business.length ? `Клиенту нужны три межкомнатные двери, замер на неделе (звонков ${business.length}).` : 'Автоответчик, разговора не было.', agreements: business.length ? ['Замер в четверг 23.10', 'Менеджер пришлёт расчёт после замера'] : [], nextStep: business.length ? 'Менеджер согласует время замера.' : '', managerScore: business.length ? 8 : 5, managerComment: business.length ? 'Потребность и сроки выявлены, бюджет не уточнил.' : '', callsCount: business.length, totalDuration: 0, callIds: business, speakers: ids.flatMap((id) => [{ callId: id, tag: '1', role: 'manager' }, { callId: id, tag: '2', role: 'client' }]) });
      return { text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 1500, outputTokens: 400, cachedInputTokens: 0, cacheWriteTokens: 0 }, provider: r.primary.provider, model: r.primary.model, assistantMessage: { role: 'assistant', content: text }, latencyMs: 1, fallbackUsed: false, requested: r.primary, attempts: [] } as unknown as RoutedResponse;
    },
    providers: async () => ['openai'],
    provider: async () => null,
  };
  return { llm, asked };
}

const LEADS: Record<number, { status_id: number; pipeline_id: number }> = { 90141: { status_id: 28643029, pipeline_id: 1873498 }, 90142: { status_id: 28643038, pipeline_id: 1873498 }, 80000: { status_id: 11, pipeline_id: 2 }, 70000: { status_id: 142, pipeline_id: 1873498 } };

describe('итог разговоров за день на БД розницы (миграции с нуля)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let filesRoot: string;
  let deps: CallsDeps;
  const posts: { path: string; text: string }[] = [];
  const alerts: string[] = [];
  let llm = fakeLlm();
  const amo: AmoRaw = {
    get: async (path) => {
      if (path.includes('/api/v4/leads?filter')) {
        const ids = [...path.matchAll(/filter\[id\]\[\]=(\d+)/g)].map((m) => Number(m[1]));
        return { _embedded: { leads: ids.filter((id) => LEADS[id]).map((id) => ({ id, ...LEADS[id] })) } } as never;
      }
      return null;
    },
    post: async (path, body) => {
      posts.push({ path, text: (body as { params: { text: string } }[])[0]?.params.text ?? '' });
      return { _embedded: { notes: [{ id: 500 + posts.length }] } } as never;
    },
  };
  let seq = 100;
  /** Звонок в базе: расшифрованный (по умолчанию) или только скачанный (файл на томе). */
  const insert = async (o: { leadId?: number | null; entity?: 'contact' | 'lead'; calledAt: Date; durationSec?: number; transcribed?: boolean; sttMode?: SttMode }) => {
    const n = ++seq;
    const [id] = await deps.calls.insertNew(ACC, [{ noteId: n, entity: o.entity ?? 'contact', entityId: o.entity === 'lead' ? (o.leadId ?? 0) : 501, direction: n % 2 ? 'in' : 'out', link: `https://rfdveri.megapbx.ru/api/v2/call-records/record/2026-10-22/aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}/x.mp3`, recordKey: `k${n}`, phone: '79099500381', durationSec: o.durationSec ?? 185, callStatus: 4, calledAt: o.calledAt, noteUpdatedAt: o.calledAt, managerId: 3, leadId: o.leadId === undefined ? 90141 : o.leadId }], o.sttMode ?? 'async');
    const rel = `calls/${ACC}/2026-10/${id}_x.mp3`;
    mkdirSync(dirname(join(filesRoot, rel)), { recursive: true });
    writeFileSync(join(filesRoot, rel), MP3);
    await deps.calls.setDownloaded(id!, { filePath: rel, fileBytes: MP3.byteLength, fileMime: 'audio/mpeg' });
    if (o.transcribed !== false) {
      await deps.calls.setTranscript(id!, transcript(n, o.sttMode ?? 'async'), 'transcribed');
      await deps.calls.addCost(id!, { sttRub: 0.61, sttUsd: 0 });
    }
    return id!;
  };
  const run = (opts: Parameters<typeof runDaySummary>[2] = {}) => runDaySummary(deps, ACC, { now: () => NOW, sleep: async () => undefined, amo, transcribe: { stt: () => new FakeSpeechKit(99), inlineWaitMs: 0 }, ...opts });

  beforeAll(async () => {
    ({ db, drop } = await freshDb());
    await new AccountsRepo(db).upsertInstalled({ id: ACC, subdomain: 'acc', accountDomain: 'acc.amocrm.ru' });
    await new SettingsRepo(db).save(ACC, 1, widgetSettingsSchema.parse({ calls: { daySummaryTimeoutSec: 0 } }));
    filesRoot = mkdtempSync(join(tmpdir(), 'calls-day-'));
    deps = depsOf(db, (async () => new Response('нет', { status: 404 })) as typeof fetch, filesRoot, {
      llmFor: async () => ({ llm: llm.llm, route: { primary: { provider: 'openai', model: 'gpt-5.5' }, fallback: null }, pricing: {}, usdRubRate: 90 }),
      alerter: { alert: async (m: string) => void alerts.push(m) },
    });
  });
  afterAll(() => drop());

  it('после расшифровки примечание не публикуется: звонок остаётся transcribed, итогов нет', async () => {
    const id = await insert({ calledAt: at('2026-10-22T06:05:00Z'), transcribed: false });
    const stt = new FakeSpeechKit(1);
    const r = await runCallsPoll(deps, ACC, { now: () => NOW, sleep: async () => undefined, amo, transcribeOptions: { stt: () => stt, inlineWaitMs: 10_000 } });
    expect(r.transcribed).toMatchObject({ picked: 1, transcribed: 1 });
    expect((await deps.calls.get(ACC, id))?.status).toBe('transcribed');
    expect(posts).toHaveLength(0);
    expect(await deps.days.list(ACC)).toHaveLength(0);
    // Вместе с ним — ещё два звонка той же сделки за день (для следующего сценария).
    await insert({ calledAt: at('2026-10-22T08:30:00Z') });
    await insert({ calledAt: at('2026-10-22T10:00:00Z') });
  });

  it('три звонка сделки за день → один вызов модели и одно примечание в сделку; звонки posted со ссылкой на итог', async () => {
    llm = fakeLlm();
    const r = await run();
    expect(r).toMatchObject({ enabled: true, groups: 1, calls: 3, notes: 1, noBusiness: 0, skipped: 0, errors: 0, waiting: 0 });
    expect(llm.asked).toHaveLength(1);
    expect(llm.asked[0]).toContain('<call id="');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe('/api/v4/leads/90141/notes');
    expect(posts[0]!.text).toBe(['Итог разговоров за 22.10.2026: 3 звонка, общая длительность 9:15', 'Итог: Клиенту нужны три межкомнатные двери, замер на неделе (звонков 3).', 'Договорённости: \n— Замер в четверг 23.10\n— Менеджер пришлёт расчёт после замера', 'Следующий шаг: Менеджер согласует время замера.', 'Оценка менеджера: 8/10 — Потребность и сроки выявлены, бюджет не уточнил.'].join('\n'));
    const days = await deps.days.list(ACC);
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ leadId: 90141, contactId: null, day: '2026-10-22', business: true, callsCount: 3, totalDurationSec: 555, noteId: 501, noteEntity: 'lead' });
    const rows = (await deps.calls.list(ACC)).filter((c) => c.leadId === 90141);
    expect(rows.map((c) => [c.status, c.daySummaryId])).toEqual([['posted', days[0]!.id], ['posted', days[0]!.id], ['posted', days[0]!.id]]);
    expect((rows[0]!.transcript as CallTranscript).segments.map((s) => s.role)).toEqual(['manager', 'client']);
    const j = await new JournalRepo(db).list(ACC, { limit: 10 });
    expect(j.find((e) => e.kind === CALL_DAY_KIND)).toMatchObject({ leadId: 90141, inputTokens: 1500, outputTokens: 400 });
    expect(j.find((e) => e.kind === CALL_DAY_RUN_KIND)?.summary).toBe('Итог разговоров за день: сделок и контактов 1, звонков 3, примечаний 1');
    // Повторный запуск в тот же день: новых звонков нет — ничего не пишется.
    expect(await run()).toMatchObject({ groups: 0, notes: 0 });
    expect(posts).toHaveLength(1);
  });

  it('повторный запуск в тот же день пишет отдельный итог только по новым звонкам; без делового содержания — не входит', async () => {
    const spam = await insert({ calledAt: at('2026-10-22T11:00:00Z') });
    await insert({ calledAt: at('2026-10-22T11:30:00Z') });
    llm = fakeLlm({ exclude: [spam] });
    const r = await run();
    expect(r).toMatchObject({ groups: 1, calls: 2, notes: 1, noBusiness: 0 });
    expect(posts).toHaveLength(2);
    expect(posts[1]!.text.split('\n')[0]).toBe('Итог разговоров за 22.10.2026: 1 звонок, общая длительность 3:05');
    const days = await deps.days.list(ACC, { leadId: 90141 });
    expect(days).toHaveLength(2);
    const s = (await deps.calls.get(ACC, spam))!;
    expect([s.status, s.daySummaryId]).toEqual(['analyzed', days[0]!.id]);
    // Все звонки без содержания: итог есть (business = false), примечания нет, звонки analyzed.
    const only = await insert({ calledAt: at('2026-10-22T12:00:00Z'), leadId: 90142 });
    llm = fakeLlm({ exclude: [only] });
    const r2 = await run();
    expect(r2).toMatchObject({ groups: 1, notes: 0, noBusiness: 1 });
    expect(posts).toHaveLength(2);
    expect((await deps.days.list(ACC, { leadId: 90142 }))[0]).toMatchObject({ business: false, noteId: null, callsCount: 0 });
    expect((await deps.calls.get(ACC, only))?.status).toBe('analyzed');
  });

  it('сделка другой воронки и этапа 142 не обрабатываются; без сделки — примечание в контакт', async () => {
    const other = await insert({ calledAt: at('2026-10-22T09:00:00Z'), leadId: 80000 });
    const closed = await insert({ calledAt: at('2026-10-22T09:10:00Z'), leadId: 70000 });
    const noLead = await insert({ calledAt: at('2026-10-22T09:20:00Z'), leadId: null });
    llm = fakeLlm();
    const r = await run();
    expect(r).toMatchObject({ groups: 1, calls: 1, notes: 1, skipped: 2 });
    expect(llm.asked).toHaveLength(1);
    expect(posts.at(-1)?.path).toBe('/api/v4/contacts/501/notes');
    expect((await deps.days.list(ACC))[0]).toMatchObject({ leadId: null, contactId: 501, noteEntity: 'contact' });
    expect((await deps.calls.get(ACC, noLead))?.status).toBe('posted');
    const o = (await deps.calls.get(ACC, other))!;
    expect([o.status, o.error]).toEqual(['analyzed', 'сделка в другой воронке (2), итог только по воронке 1873498']);
    expect((await deps.calls.get(ACC, closed))?.error).toBe('сделка на закрытом этапе (142)');
    expect((await run()).groups).toBe(0);
  });

  it('нерасшифрованный звонок не дождался — в итог следующего дня с пометкой даты; догрузка — итоги по дням', async () => {
    const late = await insert({ calledAt: at('2026-10-22T12:30:00Z'), transcribed: false });
    const r = await run();
    expect(r).toMatchObject({ groups: 0, waiting: 1 });
    expect((await deps.calls.get(ACC, late))?.status).toBe('downloaded');
    // Следующий день: расшифровка готова, звонок 22.10 входит в итог за 23.10 с пометкой.
    const NEXT = new Date('2026-10-23T13:00:00Z');
    await insert({ calledAt: at('2026-10-23T07:00:00Z') });
    llm = fakeLlm();
    const r2 = await runDaySummary(deps, ACC, { now: () => NEXT, sleep: async () => undefined, amo, transcribe: { stt: () => new FakeSpeechKit(1), inlineWaitMs: 0 } });
    expect(r2).toMatchObject({ groups: 1, calls: 2, notes: 1, waiting: 0 });
    expect(posts.at(-1)?.text.split('\n')[0]).toBe('Итог разговоров за 23.10.2026: 2 звонка, общая длительность 6:10 (в т. ч. звонки от 22.10)');
    expect((await deps.calls.get(ACC, late))?.status).toBe('posted');
    // Догрузка: звонки 15.10 и 16.10 (deferred) → по одному примечанию на день с фактической датой.
    await insert({ calledAt: at('2026-10-15T08:00:00Z'), sttMode: 'deferred' });
    await insert({ calledAt: at('2026-10-15T09:00:00Z'), sttMode: 'deferred' });
    await insert({ calledAt: at('2026-10-16T08:00:00Z'), sttMode: 'deferred' });
    const before = posts.length;
    const r3 = await runDaySummary(deps, ACC, { now: () => NEXT, sleep: async () => undefined, amo });
    expect(r3).toMatchObject({ groups: 2, calls: 3, notes: 2 });
    expect(posts.slice(before).map((p) => p.text.split('\n')[0]).sort()).toEqual(['Итог разговоров за 15.10.2026: 2 звонка, общая длительность 6:10', 'Итог разговоров за 16.10.2026: 1 звонок, общая длительность 3:05']);
    expect(groupCalls([{ calledAt: at('2026-10-21T20:59:00Z'), leadId: 1, entity: 'contact', entityId: 9 } as CallRow, { calledAt: at('2026-10-20T20:59:00Z'), leadId: 1, entity: 'contact', entityId: 9 } as CallRow], '2026-10-22').map((g) => g.day)).toEqual(['2026-10-22', '2026-10-20']);
  });

  it('оценка догрузки без --yes ничего не пишет и считает будущие примечания; время запуска итога', async () => {
    const T0 = Math.floor(Date.parse('2026-10-18T09:00:00Z') / 1000);
    const note = (id: number, duration: number, day: string, link = `https://rfdveri.megapbx.ru/api/v2/call-records/record/${day}/aaaaaaaa-1111-0000-0000-${String(id).padStart(12, '0')}/x.mp3`) => ({ id, entity_id: 501, created_by: 3, created_at: Math.floor(Date.parse(`${day}T09:00:00Z`) / 1000) + id, updated_at: T0 + id, responsible_user_id: 3, note_type: 'call_in', params: { link, duration, phone: '79099500381' } });
    const amoNotes: AmoRaw = {
      get: async (path) => {
        if (path.includes('/contacts/notes?') && path.includes('page=1')) return { _embedded: { notes: [note(1, 185, '2026-10-18'), note(2, 120, '2026-10-18'), note(3, 240, '2026-10-19'), note(4, 5, '2026-10-19'), { ...note(5, 90, '2026-10-19'), params: { duration: 90 } }] } } as never;
        if (path.includes('/contacts/501?with=leads')) return { _embedded: { leads: [{ id: 90141 }] } } as never;
        if (path.includes('/api/v4/leads?filter')) return { _embedded: { leads: [{ id: 90141, status_id: 28643029, pipeline_id: 1873498, updated_at: 1, closed_at: null }] } } as never;
        return null;
      },
      post: async () => null,
    };
    const before = (await deps.calls.list(ACC, { limit: 500 })).length;
    const p = await previewCallsBackfill(deps, ACC, 30, { now: () => NOW, amo: amoNotes });
    expect(p).toMatchObject({ days: 30, found: 5, newCalls: 3, newMinutes: 9.3, shortOrNoLink: 2, futureNotes: 2 });
    expect(p.estimate.sttRub).toBeCloseTo(9.25 * 0.1524, 2);
    expect(p.estimate.totalRub).toBeGreaterThan(p.estimate.sttRub);
    expect((await deps.calls.list(ACC, { limit: 500 })).length).toBe(before);
    expect(daySummaryDue('19:30', null, at('2026-10-22T16:29:00Z'))).toBe(false); // 19:29 МСК
    expect(daySummaryDue('19:30', null, at('2026-10-22T16:30:00Z'))).toBe(true);
    expect(daySummaryDue('19:30', at('2026-10-22T16:31:00Z'), at('2026-10-22T18:00:00Z'))).toBe(false); // сегодня уже запускали
    expect(daySummaryDue('19:30', at('2026-10-21T16:31:00Z'), at('2026-10-22T16:35:00Z'))).toBe(true);
    expect(formatDayNote('2026-10-22', { summary: 'x', agreements: ['одна'], nextStep: '', managerScore: 5, managerComment: '', callsCount: 5, totalDuration: 61, callIds: [], speakers: [] }, [])).toContain('5 звонков, общая длительность 1:01\nИтог: x\nДоговорённости: одна\nСледующий шаг: не определён');
  });
});

describe('ошибки и повторы (часы от реального времени — updated_at ставит БД)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let deps: CallsDeps;
  const alerts: string[] = [];
  const T = { t: new Date() };
  const now = () => T.t;
  const tick = (min: number) => (T.t = new Date(T.t.getTime() + min * 60_000));

  beforeAll(async () => {
    ({ db, drop } = await freshDb());
    await new AccountsRepo(db).upsertInstalled({ id: ACC, subdomain: 'acc', accountDomain: 'acc.amocrm.ru' });
    const filesRoot = mkdtempSync(join(tmpdir(), 'calls-err-'));
    deps = depsOf(db, (async () => new Response('нет', { status: 404 })) as typeof fetch, filesRoot, { alerter: { alert: async (m: string) => void alerts.push(m) } });
    const [id] = await deps.calls.insertNew(ACC, [{ noteId: 1, entity: 'contact', entityId: 501, direction: 'in', link: 'https://rfdveri.megapbx.ru/api/v2/call-records/record/2026-10-22/aaaaaaaa-0000-0000-0000-000000000001/x.mp3', recordKey: 'k1', phone: '79099500381', durationSec: 185, callStatus: 4, calledAt: now(), noteUpdatedAt: now(), managerId: 3, leadId: 90141 }]);
    const rel = `calls/${ACC}/2026-10/${id}_x.mp3`;
    mkdirSync(dirname(join(filesRoot, rel)), { recursive: true });
    writeFileSync(join(filesRoot, rel), MP3);
    await deps.calls.setDownloaded(id!, { filePath: rel, fileBytes: MP3.byteLength, fileMime: 'audio/mpeg' });
  });
  afterAll(() => drop());

  it('расшифровка падает → failed, повтор через 30 мин, после 3 попыток — один алерт в Telegram и остановка', async () => {
    const stt = new FakeSpeechKit(1, true);
    const poll = () => runCallsPoll(deps, ACC, { now, sleep: async () => undefined, amo: { get: async () => null, post: async () => null }, transcribeOptions: { stt: () => stt } });
    expect((await poll()).transcribed).toMatchObject({ picked: 1, failed: 1, alerts: 0 });
    const row = (await deps.calls.list(ACC))[0]!;
    expect([row.status, row.stage, row.attempts, row.error]).toEqual(['failed', 'transcribe', 1, 'SpeechKit: HTTP 500']);
    expect((await poll()).transcribed?.picked).toBe(0);
    tick(31);
    expect((await poll()).transcribed?.failed).toBe(1);
    tick(31);
    expect((await poll()).transcribed).toMatchObject({ failed: 1, alerts: 1 });
    expect((await deps.calls.list(ACC))[0]).toMatchObject({ attempts: MAX_ATTEMPTS, status: 'failed' });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('расшифровка не удалась 3 раза: SpeechKit: HTTP 500');
    tick(31);
    expect((await poll()).transcribed?.picked).toBe(0);
  });
});
