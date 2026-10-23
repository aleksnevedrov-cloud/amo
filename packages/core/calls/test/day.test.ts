// RFD-AI-AGENT-CALLS-DAY-FULL: итог дня по всему общению — звонки + Wazzup + чаты amo + диалог агента + примечания менеджеров
// + почта одной лентой; сделка только с перепиской → итог есть; только сообщения агента → итога нет; дубль Wazzup / чат amo
// и письмо amo / IMAP — один раз; примечания агента не попали; обрезка длинного входа; повтор без дублей; другая воронка и
// этап 142 не обрабатываются; нерасшифрованный звонок уходит в следующий день; догрузка — итоги по дням; ошибки и повторы.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AmoApiClient } from '@core/amo';
import { AccountsRepo, JournalRepo, SettingsRepo, widgetSettingsSchema, type Db } from '@core/db';
import type { LlmGateway, RoutedResponse } from '@core/llm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb } from '../../db/test/setup.ts';
import { CALL_DAY_KIND, CALL_DAY_RUN_KIND, daySummaryDue, formatDayNote, MAX_ATTEMPTS, previewCallsBackfill, runCallsPoll, runDaySummary, type AmoRaw, type CallsDeps, type CallStt, type CallTranscript, type LocalMailFile, type LocalMessage, type PendingTranscription, type SttMode } from '../src/index.ts';
import { depsOf } from './helpers.ts';

const ACC = 1;
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0x0a, 0xff, 0xfb, 0x90, 0x64, 1, 2, 3]);
const NOW = new Date('2026-10-22T13:00:00Z'); // 16:00 МСК, итог за 22.10.2026
const at = (iso: string) => new Date(iso);
const msk = (hhmm: string, day = '2026-10-22') => new Date(`${day}T${hhmm}:00+03:00`);

const segs = (n: number) => [
  { speaker: '1', startMs: 0, endMs: 4000, text: `Компания РФ-Двери, здравствуйте (${n}).` },
  { speaker: '2', startMs: 4500, endMs: 15000, text: 'Нужны три межкомнатные двери, замер на неделе.' },
];
const transcript = (n: number, mode: SttMode = 'async'): CallTranscript => ({ provider: 'speechkit', mode, model: mode === 'deferred' ? 'deferred-general' : 'general', text: segs(n).map((s) => s.text).join('\n'), segments: segs(n), durationSec: 15, speakers: 2, cost: { rub: 0.61, usd: 0 }, startedAt: NOW.toISOString(), finishedAt: NOW.toISOString() });

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

/** Мок модели: id записей ленты — из подсказки ([call:1], [wz:a] …); exclude — без делового содержания; очередь ответов / ошибок. */
function fakeLlm(opts: { exclude?: string[]; first?: (string | Error)[] } = {}) {
  const asked: string[] = [];
  const queue = [...(opts.first ?? [])];
  const llm: LlmGateway = {
    async chat(req, r) {
      const content = String(req.messages[0]?.content ?? '');
      asked.push(content);
      const q = queue.shift();
      if (q instanceof Error) throw q;
      const ids = [...new Set([...content.matchAll(/\[((?:call|wz|chat|agent|note|mail|chatev):[^\]\s]+)\]/g)].map((m) => m[1] as string))];
      const business = ids.filter((id) => !id.startsWith('agent:') && !(opts.exclude ?? []).includes(id));
      const callIds = ids.filter((id) => id.startsWith('call:')).map((id) => Number(id.slice(5)));
      const text = q ?? JSON.stringify({ summary: business.length ? `Клиенту нужны три межкомнатные двери, замер на неделе (записей ${business.length}).` : 'Автоответчик, разговора не было.', agreements: business.length ? ['Замер в четверг 23.10', 'Менеджер пришлёт расчёт после замера'] : [], nextStep: business.length ? 'Менеджер согласует время замера.' : '', managerScore: business.length ? 8 : 5, managerComment: business.length ? 'Потребность и сроки выявлены, бюджет не уточнил.' : '', counts: { calls: 0, messages: 0, emails: 0, notes: 0 }, totalCallDuration: 0, sourceIds: business, speakers: callIds.flatMap((id) => [{ callId: id, tag: '1', role: 'manager' }, { callId: id, tag: '2', role: 'client' }]) });
      return { text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 1500, outputTokens: 400, cachedInputTokens: 0, cacheWriteTokens: 0 }, provider: r.primary.provider, model: r.primary.model, assistantMessage: { role: 'assistant', content: text }, latencyMs: 1, fallbackUsed: false, requested: r.primary, attempts: [] } as unknown as RoutedResponse;
    },
    providers: async () => ['openai'],
    provider: async () => null,
  };
  return { llm, asked };
}

