// RFD-AI-AGENT-CALLS-DAY-FULL: лента дня — письма без цитат и подписей, дубли Wazzup / чат amo / агент и письмо amo / IMAP
// считаются один раз, обрезка входа (сначала письма, затем старые сообщения, звонки не трогаются), признак общения людей.
import { describe, expect, it } from 'vitest';
import { countTimeline, dedupeTimeline, formatItem, hasHumanActivity, stripEmailQuotes, timelineText, type TimelineItem } from '../src/index.ts';

const at = (hhmm: string) => new Date(`2026-10-22T${hhmm}:00+03:00`);
const msg = (id: string, source: TimelineItem['source'], direction: 'in' | 'out', author: TimelineItem['author'], text: string, time: string, extra: Partial<TimelineItem> = {}): TimelineItem => ({ id, at: at(time), source, direction, author, text, ...extra });
const call = (id: number, time: string, dur = 60): TimelineItem => ({ id: `call:${id}`, at: at(time), source: 'call', direction: 'out', author: 'manager', text: 'x', durationSec: dur, callId: id, transcript: { provider: 'speechkit', mode: 'async', model: 'general', text: 'Алло', segments: [{ speaker: '1', role: 'manager', startMs: 0, endMs: 1000, text: 'Алло' }], durationSec: dur, speakers: 1, cost: { rub: 0, usd: 0 }, startedAt: '', finishedAt: '' } });

describe('лента дня (RFD-AI-AGENT-CALLS-DAY-FULL)', () => {
  it('письмо без цитат и подписи', () => {
    expect(stripEmailQuotes('Добрый день!\nНужны 3 двери.\n\n> Вы писали:\n> старое\n-- \nИван, ООО Ромашка')).toBe('Добрый день!\nНужны 3 двери.');
    expect(stripEmailQuotes('Ок, подходит.\r\n\r\n22.10.2026 в 10:00 Менеджер написал:\r\nстарое письмо')).toBe('Ок, подходит.');
  });

  it('дубли: Wazzup + чат amo + ответ агента и его эхо в Wazzup; письмо amo + копия из IMAP; разные тексты остаются', () => {
    const items = dedupeTimeline([
      msg('chat:1', 'amo_chat', 'in', 'client', 'Здравствуйте, нужны двери', '09:00'),
      msg('wz:a', 'wazzup', 'in', 'client', 'Здравствуйте,  нужны двери', '09:00', { channel: 'whatsapp' }),
      msg('agent:2', 'agent', 'out', 'agent', 'Добрый день! Какие размеры?', '09:04'),
      msg('wz:b', 'wazzup', 'out', 'manager', 'Добрый день! Какие размеры?', '09:05', { channel: 'whatsapp' }),
      msg('wz:c', 'wazzup', 'in', 'client', '900 на 2000', '09:10', { channel: 'whatsapp' }),
      msg('mail:m1', 'email', 'in', 'client', 'Заявка во вложении', '10:00', { subject: 'Заявка' }),
      msg('mail:d3', 'email', 'in', 'client', 'Заявка во вложении', '10:01', { subject: 'Re: Заявка' }),
      msg('mail:m2', 'email', 'out', 'manager', 'Считаем', '11:00', { subject: 'Re: Заявка' }),
    ]);
    expect(items.map((i) => i.id)).toEqual(['wz:a', 'agent:2', 'wz:c', 'mail:m1', 'mail:m2']); // Wazzup предпочтительнее чата amo (известен канал)
    expect(countTimeline(items)).toEqual({ calls: 0, messages: 3, emails: 2, notes: 0, totalCallDuration: 0 });
    expect(hasHumanActivity(items)).toBe(true);
    expect(hasHumanActivity([msg('agent:9', 'agent', 'out', 'agent', 'Здравствуйте! Чем помочь?', '09:00')])).toBe(false);
    expect(hasHumanActivity([call(1, '09:00')])).toBe(true);
  });

  it('формат записей: время МСК, источник, автор, id; звонок — реплики с ролями', () => {
    expect(formatItem(msg('wz:a', 'wazzup', 'in', 'client', 'Нужны двери', '10:21', { channel: 'telegram' }))).toBe('10:21 Telegram Клиент [wz:a]: Нужны двери');
    expect(formatItem(msg('note:5', 'note', 'out', 'manager', 'Просил счёт', '12:00'))).toBe('12:00 Примечание менеджера [note:5]: Просил счёт');
    expect(formatItem(msg('mail:1', 'email', 'out', 'manager', 'Во вложении КП', '11:05', { subject: 'КП', attachments: ['kp.pdf'] }))).toBe('11:05 Письмо исх. [mail:1] Тема: КП\nВо вложении КП\nВложения: kp.pdf');
    expect(formatItem(call(7, '10:21', 56))).toBe('10:21 Звонок исх. (0:56) [call:7]:\nМенеджер: Алло');
  });

  it('обрезка: сначала письма до 1500 знаков, затем старые сообщения; звонки не трогаются; сокращение отмечено', () => {
    const long = 'слово '.repeat(400); // ≈ 2400 знаков
    const items = [call(1, '08:00', 30), msg('mail:1', 'email', 'in', 'client', long, '09:00', { subject: 'Большое письмо' }), ...Array.from({ length: 30 }, (_, i) => msg(`wz:${i}`, 'wazzup', i % 2 ? 'out' : 'in', i % 2 ? 'manager' : 'client', `сообщение ${i} ${'текст '.repeat(60)}`, `10:${String(i).padStart(2, '0')}`))];
    const t = timelineText(items, 6000);
    expect(t.text.length).toBeLessThanOrEqual(6000);
    expect(t.truncated).toEqual(['письма сокращены (1)', expect.stringMatching(/^старые сообщения не вошли \(\d+\)$/)]);
    expect(t.used[0]?.id).toBe('call:1');
    expect(t.used.at(-1)?.id).toBe('wz:29'); // убраны самые старые сообщения (включая письмо), последние остались
    const onlyMail = timelineText([call(1, '08:00', 30), msg('mail:1', 'email', 'in', 'client', long, '09:00', { subject: 'Большое письмо' })], 1800);
    expect([onlyMail.truncated, onlyMail.used.find((i) => i.id === 'mail:1')?.text.length]).toEqual([['письма сокращены (1)'], 1501]);
    expect(timelineText(items.slice(0, 2)).truncated).toEqual([]);
  });
});
