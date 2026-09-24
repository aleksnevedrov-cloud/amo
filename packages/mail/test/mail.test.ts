import { randomBytes } from 'node:crypto';
import { AccountsRepo, type Db } from '@ai-door/db';
import { SecretBox } from '@ai-door/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb } from '../../db/test/setup.ts';
import { buildReply, composeRaw, isIgnored, isNoReply, MailRepo, parseEmail, replySubject, stripQuoted, type OutgoingEmail } from '../src/index.ts';

const clientMail = (over: Partial<OutgoingEmail> = {}): OutgoingEmail => ({
  from: { name: 'Иван Петров', address: 'ivan@client.ru' },
  to: { name: 'РФ-Двери', address: 'shop@rf-dveri.ru' },
  subject: 'Двери в квартиру',
  text: 'Здравствуйте! Нужны 3 белые двери 80 см.\n\n24 сент. 2026 г., в 10:00, РФ-Двери <shop@rf-dveri.ru>:\n> Добрый день! Чем помочь?',
  html: '',
  messageId: '<m1@client.ru>',
  headers: {},
  ...over,
});

describe('parseEmail', () => {
  it('разбирает письмо и убирает цитату', async () => {
    const e = await parseEmail(await composeRaw(clientMail()));
    expect(e).toMatchObject({
      messageId: '<m1@client.ru>',
      from: { address: 'ivan@client.ru', name: 'Иван Петров' },
      subject: 'Двери в квартиру',
      text: 'Здравствуйте! Нужны 3 белые двери 80 см.',
      automated: false,
      fromAiDoor: false,
    });
  });

  it('берёт текст из HTML, если нет текстовой части', async () => {
    const e = await parseEmail(await composeRaw(clientMail({ text: undefined as unknown as string, html: '<p>Нужна <b>входная</b> дверь</p>' })));
    expect(e.text).toContain('Нужна входная дверь');
  });

  it.each([
    [{ 'Auto-Submitted': 'auto-replied' }],
    [{ Precedence: 'bulk' }],
    [{ 'List-Unsubscribe': '<mailto:u@x.ru>' }],
  ])('распознаёт автоматическое письмо %o', async (headers) => {
    expect((await parseEmail(await composeRaw(clientMail({ headers })))).automated).toBe(true);
  });

  it('noreply-отправитель и наш собственный ответ', async () => {
    expect((await parseEmail(await composeRaw(clientMail({ from: { name: '', address: 'no-reply@bank.ru' } })))).automated).toBe(true);
    expect((await parseEmail(await composeRaw(clientMail({ headers: { 'X-AI-Door': '1' } })))).fromAiDoor).toBe(true);
  });
});

describe('stripQuoted', () => {
  it.each([
    ['Да, подходит.\n\nOn Mon, Sep 22, 2026 at 10:00 AM Shop <s@x.ru> wrote:\n> old', 'Да, подходит.'],
    ['Спасибо\n-----Original Message-----\nFrom: x', 'Спасибо'],
    ['Ответ\n--\nИван, тел. 123', 'Ответ'],
    ['Первая строка\n> цитата\nВторая', 'Первая строка\nВторая'],
  ])('%#', (input, out) => {
    expect(stripQuoted(input)).toBe(out);
  });
});

describe('ответ в цепочку', () => {
  it('Re: без повторов, In-Reply-To, References, маркер и подпись', async () => {
    expect(replySubject('RE: Re: Fwd: Двери')).toBe('Re: Двери');
    expect(replySubject('')).toBe('Re: Ваш запрос');
    const r = buildReply(
      { name: 'РФ-Двери', address: 'shop@rf-dveri.ru' },
      { to: 'ivan@client.ru', subject: 'Двери', inReplyTo: '<m2@client.ru>', references: ['<m1@client.ru>'] },
      'Подойдёт Турин 1 — 14 900 ₽.',
      'С уважением,\nРФ-Двери',
    );
    expect(r.messageId).toMatch(/^<ai-door\..+@rf-dveri\.ru>$/);
    const parsed = await parseEmail(await composeRaw(r));
    expect(parsed).toMatchObject({ subject: 'Re: Двери', inReplyTo: '<m2@client.ru>', fromAiDoor: true, automated: true });
    expect(parsed.references).toEqual(['<m1@client.ru>', '<m2@client.ru>']);
    expect(parsed.text).toBe('Подойдёт Турин 1 — 14 900 ₽.');
    const full = await (await import('mailparser')).simpleParser(await composeRaw(r));
    expect(full.text).toContain('С уважением');
  });
});

describe('фильтры', () => {
  it('исключения по адресу и домену', () => {
    const ignore = ['supplier.ru', '@partner.com', 'boss@rf-dveri.ru'];
    expect(isIgnored('a@supplier.ru', ignore)).toBe(true);
    expect(isIgnored('a@mail.supplier.ru', ignore)).toBe(true);
    expect(isIgnored('x@partner.com', ignore)).toBe(true);
    expect(isIgnored('boss@rf-dveri.ru', ignore)).toBe(true);
    expect(isIgnored('client@rf-dveri.ru', ignore)).toBe(false);
    expect(isNoReply('mailer-daemon@yandex.ru')).toBe(true);
    expect(isNoReply('ivan@client.ru')).toBe(false);
  });
});

describe('MailRepo', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let repo: MailRepo;
  beforeAll(async () => {
    ({ db, drop } = await freshDb());
    await new AccountsRepo(db).upsertInstalled({ id: 1, subdomain: 'a', accountDomain: 'a.amocrm.ru' });
    repo = new MailRepo(db, new SecretBox(randomBytes(32).toString('hex')));
  });
  afterAll(async () => drop());

  it('пароль хранится зашифрованным', async () => {
    expect(await repo.hasPassword(1)).toBe(false);
    await repo.setPassword(1, 'app-password-123', 5);
    expect(await repo.getPassword(1)).toBe('app-password-123');
    const { rows } = await db.query('SELECT password_enc FROM mailbox_credentials');
    expect(rows[0].password_enc).not.toContain('app-password');
  });

  it('позиции папок, ошибки, лимит ответов, активность менеджера', async () => {
    await repo.markError(1, 'INBOX', 'AUTH failed');
    expect((await repo.folderState(1, 'INBOX'))?.lastError).toBe('AUTH failed');
    await repo.saveFolderState(1, 'INBOX', '123', 40);
    expect(await repo.folderState(1, 'INBOX')).toMatchObject({ uidValidity: '123', lastUid: 40, lastError: null });
    await repo.logOutbound(1, 5, 'Ivan@Client.ru', '<a@x>');
    await repo.logOutbound(1, 5, 'ivan@client.ru', '<b@x>');
    expect(await repo.repliesToday(1, 'IVAN@client.ru')).toBe(2);
    expect(await repo.isOurMessage(1, '<a@x>')).toBe(true);
    const t0 = new Date(Date.now() - 60_000);
    expect(await repo.managerRepliedSince(1, ['ivan@client.ru'], t0)).toBe(false);
    await repo.managerWrote(1, 'Ivan@client.ru', new Date());
    expect(await repo.managerRepliedSince(1, ['ivan@client.ru'], t0)).toBe(true);
  });
});
