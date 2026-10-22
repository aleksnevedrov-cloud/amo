// RFD-AI-AGENT-OPT-CALLS, этапы 2–3: расшифровка (мок SpeechKit — асинхронный и отложенный режимы, мок OpenAI), разбор
// моделью (мок LLM, проверка JSON с повтором), примечание «Анализ звонка» в сделку и в контакт (мок amo), защита от дублей,
// короткий звонок, звонок без делового содержания, ошибка → повтор через 30 мин → 3 попытки → алерт, оценка догрузки.
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AccountsRepo, JournalRepo, type Db } from '@core/db';
import type { LlmGateway, RoutedResponse } from '@core/llm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CALL_ANALYSIS_KIND,
  CALL_ERROR_KIND,
  CALL_NOTE_KIND,
  CallsRepo,
  callsSettingsSchema,
  formatCallNote,
  MAX_ATTEMPTS,
  OptSettingsRepo,
  parseSpeechKitLines,
  pickStt,
  previewCallsBackfill,
  processCalls,
  runCallsPoll,
  type AmoRaw,
  type CallAnalysis,
  type CallsProcessCore,
  type CallStt,
  type OptSettings,
  type CallTranscript,
  type PendingTranscription,
  type SttMode,
} from '../src/index.ts';
import { freshOptDb } from './setup.ts';

const ACCOUNT = 31337;
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0x0a, 0xff, 0xfb, 0x90, 0x64, 1, 2, 3]);
const CALLED_AT = new Date('2026-10-21T12:05:51Z'); // 15:05 МСК
const LINK = (n: number) => `https://rfdveri.megapbx.ru/api/v2/call-records/record/2026-10-21/aaaaaaaa-0000-0000-0000-00000000000${n}/x.mp3`;

const segments = () => [
  { speaker: '1', startMs: 0, endMs: 4000, text: 'Компания РФ-Двери, Анна, здравствуйте.' },
  { speaker: '2', startMs: 4500, endMs: 15000, text: 'Здравствуйте, нужно 12 противопожарных дверей на объект в Люберцах, сроки две недели.' },
  { speaker: '1', startMs: 15500, endMs: 30000, text: 'Понял, подготовлю КП до пятницы и перезвоню.' },
];
const transcript = (mode: SttMode): CallTranscript => ({ provider: 'speechkit', mode, model: mode === 'deferred' ? 'deferred-general' : 'general', text: segments().map((s) => s.text).join('\n'), segments: segments(), durationSec: 30, speakers: 2, cost: { rub: mode === 'deferred' ? 0.46 : 1.82, usd: 0 }, startedAt: '2026-10-21T13:00:00Z', finishedAt: '2026-10-21T13:00:20Z' });

/** Мок SpeechKit: start → операция; poll отдаёт результат после readyAfter проверок. */
class FakeSpeechKit implements CallStt {
  readonly name = 'speechkit' as const;
  started: { mode: SttMode; bytes: number }[] = [];
  polls = 0;
  constructor(
    private readyAfter: number,
    private text: 'ok' | 'empty' = 'ok',
  ) {}
  async start(bytes: Uint8Array, _mime: string, opts: { mode: SttMode }) {
    this.started.push({ mode: opts.mode, bytes: bytes.byteLength });
    return { pending: { provider: 'speechkit' as const, mode: opts.mode, operationId: `op-${this.started.length}`, startedAt: '2026-10-21T13:00:00Z', polls: 0 } };
  }
  async poll(p: PendingTranscription) {
    this.polls++;
    if (this.polls < this.readyAfter) return null;
    const t = transcript(p.mode);
    return this.text === 'empty' ? { ...t, text: '', segments: [] } : t;
  }
}

const ANALYSIS: CallAnalysis = { businessContent: true, summary: 'Клиенту нужны 12 противопожарных дверей на объект в Люберцах, срок две недели.', agreements: ['Менеджер готовит КП до пятницы 24.10', 'Перезвонить клиенту после отправки КП'], nextStep: 'Менеджер отправляет КП и перезванивает.', managerScore: 7, managerComment: 'Потребность и сроки выявлены, бюджет и доставку не уточнил.', speakers: [{ tag: '1', role: 'manager' }, { tag: '2', role: 'client' }] };

