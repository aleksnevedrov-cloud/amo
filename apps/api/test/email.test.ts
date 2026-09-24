import { composeRaw, type Mailbox, type OutgoingEmail } from '@ai-door/mail';
import { widgetSettingsSchema } from '@ai-door/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, widgetToken } from './helpers.ts';

let ctx: Awaited<ReturnType<typeof setup>>;
const sent: OutgoingEmail[] = [];
let imapFails = false;
const appended: string[] = [];

const mailbox: Mailbox = {
  folderState: async () => {
    if (imapFails) throw new Error('AUTHENTICATIONFAILED Invalid credentials');
    return { uidValidity: '1', maxUid: 0 };
  },
  fetchAfter: async () => [],
  findSentFolder: async () => 'Отправленные',
  append: async (folder) => void appended.push(folder),
  close: async () => undefined,
};

beforeAll(async () => {
  ctx = await setup({
    mailConnect: async () => mailbox,
    mailSender: () => ({ send: async (m) => (sent.push(m), composeRaw(m)), verify: async () => undefined }),
  });
  await ctx.app.inject({ url: '/oauth/amo/callback', query: { code: 'C', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
  await ctx.deps.settings.save(
    31337,
    1,
    widgetSettingsSchema.parse({ email: { enabled: true, imapHost: 'imap.yandex.ru', smtpHost: 'smtp.yandex.ru', username: 'shop@rf-dveri.ru' } }),
  );
});
afterAll(async () => ctx.close());

const admin = async () => ({ 'x-auth-token': await widgetToken() });
const user = async () => ({ 'x-auth-token': await widgetToken({ is_admin: false }) });

describe('пароль и проверка подключения', () => {
  it('без пароля проверка невозможна; пароль задаёт только админ и не возвращается', async () => {
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/email/test', headers: await admin() })).json()).toEqual({ error: 'no_password' });
    expect((await ctx.app.inject({ method: 'PUT', url: '/widget/v1/email/password', headers: await user(), payload: { password: 'x' } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'PUT', url: '/widget/v1/email/password', headers: await admin(), payload: { password: 'app-pass' } })).statusCode).toBe(200);
    const st = await ctx.app.inject({ url: '/widget/v1/email/status', headers: await user() });
    expect(st.json()).toMatchObject({ enabled: true, hasPassword: true });
    expect(st.body).not.toContain('app-pass');
    // И в настройках пароля нет.
    expect((await ctx.app.inject({ url: '/widget/v1/settings', headers: await admin() })).body).not.toContain('app-pass');
  });

  it('проверка: IMAP и SMTP в порядке, папка «Отправленные» найдена', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: '/widget/v1/email/test', headers: await admin() });
    expect(r.json()).toEqual({ imap: 'ok', smtp: 'ok', sentFolder: 'Отправленные' });
  });

  it('проверка: понятная ошибка IMAP', async () => {
    imapFails = true;
    const r = await ctx.app.inject({ method: 'POST', url: '/widget/v1/email/test', headers: await admin() });
    imapFails = false;
    expect(r.json()).toMatchObject({ imap: expect.stringContaining('AUTHENTICATIONFAILED'), smtp: 'ok' });
  });
});

describe('черновик ответа на письмо', () => {
  it('одобрение отправляет письмо сразу, без бота-отправщика', async () => {
    const id = await ctx.deps.suggestions.add(31337, 950, 'draft', 'Добрый день! Турин 1 — 14 900 ₽.', {
      channel: 'email',
      emailMeta: { from: 'ivan@client.ru', fromName: 'Иван', subject: 'Двери', messageId: '<m1@client.ru>', references: [] },
    });
    const res = await ctx.app.inject({ method: 'POST', url: `/widget/v1/suggestions/${id}/approve`, headers: await user(), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(sent.at(-1)).toMatchObject({ to: { address: 'ivan@client.ru' }, subject: 'Re: Двери', inReplyTo: '<m1@client.ru>' });
    expect(appended).toContain('Отправленные');
    expect((await ctx.deps.suggestions.get(31337, id))?.status).toBe('sent');
    expect(ctx.amo.calls.some((c) => c.url.endsWith('/api/v2/salesbot/run'))).toBe(false);
  });
});
