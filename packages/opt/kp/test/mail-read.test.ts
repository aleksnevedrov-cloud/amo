// Чтение письма заявки из ящика: выбор письма, лимиты вложений, только чтение (настоящий IMAP — hoodiecrow), пауза после ошибки входа.
import type { AddressInfo } from 'node:net';
// @ts-expect-error — у hoodiecrow нет типов
import hoodiecrow from 'hoodiecrow-imap';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chooseLatest, htmlToPlain, ImapMailReader, MailAuthError, normalizeSubject, parseMail, pickMailAttachments, resetMailAuthPauses, stripQuoted, type MailAttachment, type MailReadConfig } from '../src/mail-read.ts';

async function raw(mail: { from: string; subject: string; text?: string; html?: string; date: Date; attachments?: { filename: string; content: Buffer; contentType?: string; cid?: string }[] }): Promise<string> {
  const t = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
  const info = await t.sendMail({ from: mail.from, to: 'shop@rf-dveri.ru', subject: mail.subject, text: mail.text, html: mail.html, date: mail.date, attachments: mail.attachments });
  return (info.message as Buffer).toString();
}

const att = (over: Partial<MailAttachment> & { size: number }): MailAttachment => ({ filename: 'f.pdf', contentType: 'application/pdf', content: Buffer.alloc(0), inline: false, ...over });

describe('выбор письма и разбор', () => {
  it('тема без Re/Fwd; при известной теме берётся письмо с ней, иначе самое свежее от отправителя', () => {
    expect(normalizeSubject('Re: Fwd: Запрос КП')).toBe('запрос кп');
    const c = [
      { uid: 1, subject: 'Запрос КП', date: new Date('2026-10-12T10:00:00Z') },
      { uid: 2, subject: 'Другое', date: new Date('2026-10-12T12:00:00Z') },
      { uid: 3, subject: 'Re: Запрос КП', date: new Date('2026-10-12T11:00:00Z') },
    ];
    expect(chooseLatest(c, 'Запрос КП')?.uid).toBe(3);
    expect(chooseLatest(c, null)?.uid).toBe(2);
    expect(chooseLatest(c, 'Нет такой темы')?.uid).toBe(2);
    expect(chooseLatest([], 'x')).toBeNull();
  });

  it('лимиты вложений как у розницы: встроенные < 20 КБ, 25 МБ на файл, 10 файлов, 60 МБ суммарно', () => {
    const big = 25 * 1024 * 1024 + 1;
    const r = pickMailAttachments([
      att({ filename: 'logo.png', size: 3_000, inline: true }),
      att({ filename: 'photo.jpg', size: 400_000, inline: true }),
      att({ filename: 'huge.zip', size: big }),
      ...Array.from({ length: 11 }, (_, i) => att({ filename: `f${i}.pdf`, size: 1_000 })),
    ]);
    expect(r.take.map((a) => a.filename)).toEqual(['photo.jpg', ...Array.from({ length: 9 }, (_, i) => `f${i}.pdf`)]);
    expect(r.skipped).toEqual([
      { name: 'logo.png', reason: 'встроенная картинка меньше 20 КБ' },
      { name: 'huge.zip', reason: 'файл больше 25 МБ' },
      { name: 'f9.pdf', reason: 'больше 10 файлов из одного письма не берём' },
      { name: 'f10.pdf', reason: 'больше 10 файлов из одного письма не берём' },
    ]);
    const total = pickMailAttachments([att({ filename: 'a.bin', size: 24 * 1024 * 1024 }), att({ filename: 'b.bin', size: 24 * 1024 * 1024 }), att({ filename: 'c.bin', size: 24 * 1024 * 1024 })]);
    expect(total.skipped).toEqual([{ name: 'c.bin', reason: 'суммарно больше 60 МБ' }]);
  });

  it('цитаты и подпись отрезаются, HTML без текстовой части — в текст', async () => {
    expect(stripQuoted('Нужны двери.\n\n12.10.2026, 16:55, Иван <i@x.ru> пишет:\n> старое\n-- \nПодпись')).toBe('Нужны двери.');
    expect(htmlToPlain('<p>Добрый&nbsp;день!</p><div>Нужна <b>дверь</b> 1,4&times;2,7</div>')).toBe('Добрый день!\nНужна дверь 1,4&times;2,7');
    const m = await parseMail(5, Buffer.from(await raw({ from: 'a@b.ru', subject: 'Тема', html: '<p>Текст из HTML</p>', date: new Date('2026-10-12T13:55:00Z'), attachments: [{ filename: 'img.png', content: Buffer.alloc(10), contentType: 'image/png', cid: 'img1' }] })));
    expect(m).toMatchObject({ uid: 5, from: 'a@b.ru', subject: 'Тема', text: 'Текст из HTML' });
    expect(m.attachments.map((a) => [a.filename, a.inline])).toEqual([['img.png', true]]);
  });
});