/** Мок шлюза модели: очередь ответов (строка — текст ответа, Error — сбой). */
function fakeLlm(answers: (string | Error)[]) {
  const asked: string[] = [];
  const llm: LlmGateway = {
    async chat(req, r) {
      asked.push(String(req.messages[0]?.content ?? ''));
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return { text: a ?? '', toolCalls: [], stopReason: 'end', usage: { inputTokens: 1200, outputTokens: 300, cachedInputTokens: 0, cacheWriteTokens: 0 }, provider: r.primary.provider, model: r.primary.model, assistantMessage: { role: 'assistant', content: a ?? '' }, latencyMs: 1, fallbackUsed: false, requested: r.primary, attempts: [] } as unknown as RoutedResponse;
    },
    providers: async () => ['openai'],
    provider: async () => null,
  };
  return { llm, asked, answers };
}

describe('расшифровка и разбор: без БД', () => {
  it('SpeechKit: JSON построчно → реплики с говорящими и таймкодами, нормализованный текст вместо сырого', () => {
    const lines = [
      JSON.stringify({ result: { sessionUuid: {}, channelTag: '1', final: { alternatives: [{ words: [{ text: 'компания', startTimeMs: '120', endTimeMs: '600' }, { text: 'рф двери', startTimeMs: '700', endTimeMs: '1400' }], text: 'компания рф двери здравствуйте', startTimeMs: '120', endTimeMs: '2100' }], channelTag: '1' } } }),
      JSON.stringify({ result: { channelTag: '1', finalRefinement: { normalizedText: { alternatives: [{ text: 'Компания «РФ-Двери», здравствуйте.' }] } } } }),
      JSON.stringify({ result: { channelTag: '2', final: { alternatives: [{ words: [{ text: 'нужно', startTimeMs: '3000', endTimeMs: '3300' }], text: 'нужно двенадцать дверей', startTimeMs: '3000', endTimeMs: '5200' }], channelTag: '2' } } }),
      JSON.stringify({ result: { statistics: { x: 1 } } }),
      'не json',
    ].join('\n');
    const p = parseSpeechKitLines(lines);
    expect(p.segments).toEqual([
      { speaker: '1', startMs: 120, endMs: 2100, text: 'Компания «РФ-Двери», здравствуйте.' },
      { speaker: '2', startMs: 3000, endMs: 5200, text: 'нужно двенадцать дверей' },
    ]);
    expect([p.durationSec, p.speakers]).toEqual([5, 2]);
  });

  it('провайдер по настройке и ключам: нет ключа SpeechKit — OpenAI; нет ключей — null; примечание по формату ТЗ', () => {
    expect(pickStt('speechkit', { speechkit: 'y', openai: 'o' })?.name).toBe('speechkit');
    expect(pickStt('speechkit', { openai: 'o' })?.name).toBe('openai');
    expect(pickStt('openai', { speechkit: 'y' })?.name).toBe('speechkit');
    expect(pickStt('speechkit', {})).toBeNull();
    const text = formatCallNote({ calledAt: CALLED_AT, direction: 'in', durationSec: 185 }, ANALYSIS);
    expect(text).toBe(['Анализ звонка 21.10.2026 15:05, входящий, 3:05', 'Итог: Клиенту нужны 12 противопожарных дверей на объект в Люберцах, срок две недели.', 'Договорённости: \n— Менеджер готовит КП до пятницы 24.10\n— Перезвонить клиенту после отправки КП', 'Следующий шаг: Менеджер отправляет КП и перезванивает.', 'Оценка менеджера: 7/10 — Потребность и сроки выявлены, бюджет и доставку не уточнил.'].join('\n'));
    expect(formatCallNote({ calledAt: CALLED_AT, direction: 'out', durationSec: 61 }, { ...ANALYSIS, agreements: [], nextStep: '' })).toContain('исходящий, 1:01\n');
    expect(formatCallNote({ calledAt: CALLED_AT, direction: 'out', durationSec: 61 }, { ...ANALYSIS, agreements: [], nextStep: '' })).toContain('Договорённости: нет\nСледующий шаг: не определён');
  });
});

