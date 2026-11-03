// RETAIL-WIDGET-WINDOW: лента переписки по сделке, ответ менеджера из окна (Wazzup, только по кнопке, запись в журнал),
// режим из окна (только администратор), сбои загрузки виджета — в журнал.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, widgetToken } from './helpers.ts';

const LEAD = 29986849;
const PHONE = '79773793480';
// Время сообщений Wazzup — минуты назад: диалог агента пишется в ту же минуту, что и вебхук Wazzup.
const t = (minutesAgo: string) => new Date(Date.now() - Number(minutesAgo) * 60_000);

describe('окно виджета: диалог, ответ клиенту, режим (RETAIL-WIDGET-WINDOW)', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let headers: Record<string, string>;
  const sent: { body: Record<string, unknown>; auth: string | null }[] = [];
  let wazzupStatus = 201;
  beforeAll(async () => {
    ctx = await setup();
    headers = { 'x-auth-token': await widgetToken() };
    await ctx.app.inject({ url: '/oauth/amo/callback', query: { code: 'CODE', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
    // amo: контакт сделки с телефоном, пользователи; Wazzup: отправка сообщения.
    const base = ctx.deps.fetch;
    ctx.deps.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/api/v4/contacts/77')) return json(200, { id: 77, name: 'Клиент', custom_fields_values: [{ field_id: 1, field_code: 'PHONE', values: [{ value: '+7 977 379-34-80' }] }] });
      if (url.includes('/api/v4/users')) return json(200, { _embedded: { users: [{ id: 7, name: 'Анна Петрова', rights: { is_active: true, is_admin: true } }] } });
      if (url === 'https://api.wazzup24.com/v3/message') {
        sent.push({ body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get('authorization') });
        return wazzupStatus < 300 ? json(wazzupStatus, { messageId: 'm-out-1' }) : json(wazzupStatus, { error: 'channel not available' });
      }
      return base(input, init);
    }) as typeof fetch;
    const acc = 31337;
    const w = (id: string, direction: 'in' | 'out', author: 'client' | 'manager' | 'agent', text: string, at: Date, isSystem = false) =>
      ctx.deps.wazzup.upsert(acc, { messageId: id, channelId: 'ch-wa', chatId: PHONE, chatType: 'whatsapp', phone: PHONE, direction, author, text, status: 'delivered', isSystem, sentAt: at, source: 'webhook' });
    await w('w1', 'in', 'client', 'Здравствуйте, интересует Валенсия ПГ, 2 шт', t('30'));
    await ctx.deps.dialog.addMessage(acc, LEAD, 'client', 'Здравствуйте, интересует Валенсия ПГ, 2 шт');
    await ctx.deps.dialog.addMessage(acc, LEAD, 'ai', 'Валенсия ПГ — 12 900 ₽, в наличии');
    await ctx.deps.journal.add({ accountId: acc, leadId: LEAD, kind: 'reply', summary: 'Валенсия ПГ — 12 900 ₽, в наличии', details: { provider: 'openai', model: 'gpt-5.5', channel: 'chat', incoming: ['Здравствуйте, интересует Валенсия ПГ, 2 шт'] } });
    await w('w2', 'out', 'manager', 'Валенсия ПГ — 12 900 ₽, в наличии', t('29'));
    await w('w3', 'out', 'manager', '=== SYSTEM WZ === чат передан', t('28'));
    await w('w4', 'in', 'client', 'системное', t('27'), true);
    await w('w5', 'out', 'manager', 'Юрист по рамкам свяжется с вами', t('25'));
    // Письмо клиента (почта) — только в диалоге агента.
    await ctx.deps.dialog.addMessage(acc, LEAD, 'client', 'Пришлите счёт на почту');
    await ctx.deps.suggestions.add(acc, LEAD, 'hint', 'Предложите доставку на завтра', {});
  });
  afterAll(() => ctx.close());

  const dialog = async () => (await ctx.app.inject({ url: `/widget/v1/leads/${LEAD}/dialog`, headers })).json();

  it('лента: клиент (WhatsApp), агент с моделью, менеджер из мессенджера, сообщение диалога вне Wazzup, подсказка «не отправлена»; системные Wazzup скрыты', async () => {
    const d = await dialog();
    expect(d.items.map((i: { who: string; channelLabel: string | null; text: string; model?: string; notSent?: boolean }) => [i.who, i.channelLabel, i.text, i.model ?? null, i.notSent ?? false])).toEqual([
      ['client', 'WhatsApp', 'Здравствуйте, интересует Валенсия ПГ, 2 шт', null, false],
      ['agent', 'WhatsApp', 'Валенсия ПГ — 12 900 ₽, в наличии', 'gpt-5.5', false],
      ['manager', 'WhatsApp', 'Юрист по рамкам свяжется с вами', null, false],
      ['client', 'чат amo', 'Пришлите счёт на почту', null, false],
      ['hint', null, 'Предложите доставку на завтра', null, true],
    ]);
    expect(JSON.stringify(d.items)).not.toContain('SYSTEM WZ');
    expect(JSON.stringify(d.items)).not.toContain('системное');
  });

  it('без ключа Wazzup — отправка недоступна с причиной (запасной вариант «Скопировать / Открыть чат»)', async () => {
    expect((await dialog()).send).toEqual({ available: false, reason: 'Wazzup не подключён — ответ из окна недоступен; скопируйте текст и отправьте в чате amo' });
    expect((await ctx.app.inject({ method: 'POST', url: `/widget/v1/leads/${LEAD}/send`, headers, payload: { text: 'тест' } })).json()).toMatchObject({ error: 'no_key' });
    await ctx.deps.secrets.set(31337, 'wazzup', 'wz-key-1', 7);
  });

  it('«Отправить»: в тот же чат WhatsApp от имени менеджера; журнал — кто, канал, текст; в ленте «Менеджер · имя»; повтор того же текста — 409', async () => {
    expect((await dialog()).send).toEqual({ available: true, channel: 'whatsapp', channelLabel: 'WhatsApp', reason: null });
    expect((await ctx.app.inject({ method: 'POST', url: `/widget/v1/leads/${LEAD}/send`, headers, payload: { text: '   ' } })).statusCode).toBe(400);
    const r = await ctx.app.inject({ method: 'POST', url: `/widget/v1/leads/${LEAD}/send`, headers, payload: { text: 'Анна, менеджер: счёт отправлю сегодня' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, channel: 'whatsapp', userName: 'Анна Петрова' });
    expect(sent).toEqual([{ body: { channelId: 'ch-wa', chatId: PHONE, chatType: 'whatsapp', text: 'Анна, менеджер: счёт отправлю сегодня', crmUserId: '7' }, auth: 'Bearer wz-key-1' }]);
    const log = (await ctx.app.inject({ url: `/widget/v1/journal?leadId=${LEAD}`, headers })).json().items as { kind: string; summary: string; details: Record<string, unknown> }[];
    expect(log.find((e) => e.kind === 'manager_send')).toMatchObject({ summary: 'Анна, менеджер: счёт отправлю сегодня', details: { userId: 7, userName: 'Анна Петрова', channel: 'whatsapp', via: 'wazzup' } });
    // Повторное нажатие с тем же текстом — не отправляется.
    expect((await ctx.app.inject({ method: 'POST', url: `/widget/v1/leads/${LEAD}/send`, headers, payload: { text: 'Анна, менеджер: счёт отправлю сегодня' } })).json()).toMatchObject({ error: 'duplicate' });
    expect(sent).toHaveLength(1);
    // Эхо Wazzup вернулось — в ленте «Менеджер · Анна Петрова».
    await ctx.deps.wazzup.upsert(31337, { messageId: 'm-out-1', channelId: 'ch-wa', chatId: PHONE, chatType: 'whatsapp', phone: PHONE, direction: 'out', author: 'manager', text: 'Анна, менеджер: счёт отправлю сегодня', status: 'sent', isSystem: false, sentAt: new Date(), source: 'webhook' });
    const items = (await dialog()).items as { who: string; managerName?: string | null; text: string }[];
    expect(items.filter((i) => i.text === 'Анна, менеджер: счёт отправлю сегодня')).toEqual([expect.objectContaining({ who: 'manager', managerName: 'Анна Петрова' })]);
  });

  it('Wazzup отклонил — 502 с причиной и запись об ошибке в журнале', async () => {
    wazzupStatus = 400;
    const r = await ctx.app.inject({ method: 'POST', url: `/widget/v1/leads/${LEAD}/send`, headers, payload: { text: 'второе сообщение' } });
    wazzupStatus = 201;
    expect(r.statusCode).toBe(502);
    expect(r.json().message).toContain('HTTP 400');
    const log = (await ctx.app.inject({ url: `/widget/v1/journal?leadId=${LEAD}&kind=error`, headers })).json().items as { summary: string }[];
    expect(log[0]?.summary).toContain('Ответ менеджера не отправлен (WhatsApp): HTTP 400');
  });

  it('режим из окна — только администратор; сбой загрузки виджета — в журнал', async () => {
    const user = { 'x-auth-token': await widgetToken({ is_admin: false }) };
    expect((await ctx.app.inject({ method: 'PUT', url: '/widget/v1/settings/mode', headers: user, payload: { mode: 'semi' } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'PUT', url: '/widget/v1/settings/mode', headers, payload: { mode: 'semi' } })).json()).toMatchObject({ mode: 'semi' });
    expect((await ctx.app.inject({ url: '/widget/v1/settings', headers })).json().settings.mode).toBe('semi');
    const e = await ctx.app.inject({ method: 'POST', url: '/widget/v1/client-errors', headers, payload: { method: 'GET', path: `/widget/v1/leads/${LEAD}/panel`, reason: 'таймаут', status: null, attempts: 2, recovered: true, leadId: LEAD } });
    expect(e.json()).toEqual({ ok: true });
    const log = (await ctx.app.inject({ url: `/widget/v1/journal?leadId=${LEAD}&kind=note`, headers })).json().items as { summary: string }[];
    expect(log.map((x) => x.summary)).toContain(`Виджет: GET /leads/${LEAD}/panel — таймаут, повтор помог (попытка 2)`);
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/client-errors', headers, payload: { method: 'GET', path: `/widget/v1/leads/${LEAD}/panel`, reason: 'HTTP 502', status: 502, attempts: 3, recovered: false, leadId: LEAD } });
    const errors = (await ctx.app.inject({ url: `/widget/v1/journal?leadId=${LEAD}&kind=error`, headers })).json().items as { summary: string }[];
    expect(errors[0]?.summary).toBe(`Виджет: GET /leads/${LEAD}/panel — HTTP 502, попыток без ответа: 3`);
  });
});
