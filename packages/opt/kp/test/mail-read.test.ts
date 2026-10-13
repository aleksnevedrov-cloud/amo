// Чтение письма заявки из ящика: выбор письма, лимиты вложений, только чтение (настоящий IMAP — hoodiecrow), пауза после ошибки входа.
import { createServer, connect as netConnect, type AddressInfo, type Server, type Socket } from 'node:net';
// @ts-expect-error — у hoodiecrow нет типов
import hoodiecrow from 'hoodiecrow-imap';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chooseLatest, compressUids, domainOf, htmlToPlain, ImapMailReader, isPublicDomain, MailAuthError, MailTimeoutError, normalizeSubject, parseMail, pickMailAttachments, resetMailAuthPauses, searchableFolders, stripQuoted, type MailAttachment, type MailReadConfig } from '../src/mail-read.ts';

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
    // UID одной командой FETCH диапазонами.
    expect(compressUids([10, 9, 1, 2, 3, 7, 3])).toBe('1:3,7,9:10');
    expect(compressUids([5])).toBe('5');
    expect(compressUids([])).toBe('');
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
      // Как у Яндекса в сделке 30013995: адрес отправителя в смешанном регистре, SEARCH FROM его не находит.
      { raw: await raw({ from: 'StOptPostavka@yandex.ru', subject: 'Карточка организации', text: 'Высылаю карточку', date: d('2026-10-11T09:00:00Z'), attachments: [{ filename: 'Карточка Строй(1).doc', content: Buffer.alloc(3_000, 1), contentType: 'application/msword' }] }), uid: 5 },
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
    // Во «Входящих» в окне все 5 писем (hoodiecrow считает SINCE/BEFORE по дате записи на сервер — сегодня), от отправителя два (uid 1 и 5); запасной проход не понадобился.
    expect(r.diag.folders[0]).toEqual({ path: 'INBOX', specialUse: '\\Inbox', inWindow: 5, bySender: 2, scannedWithoutDate: 0, bySenderWithoutDate: 0, envelopes: 5, ms: expect.any(Number) });
    // Во Входящих есть письма отправителя, но не с этой темой — остальные папки просмотрены.
    expect(r.diag.stoppedAfterInbox).toBe(false);
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

  it('без темы — письмо отправителя есть во Входящих: берётся самое свежее оттуда, остальные папки не обходятся; прогресс по папкам', async () => {
    const lines: string[] = [];
    const r = await new ImapMailReader(cfg).findLatest({ from: SENDER, around: d('2026-10-12T16:55:00Z') }, { onProgress: (l) => lines.push(l) });
    expect(r.mail).toMatchObject({ folder: 'INBOX', uid: 5, from: SENDER, subject: 'Карточка организации' });
    expect(r.diag.stoppedAfterInbox).toBe(true);
    expect(r.diag.folders.map((f) => f.path)).toEqual(['INBOX']);
    expect(lines[0]).toMatch(/^INBOX: в окне дат 5, ENVELOPE загружено 5, от отправителя 2, \d+\.\d с$/);
    expect(lines[1]).toBe('письмо отправителя найдено во Входящих — остальные папки не смотрим');
    // Тема известна и во Входящих её нет — обход продолжается, самое свежее с точного адреса по всем папкам: Спам.
    const spam = await new ImapMailReader(cfg).findLatest({ from: SENDER, around: d('2026-10-12T16:55:00Z'), subject: 'Счёт' });
    expect(spam.mail).toMatchObject({ folder: 'Spam', subject: 'Счёт', from: SENDER });
  });

  it('публичный домен без письма с точного адреса — null (чужие письма @yandex.ru не берутся); корпоративный домен — найдено по домену с пометкой', async () => {
    const pub = await new ImapMailReader(cfg).findLatest({ from: 'nobody@yandex.ru', around: d('2026-10-12T16:55:00Z'), subject: 'Запрос ООО Стройоптпоставка' });
    expect(pub.mail).toBeNull();
    expect(pub.diag.criteria.domain).toBeNull();
    // Письма в окне есть, но от этого адреса — ни одного; запасной проход по последним письмам тоже пуст.
    // Запасной проход без даты — только Входящие и Спам, пользовательская папка Requests без него.
    expect(pub.diag.folders.map((f) => [f.path, f.inWindow, f.bySender, f.scannedWithoutDate, f.bySenderWithoutDate])).toEqual([['INBOX', 5, 0, 5, 0], ['Requests', 1, 0, 0, 0], ['Spam', 1, 0, 1, 0]]);
    const corp = await new ImapMailReader(cfg).findLatest({ from: 'buyer@stroyopt.ru', around: d('2026-10-12T16:55:00Z') });
    expect(corp.mail).toMatchObject({ folder: 'INBOX', from: 'manager@stroyopt.ru', matchedBy: 'domain', subject: 'Спецификация' });
    expect(corp.diag.criteria.domain).toBe('stroyopt.ru');
  });

  it('окно дат пустое — запасной поиск без даты по последним письмам Входящих и Спама', async () => {
    const far = await new ImapMailReader(cfg).findLatest({ from: SENDER, around: d('2026-11-20T10:00:00Z'), subject: 'Карточка организации' });
    expect(far.diag.fallbackWithoutDate).toBe(true);
    expect(far.diag.folders[0]).toEqual({ path: 'INBOX', specialUse: '\\Inbox', inWindow: 0, bySender: 0, scannedWithoutDate: 5, bySenderWithoutDate: 2, envelopes: 5, ms: expect.any(Number) });
    expect(far.mail).toMatchObject({ folder: 'INBOX', uid: 5, subject: 'Карточка организации' });
    expect(far.diag.stoppedAfterInbox).toBe(true);
    // Совсем чужой домен — ничего, диагностика по папкам с нулями.
    const none = await new ImapMailReader(cfg).findLatest({ from: 'x@nowhere.test', around: d('2026-10-12T16:55:00Z') });
    expect(none.mail).toBeNull();
    expect(none.diag.folders.map((f) => [f.path, f.inWindow, f.bySender, f.scannedWithoutDate, f.bySenderWithoutDate])).toEqual([['INBOX', 5, 0, 5, 0], ['Requests', 1, 0, 0, 0], ['Spam', 1, 0, 1, 0]]);
  });

  it('From в смешанном регистре (StOptPostavka@yandex.ru) находится по stoptpostavka@yandex.ru: SEARCH FROM не используется, отправитель сверяется по ENVELOPE', async () => {
    const r = await new ImapMailReader(cfg).findLatest({ from: SENDER, around: d('2026-10-11T16:55:00Z'), subject: 'Карточка организации' });
    expect(r.mail).toMatchObject({ uid: 5, folder: 'INBOX', from: SENDER, subject: 'Карточка организации', matchedBy: 'address' });
    expect(r.mail?.attachments.map((a) => a.filename)).toEqual(['Карточка Строй(1).doc']);
    expect(r.diag.folders[0]).toMatchObject({ path: 'INBOX', inWindow: 5, bySender: 2 });
    expect(r.diag.errors).toEqual([]);
    // Регистр искомого адреса тоже не важен.
    const mixed = await new ImapMailReader(cfg).findLatest({ from: 'StOptPostavka@Yandex.ru', around: d('2026-10-11T16:55:00Z'), subject: 'Карточка организации' });
    expect(mixed.mail?.uid).toBe(5);
    expect(mixed.diag.criteria.from).toBe(SENDER);
  });

  it('кириллица в адресе не уходит в SEARCH — понятная ошибка до подключения; кириллическая тема сравнивается на клиенте', async () => {
    await expect(new ImapMailReader(cfg).findLatest({ from: 'Баринов Михаил Анатольевич 914@rolt.ru', around: d('2026-10-12T16:55:00Z') })).rejects.toThrow(/должен быть e-mail в ASCII/);
    // Тема с кириллицей: в SEARCH не передаётся, письмо находится по envelope.
    const r = await new ImapMailReader(cfg).findLatest({ from: SENDER, around: d('2026-10-12T16:55:00Z'), subject: 'РОЛТ Михаил — Запрос ООО Стройоптпоставка' });
    expect(r.mail?.folder).toBe('Spam');
    expect(r.diag.errors).toEqual([]);
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
    expect((await new ImapMailReader(cfg).findLatest(search)).mail?.folder).toBe('INBOX');
  });

  it('зависший сервер: без приветствия и с приветствием без ответа на вход — таймаут с понятной ошибкой, а не вечное ожидание', async () => {
    resetMailAuthPauses();
    const silent = createServer(() => undefined);
    await new Promise<void>((r) => silent.listen(0, r));
    const greetOnly = createServer((sock) => sock.write('* OK IMAP4rev1 ready\r\n'));
    await new Promise<void>((r) => greetOnly.listen(0, r));
    try {
      const search = { from: SENDER, around: d('2026-10-12T16:55:00Z') };
      const t0 = Date.now();
      const e1 = await new ImapMailReader({ ...cfg, port: (silent.address() as AddressInfo).port }).findLatest(search, { connectMs: 400 }).catch((e: Error) => e);
      expect(e1).toBeInstanceOf(MailTimeoutError);
      expect((e1 as Error).message).toBe('чтение ящика прервано по таймауту на подключение и вход');
      const e2 = await new ImapMailReader({ ...cfg, port: (greetOnly.address() as AddressInfo).port }).findLatest(search, { connectMs: 400 }).catch((e: Error) => e);
      expect(e2).toBeInstanceOf(MailTimeoutError);
      expect(Date.now() - t0).toBeLessThan(5_000);
      // Таймаут — не ошибка входа: паузы на 30 минут нет, следующая попытка идёт к серверу.
      expect((await new ImapMailReader(cfg).findLatest(search)).mail?.uid).toBe(5);
    } finally {
      silent.close();
      greetOnly.close();
    }
  });

  it('зависший SEARCH: таймаут команды, переподключение и проход по последним письмам Входящих по номерам сообщений', async () => {
    resetMailAuthPauses();
    // Прокси к hoodiecrow: после команды SEARCH ответы сервера клиенту не передаются — как будто сервер завис.
    const sockets = new Set<Socket>();
    const proxy: Server = createServer((client) => {
      const upstream = netConnect(cfg.port, cfg.host);
      sockets.add(client).add(upstream);
      let mute = false;
      client.on('data', (b) => {
        if (/ UID SEARCH | SEARCH /i.test(b.toString())) mute = true;
        upstream.write(b);
      });
      upstream.on('data', (b) => {
        if (!mute) client.write(b);
      });
      const end = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on('close', end).on('error', end);
      upstream.on('close', end).on('error', end);
    });
    await new Promise<void>((r) => proxy.listen(0, r));
    try {
      const lines: string[] = [];
      const r = await new ImapMailReader({ ...cfg, port: (proxy.address() as AddressInfo).port }).findLatest({ from: SENDER, around: d('2026-10-12T16:55:00Z') }, { commandMs: 700, onProgress: (l) => lines.push(l) });
      expect(r.diag.errors).toEqual(['INBOX: SEARCH по дате прерван по таймауту (1 с), переподключение']);
      expect(r.diag.folders[0]).toMatchObject({ path: 'INBOX', inWindow: 0, scannedWithoutDate: 5, bySenderWithoutDate: 2 });
      expect(r.mail).toMatchObject({ folder: 'INBOX', uid: 5 });
      expect(lines[0]).toContain('SEARCH по таймауту');
    } finally {
      for (const s of sockets) s.destroy();
      proxy.close();
    }
  }, 20_000);
});
