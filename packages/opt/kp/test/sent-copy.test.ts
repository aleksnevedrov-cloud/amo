// KP-SENT-COPY: настоящие клиенты (nodemailer, imapflow) против поддельных SMTP и IMAP на сокетах. Письмо уходит по SMTP
// готовым MIME, тот же MIME кладётся APPEND-ом в папку \Sent с флагом \Seen; вложение на месте; папка без \Sent — по имени;
// неверный пароль — понятная причина.
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { simpleParser } from 'mailparser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeKpMail, ImapSentCopier, pickSentFolder, SmtpKpSender } from '../src/index.ts';

type Folder = { path: string; flags: string[] };

/** SMTP без TLS: EHLO, AUTH PLAIN, MAIL, RCPT, DATA (с раскрытием точек), QUIT. */
function fakeSmtp() {
  const got: { from: string; to: string[]; data: Buffer; auth: string }[] = [];
  const server = createServer((sock: Socket) => {
    let buf = '';
    let inData = false;
    let cur = { from: '', to: [] as string[], data: Buffer.alloc(0), auth: '' };
    sock.write('220 fake.smtp ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          const body = buf.slice(0, end + 2).replace(/\r\n\.\./g, '\r\n.');
          cur.data = Buffer.from(body, 'latin1');
          got.push(cur);
          cur = { from: '', to: [], data: Buffer.alloc(0), auth: cur.auth };
          buf = buf.slice(end + 5);
          inData = false;
          sock.write('250 2.0.0 Ok: queued as FAKE1\r\n');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) sock.write('250-fake.smtp\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        else if (cmd.startsWith('AUTH PLAIN')) {
          cur.auth = Buffer.from(line.slice(11), 'base64').toString('utf8');
          sock.write('235 2.7.0 Authentication successful\r\n');
        } else if (cmd.startsWith('MAIL FROM')) {
          cur.from = /<(.*)>/.exec(line)?.[1] ?? '';
          sock.write('250 2.1.0 Ok\r\n');
        } else if (cmd.startsWith('RCPT TO')) {
          cur.to.push(/<(.*)>/.exec(line)?.[1] ?? '');
          sock.write('250 2.1.5 Ok\r\n');
        } else if (cmd === 'DATA') {
          inData = true;
          sock.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (cmd === 'QUIT') sock.end('221 2.0.0 Bye\r\n');
        else sock.write('250 Ok\r\n');
      }
    });
    sock.on('error', () => undefined);
  });
  return { server, got };
}

/** IMAP без TLS: LOGIN, LIST / LSUB с признаками папок, APPEND с литералом, LOGOUT; остальное — OK. */
function fakeImap(folders: Folder[], password: string) {
  const appended: { folder: string; flags: string; raw: Buffer }[] = [];
  const server = createServer((sock: Socket) => {
    let buf = Buffer.alloc(0);
    let pending: { tag: string; folder: string; flags: string; size: number } | null = null;
    sock.write('* OK [CAPABILITY IMAP4rev1 SPECIAL-USE] fake ready\r\n');
    const handle = (line: string) => {
      const m = /^(\S+) (\S+)(.*)$/.exec(line);
      if (!m) return;
      const [, tag, rawCmd, rest] = m as unknown as [string, string, string, string];
      const cmd = rawCmd.toUpperCase();
      if (cmd === 'LOGIN') {
        if (!rest.includes(password)) return sock.write(`${tag} NO [AUTHENTICATIONFAILED] LOGIN invalid credentials or IMAP is disabled\r\n`);
        return sock.write(`${tag} OK [CAPABILITY IMAP4rev1 SPECIAL-USE] LOGIN completed\r\n`);
      }
      if (cmd === 'CAPABILITY') return sock.write(`* CAPABILITY IMAP4rev1 SPECIAL-USE\r\n${tag} OK CAPABILITY completed\r\n`);
      if (cmd === 'LIST' && /^ "" ""$/.test(rest)) return sock.write(`* LIST (\\Noselect) "/" ""\r\n${tag} OK LIST completed\r\n`);
      if (cmd === 'LIST' || cmd === 'LSUB') {
        for (const f of folders) sock.write(`* ${cmd} (\\HasNoChildren${f.flags.length ? ` ${f.flags.join(' ')}` : ''}) "/" "${f.path}"\r\n`);
        return sock.write(`${tag} OK ${cmd} completed\r\n`);
      }
      if (cmd === 'APPEND') {
        const a = /^ "?([^"(]+?)"? \(([^)]*)\)(?: "[^"]*")? \{(\d+)(\+?)\}$/.exec(rest);
        if (!a) return sock.write(`${tag} BAD APPEND syntax\r\n`);
        pending = { tag, folder: a[1] as string, flags: a[2] as string, size: Number(a[3]) };
        if (!a[4]) sock.write('+ Ready for literal data\r\n');
        return;
      }
      if (cmd === 'LOGOUT') return sock.end(`* BYE logging out\r\n${tag} OK LOGOUT completed\r\n`);
      return sock.write(`${tag} OK ${cmd} completed\r\n`);
    };
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (pending) {
          if (buf.length < pending.size + 2) return;
          const raw = buf.subarray(0, pending.size);
          buf = buf.subarray(pending.size + 2);
          appended.push({ folder: pending.folder, flags: pending.flags, raw: Buffer.from(raw) });
          sock.write(`${pending.tag} OK [APPENDUID 1 ${appended.length}] APPEND completed\r\n`);
          pending = null;
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.subarray(0, nl).toString('utf8');
        buf = buf.subarray(nl + 2);
        handle(line);
      }
    });
    sock.on('error', () => undefined);
  });
  return { server, appended };
}

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

