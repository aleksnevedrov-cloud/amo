import { readFileSync } from 'node:fs';
import { evalFixtures } from '@ai-door/evals/seed';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FEED_PATH } from '../../../packages/tools/test/fixtures.ts';
import { TEST_DATABASE_URL } from '../../../packages/db/test/setup.ts';
import { ScriptedLlm, text, toolUse } from '../../../packages/agent/test/scripted-llm.ts';
import { setup, widgetToken } from './helpers.ts';

let ctx: Awaited<ReturnType<typeof setup>>;
const llmSteps: ConstructorParameters<typeof ScriptedLlm>[0] = [];
const ACC = 31337;
const GOOD = 'sk-good-openai-0000000000000000000';

const admin = async () => ({ 'x-auth-token': await widgetToken() });
const user = async () => ({ 'x-auth-token': await widgetToken({ is_admin: false }) });
const get = async (url: string) => (await ctx.app.inject({ url, headers: await admin() })).json();

beforeAll(async () => {
  ctx = await setup({
    llm: new ScriptedLlm(llmSteps),
    evalFixtures: () => evalFixtures(TEST_DATABASE_URL, 1),
    download: async () => ({ bytes: new Uint8Array(Buffer.from('Проём 1: 900x2100 стена 100 мм', 'utf8')), mime: 'text/plain' }),
  });
  await ctx.app.inject({ url: '/oauth/amo/callback', query: { code: 'C', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
  await ctx.deps.importer.importFromBytes(ACC, new Uint8Array(readFileSync(FEED_PATH)));
});
afterAll(async () => ctx.close());

describe('ключи двух провайдеров (раздел 5 ТЗ 1.1.0)', () => {
  it('маска вместо ключа, невалидный ключ не сохраняется, удаление', async () => {
    const before = await get('/widget/v1/llm/keys');
    expect(before).toMatchObject({ provider: 'anthropic', keys: { anthropic: { saved: false, mask: null, source: 'server' }, openai: { saved: false, mask: null, source: null } }, providers: ['anthropic'] });

    const bad = await ctx.app.inject({ method: 'PUT', url: '/widget/v1/llm/key', headers: await admin(), payload: { provider: 'openai', key: 'sk-bad-openai-00000000000000000' } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ error: 'key_invalid', message: expect.stringContaining('не принят') });
    expect((await get('/widget/v1/llm/keys')).keys.openai.saved).toBe(false);

    expect((await ctx.app.inject({ method: 'PUT', url: '/widget/v1/llm/key', headers: await user(), payload: { provider: 'openai', key: GOOD } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'PUT', url: '/widget/v1/llm/key', headers: await admin(), payload: { provider: 'openai', key: GOOD } })).statusCode).toBe(200);
    const after = await get('/widget/v1/llm/keys');
    expect(after.keys.openai).toEqual({ saved: true, mask: 'sk-…0000', source: 'account' });
    expect(after.providers).toEqual(['anthropic', 'openai']);
    // Ключ не утекает: ни в ответы API, ни в журнал (критерий 7).
    for (const url of ['/widget/v1/llm/keys', '/widget/v1/llm/status', '/widget/v1/status', '/widget/v1/journal', '/widget/v1/settings']) {
      expect((await ctx.app.inject({ url, headers: await admin() })).body).not.toContain(GOOD);
    }
    const j = await get('/widget/v1/journal');
    expect(j.items[0]).toMatchObject({ kind: 'note', summary: 'Ключ OpenAI аккаунта обновлён (sk-…0000)' });
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/llm/test', headers: await admin(), payload: { provider: 'openai' } })).json()).toEqual({ ok: true, models: ['gpt-5', 'gpt-5-mini'] });
  });

  it('список моделей из API провайдера: фильтр, цены, кэш 24 ч, обновление; без ключа — таблица тарифов', async () => {
    const first = await get('/widget/v1/llm/models?provider=openai');
    expect(first).toMatchObject({ provider: 'openai', fromCache: false, source: 'api', noKey: false });
    expect(first.models.map((m: { id: string }) => m.id)).toEqual(['gpt-5', 'gpt-5-mini']);
    expect(first.models[0]).toMatchObject({ vision: true, tools: true, price: { input: 1.25, output: 10 } });
    expect((await get('/widget/v1/llm/models?provider=openai')).fromCache).toBe(true);
    expect((await get('/widget/v1/llm/models?provider=openai&refresh=1')).fromCache).toBe(false);
    // Anthropic: ключ серверный (подменённая LLM без списка моделей) — список пуст, значит из API ничего; с таблицей — при отсутствии ключа.
    await ctx.deps.secrets.remove(ACC, 'openai');
    const noKey = await get('/widget/v1/llm/models?provider=openai');
    expect(noKey).toMatchObject({ noKey: true, source: 'tariff' });
    expect(noKey.models[0]).toMatchObject({ id: 'gpt-5.2', recommended: 1 });
    await ctx.deps.secrets.set(ACC, 'openai', GOOD, 7);
  });
});

describe('переключение провайдера (раздел 3 ТЗ 1.1.0)', () => {
  it('без ключа провайдера настройка не сохраняется; с ключом — сохраняется и попадает в аудит', async () => {
    const { settings } = await get('/widget/v1/settings');
    await ctx.deps.secrets.remove(ACC, 'openai');
    const denied = await ctx.app.inject({ method: 'PUT', url: '/widget/v1/settings', headers: await admin(), payload: { ...settings, model: { ...settings.model, provider: 'openai', model: 'gpt-5' } } });
    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toMatchObject({ error: 'no_key', provider: 'openai', message: 'Введите ключ OpenAI' });

    await ctx.deps.secrets.set(ACC, 'openai', GOOD, 7);
    const ok = await ctx.app.inject({ method: 'PUT', url: '/widget/v1/settings', headers: await admin(), payload: { ...settings, enabled: true, mode: 'auto', model: { ...settings.model, provider: 'openai', model: 'gpt-5', fallbackModel: 'claude-sonnet-5', fallbackProvider: 'anthropic' } } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().settings.model).toMatchObject({ provider: 'openai', model: 'gpt-5', fallbackProvider: 'anthropic' });
    const st = await get('/widget/v1/status');
    expect(st.llm).toMatchObject({ provider: 'openai', model: 'gpt-5', fallback: { provider: 'anthropic', model: 'claude-sonnet-5' }, providers: ['anthropic', 'openai'] });
    expect(st.llmConfigured).toBe(true);
    const j = await get('/widget/v1/journal');
    expect(j.items[0]).toMatchObject({ kind: 'note', summary: 'Модель по умолчанию: ChatGPT · gpt-5 (резерв: claude-sonnet-5)', details: { audit: 'llm.model', userId: 7 } });
    expect((await get('/widget/v1/settings/history')).items[0].changed).toContain('model');
  });

  it('песочница отвечает через OpenAI: инструменты, провайдер и модель в ответе и журнале', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/widget/v1/sandbox', headers: await admin(), payload: { messages: [{ role: 'client', text: 'Нужна белая дверь в эмали' }] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'reply', provider: 'openai', model: 'gpt-5', fallbackUsed: false, toolCalls: [{ name: 'catalog_search', ok: true }] });
    expect(res.json().text).toContain('14 900');
    expect(res.json().sources[0]).toMatchObject({ type: 'product', id: '1001' });
    const j = await get('/widget/v1/journal?kind=sandbox');
    expect(j.items[0].details).toMatchObject({ provider: 'openai', model: 'gpt-5', latencyMs: expect.any(Number) });

    // Явная модель другого провайдера в песочнице: Anthropic (подменённая LLM).
    llmSteps.push(toolUse(['catalog_search', { query: 'белая эмаль' }]), text('Турин 1 — 14 900 ₽, в наличии.'));
    const a = await ctx.app.inject({ method: 'POST', url: '/widget/v1/sandbox', headers: await admin(), payload: { messages: [{ role: 'client', text: 'Белая эмаль' }], model: { provider: 'anthropic', model: 'claude-opus-5' } } });
    expect(a.json()).toMatchObject({ kind: 'reply', provider: 'anthropic', model: 'claude-opus-5', text: 'Турин 1 — 14 900 ₽, в наличии.' });
  });

  it('сравнение двух моделей на одном диалоге (критерий 8)', async () => {
    llmSteps.push(toolUse(['catalog_search', { query: 'белая эмаль' }]), text('Турин 1 — 14 900 ₽.'));
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/widget/v1/sandbox/compare',
      headers: await admin(),
      payload: { messages: [{ role: 'client', text: 'Нужна белая дверь в эмали' }], models: [{ provider: 'anthropic', model: 'claude-opus-5' }, { provider: 'openai', model: 'gpt-5' }] },
    });
    expect(res.statusCode).toBe(200);
    const [a, b] = res.json().results;
    expect(a).toMatchObject({ model: { provider: 'anthropic', model: 'claude-opus-5' }, kind: 'reply', provider: 'anthropic', cost: { rub: expect.any(Number), inputTokens: expect.any(Number) }, latencyMs: expect.any(Number) });
    expect(b).toMatchObject({ model: { provider: 'openai', model: 'gpt-5' }, kind: 'reply', provider: 'openai', toolCalls: [{ name: 'catalog_search' }] });
    expect(a.cost.usd).toBeGreaterThan(0);
    expect(b.cost.usd).toBeGreaterThan(0);
  });

  it('модель для отдельной сделки: панель, журнал, следующий ход через неё (критерий 3 панели)', async () => {
    const h = await admin();
    const no = await ctx.app.inject({ method: 'PUT', url: '/widget/v1/leads/700/llm', headers: h, payload: { model: { provider: 'anthropic', model: 'claude-haiku-4-5' } } });
    expect(no.statusCode).toBe(200);
    expect(no.json().route).toEqual({ primary: { provider: 'anthropic', model: 'claude-haiku-4-5' }, fallback: { provider: 'anthropic', model: 'claude-sonnet-5' } });
    let panel = (await ctx.app.inject({ url: '/widget/v1/leads/700/panel', headers: h })).json();
    expect(panel.llm).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-4-5', override: { provider: 'anthropic', model: 'claude-haiku-4-5' }, configured: true, providers: ['anthropic', 'openai'] });
    expect(panel.log[0]).toMatchObject({ kind: 'note', summary: 'Модель для сделки: Claude · claude-haiku-4-5', provider: 'anthropic', model: 'claude-haiku-4-5' });
    // Другая сделка — по настройкам (OpenAI).
    const other = (await ctx.app.inject({ url: '/widget/v1/leads/701/panel', headers: h })).json();
    expect(other.llm).toMatchObject({ provider: 'openai', model: 'gpt-5', override: null });

    await ctx.app.inject({ method: 'PUT', url: '/widget/v1/leads/700/llm', headers: h, payload: { model: null } });
    panel = (await ctx.app.inject({ url: '/widget/v1/leads/700/panel', headers: h })).json();
    expect(panel.llm).toMatchObject({ provider: 'openai', override: null });
    await ctx.deps.secrets.remove(ACC, 'openai');
    expect((await ctx.app.inject({ method: 'PUT', url: '/widget/v1/leads/700/llm', headers: h, payload: { model: { provider: 'openai', model: 'gpt-5' } } })).statusCode).toBe(409);
    await ctx.deps.secrets.set(ACC, 'openai', GOOD, 7);
  });
});

describe('панель сделки 1.1.0 и eval', () => {
  it('файлы из чата, задачи AI, резюме, журнал с моделью; «Разобрать» у файла из чата', async () => {
    const h = await admin();
    await ctx.deps.dialog.enqueue(ACC, 702, '', 'https://aleksnevedrov.amocrm.ru/c/1', { url: 'https://files.amocrm.ru/x/замер.txt', type: 'text/plain' });
    await ctx.deps.journal.add({ accountId: ACC, leadId: 702, kind: 'reply', summary: 'Ок', details: { provider: 'openai', model: 'gpt-5', toolCalls: [{ name: 'crm_create_task', ok: true, input: { type: 'measure', text: 'Замер в субботу' } }] }, costRub: 2 });
    await ctx.deps.journal.add({ accountId: ACC, leadId: 702, kind: 'summary', summary: 'Потребность: 3 двери', details: { provider: 'openai', model: 'gpt-5' } });
    let panel = (await ctx.app.inject({ url: '/widget/v1/leads/702/panel', headers: h })).json();
    expect(panel.files).toMatchObject([{ name: 'замер.txt', status: 'pending', type: 'text/plain' }]);
    expect(panel.tasks).toMatchObject([{ kind: 'Согласовать замер', text: 'Замер в субботу', source: 'tool' }]);
    expect(panel.summary).toMatchObject({ text: 'Потребность: 3 двери' });
    expect(panel.log.find((e: { kind: string }) => e.kind === 'reply')).toMatchObject({ provider: 'openai', model: 'gpt-5', costRub: 2 });
    expect(panel.health).toMatchObject({ llmConfigured: true, dailyLimitExhausted: false });

    // Разбор файла из чата: скачивание подменено, структура — через OpenAI (мок отвечает документом по схеме).
    const fileId = panel.files[0].id as number;
    const r = await ctx.app.inject({ method: 'POST', url: `/widget/v1/leads/702/files/${fileId}/analyze`, headers: h });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ kind: 'measurement', provider: 'openai', model: 'gpt-5' });
    panel = (await ctx.app.inject({ url: '/widget/v1/leads/702/panel', headers: h })).json();
    expect(panel.files[0]).toMatchObject({ name: 'замер.txt', status: 'parsed', kind: 'measurement', openings: 1, summary: 'Один проём 900×2100.' });
    expect(panel.log[0]).toMatchObject({ kind: 'document', provider: 'openai', model: 'gpt-5' });
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/leads/702/files/999999/analyze', headers: h })).statusCode).toBe(404);
  });

  it('прогон eval на модели из «Песочницы»: фоновый запуск, прогресс, итог по модели', async () => {
    const h = await admin();
    const denied = await ctx.app.inject({ method: 'POST', url: '/widget/v1/evals/run', headers: await user(), payload: { models: [{ provider: 'openai', model: 'gpt-5' }] } });
    expect(denied.statusCode).toBe(403);
    const dialogs = (await ctx.app.inject({ url: '/widget/v1/evals/dialogs', headers: h })).json();
    expect(dialogs.items.length).toBeGreaterThanOrEqual(50);
    const started = await ctx.app.inject({ method: 'POST', url: '/widget/v1/evals/run', headers: h, payload: { models: [{ provider: 'openai', model: 'gpt-5' }], ids: ['01-white-enamel'] } });
    expect(started.statusCode).toBe(202);
    const id = started.json().id as number;
    let run = null as null | { status: string; results: { ref: unknown; reports: { id: string; passed: boolean; fabricated: string[]; provider: string }[]; summary: { passed: number; fabricated: number; avgCostUsd: number } }[]; summary: unknown; progress: { done: number; total: number } };
    for (let i = 0; i < 100 && run?.status !== 'done' && run?.status !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 200));
      run = (await ctx.app.inject({ url: `/widget/v1/evals/runs/${id}`, headers: h })).json();
    }
    expect(run?.status).toBe('done');
    expect(run?.progress).toEqual({ done: 1, total: 1 });
    expect(run?.results[0]).toMatchObject({ ref: { provider: 'openai', model: 'gpt-5' }, summary: { total: 1, passed: 1, fabricated: 0, handoffExpected: 0 } });
    expect(run?.results[0]?.reports[0]).toMatchObject({ id: '01-white-enamel', passed: true, provider: 'openai', model: 'gpt-5' });
    expect((run?.results[0]?.summary.avgCostUsd ?? 0) > 0).toBe(true);
    const list = (await ctx.app.inject({ url: '/widget/v1/evals/runs', headers: h })).json();
    expect(list.items[0]).toMatchObject({ id, status: 'done' });
    // Временная схема удалена.
    const schemas = await ctx.deps.db.query(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname LIKE 'eval_%'`);
    expect(schemas.rows[0].n).toBe(0);
  });

  it('аналитика по провайдеру и модели', async () => {
    const a = (await ctx.app.inject({ url: '/widget/v1/analytics/models?days=7', headers: await admin() })).json();
    const gpt = a.items.find((x: { provider: string; model: string }) => x.provider === 'openai' && x.model === 'gpt-5');
    expect(gpt).toMatchObject({ dialogs: expect.any(Number), sandbox: expect.any(Number), costRub: expect.any(Number) });
    expect(gpt.sandbox).toBeGreaterThanOrEqual(2);
    expect(gpt.avgLatencyMs).toEqual(expect.any(Number));
  });
});
