// RFD-AI-AGENT-REFUSAL-ANALYSIS: переход сделки в «Отказ» (событие lead_status_changed) → одно примечание-анализ за всю жизнь
// сделки и строки в задачу администратора; повтор события — без дубля; повторный уход в «Отказ» после возврата — новый анализ;
// другой этап / воронка — ничего; задачи нет — только примечание; сделка без общения — «общения в данных агента нет»;
// показ calls-demo --refusal без --post ничего не пишет, с --post — примечание один раз.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AmoApiClient } from '@core/amo';
import { AccountsRepo, JournalRepo, SettingsRepo, widgetSettingsSchema, type Db } from '@core/db';
import type { LlmGateway, RoutedResponse } from '@core/llm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb } from '../../db/test/setup.ts';
import { fetchStatusEvents, findAdminTask, formatRefusalNote, REFUSAL_KIND, REFUSAL_SYNC_ENTITY, runRefusalDemo, runRefusalPoll, type AmoRaw, type CallsDeps, type CallTranscript, type LocalMessage } from '../src/index.ts';
import { depsOf } from './helpers.ts';

const ACC = 1;
const PIPE = 1873498;
const T0 = new Date('2026-10-23T09:00:00Z'); // переход в «Отказ», 12:00 МСК
const NOW = new Date('2026-10-23T09:06:00Z'); // опрос через 6 минут
const unix = (d: Date) => Math.floor(d.getTime() / 1000);
const at = (iso: string) => new Date(iso);

const state = {
  events: [] as { id: string; entity_id: number; created_at: number; after: { id: number; pipeline_id: number }; before?: { id: number; pipeline_id: number } }[],
  leads: {} as Record<number, { created_at: number; closed_at: number | null; status_id: number; pipeline_id: number }>,
  tasks: {} as Record<number, { id: number; text: string; created_at: number; responsible_user_id: number }[]>,
  notes: {} as Record<number, { id: number; created_by: number; created_at: number; params: { text: string } }[]>,
  wz: {} as Record<number, LocalMessage[]>,
  posts: [] as { path: string; text: string }[],
  patches: [] as { path: string; body: unknown }[],
};

const amo: AmoRaw = {
  get: async (path) => {
    if (path.startsWith('/api/v4/events?filter[type]=lead_status_changed')) {
      const from = Number(/from\]=(\d+)/.exec(path)?.[1] ?? 0);
      const to = Number(/to\]=(\d+)/.exec(path)?.[1] ?? 0);
      return { _embedded: { events: state.events.filter((e) => e.created_at >= from && e.created_at <= to).map((e) => ({ id: e.id, type: 'lead_status_changed', entity_id: e.entity_id, entity_type: 'lead', created_by: 5, created_at: e.created_at, value_after: [{ lead_status: e.after }], value_before: e.before ? [{ lead_status: e.before }] : [] })) } } as never;
    }
    let m = /^\/api\/v4\/leads\/(\d+)$/.exec(path);
    if (m) {
      const l = state.leads[Number(m[1])];
      return l ? ({ id: Number(m[1]), ...l, responsible_user_id: 5 } as never) : null;
    }
    m = /^\/api\/v4\/tasks\?filter\[entity_type\]=leads&filter\[entity_id\]=(\d+)/.exec(path);
    if (m) return { _embedded: { tasks: (state.tasks[Number(m[1])] ?? []).map((t) => ({ ...t, is_completed: false, entity_id: Number(m![1]), entity_type: 'leads' })) } } as never;
    m = /^\/api\/v4\/leads\/(\d+)\/notes\?filter\[note_type\]\[\]=common/.exec(path);
    if (m) return { _embedded: { notes: (state.notes[Number(m[1])] ?? []).map((n) => ({ ...n, note_type: 'common', entity_id: Number(m![1]) })) } } as never;
    return null;
  },
  post: async (path, body) => {
    state.posts.push({ path, text: (body as { params: { text: string } }[])[0]?.params.text ?? '' });
    return { _embedded: { notes: [{ id: 700 + state.posts.length }] } } as never;
  },
  patch: async (path, body) => {
    state.patches.push({ path, body });
    const id = Number(path.split('/').pop());
    for (const list of Object.values(state.tasks)) for (const t of list) if (t.id === id) t.text = (body as { text: string }).text;
    return { id } as never;
  },
};
const client = {
  getLead: async (id: number) => ({ id, _embedded: { contacts: [{ id: 501 }] } }),
  getContact: async () => ({ id: 501, name: 'Иван', custom_fields_values: [{ field_id: 1, field_code: 'PHONE', values: [{ value: '+7 909 950-03-81' }] }] }),
  leadMailNotes: async () => [],
} as unknown as AmoApiClient;

