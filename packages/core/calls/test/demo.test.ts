// RFD-AI-AGENT-CALLS-DEMO: итог по одной сделке — без --post ничего не пишет в amo и таблицы итогов (печатает реплики с
// ролями, итог и стоимость), с --post — одно примечание и сохранённый итог; повторно — дублей нет; готовые расшифровки
// не делаются заново.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsRepo, JournalRepo, SettingsRepo, widgetSettingsSchema, type Db } from '@core/db';
import type { LlmGateway, RoutedResponse } from '@core/llm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb } from '../../db/test/setup.ts';
import { CALL_DAY_KIND, runCallsDemo, type AmoRaw, type CallsDeps, type CallStt, type CallTranscript, type PendingTranscription, type SttMode } from '../src/index.ts';
import { depsOf } from './helpers.ts';

const ACC = 1;
const LEAD = 90141;
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0x0a, 0xff, 0xfb, 0x90, 0x64, 1, 2, 3]);
const NOW = new Date('2026-10-22T13:00:00Z');
const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const link = (n: number) => `https://rfdveri.megapbx.ru/api/v2/call-records/record/2026-10-22/aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}/x.mp3`;
const note = (id: number, entityId: number, type: 'call_in' | 'call_out', at: string, duration: number) => ({ id, entity_id: entityId, created_by: 3, created_at: T(at), updated_at: T(at), responsible_user_id: 3, note_type: type, params: { link: link(id), duration, phone: '79099500381' } });

const segs = (n: number) => [
  { speaker: '1', startMs: 0, endMs: 4000, text: `РФ-Двери, здравствуйте (${n}).` },
  { speaker: '2', startMs: 4500, endMs: 15000, text: 'Нужны две входные двери, замер на неделе.' },
];
class FakeSpeechKit implements CallStt {
  readonly name = 'speechkit' as const;
  started = 0;
  async start(_b: Uint8Array, _m: string, o: { mode: SttMode }) {
    this.started++;
    return { pending: { provider: 'speechkit' as const, mode: o.mode, operationId: `op-${this.started}`, startedAt: NOW.toISOString(), polls: 0 } };
  }
  async poll(p: PendingTranscription): Promise<CallTranscript> {
    return { provider: 'speechkit', mode: p.mode, model: 'general', text: segs(1).map((s) => s.text).join('\n'), segments: segs(1), durationSec: 15, speakers: 2, cost: { rub: 0.61, usd: 0 }, startedAt: NOW.toISOString(), finishedAt: NOW.toISOString() };
  }
}

function fakeLlm() {
  let calls = 0;
  const llm: LlmGateway = {
    async chat(req, r) {
      calls++;
      const ids = [...String(req.messages[0]?.content ?? '').matchAll(/<call id="(\d+)"/g)].map((m) => Number(m[1]));
      const text = JSON.stringify({ summary: 'Клиенту нужны две входные двери, замер на неделе.', agreements: ['Замер в четверг'], nextStep: 'Менеджер согласует время замера.', managerScore: 7, managerComment: 'Потребность выявлена.', callsCount: ids.length, totalDuration: 0, callIds: ids, speakers: ids.flatMap((id) => [{ callId: id, tag: '1', role: 'manager' }, { callId: id, tag: '2', role: 'client' }]) });
      return { text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 1000, outputTokens: 300, cachedInputTokens: 0, cacheWriteTokens: 0 }, provider: r.primary.provider, model: r.primary.model, assistantMessage: { role: 'assistant', content: text }, latencyMs: 1, fallbackUsed: false, requested: r.primary, attempts: [] } as unknown as RoutedResponse;
    },
    providers: async () => ['openai'],
    provider: async () => null,
  };
  return { llm, calls: () => calls };
}

