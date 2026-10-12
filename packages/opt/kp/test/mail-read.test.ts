// Чтение письма заявки из ящика: выбор письма, лимиты вложений, только чтение (настоящий IMAP — hoodiecrow), пауза после ошибки входа.
import type { AddressInfo } from 'node:net';
// @ts-expect-error — у hoodiecrow нет типов
import hoodiecrow from 'hoodiecrow-imap';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chooseLatest, domainOf, htmlToPlain, ImapMailReader, isPublicDomain, MailAuthError, normalizeSubject, parseMail, pickMailAttachments, resetMailAuthPauses, searchableFolders, stripQuoted, type MailAttachment, type MailReadConfig } from '../src/mail-read.ts';

async function raw(mail: { from: string; subject: string; text?: string; html?: string; date: Date; attachments?: { filename: string; content: Buffer; contentType?: string; cid?: string }[] }): Promise<string> {
  const t = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
  const info = await t.sendMail({ from: mail.from, to: 'shop@rf-dveri.ru', subject: mail.subject, text: mail.text, html: mail.html, date: mail.date, attachments: mail.attachments });
  return (info.message as Buffer).toString();
}

const att = (over: Partial<MailAttachment> & { size: number }): MailAttachment => ({ filename: 'f.pdf', contentType: 'application/pdf', content: Buffer.alloc(0), inline: false, ...over });

