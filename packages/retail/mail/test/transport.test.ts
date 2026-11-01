import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { ImapMailbox, isAuthFailure, imapErrorText, type ImapError, type MailServerConfig } from '../src/index.ts';

/**
 * Поддельный IMAP-сервер, который обрывает соединение во время входа — так ведёт себя сервер
 * при перегрузке («BYE Too many connections»). Режим after: BYE сразу после ответа на CAPABILITY
 * (imapflow успевает начать LOGIN — «Already logged out»); before: BYE вместо ответа на CAPABILITY.
 */
async function byeServer(mode: 'after' | 'before') {
  const srv = net.createServer((s) => {
    s.write('* OK ready\r\n');
    s.on('data', (d) => {
      if (s.writableEnded) return;
      const line = d.toString();
      const tag = line.split(' ')[0];
      if (mode === 'before') s.write('* BYE closing\r\n');
      else s.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK done\r\n* BYE closing\r\n`);
      s.end();
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as net.AddressInfo).port;
  const cfg: MailServerConfig = {
    imapHost: '127.0.0.1',
    imapPort: port,
    imapSecure: false,
    smtpHost: '',
    smtpPort: 0,
    smtpSecure: false,
    username: 'shop@rf-dveri.ru',
    password: 'secret',
  };
  return { cfg, close: () => new Promise<void>((resolve) => srv.close(() => resolve())) };
}

/** Необработанное событие 'error' уронило бы процесс — ловим его как провал теста. */
async function withUncaught<T>(fn: () => Promise<T>): Promise<{ result: T; uncaught: Error[] }> {
  const uncaught: Error[] = [];
  const onUncaught = (e: Error) => void uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  try {
    const result = await fn();
    // Хвостовые события приходят на следующих тиках.
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { result, uncaught };
  } finally {
    process.off('uncaughtException', onUncaught);
  }
}

describe('ImapMailbox: ошибка IMAP не роняет процесс', () => {
  /** Обе гонки закрытия сокета: до ответа на CAPABILITY (как на проде) и сразу после него. */
  it.each([
    ['before', 'Already logged out'],
    ['after', 'Connection not available'],
  ] as const)("сервер закрыл сокет во время входа (%s): connect() отклонён, событие 'error' обработано, процесс жив", async (mode, emitted) => {
    const srv = await byeServer(mode);
    const events: ImapError[] = [];
    try {
      const { result, uncaught } = await withUncaught(() =>
        ImapMailbox.connect(srv.cfg, { onError: (e) => void events.push(e) }).then(
          () => null,
          (e: ImapError) => e,
        ),
      );
      expect(uncaught).toEqual([]);
      expect(result).not.toBeNull();
      // Событие пришло уже после отказа connect(): его флаг отказа входа и текст добавлены к ошибке connect().
      expect(events.map((e) => [e.message, e.authenticationFailed])).toEqual([[emitted, true]]);
      expect(result).toMatchObject({ code: 'ClosedAfterConnectText', reason: 'closing', authenticationFailed: true, message: `Unexpected close; ${emitted}` });
      expect(isAuthFailure(result)).toBe(true);
      expect(imapErrorText(result)).toBe(`Unexpected close; ${emitted} BYE: closing`);
      expect(JSON.stringify({ result, events })).not.toContain('secret');
    } finally {
      await srv.close();
    }
  });

  it('isAuthFailure: по флагу imapflow и по тексту ответа сервера', () => {
    expect(isAuthFailure(Object.assign(new Error('Already logged out'), { authenticationFailed: true }))).toBe(true);
    expect(isAuthFailure(Object.assign(new Error('Command failed'), { serverResponseCode: 'AUTHENTICATIONFAILED' }))).toBe(true);
    expect(isAuthFailure(new Error('535 5.7.8 Login denied'))).toBe(true);
    expect(isAuthFailure(new Error('ECONNRESET'))).toBe(false);
    expect(isAuthFailure(null)).toBe(false);
  });
});