describe('обработка звонков на БД опта (миграции с нуля)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let filesRoot: string;
  let repo: CallsRepo;
  const posts: { path: string; body: unknown }[] = [];
  const alerts: string[] = [];
  const amo: AmoRaw = {
    get: async () => null,
    post: async (path, body) => {
      posts.push({ path, body });
      return { _embedded: { notes: [{ id: 500 + posts.length }] } } as never;
    },
  };
  let llm = fakeLlm([]);
  let core: CallsProcessCore;
  // Часы теста идут от реального времени: повтор через 30 минут сравнивается с updated_at, которое ставит БД.
  const T = { t: new Date() };
  const now = () => T.t;
  const tick = (min: number) => (T.t = new Date(T.t.getTime() + min * 60_000));

  const insert = async (n: number, over: { durationSec?: number; leadId?: number | null; entity?: 'contact' | 'lead'; sttMode?: SttMode; withFile?: boolean } = {}) => {
    const [id] = await repo.insertNew(ACCOUNT, [{ noteId: n, entity: over.entity ?? 'contact', entityId: over.entity === 'lead' ? 90025 : 501, direction: n % 2 ? 'in' : 'out', link: LINK(n), recordKey: `aaaaaaaa-0000-0000-0000-00000000000${n}`, phone: '79099500381', durationSec: over.durationSec ?? 185, callStatus: 4, calledAt: CALLED_AT, noteUpdatedAt: CALLED_AT, managerId: 3, leadId: over.leadId === undefined ? 90141 : over.leadId }], over.sttMode ?? 'async');
    if (over.withFile !== false) {
      const rel = `calls/${ACCOUNT}/2026-10/${id}_x.mp3`;
      mkdirSync(dirname(join(filesRoot, rel)), { recursive: true });
      writeFileSync(join(filesRoot, rel), MP3);
      await repo.setDownloaded(id!, { filePath: rel, fileBytes: MP3.byteLength, fileMime: 'audio/mpeg' });
    }
    return id!;
  };
  const run = (stt: CallStt | null, extra: Record<string, unknown> = {}) => processCalls(core, ACCOUNT, settingsAll(), { now, sleep: async () => undefined, stt: () => stt, amo, inlineWaitMs: 10_000, ...extra });
  let settingsAll: () => OptSettings;

  beforeAll(async () => {
    ({ db, drop } = await freshOptDb());
    await new AccountsRepo(db).upsertInstalled({ id: ACCOUNT, subdomain: 'acc', accountDomain: 'acc.amocrm.ru' });
    filesRoot = mkdtempSync(join(tmpdir(), 'calls-proc-'));
    repo = new CallsRepo(db);
    const s = new OptSettingsRepo(db);
    const base = (await s.get(ACCOUNT)).settings;
    await s.save(ACCOUNT, 1, { ...base, calls: callsSettingsSchema.parse({ enabled: true }) });
    const saved = (await s.get(ACCOUNT)).settings;
    settingsAll = () => saved;
    core = {
      calls: repo,
      journal: new JournalRepo(db),
      settings: s,
      accounts: new AccountsRepo(db),
      tokenService: { getAccessToken: async () => 'TOKEN' } as unknown as CallsProcessCore['tokenService'],
      fetch: (async () => new Response('нет', { status: 404 })) as typeof fetch,
      filesRoot,
      ai: async () => ({ llm: llm.llm, source: 'server', providers: ['openai'], keySources: {} }),
      env: { YANDEX_SPEECHKIT_API_KEY: 'y', OPENAI_API_KEY: 'o' } as CallsProcessCore['env'],
      alerter: { alert: async (m: string) => void alerts.push(m) },
    };
  });
  afterAll(() => drop());

  it('асинхронный режим: операция → результат в том же опросе → разбор (1-й ответ не по схеме, 2-й верный) → примечание в сделку', async () => {
    const id = await insert(1);
    llm = fakeLlm(['{"summary": "без speakers"}', JSON.stringify(ANALYSIS)]);
    const stt = new FakeSpeechKit(2);
    const r = await run(stt);
    expect(r).toMatchObject({ picked: 1, transcribed: 1, pending: 0, analyzed: 1, posted: 1, failed: 0 });
    expect(stt.started).toEqual([{ mode: 'async', bytes: MP3.byteLength }]);
    const row = (await repo.get(ACCOUNT, id))!;
    expect(row.status).toBe('posted');
    const t = row.transcript as CallTranscript;
    expect(t.segments.map((s) => s.role)).toEqual(['manager', 'client', 'manager']);
    expect(row.analysis).toMatchObject({ managerScore: 7, attempts: 2, provider: 'openai' });
    expect(row.cost).toMatchObject({ sttRub: 1.82, sttMode: 'async', llmInputTokens: 2400, llmOutputTokens: 600 });
    expect(row.posted).toMatchObject({ noteId: 501, entity: 'lead', entityId: 90141 });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe('/api/v4/leads/90141/notes');
    const note = (posts[0]!.body as { note_type: string; params: { text: string } }[])[0]!;
    expect(note.note_type).toBe('common');
    expect(note.params.text.split('\n')[0]).toBe('Анализ звонка 21.10.2026 15:05, входящий, 0:30');
    expect(note.params.text).toContain('Оценка менеджера: 7/10 — ');
    // Второй запрос модели — с текстом ошибки проверки.
    expect(llm.asked[1]).toContain('Предыдущий ответ не прошёл проверку: не соответствует схеме');
    expect(llm.asked[0]).toContain('[0:04] [говорящий 2] Здравствуйте, нужно 12');
    const j = await new JournalRepo(db).list(ACCOUNT, { limit: 10 });
    expect(j.find((e) => e.kind === CALL_ANALYSIS_KIND)).toMatchObject({ leadId: 90141, inputTokens: 2400, outputTokens: 600 });
    expect(j.find((e) => e.kind === CALL_NOTE_KIND)?.summary).toBe(`Звонок ${id}: примечание «Анализ звонка» записано в сделку 90141 (id 501)`);
    // Повторный прогон: звонок posted, ничего не берётся, второго примечания нет.
    expect((await run(stt)).picked).toBe(0);
    expect(posts).toHaveLength(1);
  });

  it('отложенный режим (догрузка): операция без ожидания, результат в следующем опросе; примечание — в контакт, если сделки нет', async () => {
    const id = await insert(2, { leadId: null, sttMode: 'deferred' });
    llm = fakeLlm([JSON.stringify(ANALYSIS)]);
    const stt = new FakeSpeechKit(1);
    const r1 = await run(stt);
    expect(r1).toMatchObject({ picked: 1, transcribed: 0, pending: 1 });
    expect(stt.polls).toBe(0); // отложенный режим: в этом опросе не ждём
    expect(stt.started[0]?.mode).toBe('deferred');
    let row = (await repo.get(ACCOUNT, id))!;
    expect([row.status, (row.transcript as { pending: PendingTranscription }).pending.operationId]).toEqual(['downloaded', 'op-1']);
    const r2 = await run(stt);
    expect(r2).toMatchObject({ picked: 1, transcribed: 1, analyzed: 1, posted: 1 });
    row = (await repo.get(ACCOUNT, id))!;
    expect([row.status, (row.transcript as CallTranscript).mode, (row.cost as { sttRub: number }).sttRub]).toEqual(['posted', 'deferred', 0.46]);
    expect(posts.at(-1)?.path).toBe('/api/v4/contacts/501/notes');
    expect(stt.started).toHaveLength(1);
  });

  it('защита от дублей: posted заполнен — не публикуем; короткий звонок — unavailable; без делового содержания — примечания нет', async () => {
    const dup = await insert(3);
    await repo.setAnalysis(dup, ANALYSIS, transcript('async'));
    await repo.setPosted(dup, { noteId: 777, entity: 'lead', entityId: 90141 }, 'analyzed');
    const short = await insert(4, { durationSec: 12 });
    const spam = await insert(5);
    llm = fakeLlm([JSON.stringify({ ...ANALYSIS, businessContent: false, summary: 'Автоответчик, разговора не было.', agreements: [], nextStep: '', managerScore: 5, managerComment: '' })]);
    const postsBefore = posts.length;
    const r = await run(new FakeSpeechKit(1));
    // Звонок с заполненным posted в выборку не попадает вовсе — второго примечания быть не может.
    expect(r).toMatchObject({ picked: 2, unavailable: 1, transcribed: 1, analyzed: 1, skipped: 1, posted: 0 });
    expect(posts).toHaveLength(postsBefore);
    expect((await repo.get(ACCOUNT, dup))).toMatchObject({ status: 'analyzed', posted: expect.objectContaining({ noteId: 777 }) });
    const s = (await repo.get(ACCOUNT, short))!;
    expect([s.status, s.error]).toEqual(['unavailable', 'звонок короче 30 с (12 с) — не расшифровывается']);
    const n = (await repo.get(ACCOUNT, spam))!;
    expect([n.status, n.posted]).toEqual(['analyzed', expect.objectContaining({ skipped: 'без делового содержания' })]);
    expect((await new JournalRepo(db).list(ACCOUNT, { limit: 5 })).find((e) => e.kind === CALL_ANALYSIS_KIND)?.summary).toContain('без делового содержания — Автоответчик');
    expect((await run(new FakeSpeechKit(1))).picked).toBe(0);
  });

  it('ошибка шага → failed, повтор через 30 мин, после 3 попыток — алерт в Telegram один раз и остановка; пустая расшифровка — unavailable', async () => {
    const id = await insert(6);
    const stt = new FakeSpeechKit(1);
    llm = fakeLlm([new Error('модель недоступна'), new Error('модель недоступна'), new Error('модель недоступна'), JSON.stringify(ANALYSIS)]);
    const r1 = await run(stt);
    expect(r1).toMatchObject({ transcribed: 1, failed: 1, alerts: 0 });
    let row = (await repo.get(ACCOUNT, id))!;
    expect([row.status, row.stage, row.attempts, row.error]).toEqual(['failed', 'analyze', 1, 'модель недоступна']);
    expect((await run(stt)).picked).toBe(0); // раньше 30 минут — не берётся
    tick(31);
    expect((await run(stt)).failed).toBe(1);
    tick(31);
    const r3 = await run(stt);
    expect(r3).toMatchObject({ failed: 1, alerts: 1 });
    row = (await repo.get(ACCOUNT, id))!;
    expect([row.status, row.attempts, row.alertedAt !== null]).toEqual(['failed', MAX_ATTEMPTS, true]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain(`звонок ${id} (`);
    expect(alerts[0]).toContain('анализ не удалась 3 раза: модель недоступна');
    tick(31);
    expect((await run(stt)).picked).toBe(0); // попытки кончились
    const errs = (await new JournalRepo(db).list(ACCOUNT, { kind: String(CALL_ERROR_KIND), limit: 10 })).filter((e) => (e.details as { callId: number }).callId === id);
    expect(errs.map((e) => e.summary.includes('повторов больше не будет'))).toEqual([true, false, false]);
    // Расшифровка пустая — речи нет: unavailable, модель не вызывается.
    const silent = await insert(7);
    expect((await run(new FakeSpeechKit(1, 'empty'))).unavailable).toBe(1);
    expect((await repo.get(ACCOUNT, silent))?.error).toContain('расшифровка пустая');
  });

  it('догрузка: оценка за N дней без записи в базу; с запуском — звонки в режиме deferred без обработки в этом же вызове', async () => {
    const T0 = Math.floor(Date.parse('2026-10-15T09:00:00Z') / 1000);
    const note = (id: number, duration: number, link = LINK(id)) => ({ id, entity_id: 501, created_by: 3, created_at: T0 + id, updated_at: T0 + id, responsible_user_id: 3, note_type: 'call_in', params: { link, duration, phone: '79099500381' } });
    const amoNotes: AmoRaw = {
      get: async (path) => {
        if (path.includes('/contacts/notes?') && path.includes('page=1')) return { _embedded: { notes: [note(1, 185), note(8, 120), note(9, 240), note(10, 5), { ...note(11, 90), params: { duration: 90 } }] } } as never;
        if (path.includes('/contacts/501?with=leads')) return { _embedded: { leads: [] } } as never;
        return null;
      },
      post: async () => null,
    };
    const before = (await repo.list(ACCOUNT, { limit: 100 })).length;
    const p = await previewCallsBackfill(core, ACCOUNT, 30, { now, amo: amoNotes });
    // Примечание 1 уже в базе, 10 — короткое, 11 — без записи: новых два (120 + 240 с = 6 мин).
    expect(p).toMatchObject({ days: 30, found: 5, newCalls: 2, newMinutes: 6, shortOrNoLink: 2 });
    expect(p.estimate.sttRub).toBeCloseTo(6 * 0.1524, 2);
    expect(p.estimate.llmUsd).toBeGreaterThan(0);
    expect(p.estimate.totalRub).toBeGreaterThan(p.estimate.sttRub);
    expect((await repo.list(ACCOUNT, { limit: 100 })).length).toBe(before);
    const r = await runCallsPoll(core, ACCOUNT, { now, sinceDays: 30, process: false, amo: amoNotes, sleep: async () => undefined });
    expect(r).toMatchObject({ inserted: 2, processed: null, unavailable: 2 });
    const rows = (await repo.list(ACCOUNT, { limit: 100 })).filter((c) => [8, 9].includes(c.noteId));
    expect(rows.map((c) => [c.sttMode, c.status])).toEqual([['deferred', 'unavailable'], ['deferred', 'unavailable']]);
  });
});
