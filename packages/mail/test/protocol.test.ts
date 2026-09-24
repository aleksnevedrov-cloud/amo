// Проверка адаптеров на настоящих протоколах: локальные IMAP (hoodiecrow) и SMTP (smtp-server).
import type { AddressInfo } from 'node:net';
// @ts-expect-error — у hoodiecrow нет типов
import hoodiecrow from 'hoodiecrow-imap';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReply, composeRaw, ImapMailbox, parseEmail, SmtpSender, type MailServerConfig } from '../src/index.ts';

let imap: { listen(port: number, cb: () => void): void; close(cb?: () => void): void; server: { address(): AddressInfo } };
let smtp: SMTPServer;
const received: { from: string; to: string[]; raw: string }[] = [];
let cfg: MailServerConfig;

beforeAll(async () => {
  const clientMail = await composeRaw({
    from: { name: 'Иван', address: 'ivan@client.ru' },
    to: { name: '', address: 'shop@rf-dveri.ru' },
    subject: 'Двери',
    text: 'Нужны белые двери',
    html: '',
    messageId: '<m1@client.ru>',
    headers: {},
  });
  imap = hoodiecrow({
    plugins: ['SPECIAL-USE', 'UIDPLUS'],
    users: { shop: { password: 'pass' } },
    storage: {
      INBOX: { messages: [{ raw: clientMail.toString(), uid: 1 }] },
      '': { separator: '/', folders: { Sent: { 'special-use': '\\Sent', messages: [] } } },
    },
  });
  await new Promise<void>((r) => imap.listen(0, r));
  smtp = new SMTPServer({
    secure: false,
    authOptional: false,
    disabledCommands: ['STARTTLS'],
    onAuth: (auth, _s, cb) => (auth.username === 'shop' && auth.password === 'pass' ? cb(null, { user: 'shop' }) : cb(new Error('Invalid login'))),
    onData: (stream, session, cb) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
          to: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks).toString(),
        });
        cb();
      });
    },
  });
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
  cfg = {
    imapHost: '127.0.0.1',
    imapPort: imap.server.address().port,
    imapSecure: false,
    smtpHost: '127.0.0.1',
    smtpPort: (smtp.server.address() as AddressInfo).port,
    smtpSecure: false,
    username: 'shop',
    password: 'pass',
  };
});
afterAll(async () => {
  // Тестовые серверы ждут закрытия клиентских соединений — не ждём дольше секунды.
  const closeWithin = (fn: (cb: () => void) => void) => Promise.race([new Promise<void>((r) => fn(() => r())), new Promise<void>((r) => setTimeout(r, 1000))]);
  await closeWithin((cb) => imap.close(cb));
  await closeWithin((cb) => smtp.close(cb));
});

describe('ImapMailbox (IMAP)', () => {
  it('состояние папки, выборка после UID, поиск «Отправленных», добавление письма', async () => {
    const box = await ImapMailbox.connect(cfg);
    try {
      const st = await box.folderState('INBOX');
      expect(st.maxUid).toBe(1);
      const msgs = await box.fetchAfter('INBOX', 0, 10);
      expect(msgs.map((m) => m.uid)).toEqual([1]);
      expect((await parseEmail(msgs[0]!.source)).subject).toBe('Двери');
      // Новых писем нет: «N:*» не должен вернуть последнее повторно.
      expect(await box.fetchAfter('INBOX', 1, 10)).toEqual([]);
      const sent = await box.findSentFolder();
      expect(sent).toBe('Sent');
      await box.append(sent!, await composeRaw(buildReply({ name: 'РФ-Двери', address: 'shop@rf-dveri.ru' }, { to: 'ivan@client.ru', subject: 'Двери', inReplyTo: '<m1@client.ru>', references: [] }, 'Ответ', '')));
      expect((await box.folderState('Sent')).maxUid).toBe(1);
    } finally {
      await box.close();
    }
  });

  it('неверный пароль — ошибка подключения', async () => {
    await expect(ImapMailbox.connect({ ...cfg, password: 'wrong' })).rejects.toThrow();
  });
});

describe('SmtpSender (SMTP)', () => {
  it('проверка и отправка письма в цепочку', async () => {
    const sender = new SmtpSender(cfg);
    await sender.verify();
    const mail = buildReply({ name: 'РФ-Двери', address: 'shop@rf-dveri.ru' }, { to: 'ivan@client.ru', subject: 'Двери', inReplyTo: '<m1@client.ru>', references: [] }, 'Подойдёт Турин 1.', 'С уважением');
    await sender.send(mail);
    const got = received.at(-1)!;
    expect(got).toMatchObject({ from: 'shop@rf-dveri.ru', to: ['ivan@client.ru'] });
    const parsed = await parseEmail(got.raw);
    expect(parsed).toMatchObject({ subject: 'Re: Двери', inReplyTo: '<m1@client.ru>', fromAiDoor: true, text: 'Подойдёт Турин 1.' });
  });

  it('неверный пароль SMTP', async () => {
    await expect(new SmtpSender({ ...cfg, password: 'wrong' }).verify()).rejects.toThrow(/Invalid login/);
  });
});