const LEADS: Record<number, { status_id: number; pipeline_id: number }> = { 90141: { status_id: 28643029, pipeline_id: 1873498 }, 90142: { status_id: 28643038, pipeline_id: 1873498 }, 90143: { status_id: 28643038, pipeline_id: 1873498 }, 90144: { status_id: 28643038, pipeline_id: 1873498 }, 90145: { status_id: 28643038, pipeline_id: 1873498 }, 80000: { status_id: 11, pipeline_id: 2 }, 70000: { status_id: 142, pipeline_id: 1873498 } };

/** Источники по сделкам: Wazzup, диалог, примечания (сделки и контакта), письма карточки, события чатов; меняются по сценариям. */
const state = {
  wz: {} as Record<number, LocalMessage[]>,
  dlg: {} as Record<number, LocalMessage[]>,
  notes: {} as Record<number, { id: number; created_by: number; created_at: number; params: { text: string } }[]>,
  cnotes: [] as { id: number; created_by: number; created_at: number; params: { text: string } }[],
  mail: {} as Record<number, { id: number; createdAt: Date; income: boolean; subject: string; text: string; from: string; to: string; attachments: string[] }[]>,
  events: {} as Record<number, { id: string; created_by: number; created_at: number; type: string }[]>,
  mailFiles: {} as Record<number, LocalMailFile[]>,
  active: [] as number[],
  posts: [] as { path: string; text: string }[],
};
const unix = (d: Date) => Math.floor(d.getTime() / 1000);

