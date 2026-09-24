import { readFileSync } from 'node:fs';
import { exportRulesXlsx, pricingRulesSchema } from '@ai-door/pricing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScriptedLlm, text, toolUse } from '../../../packages/agent/test/scripted-llm.ts';
import { botToken, setup, widgetToken } from './helpers.ts';

let ctx: Awaited<ReturnType<typeof setup>>;
const steps: ConstructorParameters<typeof ScriptedLlm>[0] = [];
const RULES = {
  sizes: { nonStandardMarkupPct: 30 },
  components: [
    { code: 'box', name: 'Коробка телескоп', qtyPerDoor: 2.5, defaultPrice: 1200 },
    { code: 'casing', name: 'Наличник телескоп', qtyPerDoor: 5, defaultPrice: 800 },
  ],
  services: [{ code: 'delivery_mkad', name: 'Доставка в пределах МКАД', unit: 'fixed', price: 0 }],
};
const admin = async () => ({ 'x-auth-token': await widgetToken() });
const user = async () => ({ 'x-auth-token': await widgetToken({ is_admin: false }) });

beforeAll(async () => {
  ctx = await setup({ llm: new ScriptedLlm(steps) });
  await ctx.app.inject({ url: '/oauth/amo/callback', query: { code: 'C', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
  await ctx.deps.importer.importFromBytes(31337, new Uint8Array(readFileSync(new URL('../../../evals/fixtures/catalog.yml', import.meta.url))));
});
afterAll(async () => ctx.close());

describe('правила цен', () => {
  it('сохранение только админом, валидация, чтение', async () => {
    expect((await ctx.app.inject({ method: 'PUT', url: '/widget/v1/pricing', headers: await user(), payload: RULES })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'PUT', url: '/widget/v1/pricing', headers: await admin(), payload: { components: [{ code: 'BAD CODE' }] } })).statusCode).toBe(400);
    const ok = await ctx.app.inject({ method: 'PUT', url: '/widget/v1/pricing', headers: await admin(), payload: RULES });
    expect(ok.json()).toMatchObject({ version: 1 });
    const got = (await ctx.app.inject({ url: '/widget/v1/pricing', headers: await user() })).json();
    expect(got.rules.components).toHaveLength(2);
  });

  it('импорт XLSX (предпросмотр и сохранение) и экспорт', async () => {
    const file = Buffer.from(await exportRulesXlsx(pricingRulesSchema.parse({ ...RULES, services: [] }))).toString('base64');
    const preview = await ctx.app.inject({ method: 'POST', url: '/widget/v1/pricing/import', headers: await admin(), payload: { file } });
    expect(preview.json()).toMatchObject({ saved: false, rules: { services: [] } });
    const bad = await ctx.app.inject({ method: 'POST', url: '/widget/v1/pricing/import', headers: await admin(), payload: { file: Buffer.from('x').toString('base64') } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().problems[0]).toMatch(/Excel/);
    const exp = (await ctx.app.inject({ url: '/widget/v1/pricing/export', headers: await user() })).json();
    expect(exp.name).toBe('pravila-cen.xlsx');
    expect(exp.file.length).toBeGreaterThan(100);
  });

  it('тест расчёта по товарам каталога', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/widget/v1/pricing/test',
      headers: await user(),
      payload: { doors: [{ product_id: '1004', width_mm: 800, height_mm: 2000, qty: 2 }], services: [{ code: 'delivery_mkad' }] },
    });
    const body = res.json();
    expect(body.result.total).toBe(7900 * 2 + 5 * 1200 + 10 * 800);
    expect(body.text).toContain('Черновик детализации');
    const nf = await ctx.app.inject({ method: 'POST', url: '/widget/v1/pricing/test', headers: await user(), payload: { doors: [{ product_id: 'x', qty: 1 }] } });
    expect(nf.statusCode).toBe(404);
  });
});

