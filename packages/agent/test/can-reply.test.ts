import { describe, expect, it } from 'vitest';
import { blockSummary, canReply } from '../src/can-reply.ts';

const ACC = 1;
const LEAD = 29986849;
const NOW = new Date('2026-10-04T10:00:00Z');

function deps(parts: {
  paused?: boolean;
  pauseReason?: string | null;
  lastAiAt?: Date | null;
  events?: { created_by: number; created_at?: number }[];
  eventsThrow?: boolean;
  throwTimes?: number;
}) {
  const asked: Date[] = [];
  let throwLeft = parts.throwTimes ?? 0;
  return {
    asked,
    deps: {
      async state() {
        return { paused: parts.paused ?? false, pauseReason: parts.pauseReason ?? null, lastAiAt: parts.lastAiAt ?? null };
      },
      async outgoingChatEvents(_leadId: number, since: Date) {
        asked.push(since);
        if (parts.eventsThrow) throw new Error('amo недоступна');
        if (throwLeft > 0) {
          throwLeft -= 1;
          throw new Error('amo timeout');
        }
        return parts.events ?? [];
      },
    },
  };
}

describe('canReply', () => {
  it('менеджер не писал — отправка разрешена', async () => {
    const { deps: d } = deps({});
    expect(await canReply(d, { accountId: ACC, leadId: LEAD, now: NOW })).toEqual({ allowed: true });
  });

  it('менеджер ответил клиенту — отправка запрещена, причина в details', async () => {
    const { deps: d } = deps({ events: [{ created_by: 3, created_at: 1791108000 }] });
    const r = await canReply(d, { accountId: ACC, leadId: LEAD, now: NOW });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('manager_active');
    expect(r.details).toMatchObject({ createdBy: 3 });
    expect(blockSummary(r)).toBe('Ответ не отправлен: менеджер ведёт диалог');
  });

  it('событие самого агента (created_by = 0) запретом не считается', async () => {
    const { deps: d } = deps({ events: [{ created_by: 0 }] });
    expect(await canReply(d, { accountId: ACC, leadId: LEAD, now: NOW })).toEqual({ allowed: true });
  });

  it('диалог на паузе — запрещено даже без событий менеджера', async () => {
    const { deps: d } = deps({ paused: true, pauseReason: 'manual' });
    const r = await canReply(d, { accountId: ACC, leadId: LEAD, now: NOW });
    expect(r).toMatchObject({ allowed: false, reason: 'paused', details: { pauseReason: 'manual' } });
    expect(blockSummary(r)).toBe('Ответ не отправлен: AI на паузе');
  });

  it('явная передача агенту снимает запрет по паузе', async () => {
    const { deps: d } = deps({ paused: true, pauseReason: 'manual' });
    expect(await canReply(d, { accountId: ACC, leadId: LEAD, now: NOW, manualReturn: true })).toEqual({ allowed: true });
  });

  it('явная передача агенту НЕ снимает запрет по активному менеджеру', async () => {
    const { deps: d } = deps({ paused: true, events: [{ created_by: 3 }] });
    expect(await canReply(d, { accountId: ACC, leadId: LEAD, now: NOW, manualReturn: true })).toMatchObject({
      allowed: false,
      reason: 'manager_active',
    });
  });

  it('события ищутся с последнего ответа агента', async () => {
    const lastAiAt = new Date('2026-10-04T09:58:30Z');
    const { deps: d, asked } = deps({ lastAiAt });
    await canReply(d, { accountId: ACC, leadId: LEAD, now: NOW });
    expect(asked[0]).toEqual(lastAiAt);
  });

  it('агент в сделке не отвечал — окно 7 дней назад', async () => {
    const { deps: d, asked } = deps({});
    await canReply(d, { accountId: ACC, leadId: LEAD, now: NOW });
    expect(asked[0]?.toISOString()).toBe('2026-09-27T10:00:00.000Z');
  });

  it('amo недоступна оба раза: отправка запрещена', async () => {
    const { deps: d, asked } = deps({ eventsThrow: true });
    const r = await canReply(d, { accountId: ACC, leadId: LEAD, now: NOW });
    expect(r).toEqual({ allowed: false, reason: 'check_failed' });
    expect(asked).toHaveLength(2);
    expect(blockSummary(r)).toBe('Ответ не отправлен: проверка допуска не прошла');
  });

  it('amo ответила со второй попытки: отправка разрешена', async () => {
    const { deps: d, asked } = deps({ throwTimes: 1 });
    const r = await canReply(d, { accountId: ACC, leadId: LEAD, now: NOW });
    expect(r).toEqual({ allowed: true });
    expect(asked).toHaveLength(2);
  });

  it('сбой проверки не перебивает паузу', async () => {
    const { deps: d } = deps({ paused: true, pauseReason: 'manager_message', eventsThrow: true });
    const r = await canReply(d, { accountId: ACC, leadId: LEAD, now: NOW });
    expect(r.reason).toBe('paused');
  });

  it('ответ только по почте — события чата не запрашиваются', async () => {
    const { deps: d, asked } = deps({ events: [{ created_by: 3 }] });
    expect(await canReply(d, { accountId: ACC, leadId: LEAD, now: NOW, checkChat: false })).toEqual({ allowed: true });
    expect(asked).toHaveLength(0);
  });
});