describe('итог дня по всему общению на БД розницы (миграции с нуля)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let filesRoot: string;
  let deps: CallsDeps;
  let llm = fakeLlm();
  const amo: AmoRaw = {
    get: async (path) => {
      if (path.includes('/api/v4/leads?filter')) {
        const ids = [...path.matchAll(/filter\[id\]\[\]=(\d+)/g)].map((m) => Number(m[1]));
        return { _embedded: { leads: ids.filter((id) => LEADS[id]).map((id) => ({ id, ...LEADS[id] })) } } as never;
      }
      let m = /^\/api\/v4\/leads\/(\d+)\/notes\?filter\[note_type\]\[\]=common/.exec(path);
      if (m) return { _embedded: { notes: (state.notes[Number(m[1])] ?? []).map((n) => ({ ...n, note_type: 'common', entity_id: Number(m![1]) })) } } as never;
      m = /^\/api\/v4\/contacts\/(\d+)\/notes\?filter\[note_type\]\[\]=common/.exec(path);
      if (m) return { _embedded: { notes: state.cnotes.map((n) => ({ ...n, note_type: 'common', entity_id: 501 })) } } as never;
      m = /^\/api\/v4\/events\?filter\[entity\]=lead&filter\[entity_id\]=(\d+)/.exec(path);
      if (m) return { _embedded: { events: state.events[Number(m[1])] ?? [] } } as never;
      if (path.startsWith('/api/v4/leads/notes?')) return { _embedded: { notes: Object.entries(state.notes).flatMap(([lead, ns]) => ns.map((n) => ({ ...n, note_type: 'common', entity_id: Number(lead) }))) } } as never;
      return null;
    },
    post: async (path, body) => {
      state.posts.push({ path, text: (body as { params: { text: string } }[])[0]?.params.text ?? '' });
      return { _embedded: { notes: [{ id: 500 + state.posts.length }] } } as never;
    },
  };
  const client = {
    getLead: async (id: number) => (LEADS[id] ? { id, _embedded: { contacts: [{ id: 501 }] } } : null),
    getContact: async () => ({ id: 501, name: 'Иван', custom_fields_values: [{ field_id: 1, field_code: 'PHONE', values: [{ value: '+7 909 950-03-81' }] }, { field_id: 2, field_code: 'EMAIL', values: [{ value: 'client@romashka.ru' }] }] }),
    leadMailNotes: async (id: number) => state.mail[id] ?? [],
  } as unknown as AmoApiClient;
  let seq = 100;
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
  const run = (opts: Parameters<typeof runDaySummary>[2] = {}) => runDaySummary(deps, ACC, { now: () => NOW, sleep: async () => undefined, amo, client, transcribe: { stt: () => new FakeSpeechKit(99), inlineWaitMs: 0 }, ...opts });

  beforeAll(async () => {
    ({ db, drop } = await freshDb());
    await new AccountsRepo(db).upsertInstalled({ id: ACC, subdomain: 'acc', accountDomain: 'acc.amocrm.ru' });
    await new SettingsRepo(db).save(ACC, 1, widgetSettingsSchema.parse({ calls: { daySummaryTimeoutSec: 0 } }));
    filesRoot = mkdtempSync(join(tmpdir(), 'calls-day-'));
    deps = depsOf(db, (async () => new Response('нет', { status: 404 })) as typeof fetch, filesRoot, {
      llmFor: async () => ({ llm: llm.llm, route: { primary: { provider: 'openai', model: 'gpt-5.5' }, fallback: null }, pricing: {}, usdRubRate: 90 }),
      sources: {
        wazzup: async (_a, leadId) => state.wz[leadId] ?? [],
        dialog: async (_a, leadId) => state.dlg[leadId] ?? [],
        activeLeads: async () => state.active,
        mailFiles: async (_a, leadId) => state.mailFiles[leadId] ?? [],
      },
    });
  });
  afterAll(() => drop());

  it('после расшифровки примечание не публикуется: звонок остаётся transcribed, итогов нет', async () => {
    const id = await insert({ calledAt: at('2026-10-22T06:05:00Z'), transcribed: false });
    const stt = new FakeSpeechKit(1);
    const r = await runCallsPoll(deps, ACC, { now: () => NOW, sleep: async () => undefined, amo, transcribeOptions: { stt: () => stt, inlineWaitMs: 10_000 } });
    expect(r.transcribed).toMatchObject({ picked: 1, transcribed: 1 });
    expect((await deps.calls.get(ACC, id))?.status).toBe('transcribed');
    expect(state.posts).toHaveLength(0);
    expect(await deps.days.list(ACC)).toHaveLength(0);
    await insert({ calledAt: at('2026-10-22T08:30:00Z') });
    await insert({ calledAt: at('2026-10-22T10:00:00Z') });
  });

  it('все источники одной лентой: 3 звонка + Wazzup + диалог агента + примечание менеджера + письма; дубли один раз, примечание агента не попало → одно примечание в сделку', async () => {
    state.wz[90141] = [
      { id: 'w1', direction: 'in', author: 'client', text: 'Здравствуйте, нужны двери', at: msk('09:00'), channel: 'whatsapp' },
      { id: 'w2', direction: 'out', author: 'manager', text: 'Добрый день! Какие размеры?', at: msk('09:05'), channel: 'whatsapp' }, // эхо ответа агента
      { id: 'w3', direction: 'in', author: 'client', text: '900 на 2000, три штуки', at: msk('09:10'), channel: 'whatsapp' },
    ];
    state.dlg[90141] = [
      { id: '1', direction: 'in', author: 'client', text: 'Здравствуйте, нужны двери', at: msk('09:00') }, // то же, что w1 (через Salesbot)
      { id: '2', direction: 'out', author: 'agent', text: 'Добрый день! Какие размеры?', at: msk('09:04') },
      { id: '3', direction: 'in', author: 'client', text: 'Тема письма: Заявка\nСмета во вложении\n> цитата', at: msk('10:01') }, // копия письма из IMAP
    ];
    state.notes[90141] = [
      { id: 71, created_by: 5, created_at: unix(msk('12:00')), params: { text: 'Клиент просил выставить счёт до пятницы' } },
      { id: 72, created_by: 5, created_at: unix(msk('12:05')), params: { text: '[AI] Передано менеджеру: вопрос по монтажу' } },
      { id: 73, created_by: 0, created_at: unix(msk('12:06')), params: { text: 'Итог разговоров за 21.10.2026: …' } },
    ];
    state.cnotes = [{ id: 74, created_by: 5, created_at: unix(msk('12:30')), params: { text: 'Контакт: лучше звонить после 15:00' } }];
    state.mail[90141] = [
      { id: 81, createdAt: msk('10:00'), income: true, subject: 'Заявка', text: 'Смета во вложении\n\n> старое письмо', from: 'client@romashka.ru', to: 'sales@rf-dveri.ru', attachments: ['смета.xlsx'] },
      { id: 82, createdAt: msk('11:05'), income: false, subject: 'Re: Заявка', text: 'Считаем, пришлём КП до вечера.\n--\nМенеджер', from: 'sales@rf-dveri.ru', to: 'client@romashka.ru', attachments: [] },
    ];
    state.events[90141] = [{ id: 'e1', created_by: 5, created_at: unix(msk('09:05')), type: 'outgoing_chat_message' }]; // рядом с w2 — не дублируем
    llm = fakeLlm();
    const r = await run();
    expect(r).toMatchObject({ enabled: true, groups: 1, calls: 3, notes: 1, noBusiness: 0, noActivity: 0, skipped: 0, errors: 0, waiting: 0 });
    expect(llm.asked).toHaveLength(1);
    const prompt = llm.asked[0] ?? '';
    // В ленте: 3 звонка, w1 (дубль chat:1 убран), agent:2 (эхо w2 убрано), w3, письмо 81 (копия из IMAP убрана), письмо 82, примечания 71 и 74; агентские 72, 73 — нет.
    const ids = [...prompt.matchAll(/\[((?:call|wz|chat|agent|note|mail|chatev):[^\]\s]+)\]/g)].map((m) => m[1] as string);
    expect(ids.filter((i) => !i.startsWith('call:'))).toEqual(['wz:w1', 'agent:2', 'wz:w3', 'mail:81', 'mail:82', 'note:71', 'note:74']);
    expect(ids.filter((i) => i.startsWith('call:'))).toHaveLength(3);
    expect(prompt).toContain('09:00 WhatsApp Клиент [wz:w1]: Здравствуйте, нужны двери');
    expect(prompt).toContain('10:00 Письмо вх. [mail:81] Тема: Заявка\nСмета во вложении\nВложения: смета.xlsx');
    expect(prompt).toContain('11:05 Письмо исх. [mail:82] Тема: Re: Заявка\nСчитаем, пришлём КП до вечера.');
    expect(prompt).toContain('12:00 Примечание менеджера [note:71]: Клиент просил выставить счёт до пятницы');
    expect(prompt).not.toContain('[AI]');
    expect(prompt).toContain('звонков 3 (9:15), сообщений 3, писем 2, примечаний менеджера 2');
    expect(state.posts).toHaveLength(1);
    expect(state.posts[0]!.path).toBe('/api/v4/leads/90141/notes');
    expect(state.posts[0]!.text).toBe(['Итог дня по сделке за 22.10.2026: 3 звонка (9:15), 3 сообщения, 2 письма, 2 примечания', 'Итог: Клиенту нужны три межкомнатные двери, замер на неделе (записей 9).', 'Договорённости: \n— Замер в четверг 23.10\n— Менеджер пришлёт расчёт после замера', 'Следующий шаг: Менеджер согласует время замера.', 'Оценка менеджера: 8/10 — Потребность и сроки выявлены, бюджет не уточнил.'].join('\n'));
    const days = await deps.days.list(ACC);
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ leadId: 90141, day: '2026-10-22', business: true, callsCount: 3, totalDurationSec: 555, noteId: 501, counts: { calls: 3, messages: 3, emails: 2, notes: 2 } });
    expect(days[0]!.itemIds).toHaveLength(10);
    const rows = (await deps.calls.list(ACC)).filter((c) => c.leadId === 90141);
    expect(rows.map((c) => [c.status, c.daySummaryId])).toEqual([['posted', days[0]!.id], ['posted', days[0]!.id], ['posted', days[0]!.id]]);
    expect((rows[0]!.transcript as CallTranscript).segments.map((s) => s.role)).toEqual(['manager', 'client']);
    const j = await new JournalRepo(db).list(ACC, { limit: 10 });
    expect(j.find((e) => e.kind === CALL_DAY_KIND)).toMatchObject({ leadId: 90141, inputTokens: 1500, outputTokens: 400 });
    expect(j.find((e) => e.kind === CALL_DAY_RUN_KIND)?.summary).toBe('Итог дня: сделок и контактов 1, звонков 3, примечаний 1');
    // Повторный запуск в тот же день: нового общения нет — итог не считается, примечаний не прибавилось.
    expect(await run()).toMatchObject({ groups: 0, notes: 0, noActivity: 1 });
    expect(state.posts).toHaveLength(1);
  });

  it('сделка только с перепиской → итог есть; только сообщения агента → итога нет; другая воронка не обрабатывается', async () => {
    state.cnotes = []; // примечание на контакте относится ко всем его сделкам — для сценария «только агент» его быть не должно
    state.wz[90142] = [{ id: 'w5', direction: 'in', author: 'client', text: 'Есть ли дверь 800 на 2000 в наличии?', at: msk('11:00'), channel: 'telegram' }, { id: 'w6', direction: 'out', author: 'manager', text: 'Да, есть, 19 680 ₽', at: msk('11:20'), channel: 'telegram' }];
    state.dlg[90143] = [{ id: '9', direction: 'out', author: 'agent', text: 'Здравствуйте! Чем помочь?', at: msk('11:00') }];
    state.wz[80000] = [{ id: 'w7', direction: 'in', author: 'client', text: 'Мебель нужна', at: msk('11:00'), channel: 'whatsapp' }];
    state.active = [90142, 90143, 80000];
    llm = fakeLlm();
    const r = await run();
    expect(r).toMatchObject({ groups: 1, calls: 0, notes: 1, noActivity: 2 }); // 90143 — только агент; 90141 — ничего нового
    expect(state.posts.at(-1)?.path).toBe('/api/v4/leads/90142/notes');
    expect(state.posts.at(-1)?.text.split('\n')[0]).toBe('Итог дня по сделке за 22.10.2026: 2 сообщения');
    expect(llm.asked[0]).toContain('11:00 Telegram Клиент [wz:w5]: Есть ли дверь 800 на 2000 в наличии?');
    expect((await deps.days.list(ACC)).map((d) => d.leadId).sort()).toEqual([90141, 90142]);
    state.active = [];
  });

  it('файлы в ленте дня (RFD-AI-AGENT-WA-FILES): КП менеджера из WhatsApp с текстом, аудио клиента без разбора, вложение письма с текстом; обрезка укорачивает тексты файлов раньше сообщений', async () => {
    const kp = 'Коммерческое предложение № 1187 от 22.10.2026. Дверь «Классика 3» эмаль белая 800×2000 — 3 шт. по 19 680 ₽; монтаж 3 × 5 500 ₽. Итого 75 540 ₽. Срок изготовления 25 рабочих дней, предоплата 70 %.';
    state.wz[90145] = [
      { id: 'f0', direction: 'in', author: 'client', text: 'Пришлите КП, пожалуйста', at: msk('10:30'), channel: 'whatsapp' },
      { id: 'f1', direction: 'out', author: 'manager', text: 'Отправляю КП', at: msk('10:45'), channel: 'whatsapp', file: { name: 'КП_Иванов.pdf', mime: 'application/pdf', text: kp, status: 'done', error: null } },
      { id: 'f2', direction: 'in', author: 'client', text: '[audio]', at: msk('11:00'), channel: 'whatsapp', file: { name: 'voice.ogg', mime: 'audio/ogg', text: null, status: 'skipped', error: 'аудио' } },
      { id: 'f3', direction: 'in', author: 'client', text: '[image]', at: msk('11:05'), channel: 'whatsapp', file: { name: 'IMG_3.jpg', mime: 'image/jpeg', text: null, status: 'failed', error: 'скачивание: файл недоступен: HTTP 404' } },
    ];
    state.mail[90145] = [{ id: 91, createdAt: msk('12:00'), income: true, subject: 'Смета', text: 'Смета во вложении', from: 'client@romashka.ru', to: 'sales@rf-dveri.ru', attachments: ['смета.xlsx'] }];
    state.mailFiles[90145] = [
      { id: '7', at: msk('12:01'), messageId: 'mm1', name: 'смета.xlsx', text: 'Лист «Смета»: дверь 800×2000 — 3 шт., короб, наличники, монтаж.', status: 'done' },
      { id: '8', at: msk('14:00'), messageId: 'mm2', name: 'план.pdf', text: null, status: 'pending' },
    ];
    state.active = [90145];
    llm = fakeLlm();
    const r = await run();
    expect(r).toMatchObject({ groups: 1, notes: 1, errors: 0 });
    const prompt = llm.asked[0] ?? '';
    expect(prompt).toContain(`10:45 WhatsApp Менеджер — отправил файл [wz:f1]: Отправляю КП\nФайл КП_Иванов.pdf: ${kp}`);
    expect(prompt).toContain('11:00 WhatsApp Клиент — прислал файл [wz:f2]: [audio]\nФайл voice.ogg (аудио)');
    expect(prompt).toContain('11:05 WhatsApp Клиент — прислал файл [wz:f3]: [image]\nФайл IMG_3.jpg (не разобран: скачивание: файл недоступен: HTTP 404)');
    expect(prompt).toContain('12:00 Письмо вх. [mail:91] Тема: Смета\nСмета во вложении\nФайл смета.xlsx: Лист «Смета»: дверь 800×2000 — 3 шт., короб, наличники, монтаж.');
    expect(prompt).toContain('14:00 Письмо вх. [mailfile:8] Тема: вложение план.pdf\n\nФайл план.pdf (разбор ещё идёт)');
    expect(prompt).not.toContain('Вложения: смета.xlsx'); // имя вложения с текстом не дублируется строкой «Вложения:»
    expect(state.posts.at(-1)?.path).toBe('/api/v4/leads/90145/notes');
    expect(state.posts.at(-1)?.text.split('\n')[0]).toBe('Итог дня по сделке за 22.10.2026: 4 сообщения, 2 письма');
    state.active = [];
  });

  it('повторный запуск в тот же день пишет отдельный итог только по новому общению; без делового содержания — примечания нет', async () => {
    state.wz[90141]!.push({ id: 'w8', direction: 'in', author: 'client', text: 'Договорились, жду замерщика в четверг', at: msk('15:00'), channel: 'whatsapp' });
    llm = fakeLlm();
    const r = await run();
    expect(r).toMatchObject({ groups: 1, notes: 1 });
    expect(llm.asked[0]).not.toContain('[wz:w1]');
    expect(llm.asked[0]).toContain('[wz:w8]');
    expect(state.posts.at(-1)?.text.split('\n')[0]).toBe('Итог дня по сделке за 22.10.2026: 1 сообщение');
    expect(await deps.days.forLead(ACC, 90141, '2026-10-22')).toHaveLength(2);
    // Без делового содержания: итог есть (business = false), примечания нет.
    state.wz[90141]!.push({ id: 'w9', direction: 'in', author: 'client', text: 'ок', at: msk('15:30'), channel: 'whatsapp' });
    llm = fakeLlm({ exclude: ['wz:w9'] });
    const r2 = await run();
    expect(r2).toMatchObject({ groups: 1, notes: 0, noBusiness: 1 });
    expect((await deps.days.forLead(ACC, 90141, '2026-10-22')).at(-1)).toMatchObject({ business: false, noteId: null });
    expect(await run()).toMatchObject({ groups: 0, noActivity: 1 });
  });

  it('закрытый этап 142: звонок не обрабатывается; без сделки — итог по контакту; длинный вход сокращается с пометкой', async () => {
    const closed = await insert({ calledAt: at('2026-10-22T09:10:00Z'), leadId: 70000 });
    const noLead = await insert({ calledAt: at('2026-10-22T09:20:00Z'), leadId: null });
    state.wz[90144] = Array.from({ length: 80 }, (_, i) => ({ id: `L${i}`, direction: i % 2 ? ('out' as const) : ('in' as const), author: i % 2 ? ('manager' as const) : ('client' as const), text: `сообщение ${i} ${'текст '.repeat(200)}`, at: new Date(msk('08:00').getTime() + i * 60_000), channel: 'whatsapp' }));
    state.active = [90144];
    llm = fakeLlm();
    const r = await run();
    expect(r).toMatchObject({ groups: 2, notes: 2, skipped: 1 });
    expect((await deps.calls.get(ACC, closed))?.error).toBe('сделка на закрытом этапе (142)');
    expect((await deps.calls.get(ACC, noLead))?.status).toBe('posted');
    const contactNote = state.posts.find((p) => p.path === '/api/v4/contacts/501/notes');
    expect(contactNote?.text.split('\n')[0]).toBe('Итог дня по контакту за 22.10.2026: 1 звонок (3:05)');
    const longNote = state.posts.find((p) => p.path === '/api/v4/leads/90144/notes');
    expect(longNote?.text.split('\n')[0]).toMatch(/^Итог дня по сделке за 22\.10\.2026: \d+ сообщений \(часть переписки сокращена\)$/);
    expect(llm.asked.find((a) => a.includes('[wz:L79]'))).toContain('Лента сокращена: старые сообщения не вошли');
    state.active = [];
    state.wz[90144] = [];
  });

  it('нерасшифрованный звонок не дождался — в итог следующего дня с пометкой даты; догрузка — итоги по дням', async () => {
    const late = await insert({ calledAt: at('2026-10-22T12:30:00Z'), transcribed: false });
    const r = await run();
    expect(r).toMatchObject({ groups: 0, waiting: 1 });
    expect((await deps.calls.get(ACC, late))?.status).toBe('downloaded');
    const NEXT = new Date('2026-10-23T13:00:00Z');
    await insert({ calledAt: at('2026-10-23T07:00:00Z') });
    state.wz[90141] = [];
    state.dlg[90141] = [];
    state.notes[90141] = [];
    state.cnotes = [];
    state.mail[90141] = [];
    state.events[90141] = [];
    llm = fakeLlm();
    const r2 = await runDaySummary(deps, ACC, { now: () => NEXT, sleep: async () => undefined, amo, client, transcribe: { stt: () => new FakeSpeechKit(1), inlineWaitMs: 0 } });
    expect(r2).toMatchObject({ groups: 1, calls: 2, notes: 1, waiting: 0 });
    expect(state.posts.at(-1)?.text.split('\n')[0]).toBe('Итог дня по сделке за 23.10.2026: 2 звонка (6:10) (в т. ч. звонки от 22.10)');
    expect((await deps.calls.get(ACC, late))?.status).toBe('posted');
    await insert({ calledAt: at('2026-10-15T08:00:00Z'), sttMode: 'deferred' });
    await insert({ calledAt: at('2026-10-15T09:00:00Z'), sttMode: 'deferred' });
    await insert({ calledAt: at('2026-10-16T08:00:00Z'), sttMode: 'deferred' });
    const before = state.posts.length;
    const r3 = await runDaySummary(deps, ACC, { now: () => NEXT, sleep: async () => undefined, amo, client });
    expect(r3).toMatchObject({ groups: 2, calls: 3, notes: 2 });
    expect(state.posts.slice(before).map((p) => p.text.split('\n')[0]).sort()).toEqual(['Итог дня по сделке за 15.10.2026: 2 звонка (6:10)', 'Итог дня по сделке за 16.10.2026: 1 звонок (3:05)']);
  });

  it('оценка догрузки без --yes ничего не пишет; время запуска итога; формат примечания', async () => {
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
    expect((await deps.calls.list(ACC, { limit: 500 })).length).toBe(before);
    expect(daySummaryDue('19:30', null, at('2026-10-22T16:29:00Z'))).toBe(false);
    expect(daySummaryDue('19:30', null, at('2026-10-22T16:30:00Z'))).toBe(true);
    expect(daySummaryDue('19:30', at('2026-10-22T16:31:00Z'), at('2026-10-22T18:00:00Z'))).toBe(false);
    expect(formatDayNote('2026-10-22', { summary: 'x', agreements: ['одна'], nextStep: '', managerScore: 5, managerComment: '', counts: { calls: 2, messages: 5, emails: 1, notes: 0 }, totalCallDuration: 61, sourceIds: [], speakers: [] })).toContain('Итог дня по сделке за 22.10.2026: 2 звонка (1:01), 5 сообщений, 1 письмо\nИтог: x\nДоговорённости: одна\nСледующий шаг: не определён');
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

  it('сетевая ошибка при проверке операции → failed без счёта попыток; следующий опрос возвращает в downloaded и забирает результат по сохранённой операции', async () => {
    let fail = true;
    const stt: CallStt = {
      name: 'speechkit',
      async start(_b, _m, o) {
        return { pending: { provider: 'speechkit', mode: o.mode, operationId: 'op-net', startedAt: NOW.toISOString(), polls: 0 } };
      },
      async poll(p) {
        if (fail) throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND operations.api.cloud.yandex.net' } });
        expect(p.operationId).toBe('op-net');
        return transcript(1, p.mode);
      },
    };
    let starts = 0;
    const counting: CallStt = { name: 'speechkit', start: async (...a) => (starts++, stt.start(...a)), poll: (...a) => stt.poll(...a) };
    const poll = () => runCallsPoll(deps, ACC, { now, sleep: async () => undefined, amo: { get: async () => null, post: async () => null }, transcribeOptions: { stt: () => counting, inlineWaitMs: 5000 } });
    expect((await poll()).transcribed).toMatchObject({ restarted: 0, picked: 1, failed: 1, alerts: 0 });
    let row = (await deps.calls.list(ACC))[0]!;
    expect([row.status, row.stage, row.attempts, row.error]).toEqual(['failed', 'transcribe', 0, 'сеть: fetch failed: ENOTFOUND getaddrinfo ENOTFOUND operations.api.cloud.yandex.net']);
    expect((row.transcript as { pending: PendingTranscription }).pending.operationId).toBe('op-net');
    fail = false;
    expect((await poll()).transcribed).toMatchObject({ restarted: 1, picked: 1, transcribed: 1, failed: 0 });
    row = (await deps.calls.list(ACC))[0]!;
    expect([row.status, row.attempts, starts]).toEqual(['transcribed', 0, 1]);
    const [id] = await deps.calls.insertNew(ACC, [{ noteId: 2, entity: 'contact', entityId: 501, direction: 'in', link: 'https://rfdveri.megapbx.ru/api/v2/call-records/record/2026-10-22/aaaaaaaa-0000-0000-0000-000000000002/x.mp3', recordKey: 'k2', phone: '79099500381', durationSec: 185, callStatus: 4, calledAt: now(), noteUpdatedAt: now(), managerId: 3, leadId: 90141 }]);
    const rel = `calls/${ACC}/2026-10/${id}_x.mp3`;
    mkdirSync(dirname(join(deps.filesRoot, rel)), { recursive: true });
    writeFileSync(join(deps.filesRoot, rel), MP3);
    await deps.calls.setDownloaded(id!, { filePath: rel, fileBytes: MP3.byteLength, fileMime: 'audio/mpeg' });
  });

  it('расшифровка падает → failed, повтор через 30 мин, после 3 попыток — один алерт в Telegram и остановка', async () => {
    const stt = new FakeSpeechKit(1, true);
    const poll = () => runCallsPoll(deps, ACC, { now, sleep: async () => undefined, amo: { get: async () => null, post: async () => null }, transcribeOptions: { stt: () => stt } });
    expect((await poll()).transcribed).toMatchObject({ picked: 1, failed: 1, alerts: 0 });
    const row = (await deps.calls.list(ACC)).find((c) => c.noteId === 2)!;
    expect([row.status, row.stage, row.attempts, row.error]).toEqual(['failed', 'transcribe', 1, 'SpeechKit: HTTP 500']);
    expect((await poll()).transcribed?.picked).toBe(0);
    tick(31);
    expect((await poll()).transcribed?.failed).toBe(1);
    tick(31);
    expect((await poll()).transcribed).toMatchObject({ failed: 1, alerts: 1 });
    expect((await deps.calls.list(ACC)).find((c) => c.noteId === 2)).toMatchObject({ attempts: MAX_ATTEMPTS, status: 'failed' });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('расшифровка не удалась 3 раза: SpeechKit: HTTP 500');
    tick(31);
    expect((await poll()).transcribed?.picked).toBe(0);
  });
});
