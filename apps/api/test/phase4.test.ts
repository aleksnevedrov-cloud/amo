import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, widgetToken } from './helpers.ts';

let ctx: Awaited<ReturnType<typeof setup>>;

beforeAll(async () => {
  ctx = await setup();
  await ctx.app.inject({ url: '/oauth/amo/callback', query: { code: 'C', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
});
afterAll(async () => ctx.close());

const admin = async () => ({ 'x-auth-token': await widgetToken() });
const user = async () => ({ 'x-auth-token': await widgetToken({ is_admin: false }) });
const stranger = async () => ({ 'x-auth-token': await widgetToken({ account_id: 424242 }) });

describe('аналитика и учёт расходов', () => {
  it('сводка и расход по месяцам; чужой аккаунт видит нули', async () => {
    await ctx.deps.journal.add({ accountId: 31337, leadId: 1, kind: 'reply', summary: 'a', costRub: 2.5 });
    await ctx.deps.journal.add({ accountId: 31337, leadId: 1, kind: 'handoff', summary: 'b', details: { reason: 'wholesale' } });
    await ctx.deps.outcomes.start(31337, 1, 1, 10);
    const a = (await ctx.app.inject({ url: '/widget/v1/analytics?days=7', headers: await user() })).json();
    expect(a).toMatchObject({ dialogs: 1, replies: 1, handoffs: 1, costRub: 2.5, outcomes: { tracked: 1, advanced: 0 } });
    expect(a.handoffReasons).toEqual([{ reason: 'wholesale', count: 1 }]);
    const b = (await ctx.app.inject({ url: '/widget/v1/billing', headers: await user() })).json();
    expect(b.months[0]).toMatchObject({ costRub: 2.5, replies: 1 });
    const other = (await ctx.app.inject({ url: '/widget/v1/analytics?days=7', headers: await stranger() })).json();
    expect(other).toMatchObject({ dialogs: 0, costRub: 0 });
  });
});

describe('версии настроек', () => {
  it('история, снимок, откат только админом', async () => {
    const { settings } = await ctx.deps.settings.get(31337);
    await ctx.deps.settings.save(31337, 7, { ...settings, behavior: { ...settings.behavior, greeting: 'Привет!' } });
    await ctx.deps.settings.save(31337, 7, { ...settings, behavior: { ...settings.behavior, greeting: 'Здравствуйте!' } });
    const h = (await ctx.app.inject({ url: '/widget/v1/settings/history', headers: await user() })).json();
    expect(h.items.length).toBeGreaterThanOrEqual(2);
    expect(h.items[0].changed).toEqual(['behavior']);
    const first = h.items[1].id;
    const snap = (await ctx.app.inject({ url: `/widget/v1/settings/history/${first}`, headers: await user() })).json();
    expect(snap.settings.behavior.greeting).toBe('Привет!');
    expect((await ctx.app.inject({ method: 'POST', url: `/widget/v1/settings/history/${first}/restore`, headers: await user() })).statusCode).toBe(403);
    const r = await ctx.app.inject({ method: 'POST', url: `/widget/v1/settings/history/${first}/restore`, headers: await admin() });
    expect(r.statusCode).toBe(200);
    expect((await ctx.deps.settings.get(31337)).settings.behavior.greeting).toBe('Привет!');
    expect((await ctx.app.inject({ url: '/widget/v1/settings/history/999999', headers: await user() })).statusCode).toBe(404);
  });
});

describe('изоляция аккаунтов и удаление данных', () => {
  it('токен другого аккаунта не видит чужие данные', async () => {
    const j = (await ctx.app.inject({ url: '/widget/v1/journal', headers: await stranger() })).json();
    expect(j.items).toEqual([]);
    const docs = (await ctx.app.inject({ url: '/widget/v1/leads/1/documents', headers: await stranger() })).json();
    expect(docs.items).toEqual([]);
    const st = (await ctx.app.inject({ url: '/widget/v1/status', headers: await stranger() })).json();
    expect(st.connected).toBe(false);
  });

  it('purge: только админ, только с подтверждением; после — аккаунт не подключён', async () => {
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/account/purge', headers: await user(), payload: { confirm: 'УДАЛИТЬ' } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/account/purge', headers: await admin(), payload: { confirm: 'да' } })).statusCode).toBe(400);
    const r = await ctx.app.inject({ method: 'POST', url: '/widget/v1/account/purge', headers: await admin(), payload: { confirm: 'УДАЛИТЬ' } });
    expect(r.json()).toEqual({ ok: true });
    expect(ctx.alerts.some((a) => a.includes('31337') && a.includes('удалены'))).toBe(true);
    expect((await ctx.app.inject({ url: '/widget/v1/status', headers: await admin() })).json().connected).toBe(false);
    expect((await ctx.app.inject({ url: '/widget/v1/journal', headers: await admin() })).json().items).toEqual([]);
  });
});

