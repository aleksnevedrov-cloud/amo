import { randomBytes } from 'node:crypto';
import { AmoOAuth, TokenService } from '@ai-door/amo';
import { SecretBox } from '@ai-door/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AccountsRepo,
  DialogRepo,
  DocumentsRepo,
  JournalRepo,
  migrate,
  PgTokenStore,
  SettingsRepo,
  widgetSettingsSchema,
  type Db,
} from '../src/index.ts';
import { freshDb } from './setup.ts';

let db: Db;
let drop: () => Promise<void>;
const box = new SecretBox(randomBytes(32).toString('hex'));
const HOUR = 3600_000;

beforeAll(async () => {
  ({ db, drop } = await freshDb());
});
afterAll(async () => drop());

async function installAccount(id: number, expiresAt: Date) {
  await new AccountsRepo(db).upsertInstalled({ id, subdomain: `acc${id}`, accountDomain: `acc${id}.amocrm.ru` });
  await new PgTokenStore(db, box).put(id, { accessToken: 'A1', refreshToken: 'R1', expiresAt });
}

function countingOAuth(opts: { fail?: number; delayMs?: number } = {}) {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, opts.delayMs ?? 0));
    if (opts.fail) return new Response('{}', { status: opts.fail });
    return new Response(
      JSON.stringify({ token_type: 'Bearer', expires_in: 86400, access_token: `A${calls + 1}`, refresh_token: `R${calls + 1}` }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { oauth: new AmoOAuth({ clientId: 'c', clientSecret: 's', redirectUri: 'https://x.ru/cb', fetch: fetchImpl }), calls: () => calls };
}

describe('миграции', () => {
  it('повторный запуск ничего не применяет', async () => {
    await expect(migrate(db)).resolves.toEqual([]);
  });
});

describe('PgTokenStore', () => {
  it('хранит токены в зашифрованном виде', async () => {
    await installAccount(1, new Date(Date.now() + 20 * HOUR));
    const { rows } = await db.query('SELECT access_token_enc, refresh_token_enc FROM amo_tokens WHERE account_id = 1');
    expect(rows[0].access_token_enc).not.toContain('A1');
    expect(rows[0].refresh_token_enc).not.toContain('R1');
  });

  it('параллельные запросы из разных соединений обновляют токен один раз', async () => {
    await installAccount(2, new Date(Date.now() + 1 * HOUR));
    const o = countingOAuth({ delayMs: 50 });
    const svc = new TokenService(new PgTokenStore(db, box), o.oauth, 6 * HOUR);
    const tokens = await Promise.all(Array.from({ length: 5 }, () => svc.getAccessToken(2)));
    expect(new Set(tokens)).toEqual(new Set(['A2']));
    expect(o.calls()).toBe(1);
    const status = await new PgTokenStore(db, box).status(2);
    expect(status?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * HOUR);
  });

  it('ошибку обновления сохраняет без дедлока и не портит токены', async () => {
    await installAccount(3, new Date(Date.now() + 1 * HOUR));
    const store = new PgTokenStore(db, box);
    const svc = new TokenService(store, countingOAuth({ fail: 401 }).oauth, 6 * HOUR);
    await expect(svc.getAccessToken(3)).rejects.toThrow();
    const status = await store.status(3);
    expect(status?.lastError).toMatch(/401/);
    await store.withLock(3, async (cur) => expect(cur?.refreshToken).toBe('R1'));
  });

  it('listExpiring пропускает свежие и удалённые аккаунты', async () => {
    await installAccount(4, new Date(Date.now() + 1 * HOUR));
    await new AccountsRepo(db).markUninstalled(4);
    const ids = await new PgTokenStore(db, box).listExpiring(new Date(Date.now() + 6 * HOUR));
    expect(ids).not.toContain(1);
    expect(ids).not.toContain(4);
  });
});

describe('AccountsRepo', () => {
  it('деинсталляция удаляет токены, повторная установка снимает отметку', async () => {
    const repo = new AccountsRepo(db);
    await installAccount(5, new Date(Date.now() + 20 * HOUR));
    await repo.markUninstalled(5);
    expect((await repo.get(5))?.uninstalledAt).toBeInstanceOf(Date);
    expect(await new PgTokenStore(db, box).status(5)).toBeNull();
    await repo.upsertInstalled({ id: 5, subdomain: 'acc5', accountDomain: 'acc5.amocrm.ru' });
    expect((await repo.get(5))?.uninstalledAt).toBeNull();
  });
});

describe('SettingsRepo', () => {
  it('возвращает значения по умолчанию, сохраняет и пишет аудит', async () => {
    await installAccount(6, new Date(Date.now() + 20 * HOUR));
    const repo = new SettingsRepo(db);
    const initial = await repo.get(6);
    expect(initial.version).toBe(0);
    expect(initial.settings).toMatchObject({ enabled: false, mode: 'off', model: { model: 'claude-opus-5' } });

    await repo.save(6, 100, widgetSettingsSchema.parse({ enabled: true, mode: 'off' }));
    const { version } = await repo.save(6, 101, widgetSettingsSchema.parse({ enabled: true, mode: 'auto' }));
    expect(version).toBe(2);
    expect((await repo.get(6)).settings.mode).toBe('auto');

    const { rows } = await db.query('SELECT user_id, before, after FROM settings_audit WHERE account_id = 6 ORDER BY id');
    expect(rows).toHaveLength(2);
    expect(rows[0].before).toBeNull();
    expect(Number(rows[1].user_id)).toBe(101);
    expect(rows[1].before).toMatchObject({ enabled: true, mode: 'off' });
  });
});

describe('widgetSettingsSchema', () => {
  it('старые настройки фазы 0 дополняются значениями по умолчанию', () => {
    const s = widgetSettingsSchema.parse({ enabled: true, mode: 'auto' });
    expect(s.where).toEqual({ pipelineIds: null, disabledStatusIds: [], batchWindowSec: 8, typingDelay: false });
    expect(s.limits.dailyRub).toBeNull();
  });

  it('отклоняет неизвестные поля и некорректный URL фида', () => {
    expect(() => widgetSettingsSchema.parse({ foo: 1 })).toThrow();
    expect(() => widgetSettingsSchema.parse({ catalog: { feedUrl: 'not a url' } })).toThrow();
  });
});

describe('SettingsRepo.listWithFeeds', () => {
  it('возвращает только аккаунты с фидом', async () => {
    await installAccount(7, new Date(Date.now() + 20 * HOUR));
    await new SettingsRepo(db).save(7, 1, widgetSettingsSchema.parse({ catalog: { feedUrl: 'https://rf-dveri.ru/feed.xml' } }));
    const list = await new SettingsRepo(db).listWithFeeds();
    expect(list).toEqual([{ accountId: 7, feedUrl: 'https://rf-dveri.ru/feed.xml', everyHours: 24 }]);
  });
});

describe('DialogRepo', () => {
  it('пауза, возврат и счётчик промахов', async () => {
    await installAccount(8, new Date(Date.now() + 20 * HOUR));
    const d = new DialogRepo(db);
    expect((await d.state(8, 1)).paused).toBe(false);
    await d.pause(8, 1, 'manager_message');
    expect(await d.state(8, 1)).toMatchObject({ paused: true, pauseReason: 'manager_message' });
    expect(await d.registerTurn(8, 1, true)).toBe(1);
    expect(await d.registerTurn(8, 1, true)).toBe(2);
    expect(await d.registerTurn(8, 1, false)).toBe(0);
    await d.resume(8, 1);
    expect(await d.state(8, 1)).toMatchObject({ paused: false, pauseReason: null, misses: 0 });
  });

  it('история в хронологическом порядке с лимитом', async () => {
    const d = new DialogRepo(db);
    for (const t of ['1', '2', '3']) await d.addMessage(8, 2, 'client', t);
    expect((await d.history(8, 2, 2)).map((m) => m.text)).toEqual(['2', '3']);
  });

  it('очередь входящих: пачка забирается один раз', async () => {
    const d = new DialogRepo(db);
    await d.enqueue(8, 3, 'Здравствуйте', 'https://x/1');
    await d.enqueue(8, 3, 'Нужна дверь', 'https://x/2');
    expect(await d.lastPendingAt(8, 3)).toBeInstanceOf(Date);
    const [a, b] = await Promise.all([d.takePending(8, 3), d.takePending(8, 3)]);
    const all = [...a, ...b];
    expect(all.map((m) => m.text)).toEqual(['Здравствуйте', 'Нужна дверь']);
    expect(await d.takePending(8, 3)).toEqual([]);
    expect(await d.lastPendingAt(8, 3)).toBeNull();
  });
});

describe('JournalRepo', () => {
  it('пишет, фильтрует и считает расход', async () => {
    await installAccount(9, new Date(Date.now() + 20 * HOUR));
    const j = new JournalRepo(db);
    await j.add({ accountId: 9, leadId: 1, kind: 'reply', summary: 'ответ', costRub: 1.5, costUsd: 0.016 });
    await j.add({ accountId: 9, leadId: 2, kind: 'handoff', summary: 'передача', costRub: 2 });
    expect((await j.list(9)).map((r) => r.kind)).toEqual(['handoff', 'reply']);
    expect((await j.list(9, { leadId: 1 }))[0]).toMatchObject({ summary: 'ответ', costRub: 1.5, leadId: 1 });
    expect(await j.spentTodayRub(9)).toBe(3.5);
    expect(await j.spentSummary(9)).toEqual({ todayRub: 3.5, monthRub: 3.5 });
  });
});

describe('MemoryRepo', () => {
  it('слияние, резюме, текст для промпта', async () => {
    const { MemoryRepo, memorySubject, memoryToText } = await import('../src/index.ts');
    await installAccount(10, new Date(Date.now() + 20 * HOUR));
    const repo = new MemoryRepo(db);
    const subj = memorySubject(77, 5);
    expect(subj).toBe('contact:77');
    expect(memorySubject(null, 5)).toBe('lead:5');
    await repo.update(10, subj, { budget_rub: 50000, preferences: { coating: 'эмаль' }, notes: ['ремонт в новостройке'] });
    await repo.update(10, subj, { preferences: { color: 'белый' }, notes: ['ремонт в новостройке', 'есть кошка'] });
    await repo.setSummary(10, subj, 'Искал белые двери в эмали');
    const m = await repo.get(10, subj);
    expect(m.data.preferences).toEqual({ coating: 'эмаль', color: 'белый' });
    expect(m.data.notes).toEqual(['ремонт в новостройке', 'есть кошка']);
    const text = memoryToText(m.data, m.summary);
    expect(text).toMatch(/Бюджет клиента: 50000 ₽/);
    expect(text).toMatch(/Резюме прошлых обращений: Искал белые двери/);
    expect((await repo.get(10, 'contact:999')).data.budget_rub).toBeNull();
  });
});

describe('SuggestionsRepo', () => {
  it('черновик: новый вытесняет прежний, одобрение, отправка, повтор', async () => {
    const { SuggestionsRepo } = await import('../src/index.ts');
    await installAccount(11, new Date(Date.now() + 20 * HOUR));
    const r = new SuggestionsRepo(db);
    const a = await r.add(11, 1, 'draft', 'Первый');
    const b = await r.add(11, 1, 'draft', 'Второй');
    expect((await r.get(11, a))?.status).toBe('expired');
    expect((await r.pendingDrafts(11)).map((x) => x.id)).toEqual([b]);
    expect(await r.decide(11, a, 'approved', 5)).toBeNull();
    const ok = await r.decide(11, b, 'approved', 5, 'Второй, исправленный');
    expect(ok).toMatchObject({ status: 'approved', text: 'Второй, исправленный', decidedBy: 5 });
    expect(await r.decide(12, b, 'rejected', 5)).toBeNull();
    const sent = await r.takeApproved(11, 1);
    expect(sent?.id).toBe(b);
    expect(await r.takeApproved(11, 1)).toBeNull();
    await r.markApprovedAgain(11, b);
    expect((await r.get(11, b))?.status).toBe('approved');
    await r.add(11, 1, 'hint', 'Подсказка');
    expect((await r.listForLead(11, 1)).map((x) => x.kind)).toEqual(['hint', 'draft', 'draft']);
  });

  it('вложения во входящих и счётчик ответов AI', async () => {
    const d = new DialogRepo(db);
    await d.enqueue(11, 2, '', 'https://x/c', { url: 'https://drive/v.ogg', type: 'voice' });
    expect((await d.takePending(11, 2))[0]).toMatchObject({ attachmentUrl: 'https://drive/v.ogg', attachmentType: 'voice' });
    await d.addMessage(11, 2, 'ai', 'a');
    await d.addMessage(11, 2, 'client', 'b');
    await d.addMessage(11, 2, 'ai', 'c');
    expect(await d.aiMessagesCount(11, 2)).toBe(2);
  });
});

describe('DocumentsRepo', () => {
  it('хранит результат разбора без файла, считает за день, отдаёт по сделке', async () => {
    await installAccount(1201, new Date(Date.now() + HOUR));
    const repo = new DocumentsRepo(db);
    const base = { accountId: 1201, leadId: 5, source: 'widget' as const, filename: 'замер.jpg', mime: 'image/jpeg', sizeBytes: 100, format: 'image', ocr: 'yandex', kind: 'measurement', data: { title: 'Замер', openings: [{ width_mm: 838 }] }, textChars: 120, piiRemoved: 2, model: 'claude-opus-5', costUsd: 0.01, createdBy: 7 };
    const id = await repo.add(base);
    await repo.add({ ...base, leadId: 6, kind: 'request' });
    expect(await repo.countToday(1201)).toBe(2);
    expect(await repo.countToday(1202)).toBe(0);
    const got = await repo.get(1201, id);
    expect(got).toMatchObject({ id, leadId: 5, kind: 'measurement', ocr: 'yandex', piiRemoved: 2, costUsd: 0.01, createdBy: 7, data: { title: 'Замер' } });
    expect((await repo.listForLead(1201, 5)).map((d) => d.id)).toEqual([id]);
    expect(await repo.get(1202, id)).toBeNull();
  });
});

describe('аналитика (фаза 4)', () => {
  it('исходы: старт один раз, перепроверка, классификация, сводка и расход по месяцам', async () => {
    const { AnalyticsRepo, OutcomesRepo, classifyOutcome } = await import('../src/index.ts');
    await installAccount(1301, new Date(Date.now() + HOUR));
    const outcomes = new OutcomesRepo(db);
    await outcomes.start(1301, 10, 1, 100);
    await outcomes.start(1301, 10, 1, 999); // повтор не перезаписывает
    await outcomes.start(1301, 11, 1, 100);
    expect(await outcomes.accountsWithDue(0, 60)).toEqual([1301]);
    const due = await outcomes.due(1301, { olderThanMs: 0, withinDays: 60, limit: 10 });
    expect(due.map((d) => d.firstStatusId)).toEqual([100, 100]);

    const order = new Map([[100, 10], [101, 20], [102, 30]]);
    expect(classifyOutcome({ pipelineId: 1, statusId: 100 }, { pipelineId: 1, statusId: 102 }, order)).toEqual({ advanced: true, won: false, lost: false });
    expect(classifyOutcome({ pipelineId: 1, statusId: 101 }, { pipelineId: 1, statusId: 100 }, order)).toEqual({ advanced: false, won: false, lost: false });
    expect(classifyOutcome({ pipelineId: 1, statusId: 100 }, { pipelineId: 1, statusId: 142 }, order)).toEqual({ advanced: true, won: true, lost: false });
    expect(classifyOutcome({ pipelineId: 1, statusId: 100 }, { pipelineId: 2, statusId: 5 }, order)).toEqual({ advanced: false, won: false, lost: false });
    expect(classifyOutcome({ pipelineId: 1, statusId: 100 }, { pipelineId: 1, statusId: 143 }, order).lost).toBe(true);

    await outcomes.record(1301, 10, { statusId: 102, pipelineId: 1, advanced: true, won: false, lost: false });
    await outcomes.markGone(1301, 11);
    // Только что проверенная сделка не попадает в выборку, пока не пройдёт интервал перепроверки.
    expect(await outcomes.due(1301, { olderThanMs: HOUR, withinDays: 60, limit: 10 })).toEqual([]);

    const journal = new JournalRepo(db);
    await journal.add({ accountId: 1301, leadId: 10, kind: 'reply', summary: 'a', costRub: 3, inputTokens: 1000, outputTokens: 100 });
    await journal.add({ accountId: 1301, leadId: 10, kind: 'handoff', summary: 'b', details: { reason: 'discount' } });
    await journal.add({ accountId: 1301, leadId: 10, kind: 'handoff', summary: 'служебная запись без reason' });
    await journal.add({ accountId: 1301, leadId: 11, kind: 'draft', summary: 'c', details: { delivery: 'draft' }, costRub: 1 });
    await journal.add({ accountId: 1301, leadId: 12, kind: 'skipped', summary: 'не диалог' });
    await journal.add({ accountId: 1302, leadId: 1, kind: 'reply', summary: 'чужой аккаунт', costRub: 100 }).catch(() => undefined);
    const a = await new AnalyticsRepo(db).summary(1301, new Date(Date.now() - HOUR), new Date(Date.now() + HOUR));
    expect(a).toMatchObject({ dialogs: 2, replies: 1, drafts: 1, handoffs: 1, costRub: 4, avgCostPerDialogRub: 2 });
    expect(a.outcomes).toEqual({ tracked: 2, advanced: 1, won: 0, lost: 1, conversionPct: 50 });
    expect(a.handoffReasons).toEqual([{ reason: 'discount', count: 1 }]);
    expect(a.byDay).toHaveLength(1);
    expect(a.byDay[0]).toMatchObject({ dialogs: 2, replies: 1, handoffs: 1, costRub: 4 });
    const months = await new AnalyticsRepo(db).billing(1301);
    expect(months).toHaveLength(1);
    expect(months[0]).toMatchObject({ costRub: 4, inputTokens: 1000, outputTokens: 100, dialogs: 2, replies: 1 });
  });
});

describe('версии настроек и удаление данных', () => {
  it('история с изменёнными разделами, снимок, откат новой версией; purge удаляет всё каскадом', async () => {
    await installAccount(1401, new Date(Date.now() + HOUR));
    const repo = new SettingsRepo(db);
    const v1 = widgetSettingsSchema.parse({ enabled: true, mode: 'auto' });
    await repo.save(1401, 7, v1);
    await repo.save(1401, 8, { ...v1, behavior: { ...v1.behavior, greeting: 'Здравствуйте!' }, limits: { ...v1.limits, dailyRub: 500 } });
    const history = await repo.history(1401);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ userId: 8, changed: ['behavior', 'limits'] });
    expect(history[1]!.changed).toContain('enabled');
    const snap = await repo.version(1401, history[1]!.id);
    expect(snap?.settings.behavior.greeting).toBe('');
    const r = await repo.restore(1401, 9, history[1]!.id);
    expect(r?.version).toBe(3);
    const cur = await repo.get(1401);
    expect(cur.settings.behavior.greeting).toBe('');
    expect(cur.settings.limits.dailyRub).toBeNull();
    expect((await repo.history(1401))[0]).toMatchObject({ userId: 9, changed: ['behavior', 'limits'] });
    expect(await repo.version(1401, 999_999)).toBeNull();

    await new JournalRepo(db).add({ accountId: 1401, kind: 'reply', summary: 'x' });
    expect(await new AccountsRepo(db).purge(1401)).toBe(true);
    expect(await new AccountsRepo(db).purge(1401)).toBe(false);
    for (const t of ['widget_settings', 'settings_audit', 'ai_journal', 'amo_tokens']) {
      const { rows } = await db.query(`SELECT count(*) AS n FROM ${t} WHERE account_id = 1401`);
      expect(Number(rows[0].n), t).toBe(0);
    }
  });
});