const ANALYSIS = { summary: 'Клиент искал три межкомнатные двери, получил расчёт 75 540 ₽, после КП несколько дней не отвечал, затем сказал, что выбрал другого поставщика.', refusalReason: 'Дорого — у конкурентов дешевле на 15 %', lostAt: 'После отправки КП: менеджер не напомнил о себе четыре дня', managerScore: 6, managerComment: 'Потребность и размеры выявлены быстро, КП отправлено в день запроса; не было звонка после КП и обсуждения скидки.', couldBeSaved: 'Да: позвонить, предложить вариант дешевле (эмаль вместо шпона) или скидку на монтаж.' };

function fakeLlm() {
  const asked: string[] = [];
  const llm: LlmGateway = {
    async chat(req, r) {
      const content = String(req.messages[0]?.content ?? '');
      asked.push(content);
      const callIds = [...new Set([...content.matchAll(/\[call:(\d+)\]/g)].map((m) => Number(m[1])))];
      const text = JSON.stringify({ ...ANALYSIS, speakers: callIds.flatMap((id) => [{ callId: id, tag: '1', role: 'manager' }, { callId: id, tag: '2', role: 'client' }]) });
      return { text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 2500, outputTokens: 500, cachedInputTokens: 0, cacheWriteTokens: 0 }, provider: r.primary.provider, model: r.primary.model, assistantMessage: { role: 'assistant', content: text }, latencyMs: 1, fallbackUsed: false, requested: r.primary, attempts: [] } as unknown as RoutedResponse;
    },
    providers: async () => ['openai'],
    provider: async () => null,
  };
  return { llm, asked };
}

const transcript: CallTranscript = { provider: 'speechkit', mode: 'async', model: 'general', text: 'Компания РФ-Двери, здравствуйте.\nНужны три двери, посчитайте.', segments: [{ speaker: '1', startMs: 0, endMs: 3000, text: 'Компания РФ-Двери, здравствуйте.' }, { speaker: '2', startMs: 3500, endMs: 9000, text: 'Нужны три двери, посчитайте.' }], durationSec: 185, speakers: 2, cost: { rub: 1.87, usd: 0 }, startedAt: T0.toISOString(), finishedAt: T0.toISOString() };