describe('копия КП в «Отправленные» по настоящим протоколам (KP-SENT-COPY)', () => {
  const smtp = fakeSmtp();
  const imap = fakeImap([{ path: 'INBOX', flags: [] }, { path: 'Drafts', flags: ['\\Drafts'] }, { path: 'Sent', flags: ['\\Sent'] }], 'app-password');
  const plain = fakeImap([{ path: 'INBOX', flags: [] }, { path: 'Sent Items', flags: [] }], 'app-password');
  let smtpPort = 0;
  let imapPort = 0;
  let plainPort = 0;
  beforeAll(async () => {
    [smtpPort, imapPort, plainPort] = await Promise.all([listen(smtp.server), listen(imap.server), listen(plain.server)]);
  });
  afterAll(() => {
    for (const s of [smtp.server, imap.server, plain.server]) s.close();
  });
  const imapCfg = (port: number, password = 'app-password') => ({ host: '127.0.0.1', port, secure: false, username: 'rf-dveri@yandex.ru', password });

  it('SMTP — готовый MIME с конвертом «кому» и «копия»; IMAP APPEND — тот же MIME в папку \\Sent с \\Seen; вложение на месте', async () => {
    const pdf = Buffer.from(`%PDF-1.4\n${'КП-2026-16 '.repeat(400)}\n%%EOF`);
    const mail = composeKpMail({ from: { name: 'РФ-Двери', address: 'rf-dveri@yandex.ru' }, to: 'borovova@m-47.ru', cc: 'manager@rf-dveri.ru', subject: 'Коммерческое предложение КП-2026-16', text: 'Здравствуйте!\n\nКП во вложении.', signature: 'РФ-Двери', attachment: { filename: 'KP-КП-2026-16.pdf', content: pdf } });
    const r = await new SmtpKpSender().send({ host: '127.0.0.1', port: smtpPort, secure: false, username: 'rf-dveri@yandex.ru', password: 'app-password' }, mail);
    expect(r).toMatchObject({ messageId: mail.messageId, accepted: ['borovova@m-47.ru', 'manager@rf-dveri.ru'], rejected: [] });
    expect(r.response).toContain('250 2.0.0 Ok: queued as FAKE1');
    expect(smtp.got).toHaveLength(1);
    expect(smtp.got[0]).toMatchObject({ from: 'rf-dveri@yandex.ru', to: ['borovova@m-47.ru', 'manager@rf-dveri.ru'], auth: '\u0000rf-dveri@yandex.ru\u0000app-password' });
    // По SMTP ушёл ровно тот MIME, что вернул send (его же кладём в «Отправленные» и в .eml).
    expect(smtp.got[0]!.data.toString('latin1').replace(/\r\n$/, '')).toBe(r.raw.toString('latin1').replace(/\r\n$/, ''));

    const c = await new ImapSentCopier().append(imapCfg(imapPort), r.raw, null);
    expect(c).toEqual({ folder: 'Sent' });
    expect(imap.appended).toHaveLength(1);
    expect(imap.appended[0]).toMatchObject({ folder: 'Sent', flags: '\\Seen' });
    expect(imap.appended[0]!.raw.equals(r.raw)).toBe(true);
    const parsed = await simpleParser(imap.appended[0]!.raw);
    expect(parsed.messageId).toBe(mail.messageId);
    expect(parsed.subject).toBe('Коммерческое предложение КП-2026-16');
    expect(parsed.text?.trim()).toBe('Здравствуйте!\n\nКП во вложении.\n\n--\nРФ-Двери');
    expect(parsed.attachments.map((a) => [a.filename, a.contentType])).toEqual([['KP-КП-2026-16.pdf', 'application/pdf']]);
    expect(parsed.attachments[0]!.content.equals(pdf)).toBe(true);
  });

  it('без признака \\Sent у сервера — папка по имени («Sent Items» распознаёт imapflow, «Отправленные» — наш запасной поиск); заданная в настройках — она; «Проверить IMAP» — список папок', async () => {
    expect(await new ImapSentCopier().probe(imapCfg(plainPort), null)).toEqual({ folder: 'Sent Items', how: 'special_use', folders: ['INBOX', 'Sent Items'] });
    expect(await new ImapSentCopier().probe(imapCfg(imapPort), null)).toMatchObject({ folder: 'Sent', how: 'special_use' });
    expect(await new ImapSentCopier().append(imapCfg(plainPort), Buffer.from('Subject: x\r\n\r\nx\r\n'), 'sent items')).toEqual({ folder: 'Sent Items' });
    expect(pickSentFolder([{ path: 'INBOX' }, { path: '&BB4EQgQ,BEAEMAQyBDsENQQ9BD0ESwQ1-', name: 'Отправленные' }], null)).toMatchObject({ folder: '&BB4EQgQ,BEAEMAQyBDsENQQ9BD0ESwQ1-', how: 'name' });
    expect(pickSentFolder([{ path: 'INBOX' }], null)).toEqual({ folder: null, how: null, folders: ['INBOX'] });
  });

  it('неверный пароль / IMAP выключен — причина со словами про пароль приложения и доступ по IMAP', async () => {
    await expect(new ImapSentCopier().append(imapCfg(imapPort, 'wrong'), Buffer.from('x'), null)).rejects.toThrow(/вход rf-dveri@yandex\.ru не удался .*пароль приложения.*доступ по IMAP/);
  });
});