describe('выбор письма и разбор', () => {
  it('тема без Re/Fwd; точный адрес выше домена; при известной теме берётся письмо с ней, иначе самое свежее', () => {
    expect(normalizeSubject('Re: Fwd: Запрос КП')).toBe('запрос кп');
    expect(domainOf('Stoptpostavka@Yandex.ru')).toBe('yandex.ru');
    expect(isPublicDomain('Yandex.ru')).toBe(true);
    expect(isPublicDomain('stroyopt.ru')).toBe(false);
    const c = [
      { uid: 1, folder: 'INBOX', subject: 'Запрос КП', date: new Date('2026-10-12T10:00:00Z'), exact: true },
      { uid: 2, folder: 'INBOX', subject: 'Другое', date: new Date('2026-10-12T12:00:00Z'), exact: true },
      { uid: 3, folder: 'Spam', subject: 'Re: Запрос КП', date: new Date('2026-10-12T11:00:00Z'), exact: true },
      { uid: 4, folder: 'INBOX', subject: 'Запрос КП', date: new Date('2026-10-12T18:00:00Z'), exact: false },
    ];
    expect(chooseLatest(c, 'Запрос КП')?.uid).toBe(3);
    expect(chooseLatest(c, null)?.uid).toBe(2);
    expect(chooseLatest(c, 'Нет такой темы')?.uid).toBe(2);
    // Совпадение только по домену берётся лишь когда точного адреса нет.
    expect(chooseLatest(c.filter((x) => !x.exact), 'Запрос КП')?.uid).toBe(4);
    expect(chooseLatest([], 'x')).toBeNull();
  });

  it('папки для поиска: все из LIST кроме Отправленных, Черновиков, Корзины и несёлектируемых; INBOX первой', () => {
    const r = searchableFolders([
      { path: 'Spam', specialUse: '\\Junk' },
      { path: 'Sent', specialUse: '\\Sent' },
      { path: 'INBOX', specialUse: null },
      { path: 'Drafts', specialUse: '\\Drafts' },
      { path: 'Trash', specialUse: '\\Trash' },
      { path: 'Archive', flags: new Set(['\\Noselect']) },
      { path: 'Requests' },
    ]);
    expect(r.use.map((f) => f.path)).toEqual(['INBOX', 'Requests', 'Spam']);
    expect(r.skipped).toEqual(['Sent', 'Drafts', 'Trash', 'Archive']);
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
  const d = (s: string) => new Date(s);
  const SENDER = 'stoptpostavka@yandex.ru';

  beforeAll(async () => {
    const inbox = [
      { raw: await raw({ from: SENDER, subject: 'Запрос', text: 'Старое письмо', date: d('2026-10-01T10:00:00Z') }), uid: 1 },
      { raw: await raw({ from: 'other@mail.ru', subject: 'Запрос', text: 'Чужое письмо', date: d('2026-10-12T12:00:00Z') }), uid: 2 },
      { raw: await raw({ from: 'someone@yandex.ru', subject: 'Запрос ООО Стройоптпоставка', text: 'Тот же публичный домен, другой адрес — чужой клиент', date: d('2026-10-12T17:00:00Z') }), uid: 3 },
      { raw: await raw({ from: 'manager@stroyopt.ru', subject: 'Спецификация', text: 'Корпоративный домен, другой сотрудник', date: d('2026-10-12T14:00:00Z') }), uid: 4 },
    ];
    // Письмо заявки лежит не в INBOX, а в пользовательской папке — так бывает при правилах сортировки в ящике.
    const requests = [
      { raw: await raw({ from: SENDER, subject: 'Запрос ООО Стройоптпоставка', text: 'Добрый день!\nНужна дверь двухпольная, массив лиственницы 1,4×2,7 м, окраска L429 Indigo, 2 шт.', date: d('2026-10-12T13:55:00Z'), attachments: [{ filename: 'ТЗ.pdf', content: Buffer.alloc(2_000, 7), contentType: 'application/pdf' }] }), uid: 1 },
    ];
    const spam = [{ raw: await raw({ from: SENDER, subject: 'Счёт', text: 'Попало в спам, позже', date: d('2026-10-12T15:00:00Z') }), uid: 1 }];
    // В «Отправленных» самое свежее письмо с тем же адресом в FROM — его искать нельзя.
    const sent = [{ raw: await raw({ from: SENDER, subject: 'Запрос ООО Стройоптпоставка', text: 'Копия из отправленных', date: d('2026-10-12T20:00:00Z') }), uid: 1 }];
    imap = hoodiecrow({
      plugins: ['SPECIAL-USE', 'UIDPLUS'],
      users: { shop: { password: 'pass' } },
      storage: {
        INBOX: { messages: inbox },
        '': {
          separator: '/',
          folders: {
            Requests: { messages: requests },
            Spam: { 'special-use': '\\Junk', messages: spam },
            Sent: { 'special-use': '\\Sent', messages: sent },
            Drafts: { 'special-use': '\\Drafts', messages: [] },
          },
        },
      },
    });
    await new Promise<void>((r) => imap.listen(0, r));
    cfg = { host: '127.0.0.1', port: imap.server.address().port, secure: false, username: 'shop', password: 'pass' };
    resetMailAuthPauses();
  });
  afterAll(async () => {
    await Promise.race([new Promise<void>((r) => imap.close(() => r())), new Promise<void>((r) => setTimeout(r, 1000))]);
  });

  it('письмо в пользовательской папке: найдено по адресу, дате ±2 дня и теме; Отправленные и Черновики не смотрим; папки read-only, \\Seen не ставится', async () => {
    const r = await new ImapMailReader(cfg).findLatest({ from: SENDER, around: d('2026-10-12T16:55:00Z'), subject: 'Запрос ООО Стройоптпоставка' });
    expect(r.readOnly).toBe(true);
    expect(r.mail).toMatchObject({ uid: 1, folder: 'Requests', from: SENDER, subject: 'Запрос ООО Стройоптпоставка' });
    expect(r.mail?.text).toContain('окраска L429 Indigo, 2 шт.');
    expect(r.mail?.attachments.map((a) => [a.filename, a.size])).toEqual([['ТЗ.pdf', 2_000]]);
    expect(r.mail?.matchedBy).toBe('address');
    // Публичный домен: по домену не ищем — в критериях domain = null.
    expect(r.diag.criteria).toEqual({ from: SENDER, domain: null, since: '2026-10-10', before: '2026-10-15', subject: 'Запрос ООО Стройоптпоставка' });
    expect(r.diag.folders.map((f) => f.path)).toEqual(['INBOX', 'Requests', 'Spam']);
    expect(r.diag.skippedFolders).toEqual(expect.arrayContaining(['Sent', 'Drafts']));
    expect(r.diag.fallbackWithoutDate).toBe(false);
    // Флаги прочитанных писем не менялись ни в одной папке.
    const check = new ImapFlow({ host: cfg.host, port: cfg.port, secure: false, auth: { user: 'shop', pass: 'pass' }, logger: false });
    check.on('error', () => undefined);
    await check.connect();
    try {
      for (const folder of ['INBOX', 'Requests', 'Spam']) {
        await check.mailboxOpen(folder, { readOnly: true });
        for await (const m of check.fetch('1:*', { uid: true, flags: true })) expect([...(m.flags ?? [])]).not.toContain('\\Seen');
      }
    } finally {
      await check.logout();
    }
  });

  it('без темы — самое свежее от точного адреса в окне, включая Спам; письма из Отправленных не считаются', async () => {
    const r = await new ImapMailReader(cfg).findLatest({ from: SENDER, around: d('2026-10-12T16:55:00Z') });
    expect(r.mail).toMatchObject({ folder: 'Spam', subject: 'Счёт' });
    // Тот же домен, другой адрес (uid 3 в INBOX, 17:00) — ниже точного адреса, хотя свежее.
    expect(r.mail?.from).toBe(SENDER);
  });

  it('публичный домен без письма с точного адреса — null (чужие письма @yandex.ru не берутся); корпоративный домен — найдено по домену с пометкой', async () => {
    const pub = await new ImapMailReader(cfg).findLatest({ from: 'nobody@yandex.ru', around: d('2026-10-12T16:55:00Z'), subject: 'Запрос ООО Стройоптпоставка' });
    expect(pub.mail).toBeNull();
    expect(pub.diag.criteria.domain).toBeNull();
    expect(pub.diag.folders.map((f) => [f.path, f.byFrom])).toEqual([['INBOX', 0], ['Requests', 0], ['Spam', 0]]);
    const corp = await new ImapMailReader(cfg).findLatest({ from: 'buyer@stroyopt.ru', around: d('2026-10-12T16:55:00Z') });
    expect(corp.mail).toMatchObject({ folder: 'INBOX', from: 'manager@stroyopt.ru', matchedBy: 'domain', subject: 'Спецификация' });
    expect(corp.diag.criteria.domain).toBe('stroyopt.ru');
  });

  it('окно дат пустое — запасной поиск без даты по последним письмам', async () => {
    const far = await new ImapMailReader(cfg).findLatest({ from: SENDER, around: d('2026-11-20T10:00:00Z'), subject: 'Запрос ООО Стройоптпоставка' });
    expect(far.diag.fallbackWithoutDate).toBe(true);
    expect(far.diag.folders.find((f) => f.path === 'Requests')).toEqual({ path: 'Requests', specialUse: null, byFrom: 1, inWindow: 0 });
    expect(far.mail).toMatchObject({ folder: 'Requests', subject: 'Запрос ООО Стройоптпоставка' });
    // Совсем чужой домен — ничего, диагностика по папкам с нулями.
    const none = await new ImapMailReader(cfg).findLatest({ from: 'x@nowhere.test', around: d('2026-10-12T16:55:00Z') });
    expect(none.mail).toBeNull();
    expect(none.diag.folders.map((f) => [f.path, f.byFrom, f.inWindow])).toEqual([['INBOX', 0, 0], ['Requests', 0, 0], ['Spam', 0, 0]]);
  });

  it('неверный пароль — ошибка входа и пауза 30 минут: повторная попытка не идёт к серверу', async () => {
    resetMailAuthPauses();
    const bad = new ImapMailReader({ ...cfg, password: 'wrong' });
    const search = { from: SENDER, around: d('2026-10-12T16:55:00Z') };
    await expect(bad.findLatest(search)).rejects.toBeInstanceOf(MailAuthError);
    const again = await bad.findLatest(search).catch((e: MailAuthError) => e);
    expect(again).toBeInstanceOf(MailAuthError);
    expect((again as MailAuthError).message).toMatch(/следующая попытка не раньше \d\d:\d\d МСК/);
    expect((again as MailAuthError).retryAt.getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
    // Пауза — на связку логин@сервер: с верным паролем тот же ящик тоже ждёт, пока пауза не сброшена.
    await expect(new ImapMailReader(cfg).findLatest(search)).rejects.toBeInstanceOf(MailAuthError);
    resetMailAuthPauses();
    expect((await new ImapMailReader(cfg).findLatest(search)).mail?.folder).toBe('Spam');
  });
});