describe('ImapMailReader (настоящий IMAP, только чтение)', () => {
  let imap: { listen(port: number, cb: () => void): void; close(cb?: () => void): void; server: { address(): AddressInfo } };
  let cfg: MailReadConfig;

  beforeAll(async () => {
    const d = (s: string) => new Date(s);
    const messages = [
      { raw: await raw({ from: 'stoptpostavka@yandex.ru', subject: 'Запрос', text: 'Старое письмо', date: d('2026-10-01T10:00:00Z') }), uid: 1 },
      { raw: await raw({ from: 'other@mail.ru', subject: 'Запрос', text: 'Чужое письмо', date: d('2026-10-12T12:00:00Z') }), uid: 2 },
      { raw: await raw({ from: 'stoptpostavka@yandex.ru', subject: 'Запрос', text: 'Добрый день!\nНужна дверь двухпольная, массив лиственницы 1,4×2,7 м, окраска L429 Indigo, 2 шт.', date: d('2026-10-12T13:55:00Z'), attachments: [{ filename: 'ТЗ.pdf', content: Buffer.alloc(2_000, 7), contentType: 'application/pdf' }] }), uid: 3 },
      { raw: await raw({ from: 'stoptpostavka@yandex.ru', subject: 'Счёт', text: 'Другая тема, позже', date: d('2026-10-12T15:00:00Z') }), uid: 4 },
    ];
    imap = hoodiecrow({ plugins: ['UIDPLUS'], users: { shop: { password: 'pass' } }, storage: { INBOX: { messages } } });
    await new Promise<void>((r) => imap.listen(0, r));
    cfg = { host: '127.0.0.1', port: imap.server.address().port, secure: false, username: 'shop', password: 'pass' };
    resetMailAuthPauses();
  });
  afterAll(async () => {
    await Promise.race([new Promise<void>((r) => imap.close(() => r())), new Promise<void>((r) => setTimeout(r, 1000))]);
  });

  it('находит самое свежее письмо отправителя за ±1 день с нужной темой, папка открыта только на чтение, \\Seen не ставится', async () => {
    const r = await new ImapMailReader(cfg).findLatest({ from: 'stoptpostavka@yandex.ru', around: new Date('2026-10-12T16:55:00Z'), subject: 'Re: Запрос' });
    expect(r.readOnly).toBe(true);
    expect(r.mail).toMatchObject({ uid: 3, from: 'stoptpostavka@yandex.ru', subject: 'Запрос' });
    expect(r.mail?.text).toContain('окраска L429 Indigo, 2 шт.');
    expect(r.mail?.attachments.map((a) => [a.filename, a.size])).toEqual([['ТЗ.pdf', 2_000]]);
    // Без темы — самое свежее от отправителя в окне.
    expect((await new ImapMailReader(cfg).findLatest({ from: 'stoptpostavka@yandex.ru', around: new Date('2026-10-12T16:55:00Z') })).mail?.uid).toBe(4);
    // Вне окна ±1 день — ничего.
    expect((await new ImapMailReader(cfg).findLatest({ from: 'stoptpostavka@yandex.ru', around: new Date('2026-10-20T10:00:00Z') })).mail).toBeNull();
    // Флаги прочитанных писем не менялись.
    const check = new ImapFlow({ host: cfg.host, port: cfg.port, secure: false, auth: { user: 'shop', pass: 'pass' }, logger: false });
    check.on('error', () => undefined);
    await check.connect();
    try {
      await check.mailboxOpen('INBOX', { readOnly: true });
      for await (const m of check.fetch('1:*', { uid: true, flags: true })) expect([...(m.flags ?? [])]).not.toContain('\\Seen');
    } finally {
      await check.logout();
    }
  });

  it('неверный пароль — ошибка входа и пауза 30 минут: повторная попытка не идёт к серверу', async () => {
    resetMailAuthPauses();
    const bad = new ImapMailReader({ ...cfg, password: 'wrong' });
    const search = { from: 'stoptpostavka@yandex.ru', around: new Date('2026-10-12T16:55:00Z') };
    await expect(bad.findLatest(search)).rejects.toBeInstanceOf(MailAuthError);
    const again = await bad.findLatest(search).catch((e: MailAuthError) => e);
    expect(again).toBeInstanceOf(MailAuthError);
    expect((again as MailAuthError).message).toMatch(/следующая попытка не раньше \d\d:\d\d МСК/);
    expect((again as MailAuthError).retryAt.getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
    // Пауза — на связку логин@сервер: с верным паролем тот же ящик тоже ждёт, пока пауза не сброшена.
    await expect(new ImapMailReader(cfg).findLatest(search)).rejects.toBeInstanceOf(MailAuthError);
    resetMailAuthPauses();
    expect((await new ImapMailReader(cfg).findLatest(search)).mail?.uid).toBe(4);
  });
});