describe('итог по одной сделке — calls-demo (БД розницы, миграции с нуля)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let deps: CallsDeps;
  const posts: { path: string; text: string }[] = [];
  const llm = fakeLlm();
  const stt = new FakeSpeechKit();
  const lines: string[] = [];
  const amo: AmoRaw = {
    get: async (path) => {
      if (path === `/api/v4/leads/${LEAD}?with=contacts`) return { id: LEAD, _embedded: { contacts: [{ id: 501 }] } } as never;
      if (path.startsWith(`/api/v4/leads/${LEAD}/notes?`) && path.includes('page=1')) return { _embedded: { notes: [note(1, LEAD, 'call_out', '2026-10-22T08:00:00Z', 185)] } } as never;
      if (path.startsWith('/api/v4/contacts/501/notes?') && path.includes('page=1')) return { _embedded: { notes: [note(2, 501, 'call_in', '2026-10-22T10:30:00Z', 120), note(3, 501, 'call_in', '2026-10-21T10:30:00Z', 200), note(4, 501, 'call_in', '2026-10-22T11:00:00Z', 10)] } } as never;
      return null;
    },
    post: async (path, body) => {
      posts.push({ path, text: (body as { params: { text: string } }[])[0]?.params.text ?? '' });
      return { _embedded: { notes: [{ id: 900 + posts.length }] } } as never;
    },
  };
  const fetchRecords = (async (input: string | URL | Request) => (String(input).includes('/call-records/') ? new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } }) : new Response('нет', { status: 404 }))) as typeof fetch;
  const run = (post: boolean, date?: string) => runCallsDemo(deps, { accountId: ACC, leadId: LEAD, post, ...(date ? { date } : {}), now: () => NOW, sleep: async () => undefined, amo, stt: () => stt, out: (l) => lines.push(l) });

  beforeAll(async () => {
    ({ db, drop } = await freshDb());
    await new AccountsRepo(db).upsertInstalled({ id: ACC, subdomain: 'acc', accountDomain: 'acc.amocrm.ru' });
    await new SettingsRepo(db).save(ACC, 1, widgetSettingsSchema.parse({}));
    deps = depsOf(db, fetchRecords, mkdtempSync(join(tmpdir(), 'calls-demo-')), { llmFor: async () => ({ llm: llm.llm, route: { primary: { provider: 'openai', model: 'gpt-5.5' }, fallback: null }, pricing: {}, usdRubRate: 90 }) });
  });
  afterAll(() => drop());

  it('без --post: день последнего звонка, скачивание и расшифровка, реплики с ролями, итог и стоимость; в amo и итоги — ничего', async () => {
    const r = await run(false);
    // День последнего звонка — 22.10: звонок сделки (185 с) и звонок контакта (120 с); 21.10 — не тот день, 10 с — короткий.
    expect(r).toMatchObject({ day: '2026-10-22', calls: 2, transcribed: 2, notReady: 0, alreadySummarized: 0, posted: null });
    expect(r.noteText?.split('\n')[0]).toBe('Итог разговоров за 22.10.2026: 2 звонка, общая длительность 5:05');
    expect(r.cost).toMatchObject({ sttRub: 1.22, llmUsd: expect.any(Number) });
    expect(posts).toHaveLength(0);
    expect(await deps.days.list(ACC)).toHaveLength(0);
    expect(stt.started).toBe(2);
    expect(llm.calls()).toBe(1);
    expect(lines.some((l) => l.startsWith('  [0:00] Менеджер: РФ-Двери'))).toBe(true);
    expect(lines.some((l) => l.includes('Клиент: Нужны две входные двери'))).toBe(true);
    expect(lines.at(-1)).toBe('\nБез --post: в amoCRM и таблицы итогов ничего не записано.');
    const rows = await deps.calls.list(ACC);
    expect(rows.map((c) => [c.leadId, c.status, c.daySummaryId])).toEqual([[LEAD, 'transcribed', null], [LEAD, 'transcribed', null]]);
  });

  it('с --post: готовые расшифровки не делаются заново, одно примечание в сделку, итог сохранён; повторно — дублей нет', async () => {
    const r = await run(true);
    expect(r.posted).toMatchObject({ noteId: 901 });
    expect(stt.started).toBe(2); // расшифровки взяты из базы
    expect(llm.calls()).toBe(2);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe(`/api/v4/leads/${LEAD}/notes`);
    expect(posts[0]!.text).toBe(r.noteText);
    const days = await deps.days.list(ACC);
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ leadId: LEAD, day: '2026-10-22', noteId: 901, callsCount: 2 });
    expect((await deps.calls.list(ACC)).map((c) => c.status)).toEqual(['posted', 'posted']);
    expect((await new JournalRepo(db).list(ACC, { limit: 5 })).find((e) => e.kind === CALL_DAY_KIND)).toMatchObject({ leadId: LEAD });
    const again = await run(true);
    expect(again).toMatchObject({ alreadySummarized: 2, posted: null, noteText: null });
    expect(posts).toHaveLength(1);
    expect(llm.calls()).toBe(2);
    expect(lines.some((l) => l.includes(`Итог ${days[0]!.id} за 22.10.2026 уже есть (примечание 901)`))).toBe(true);
    // Другой день по --date: звонок 21.10 (200 с) — новый итог за 21.10.
    const prev = await run(true, '2026-10-21');
    expect(prev).toMatchObject({ day: '2026-10-21', calls: 1, transcribed: 1 });
    expect(posts.at(-1)?.text.split('\n')[0]).toBe('Итог разговоров за 21.10.2026: 1 звонок, общая длительность 3:20');
  });
});
