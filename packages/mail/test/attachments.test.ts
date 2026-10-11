import { describe, expect, it } from 'vitest';
import {
  MAX_FILES_PER_LETTER,
  checkDownloadSignature,
  pickAttachments,
  safeFilename,
  signDownload,
  storagePathFor,
  type IncomingAttachment,
} from '../src/attachments.ts';

const file = (over: Partial<IncomingAttachment> = {}): IncomingAttachment => ({
  filename: 'smeta.pdf',
  contentType: 'application/pdf',
  size: 1024,
  content: Buffer.alloc(1024),
  ...over,
});

describe('вложения писем', () => {
  it('режет путь в имени файла из письма', () => {
    expect(safeFilename('../../etc/passwd', 'text/plain')).toBe('....etcpasswd');
  });

  it('даёт имя, когда письмо его не прислало', () => {
    expect(safeFilename(null, 'application/pdf')).toBe('attachment.pdf');
  });

  it('пропускает мелкие inline-картинки подписи', () => {
    const r = pickAttachments([file({ inline: true, size: 4096 }), file()]);
    expect(r.take).toHaveLength(1);
    expect(r.skipped).toBe(1);
  });

  it('держит потолок по числу файлов в письме', () => {
    const r = pickAttachments(Array.from({ length: 14 }, () => file()));
    expect(r.take).toHaveLength(MAX_FILES_PER_LETTER);
    expect(r.skipped).toBe(14 - MAX_FILES_PER_LETTER);
  });

  it('не берёт файл тяжелее 25 МБ', () => {
    const r = pickAttachments([file({ size: 26 * 1024 * 1024 })]);
    expect(r.take).toHaveLength(0);
    expect(r.skipped).toBe(1);
  });

  it('держит потолок по сумме письма', () => {
    const big = () => file({ size: 20 * 1024 * 1024 });
    const r = pickAttachments([big(), big(), big(), big()]);
    expect(r.take).toHaveLength(3);
  });

  it('кладёт файл в папку месяца и аккаунта', () => {
    const p = storagePathFor('/data', 28528549, 'КП.pdf', new Date('2026-10-11T09:00:00Z'));
    expect(p.startsWith('/data/mail/28528549/2026-10/')).toBe(true);
    expect(p.endsWith('.pdf')).toBe(true);
  });

  it('подписанная ссылка живёт до срока и не принимает чужую подпись', () => {
    const exp = Date.parse('2026-10-18T00:00:00Z');
    const sig = signDownload(7, exp, 'secret');
    expect(checkDownloadSignature(7, exp, sig, 'secret', exp - 1000)).toBe(true);
    expect(checkDownloadSignature(7, exp, sig, 'secret', exp + 1000)).toBe(false);
    expect(checkDownloadSignature(8, exp, sig, 'secret', exp - 1000)).toBe(false);
    expect(checkDownloadSignature(7, exp, 'нет', 'secret', exp - 1000)).toBe(false);
  });
});