describe('черновики: одобрение и отправка ботом-отправщиком', () => {
  it('без бота-отправщика — 409; с ботом — запуск бота и отправка через continue', async () => {
    const id = await ctx.deps.suggestions.add(31337, 900, 'draft', 'Здравствуйте! Турин 1 — 14 900 ₽.');
    const h = await user();
    expect((await ctx.app.inject({ method: 'POST', url: `/widget/v1/suggestions/${id}/approve`, headers: h, payload: {} })).statusCode).toBe(409);

    const { settings } = await ctx.deps.settings.get(31337);
    await ctx.deps.settings.save(31337, 1, { ...settings, salesbot: { senderBotId: 42 } });
    const res = await ctx.app.inject({ method: 'POST', url: `/widget/v1/suggestions/${id}/approve`, headers: h, payload: { text: 'Здравствуйте! Турин 1 — 14 900 ₽, в наличии.' } });
    expect(res.statusCode).toBe(200);
    const run = ctx.amo.calls.find((c) => c.url.endsWith('/api/v2/salesbot/run'));
    expect(run?.body).toEqual([{ bot_id: 42, entity_id: 900, entity_type: 2 }]);

    // Бот-отправщик приходит за черновиком.
    const RETURN = 'https://aleksnevedrov.amocrm.ru/api/v4/salesbot/7/continue/8';
    const hook = await ctx.app.inject({ method: 'POST', url: '/salesbot/v1/hook', payload: { token: await botToken(), data: { lead_id: 900, kind: 'send' }, return_url: RETURN } });
    expect(hook.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    const cont = ctx.amo.calls.find((c) => c.url === RETURN);
    expect(cont?.body).toMatchObject({ execute_handlers: [{ handler: 'show', params: { value: 'Здравствуйте! Турин 1 — 14 900 ₽, в наличии.' } }] });
    expect((await ctx.deps.suggestions.get(31337, id))?.status).toBe('sent');
    expect((await ctx.deps.dialog.history(31337, 900)).at(-1)).toMatchObject({ role: 'ai' });
  });

  it('отклонение и подсказка «использована»', async () => {
    const d = await ctx.deps.suggestions.add(31337, 901, 'draft', 'x');
    const hnt = await ctx.deps.suggestions.add(31337, 901, 'hint', 'y');
    const h = await user();
    expect((await ctx.app.inject({ method: 'POST', url: `/widget/v1/suggestions/${d}/reject`, headers: h })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'POST', url: `/widget/v1/suggestions/${d}/reject`, headers: h })).statusCode).toBe(409);
    expect((await ctx.app.inject({ method: 'POST', url: `/widget/v1/suggestions/${hnt}/used`, headers: h })).statusCode).toBe(200);
    const list = (await ctx.app.inject({ url: '/widget/v1/suggestions?leadId=901', headers: h })).json().items;
    expect(list.map((x: { status: string }) => x.status)).toEqual(['used', 'rejected']);
  });

  it('вложение из Salesbot сохраняется для расшифровки', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/salesbot/v1/hook',
      payload: { token: await botToken(), data: { lead_id: 902, attachment_url: 'https://drive.amocrm.ru/v.ogg', attachment_type: 'voice' }, return_url: 'https://aleksnevedrov.amocrm.ru/c' },
    });
    expect((await ctx.deps.dialog.takePending(31337, 902))[0]).toMatchObject({ text: '', attachmentType: 'voice' });
  });
});

describe('резюме и песочница', () => {
  it('резюме по кнопке — в примечание и память', async () => {
    await ctx.deps.dialog.addMessage(31337, 903, 'client', 'Нужны 2 белые двери');
    steps.push(text('Потребность: 2 белые двери.'));
    const res = await ctx.app.inject({ method: 'POST', url: '/widget/v1/leads/903/summary', headers: await user() });
    expect(res.json()).toMatchObject({ text: 'Потребность: 2 белые двери.' });
    expect(ctx.amo.calls.some((c) => c.url.endsWith('/api/v4/leads/903/notes'))).toBe(true);
    expect((await ctx.deps.memory.get(31337, 'contact:77')).summary).toBe('Потребность: 2 белые двери.');
  });

  it('песочница считает по правилам и показывает расчёт и память', async () => {
    steps.push(
      toolUse(['price_calculate', { doors: [{ product_id: '1004', width_mm: 800, height_mm: 2000, qty: 2 }] }], ['memory_save', { budget_rub: 40000 }]),
      text('Две двери Порта 21 с комплектом — 29 800 ₽. Расчёт предварительный.'),
    );
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/widget/v1/sandbox',
      headers: await user(),
      payload: { messages: [{ role: 'client', text: 'Посчитайте 2 двери Порта 21, бюджет 40000' }] },
    });
    const b = res.json();
    expect(b.kind).toBe('reply');
    expect(b.calculation.total).toBe(29800);
    expect(b.memory.budget_rub).toBe(40000);
  });
});