describe('анализ сделки при переносе в «Отказ» (БД розницы, миграции с нуля)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let deps: CallsDeps;
  const llm = fakeLlm();
  const poll = (now = NOW) => runRefusalPoll(deps, ACC, { now: () => now, sleep: async () => undefined, amo, client });
  const lead = (id: number, createdAt: Date, status = 143) => {
    state.leads[id] = { created_at: unix(createdAt), closed_at: status === 143 ? unix(T0) : null, status_id: status, pipeline_id: PIPE };
  };

  beforeAll(async () => {
    ({ db, drop } = await freshDb());
    await new AccountsRepo(db).upsertInstalled({ id: ACC, subdomain: 'acc', accountDomain: 'acc.amocrm.ru' });
    await new SettingsRepo(db).save(ACC, 1, widgetSettingsSchema.parse({ calls: { daySummaryTimeoutSec: 0 }, refusal: { adminUserIds: [7] } }));
    deps = depsOf(db, (async () => new Response('нет', { status: 404 })) as typeof fetch, mkdtempSync(join(tmpdir(), 'refusal-')), {
      llmFor: async () => ({ llm: llm.llm, route: { primary: { provider: 'openai', model: 'gpt-5.5' }, fallback: null }, pricing: {}, usdRubRate: 90 }),
      sources: { wazzup: async (_a, leadId, _p, since, until) => (state.wz[leadId] ?? []).filter((m) => m.at >= since && m.at < until), dialog: async () => [], activeLeads: async () => [] },
    });
    // Сделка 1001: создана 20.10, переписка три дня, звонок с расшифровкой, переход в «Отказ» 23.10 12:00, задача автоматизации через 5 минут.
    lead(1001, at('2026-10-20T08:00:00Z'));
    state.wz[1001] = [
      { id: 'a1', direction: 'in', author: 'client', text: 'Здравствуйте, нужны три межкомнатные двери 800×2000', at: at('2026-10-20T08:10:00Z'), channel: 'whatsapp' },
      { id: 'a2', direction: 'out', author: 'manager', text: 'Добрый день! Отправляю расчёт: 75 540 ₽ за три двери с монтажом', at: at('2026-10-20T09:00:00Z'), channel: 'whatsapp', file: { name: 'КП_Иванов.pdf', mime: 'application/pdf', text: 'Коммерческое предложение № 1187: 3 двери «Классика 3» по 19 680 ₽, монтаж 3 × 5 500 ₽, итого 75 540 ₽.', status: 'done', error: null } },
      { id: 'a3', direction: 'in', author: 'client', text: 'Спасибо, подумаю', at: at('2026-10-21T10:00:00Z'), channel: 'whatsapp' },
      { id: 'a4', direction: 'in', author: 'client', text: 'Мы выбрали другого поставщика, у них дешевле на 15 %', at: at('2026-10-22T15:00:00Z'), channel: 'whatsapp' },
    ];
    state.notes[1001] = [{ id: 61, created_by: 5, created_at: unix(at('2026-10-22T16:00:00Z')), params: { text: 'Клиент ушёл к конкурентам' } }];
    const [callId] = await deps.calls.insertNew(ACC, [{ noteId: 9001, entity: 'lead', entityId: 1001, direction: 'out', link: 'https://rfdveri.megapbx.ru/api/v2/call-records/record/2026-10-20/aaaaaaaa-0000-0000-0000-000000009001/x.mp3', recordKey: 'k9001', phone: '79099500381', durationSec: 185, callStatus: 4, calledAt: at('2026-10-20T11:00:00Z'), noteUpdatedAt: at('2026-10-20T11:00:00Z'), managerId: 5, leadId: 1001 }], 'async');
    await deps.calls.setTranscript(callId as number, transcript, 'transcribed');
    await deps.calls.addCost(callId as number, { sttRub: 1.87, sttUsd: 0 });
    state.tasks[1001] = [{ id: 3001, text: 'Сделка перенесена в «Отказ»: проверить причину', created_at: unix(at('2026-10-23T09:05:00Z')), responsible_user_id: 7 }];
    state.events.push({ id: 'e1', entity_id: 1001, created_at: unix(T0), after: { id: 143, pipeline_id: PIPE }, before: { id: 28643038, pipeline_id: PIPE } });
  });
  afterAll(() => drop());

  it('переход в 143 воронки «Двери» → лента за всю жизнь сделки, одно примечание, строки в задаче администратора, журнал', async () => {
    const r = await poll();
    expect(r).toMatchObject({ enabled: true, events: 1, matched: 1, analyzed: 1, notes: 1, tasks: 1, noData: 0, duplicates: 0, errors: 0 });
    expect(llm.asked).toHaveLength(1);
    const prompt = llm.asked[0] ?? '';
    expect(prompt).toContain('Общение за 20.10.2026 — 23.10.2026: звонков 1 (3:05), сообщений 4, писем 0, примечаний менеджера 1');
    expect(prompt).toContain('[wz:a1]: Здравствуйте, нужны три межкомнатные двери'); // с created_at сделки, не только за день
    expect(prompt).toContain('Файл КП_Иванов.pdf: Коммерческое предложение № 1187');
    expect(prompt).toContain('[call:');
    expect(prompt).toContain('[note:61]: Клиент ушёл к конкурентам');
    expect(state.posts).toHaveLength(1);
    expect(state.posts[0]).toEqual({
      path: '/api/v4/leads/1001/notes',
      text: ['Анализ сделки при отказе (23.10.2026): 1 звонок (3:05), 4 сообщения, 0 писем, 1 примечание за весь период', `История: ${ANALYSIS.summary}`, `Причина отказа: ${ANALYSIS.refusalReason}`, `Где потеряли клиента: ${ANALYSIS.lostAt}`, `Можно ли вернуть: ${ANALYSIS.couldBeSaved}`, `Оценка менеджера: 6/10 — ${ANALYSIS.managerComment}`].join('\n'),
    });
    expect(state.patches).toHaveLength(1);
    expect(state.patches[0]).toEqual({ path: '/api/v4/tasks/3001', body: { text: `Сделка перенесена в «Отказ»: проверить причину\n\nПричина отказа: ${ANALYSIS.refusalReason}\nГде потеряли клиента: ${ANALYSIS.lostAt}\nАнализ — в примечании сделки.` } });
    const rows = await deps.refusals.forLead(ACC, 1001);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventId: 'e1', statusId: 143, pipelineId: PIPE, noteId: 701, taskId: 3001, taskUpdated: true, counts: { calls: 1, messages: 4, emails: 0, notes: 1 }, error: null });
    expect(rows[0]?.analysis?.refusalReason).toBe(ANALYSIS.refusalReason);
    // Роли говорящих из ответа модели записаны в расшифровку.
    const call = (await deps.calls.list(ACC, { leadId: 1001 }))[0];
    expect((call?.transcript as CallTranscript).segments.map((s) => s.role)).toEqual(['manager', 'client']);
    expect((await deps.calls.getSync(ACC, REFUSAL_SYNC_ENTITY))?.lastUpdatedAt).toEqual(NOW);
    const log = await new JournalRepo(db).list(ACC, { kind: REFUSAL_KIND });
    expect(log.find((e) => e.leadId === 1001)?.summary).toContain('Анализ при отказе (23.10.2026): Дорого — у конкурентов дешевле на 15 %; оценка 6/10; примечание 701; задача 3001 дополнена');
  });

  it('повторное событие того же перехода → без дубля; повторный уход в «Отказ» после возврата — новое событие и новый анализ', async () => {
    // Отметка опроса отстала (перезапуск воркера, сбой после чтения событий) — e1 читается второй раз: строка уже есть, дубля нет.
    await deps.calls.setSync(ACC, REFUSAL_SYNC_ENTITY, { lastUpdatedAt: at('2026-10-23T08:59:00Z'), lastError: null });
    const r = await poll(at('2026-10-23T09:11:00Z'));
    expect(r).toMatchObject({ events: 1, matched: 1, analyzed: 0, duplicates: 1, errors: 0 });
    expect(state.posts).toHaveLength(1);
    expect(llm.asked).toHaveLength(1);
    state.events.push({ id: 'e2', entity_id: 1001, created_at: unix(at('2026-10-23T11:00:00Z')), after: { id: 28643038, pipeline_id: PIPE }, before: { id: 143, pipeline_id: PIPE } }); // вернули в работу
    state.events.push({ id: 'e3', entity_id: 1001, created_at: unix(at('2026-10-23T11:30:00Z')), after: { id: 143, pipeline_id: PIPE }, before: { id: 28643038, pipeline_id: PIPE } }); // снова «Отказ»
    state.tasks[1001] = [];
    const r2 = await poll(at('2026-10-23T11:33:00Z'));
    expect(r2).toMatchObject({ events: 2, matched: 1, analyzed: 1, notes: 1, tasks: 0, duplicates: 0 });
    expect(state.posts).toHaveLength(2);
    expect(state.posts[1]?.text.split('\n')[0]).toBe('Анализ сделки при отказе (23.10.2026): 1 звонок (3:05), 4 сообщения, 0 писем, 1 примечание за весь период');
    expect((await deps.refusals.forLead(ACC, 1001)).map((x) => [x.eventId, x.taskId])).toEqual([['e1', 3001], ['e3', null]]);
  });

  it('переход в другой этап или в другой воронке → ничего', async () => {
    lead(1005, at('2026-10-20T08:00:00Z'), 142);
    state.leads[1006] = { created_at: unix(at('2026-10-20T08:00:00Z')), closed_at: unix(T0), status_id: 143, pipeline_id: 2 };
    state.events.push({ id: 'e5', entity_id: 1005, created_at: unix(at('2026-10-23T12:00:00Z')), after: { id: 142, pipeline_id: PIPE } });
    state.events.push({ id: 'e6', entity_id: 1006, created_at: unix(at('2026-10-23T12:01:00Z')), after: { id: 143, pipeline_id: 2 } });
    const before = state.posts.length;
    const r = await poll(at('2026-10-23T12:05:00Z'));
    expect(r).toMatchObject({ events: 2, matched: 0, analyzed: 0 });
    expect(state.posts).toHaveLength(before);
    expect(await deps.refusals.list(ACC)).toHaveLength(2);
  });

  it('задачи администратора нет (или она не в окне / не того ответственного) → только примечание, в журнале отметка; adminUserIds пустой — любая новая задача', async () => {
    lead(1002, at('2026-10-15T08:00:00Z'));
    state.wz[1002] = [{ id: 'b1', direction: 'in', author: 'client', text: 'Нужна входная дверь', at: at('2026-10-15T09:00:00Z'), channel: 'telegram' }, { id: 'b2', direction: 'out', author: 'manager', text: 'Подберём, какой размер?', at: at('2026-10-15T09:20:00Z'), channel: 'telegram' }];
    state.tasks[1002] = [
      { id: 3101, text: 'Старая задача менеджера', created_at: unix(at('2026-10-16T09:00:00Z')), responsible_user_id: 7 }, // не в окне
      { id: 3102, text: 'Задача другого сотрудника', created_at: unix(at('2026-10-23T13:02:00Z')), responsible_user_id: 9 }, // не администратор
    ];
    state.events.push({ id: 'e7', entity_id: 1002, created_at: unix(at('2026-10-23T13:00:00Z')), after: { id: 143, pipeline_id: PIPE } });
    const before = { posts: state.posts.length, patches: state.patches.length };
    const r = await poll(at('2026-10-23T13:05:00Z'));
    expect(r).toMatchObject({ matched: 1, analyzed: 1, notes: 1, tasks: 0 });
    expect(state.posts).toHaveLength(before.posts + 1);
    expect(state.patches).toHaveLength(before.patches);
    expect((await deps.refusals.forLead(ACC, 1002))[0]).toMatchObject({ taskId: null, taskUpdated: false });
    const log = await new JournalRepo(db).list(ACC, { kind: REFUSAL_KIND, leadId: 1002 });
    expect(log[0]?.summary).toContain('задача администратора не найдена — только примечание');
    // Без adminUserIds подошла бы задача 3102 (новая, в окне); 3101 — вне окна.
    const s = widgetSettingsSchema.parse({}).refusal;
    expect((await findAdminTask(amo, 1002, at('2026-10-23T13:00:00Z'), s))?.id).toBe(3102);
    expect(await findAdminTask(amo, 1002, at('2026-10-23T13:00:00Z'), { ...s, adminUserIds: [7] })).toBeNull();
  });

  it('сделка без общения в данных агента → примечание «общения в данных агента нет», модель не вызывается', async () => {
    lead(1003, at('2026-10-01T08:00:00Z'));
    state.tasks[1003] = [{ id: 3201, text: 'Отказ: разобраться', created_at: unix(at('2026-10-23T14:01:00Z')), responsible_user_id: 7 }];
    state.events.push({ id: 'e8', entity_id: 1003, created_at: unix(at('2026-10-23T14:00:00Z')), after: { id: 143, pipeline_id: PIPE } });
    const asked = llm.asked.length;
    const r = await poll(at('2026-10-23T14:05:00Z'));
    expect(r).toMatchObject({ matched: 1, analyzed: 1, notes: 1, noData: 1, tasks: 1 });
    expect(llm.asked).toHaveLength(asked);
    expect(state.posts.at(-1)?.text).toBe('Анализ сделки при отказе (23.10.2026): общения в данных агента нет — звонков с записью, сообщений, писем и примечаний по сделке не найдено.');
    expect(state.tasks[1003]?.[0]?.text).toBe('Отказ: разобраться\n\nОбщения в данных агента нет. Анализ — в примечании сделки.');
    expect((await deps.refusals.forLead(ACC, 1003))[0]).toMatchObject({ analysis: null, noteId: expect.any(Number), taskUpdated: true });
  });

  it('показ calls-demo --refusal: без --post только вывод; с --post — примечание один раз на переход', async () => {
    lead(1004, at('2026-10-18T08:00:00Z'));
    state.wz[1004] = [{ id: 'd1', direction: 'in', author: 'client', text: 'Сколько стоит дверь Турин 1?', at: at('2026-10-18T09:00:00Z'), channel: 'whatsapp' }, { id: 'd2', direction: 'out', author: 'manager', text: '14 900 ₽', at: at('2026-10-18T09:05:00Z'), channel: 'whatsapp' }];
    const lines: string[] = [];
    const before = { posts: state.posts.length, rows: (await deps.refusals.list(ACC)).length, asked: llm.asked.length };
    const dry = await runRefusalDemo(deps, { accountId: ACC, leadId: 1004, now: () => at('2026-10-23T15:00:00Z'), sleep: async () => undefined, amo, client, out: (l) => lines.push(l) });
    expect(dry).toMatchObject({ leadId: 1004, changedAt: T0, items: 2, used: 2, calls: 0, posted: null, already: false });
    expect(dry.noteText.split('\n')[0]).toBe('Анализ сделки при отказе (23.10.2026): 0 звонков (0:00), 2 сообщения, 0 писем за весь период');
    expect(lines.some((l) => l.startsWith('12:00 WhatsApp Клиент [wz:d1]: Сколько стоит дверь Турин 1?'))).toBe(true);
    expect(lines.at(-1)).toBe('\nБез --post: в amoCRM и refusal_analyses ничего не записано.');
    expect(state.posts).toHaveLength(before.posts);
    expect(await deps.refusals.list(ACC)).toHaveLength(before.rows);
    const posted = await runRefusalDemo(deps, { accountId: ACC, leadId: 1004, post: true, now: () => at('2026-10-23T15:01:00Z'), sleep: async () => undefined, amo, client, out: (l) => lines.push(l) });
    expect(posted.posted).toMatchObject({ noteId: expect.any(Number), taskId: null, taskUpdated: false });
    expect(state.posts).toHaveLength(before.posts + 1);
    expect(state.posts.at(-1)?.path).toBe('/api/v4/leads/1004/notes');
    const again = await runRefusalDemo(deps, { accountId: ACC, leadId: 1004, post: true, now: () => at('2026-10-23T15:02:00Z'), sleep: async () => undefined, amo, client, out: (l) => lines.push(l) });
    expect(again).toMatchObject({ already: true, posted: null });
    expect(state.posts).toHaveLength(before.posts + 1);
    expect(llm.asked.length - before.asked).toBe(3); // каждый показ считает заново; записи — одна
  });

  it('разбор событий amo и формат примечания без общения', async () => {
    const events = await fetchStatusEvents(amo, at('2026-10-23T08:00:00Z'), at('2026-10-23T16:00:00Z'));
    expect(events.map((e) => [e.id, e.leadId, e.statusId, e.pipelineId, e.beforeStatusId])).toEqual([
      ['e1', 1001, 143, PIPE, 28643038],
      ['e2', 1001, 28643038, PIPE, 143],
      ['e3', 1001, 143, PIPE, 28643038],
      ['e5', 1005, 142, PIPE, null],
      ['e6', 1006, 143, 2, null],
      ['e7', 1002, 143, PIPE, null],
      ['e8', 1003, 143, PIPE, null],
    ]);
    expect(formatRefusalNote(T0, null, { calls: 0, messages: 0, emails: 0, notes: 0, totalCallDuration: 0 })).toContain('общения в данных агента нет');
  });
});