describe('ключ Anthropic аккаунта', () => {
  it('статус, проверка (без расходов), сохранение только админом, удаление', async () => {
    const ctx2 = await setup({ llm: null });
    try {
      await ctx2.app.inject({ url: '/oauth/amo/callback', query: { code: 'C', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
      const st0 = (await ctx2.app.inject({ url: '/widget/v1/llm/status', headers: await user() })).json();
      expect(st0).toEqual({ hasOwnKey: false, configured: false, source: null });
      expect((await ctx2.app.inject({ url: '/widget/v1/status', headers: await user() })).json().llmConfigured).toBe(false);
      expect((await ctx2.app.inject({ method: 'POST', url: '/widget/v1/sandbox', headers: await user(), payload: { messages: [{ role: 'client', text: 'Привет' }] } })).statusCode).toBe(503);

      const bad = (await ctx2.app.inject({ method: 'POST', url: '/widget/v1/llm/test', headers: await admin(), payload: { key: 'sk-ant-bad-000000000000000000' } })).json();
      expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('не принят') });
      const good = (await ctx2.app.inject({ method: 'POST', url: '/widget/v1/llm/test', headers: await admin(), payload: { key: 'sk-ant-good-00000000000000000' } })).json();
      expect(good).toEqual({ ok: true, models: ['claude-opus-5', 'claude-sonnet-5'] });

      expect((await ctx2.app.inject({ method: 'PUT', url: '/widget/v1/llm/key', headers: await user(), payload: { key: 'sk-ant-good-00000000000000000' } })).statusCode).toBe(403);
      expect((await ctx2.app.inject({ method: 'PUT', url: '/widget/v1/llm/key', headers: await admin(), payload: { key: 'short' } })).statusCode).toBe(400);
      expect((await ctx2.app.inject({ method: 'PUT', url: '/widget/v1/llm/key', headers: await admin(), payload: { key: 'sk-ant-good-00000000000000000' } })).statusCode).toBe(200);
      const st1 = (await ctx2.app.inject({ url: '/widget/v1/llm/status', headers: await user() })).json();
      expect(st1).toEqual({ hasOwnKey: true, configured: true, source: 'account' });
      expect((await ctx2.app.inject({ url: '/widget/v1/status', headers: await user() })).json().llmConfigured).toBe(true);
      // Ключ не утекает ни в статус, ни в настройки, ни в журнал.
      for (const url of ['/widget/v1/llm/status', '/widget/v1/settings', '/widget/v1/journal']) {
        expect((await ctx2.app.inject({ url, headers: await admin() })).body).not.toContain('sk-ant-good');
      }
      expect(await ctx2.deps.secrets.get(31337, 'anthropic')).toBe('sk-ant-good-00000000000000000');

      expect((await ctx2.app.inject({ method: 'DELETE', url: '/widget/v1/llm/key', headers: await admin() })).statusCode).toBe(200);
      expect((await ctx2.app.inject({ url: '/widget/v1/llm/status', headers: await user() })).json().hasOwnKey).toBe(false);
    } finally {
      await ctx2.close();
    }
  });
});

describe('юридические страницы', () => {
  it('политика и соглашение доступны без авторизации, HTML и Markdown', async () => {
    const p = await ctx.app.inject({ url: '/legal/privacy' });
    expect(p.statusCode).toBe(200);
    expect(p.headers['content-type']).toContain('text/html');
    expect(p.body).toContain('<h1>Политика конфиденциальности');
    expect(p.body).toContain('<b>не передаются</b>');
    expect(p.body).toContain('support@rf-dveri.ru');
    const t = await ctx.app.inject({ url: '/legal/terms.md' });
    expect(t.headers['content-type']).toContain('text/markdown');
    expect(t.body).toContain('# Пользовательское соглашение');
  });
});
