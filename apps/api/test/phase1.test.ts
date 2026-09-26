import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScriptedLlm, text, toolUse } from '../../../packages/agent/test/scripted-llm.ts';
import { botToken, setup, widgetToken } from './helpers.ts';

let ctx: Awaited<ReturnType<typeof setup>>;
const llmSteps: ConstructorParameters<typeof ScriptedLlm>[0] = [];

beforeAll(async () => {
  ctx = await setup({ llm: new ScriptedLlm(llmSteps) });
  await ctx.app.inject({ url: '/oauth/amo/callback', query: { code: 'C', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
});
afterAll(async () => ctx.close());

const hook = async (body: Record<string, unknown>) => ctx.app.inject({ method: 'POST', url: '/salesbot/v1/hook', payload: body });
const RETURN = 'https://aleksnevedrov.amocrm.ru/api/v4/salesbot/1/continue/2';

describe('Salesbot widget_request', () => {
  it('ставит сообщение в очередь со склейкой', async () => {
    const res = await hook({ token: await botToken(), data: { lead_id: '555', message: 'Нужна дверь' }, return_url: RETURN });
    expect(res.statusCode).toBe(200);
    expect(ctx.scheduled.at(-1)).toEqual({ job: { accountId: 31337, leadId: 555 }, windowMs: 8000 });
    const pending = await ctx.deps.dialog.takePending(31337, 555);
    expect(pending).toMatchObject([{ text: 'Нужна дверь', returnUrl: RETURN }]);
  });

  it('пустой текст заменяется пометкой о вложении', async () => {
    await hook({ token: await botToken(), data: { lead_id: 556 }, return_url: RETURN });
    expect((await ctx.deps.dialog.takePending(31337, 556))[0]?.text).toMatch(/без текста/);
  });

  it.each([
    ['поддельный токен', async () => ({ token: await botToken(undefined, 'x'.repeat(40)), data: { lead_id: 1 }, return_url: RETURN }), 401],
    ['чужой аккаунт', async () => ({ token: await botToken({ account_id: 999 }), data: { lead_id: 1 }, return_url: RETURN }), 404],
    ['return_url на чужой домен', async () => ({ token: await botToken(), data: { lead_id: 1 }, return_url: 'https://evil.com/c' }), 400],
    ['без lead_id', async () => ({ token: await botToken(), data: {}, return_url: RETURN }), 400],
  ])('отклоняет: %s', async (_name, body, code) => {
    expect((await hook(await body())).statusCode).toBe(code);
  });
});

describe('песочница', () => {
  it('отвечает с инструментами, источниками и стоимостью, пишет в журнал', async () => {
    await ctx.deps.importer.importFromBytes(31337, new Uint8Array((await import('node:fs')).readFileSync(new URL('../../../evals/fixtures/catalog.yml', import.meta.url))));
    llmSteps.push(toolUse(['catalog_search', { query: 'экошпон' }]), text('Порта 21 экошпон дуб бежевый — 7 900 ₽, в наличии.'));
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/widget/v1/sandbox',
      headers: { 'x-auth-token': await widgetToken() },
      payload: { messages: [{ role: 'client', text: 'Нужна недорогая дверь в экошпоне' }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ kind: 'reply', text: 'Порта 21 экошпон дуб бежевый — 7 900 ₽, в наличии.' });
    expect(body.toolCalls[0]).toMatchObject({ specName: 'catalog.search', ok: true });
    expect(body.sources.length).toBeGreaterThan(0);
    expect(body.cost.rub).toBeGreaterThan(0);
    const j = await ctx.app.inject({ url: '/widget/v1/journal?kind=sandbox', headers: { 'x-auth-token': await widgetToken() } });
    expect(j.json().items[0]).toMatchObject({ kind: 'sandbox' });
  });

  it('последнее сообщение должно быть от клиента', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/widget/v1/sandbox',
      headers: { 'x-auth-token': await widgetToken() },
      payload: { messages: [{ role: 'ai', text: 'Здравствуйте' }] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('панель сделки', () => {
  it('пауза и возврат AI с записью в журнал', async () => {
    const h = { 'x-auth-token': await widgetToken({ is_admin: false }) };
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/leads/700/pause', headers: h });
    let panel = (await ctx.app.inject({ url: '/widget/v1/leads/700/panel', headers: h })).json();
    expect(panel.ai).toMatchObject({ paused: true, pauseReason: 'manual:7' });
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/leads/700/resume', headers: h });
    panel = (await ctx.app.inject({ url: '/widget/v1/leads/700/panel', headers: h })).json();
    expect(panel.ai.paused).toBe(false);
    expect(panel.log.map((e: { kind: string }) => e.kind)).toEqual(['resume', 'pause']);
  });
});

describe('база знаний и каталог', () => {
  it('добавление только админом, список, удаление', async () => {
    const user = { 'x-auth-token': await widgetToken({ is_admin: false }) };
    const admin = { 'x-auth-token': await widgetToken() };
    const payload = { kind: 'faq', question: 'Есть ли рассрочка?', answer: 'Да, рассрочка на 6 месяцев.' };
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/knowledge', headers: user, payload })).statusCode).toBe(403);
    const created = await ctx.app.inject({ method: 'POST', url: '/widget/v1/knowledge', headers: admin, payload });
    expect(created.statusCode).toBe(200);
    const list = (await ctx.app.inject({ url: '/widget/v1/knowledge', headers: user })).json();
    expect(list.items[0]).toMatchObject({ kind: 'faq', title: 'Есть ли рассрочка?' });
    const del = await ctx.app.inject({ method: 'DELETE', url: `/widget/v1/knowledge/${created.json().id}`, headers: admin });
    expect(del.statusCode).toBe(200);
  });

  it('импорт каталога без адреса фида — 400; статус включает каталог и расход', async () => {
    const admin = { 'x-auth-token': await widgetToken() };
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/catalog/import', headers: admin })).statusCode).toBe(400);
    const status = (await ctx.app.inject({ url: '/widget/v1/status', headers: admin })).json();
    expect(status).toMatchObject({ llmConfigured: true, catalog: { products: 16 }, spend: { todayRub: expect.any(Number) } });
  });
});

describe('без ключа LLM', () => {
  it('песочница отвечает 503', async () => {
    const c2 = await setup({ llm: null });
    const res = await c2.app.inject({
      method: 'POST',
      url: '/widget/v1/sandbox',
      headers: { 'x-auth-token': await widgetToken() },
      payload: { messages: [{ role: 'client', text: 'Привет' }] },
    });
    expect(res.statusCode).toBe(503);
    await c2.close();
  });
});

describe('справочники amo', () => {
  it('воронки, этапы и типы задач', async () => {
    const res = await ctx.app.inject({ url: '/widget/v1/amo/dictionaries', headers: { 'x-auth-token': await widgetToken() } });
    expect(res.json()).toEqual({
      pipelines: [{ id: 1, name: 'Продажи', statuses: [{ id: 10, name: 'Новая', sort: 10 }] }],
      taskTypes: [{ id: 1, name: 'Связаться' }],
    });
  });
});
