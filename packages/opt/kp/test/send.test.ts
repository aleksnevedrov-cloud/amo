import { describe, expect, it } from 'vitest';
import { composeKpMail, MAX_ATTACHMENT_BYTES, renderMailTemplate, sendBlockers } from '../src/send.ts';

const built = { status: 'built' as const, docxPath: '/data/kp/1/KP-1.docx', pdfPath: '/data/kp/1/KP-1.pdf', sentAt: null };

describe('отправка КП: проверки перед отправкой (6.6)', () => {
  it('собранный черновик, файл есть, адрес верный — препятствий нет', () => {
    expect(sendBlockers({ draft: built, fileBytes: 120_000, to: 'client@example.ru', resendConfirmed: false })).toEqual([]);
  });

  it('не собран, файла нет, адрес кривой, вложение больше 25 МБ — каждая причина названа', () => {
    const reasons = sendBlockers({ draft: { ...built, status: 'draft', docxPath: null, pdfPath: null }, fileBytes: null, to: 'client@', resendConfirmed: false });
    expect(reasons).toEqual(['документ ещё не собран', 'файл КП не найден на диске', 'адрес получателя пустой или не похож на e-mail']);
    expect(sendBlockers({ draft: built, fileBytes: MAX_ATTACHMENT_BYTES + 1, to: 'a@b.ru', resendConfirmed: false })).toEqual(['вложение больше 25 МБ']);
  });

  it('повторная отправка только с подтверждением', () => {
    const sent = { ...built, status: 'sent' as const, sentAt: new Date() };
    expect(sendBlockers({ draft: sent, fileBytes: 1, to: 'a@b.ru', resendConfirmed: false })).toEqual(['это КП уже отправлялось — нужно подтверждение повторной отправки']);
    expect(sendBlockers({ draft: sent, fileBytes: 1, to: 'a@b.ru', resendConfirmed: true })).toEqual([]);
  });
});

describe('письмо с КП', () => {
  it('тема и текст из шаблонов настроек, подпись, вложение, без Auto-Submitted', () => {
    expect(renderMailTemplate('Коммерческое предложение {kpNo} для {clientName}', { kpNo: 'КП-2026-7', clientName: 'ООО Ромашка' })).toBe('Коммерческое предложение КП-2026-7 для ООО Ромашка');
    expect(renderMailTemplate('КП {kpNo}', { kpNo: '', clientName: '' })).toBe('КП');
    const mail = composeKpMail({
      from: { name: 'РФ-Двери', address: 'sales@rf-dveri.ru' },
      to: ' client@example.ru ',
      cc: 'manager@rf-dveri.ru',
      subject: 'КП-1',
      text: 'Здравствуйте!\n\nДокумент во вложении.',
      signature: 'Иван, РФ-Двери',
      attachment: { filename: 'KP-1.pdf', content: Buffer.from('%PDF') },
    });
    expect(mail).toMatchObject({ to: 'client@example.ru', cc: 'manager@rf-dveri.ru', subject: 'КП-1', headers: { 'X-AI-Door': 'opt' } });
    expect(mail.text).toBe('Здравствуйте!\n\nДокумент во вложении.\n\n--\nИван, РФ-Двери');
    expect(mail.html).toContain('Документ во вложении.');
    expect(mail.messageId).toMatch(/^<ai-door-kp\.[a-z0-9]+\.[a-f0-9]{12}@rf-dveri\.ru>$/);
    expect(mail.attachments).toEqual([{ filename: 'KP-1.pdf', content: Buffer.from('%PDF') }]);
    expect(Object.keys(mail.headers)).not.toContain('Auto-Submitted');
  });
});
