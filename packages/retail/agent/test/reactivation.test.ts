import { describe, expect, it } from 'vitest';
import type { AmoLead } from '@core/amo';
import { widgetSettingsSchema, type ReactivationLead, type ReactivationPlan, type ReactivationState } from '@core/db';
import {
  classifyReply,
  findDeadline,
  handleReactivationReply,
  planReactivations,
  reasonCode,
  runTouches,
  touchText,
  type ReplyDeps,
} from '../src/reactivation.ts';

const ACC = 28528549;
const DVERI = 1873498;
const OTKAZ = 143;
const ZAKAZ = 50;
const NOW = new Date('2026-10-30T09:00:00Z');
const DAY = 24 * 3600_000;

/** Хранилище догона в памяти — та же логика, что у SQL-репозитория. */
function store(rows: ReactivationLead[] = []) {
  let seq = rows.length;
  const live: ReactivationState[] = ['planned', 'touched', 'reminder'];
  return {
    rows,
    async plan(_a: number, p: ReactivationPlan) {
      if (rows.some((r) => r.leadId === p.leadId)) return null;
      seq += 1;
      rows.push({
        id: seq,
        leadId: p.leadId,
        eventId: p.eventId,
        refusedAt: p.refusedAt,
        budget: p.budget,
        reason: p.reason,
        reasonCode: p.reasonCode,
        state: 'planned',
        stopReason: null,
        touches: 0,
        lastTouchAt: null,
        nextTouchAt: p.nextTouchAt,
        clientReplyAt: null,
        finalSent: false,
        taskId: null,
        movedAt: null,
      });
      return seq;
    },
    async skip(_a: number, p: Omit<ReactivationPlan, 'nextTouchAt'>, reason: string) {
      if (rows.some((r) => r.leadId === p.leadId)) return null;
      const id = await this.plan(_a, { ...p, nextTouchAt: new Date(0) });
      const r = rows.find((x) => x.id === id);
      if (r) {
        r.state = 'stopped';
        r.stopReason = reason;
        r.nextTouchAt = null;
      }
      return id;
    },
    async due(_a: number, now: Date, limit: number) {
      return rows
        .filter((r) => r.nextTouchAt && r.nextTouchAt <= now && live.includes(r.state))
        .sort((x, y) => (x.nextTouchAt as Date).getTime() - (y.nextTouchAt as Date).getTime())
        .slice(0, limit);
    },
    async byLead(_a: number, leadId: number) {
      return rows.find((r) => r.leadId === leadId) ?? null;
    },
    async markTouched(_a: number, id: number, at: Date, next: Date | null, state: ReactivationState = 'touched') {
      const r = rows.find((x) => x.id === id);
      if (!r) return;
      r.touches += 1;
      r.lastTouchAt = at;
      r.nextTouchAt = next;
      r.state = state;
    },
    async resolve(_a: number, id: number, state: ReactivationState, patch: Record<string, unknown> = {}) {
      const r = rows.find((x) => x.id === id);
      if (!r) return;
      r.state = state;
      r.stopReason = (patch.stopReason as string | null) ?? r.stopReason;
      r.clientReplyAt = (patch.clientReplyAt as Date | null) ?? r.clientReplyAt;
      r.nextTouchAt = (patch.nextTouchAt as Date | null) ?? null;
      r.taskId = (patch.taskId as number | null) ?? r.taskId;
      r.movedAt = (patch.movedAt as Date | null) ?? r.movedAt;
      r.finalSent = r.finalSent || Boolean(patch.finalSent);
    },
    async stop(a: number, id: number, reason: string) {
      await this.resolve(a, id, 'stopped', { stopReason: reason });
    },
  };
}

interface FakeLead {
  id: number;
  status_id: number;
  pipeline_id: number;
  price: number | null;
  responsible_user_id?: number;
  closed_at?: number | null;
}

function deps(opts: {
  rows?: ReactivationLead[];
  refusals?: { leadId: number; eventId: string; changedAt: Date; analysis: { refusalReason: string } | null }[];
  leads?: FakeLead[];
  settings?: Record<string, unknown>;
  /** Исходящие события чата: created_by > 0 — писал сотрудник. */
  outgoing?: { created_by: number }[];
  openTasks?: number;
  sendFails?: boolean;
  /** amo недоступна. */
  leadFails?: boolean;
}) {
  const st = store(opts.rows ?? []);
  const sent: { leadId: number; text: string; details: Record<string, unknown> }[] = [];
  const emails: { leadId: number; text: string }[] = [];
  const tasks: { leadId: number; text: string; completeTill: Date; responsibleUserId?: number }[] = [];
  const notes: { leadId: number; text: string }[] = [];
  const moves: { leadId: number; statusId: number }[] = [];
  const journal: { kind: string; summary: string }[] = [];
  const settings = widgetSettingsSchema.parse({
    enabled: true,
    reactivation: { enabled: true, targetStatusId: ZAKAZ, ...(opts.settings ?? {}) },
    salesbot: { senderBotId: 8149 },
    taskSweep: { pipelineId: DVERI, statusIds: [ZAKAZ] },
  });
  const leads = opts.leads ?? [];
  const api = {
    getLead: async (id: number) => {
      if (opts.leadFails) throw new Error('amo недоступна');
      return leads.find((l) => l.id === id) ?? null;
    },
    getOutgoingChatEvents: async () => opts.outgoing ?? [],
    openLeadTasks: async () => Array.from({ length: opts.openTasks ?? 0 }, (_, i) => ({ id: i + 1, text: 'x' })),
    createTask: async (t: { leadId: number; text: string; completeTill: Date; responsibleUserId?: number }) => {
      tasks.push(t);
      return 555;
    },
    addLeadNote: async (leadId: number, text: string) => {
      notes.push({ leadId, text });
      return 1;
    },
    setLeadStatus: async (leadId: number, statusId: number) => {
      moves.push({ leadId, statusId });
      const l = leads.find((x) => x.id === leadId);
      if (l) l.status_id = statusId;
    },
  };
  const d = {
    settings: { get: async () => ({ settings, version: 1 }) },
    journal: { add: async (e: { kind: string; summary: string }) => void journal.push({ kind: e.kind, summary: e.summary }) },
    reactivation: st,
    suggestions: { addApproved: async () => 1 },
    analyzedRefusals: async () => opts.refusals ?? [],
    amo: async () => ({ api }),
    send: async (_a: number, leadId: number, text: string, details: Record<string, unknown>) => {
      if (opts.sendFails) return false;
      sent.push({ leadId, text, details });
      return true;
    },
    email: async (_a: number, leadId: number, text: string) => {
      emails.push({ leadId, text });
      return true;
    },
    now: () => NOW,
  } as unknown as ReplyDeps;
  return { d, st, sent, emails, tasks, notes, moves, journal, settings };
}

const lead = (p: Partial<FakeLead> = {}): AmoLead =>
  ({ id: 29995033, status_id: OTKAZ, pipeline_id: DVERI, price: 45000, responsible_user_id: 7, ...p }) as unknown as AmoLead;

const row = (p: Partial<ReactivationLead> = {}): ReactivationLead => ({
  id: 1,
  leadId: 29995033,
  eventId: 'e1',
  refusedAt: new Date(NOW.getTime() - 2 * DAY),
  budget: 45000,
  reason: 'дорого',
  reasonCode: 'price',
  state: 'planned',
  stopReason: null,
  touches: 0,
  lastTouchAt: null,
  nextTouchAt: new Date(NOW.getTime() - 60_000),
  clientReplyAt: null,
  finalSent: false,
  taskId: null,
  movedAt: null,
  ...p,
});

describe('reasonCode', () => {
  it('набор текстов по причине отказа', () => {
    expect(reasonCode('Клиенту дорого, просил скидку')).toBe('price');
    expect(reasonCode('нужной модели не было в наличии')).toBe('stock');
    expect(reasonCode('передумал, ремонт отложен')).toBe('changedMind');
    expect(reasonCode('')).toBe('universal');
    expect(reasonCode(null)).toBe('universal');
    expect(reasonCode('причина не названа')).toBe('universal');
  });

  it('«купил дешевле у другого» — про конкурента, а не про цену', () => {
    expect(reasonCode('нашли дешевле у конкурента')).toBe('competitor');
    expect(reasonCode('уже купил в другой компании')).toBe('competitor');
  });
});

describe('classifyReply', () => {
  it('чёткий отказ', () => {
    for (const t of ['не интересно', 'уже купил, спасибо', 'не нужно ничего', 'не пишите мне больше', 'нет, спасибо']) {
      expect(classifyReply(t).kind, t).toBe('refusal');
    }
  });

  it('«подумаю» без срока', () => {
    expect(classifyReply('надо подумать')).toEqual({ kind: 'think', deadline: null });
    expect(classifyReply('пока не решил')).toEqual({ kind: 'think', deadline: null });
  });

  it('названный срок попадает в задачу в словах клиента', () => {
    expect(classifyReply('давайте через месяц')).toEqual({ kind: 'think', deadline: 'через месяц' });
    expect(classifyReply('через 2 недели наберите')).toMatchObject({ kind: 'think', deadline: 'через 2 недели' });
    expect(classifyReply('через полгода, не раньше')).toMatchObject({ kind: 'think', deadline: 'через полгода' });
    expect(classifyReply('вернёмся к этому весной')).toMatchObject({ kind: 'think', deadline: 'весной' });
    expect(findDeadline('после нового года наберите')).toBe('после нового года');
    expect(findDeadline('ок')).toBe(null);
  });

  it('всё неоднозначное — к менеджеру, агент сам не отвечает', () => {
    expect(classifyReply('а сколько будет с установкой?').kind).toBe('interest');
    expect(classifyReply('да, актуально').kind).toBe('interest');
    expect(classifyReply('???').kind).toBe('interest');
  });
});

describe('touchText', () => {
  it('второй текст — последнее сообщение, у неизвестной причины берётся универсальный', () => {
    const s = widgetSettingsSchema.parse({}).reactivation.texts;
    expect(touchText(s, 'price', 1)).toContain('дешевле');
    expect(touchText(s, 'price', 2)).toContain('последнее сообщение');
    expect(touchText(s, 'universal', 1)).toBe(s.universal.first);
  });
});

describe('planReactivations: отбор', () => {
  const refusal = { leadId: 29995033, eventId: 'e1', changedAt: new Date(NOW.getTime() - 3 * DAY), analysis: { refusalReason: 'дорого' } };

  it('сделка с бюджетом выше порога встаёт в очередь, касание — на второй день от отказа', async () => {
    const { d, st } = deps({ refusals: [refusal], leads: [lead()] });
    expect(await planReactivations(d, ACC)).toEqual({ planned: 1, skipped: 0 });
    expect(st.rows).toMatchObject([
      { leadId: 29995033, budget: 45000, reasonCode: 'price', state: 'planned', nextTouchAt: new Date(refusal.changedAt.getTime() + 2 * DAY) },
    ]);
  });

  it('бюджет ниже 30 000 ₽ не догоняем, отказ записан — второй раз amo не дёргаем', async () => {
    const { d, st } = deps({ refusals: [refusal], leads: [lead({ price: 29999 })] });
    expect(await planReactivations(d, ACC)).toEqual({ planned: 0, skipped: 1 });
    expect(st.rows).toMatchObject([{ state: 'stopped', stopReason: 'low_budget', nextTouchAt: null }]);
    expect(await planReactivations(d, ACC)).toEqual({ planned: 0, skipped: 0 });
  });

  it('сделку увели с «Отказа» — ею занимается менеджер', async () => {
    const { d, st } = deps({ refusals: [refusal], leads: [lead({ status_id: ZAKAZ })] });
    expect(await planReactivations(d, ACC)).toEqual({ planned: 0, skipped: 1 });
    expect(st.rows).toMatchObject([{ state: 'stopped', stopReason: 'moved' }]);
  });

  it('сделки в amo нет — догон закрыт', async () => {
    const { d, st } = deps({ refusals: [refusal], leads: [] });
    expect(await planReactivations(d, ACC)).toEqual({ planned: 0, skipped: 1 });
    expect(st.rows).toMatchObject([{ state: 'stopped', stopReason: 'no_lead' }]);
  });

  it('сбой amo решения не принимает: ничего не записано, сделка вернётся следующим проходом', async () => {
    const { d, st } = deps({ refusals: [refusal], leads: [lead()], leadFails: true });
    expect(await planReactivations(d, ACC)).toEqual({ planned: 0, skipped: 1 });
    expect(st.rows).toHaveLength(0);
  });

  it('повторный проход вторую строку не создаёт', async () => {
    const { d, st } = deps({ refusals: [refusal], leads: [lead()] });
    await planReactivations(d, ACC);
    expect(await planReactivations(d, ACC)).toEqual({ planned: 0, skipped: 0 });
    expect(st.rows).toHaveLength(1);
  });

  it('выключенный догон не отбирает ничего', async () => {
    const { d, st } = deps({ refusals: [refusal], leads: [lead()], settings: { enabled: false } });
    expect(await planReactivations(d, ACC)).toEqual({ planned: 0, skipped: 0 });
    expect(st.rows).toHaveLength(0);
  });
});

describe('runTouches: касания', () => {
  it('первое касание уходит в WhatsApp и письмом, второе — на пятый день от отказа', async () => {
    const r = row();
    const { d, st, sent, emails } = deps({ rows: [r], leads: [lead()] });
    expect(await runTouches(d, ACC)).toEqual({ sent: 1, stopped: 0, errors: 0 });
    expect(sent).toMatchObject([{ details: { touch: 1, reasonCode: 'price' } }]);
    expect(emails).toMatchObject([{ text: sent.map((x) => x.text).join('') }]);
    expect(st.rows).toMatchObject([{ state: 'touched', touches: 1, nextTouchAt: new Date(r.refusedAt.getTime() + 5 * DAY) }]);
  });

  it('после второго касания не пишем никогда', async () => {
    const { d, st, sent } = deps({ rows: [row({ state: 'touched', touches: 1 })], leads: [lead()] });
    expect(await runTouches(d, ACC)).toEqual({ sent: 1, stopped: 0, errors: 0 });
    expect(sent).toMatchObject([{ details: { touch: 2 } }]);
    expect(st.rows).toMatchObject([{ state: 'stopped', touches: 2, stopReason: 'two_touches', nextTouchAt: null }]);
    expect(await runTouches(d, ACC)).toEqual({ sent: 0, stopped: 0, errors: 0 });
  });

  it('менеджер пишет клиенту сам — догон прекращается без сообщения', async () => {
    const { d, st, sent } = deps({ rows: [row()], leads: [lead()], outgoing: [{ created_by: 7 }] });
    expect(await runTouches(d, ACC)).toEqual({ sent: 0, stopped: 1, errors: 0 });
    expect(sent).toHaveLength(0);
    expect(st.rows).toMatchObject([{ state: 'stopped', stopReason: 'manager_active' }]);
  });

  it('сообщения самого агента отправку не блокируют', async () => {
    const { d, sent } = deps({ rows: [row()], leads: [lead()], outgoing: [{ created_by: 0 }] });
    expect(await runTouches(d, ACC)).toEqual({ sent: 1, stopped: 0, errors: 0 });
    expect(sent).toHaveLength(1);
  });

  it('сделку увели с «Отказа» — касание не уходит', async () => {
    const { d, st, sent } = deps({ rows: [row()], leads: [lead({ status_id: ZAKAZ })] });
    expect(await runTouches(d, ACC)).toEqual({ sent: 0, stopped: 1, errors: 0 });
    expect(sent).toHaveLength(0);
    expect(st.rows).toMatchObject([{ state: 'stopped', stopReason: 'moved' }]);
  });

  it('канал недоступен — попытка остаётся на следующий проход', async () => {
    const { d, st } = deps({ rows: [row()], leads: [lead()], sendFails: true });
    expect(await runTouches(d, ACC)).toEqual({ sent: 0, stopped: 0, errors: 1 });
    expect(st.rows).toMatchObject([{ state: 'planned', touches: 0 }]);
  });

  it('напоминание после «подумаю» — последнее касание', async () => {
    const { d, st, sent } = deps({ rows: [row({ state: 'reminder', touches: 1 })], leads: [lead()] });
    expect(await runTouches(d, ACC)).toEqual({ sent: 1, stopped: 0, errors: 0 });
    expect(sent).toMatchObject([{ details: { touch: 'reminder' } }]);
    expect(st.rows).toMatchObject([{ state: 'stopped', stopReason: 'reminder_sent', nextTouchAt: null }]);
  });
});

describe('handleReactivationReply: ответ клиента', () => {
  it('сделка не в догоне — обычный диалог', async () => {
    const { d } = deps({ leads: [lead()] });
    expect(await handleReactivationReply(d, ACC, lead(), 'привет')).toEqual({ handled: false });
  });

  it('касаний ещё не было — обычный диалог', async () => {
    const { d } = deps({ rows: [row({ touches: 0 })], leads: [lead()] });
    expect(await handleReactivationReply(d, ACC, lead(), 'привет')).toEqual({ handled: false });
  });

  it('интерес: сделка на этап «Заказ» и задача ответственному', async () => {
    const l = lead();
    const { d, st, tasks, moves, sent } = deps({ rows: [row({ state: 'touched', touches: 1 })], leads: [l] });
    const out = await handleReactivationReply(d, ACC, l, 'да, сколько с установкой?');
    expect(out).toMatchObject({ handled: true, kind: 'interest', action: 'task' });
    expect(moves).toEqual([{ leadId: 29995033, statusId: ZAKAZ }]);
    expect(tasks).toMatchObject([{ responsibleUserId: 7, text: expect.stringContaining('нужен менеджер') }]);
    expect(sent).toHaveLength(0);
    expect(st.rows).toMatchObject([{ state: 'interested', taskId: 555, stopReason: 'to_manager' }]);
  });

  it('названный срок: задача со сроком в словах клиента, сделка тоже на «Заказ»', async () => {
    const l = lead();
    const { d, st, tasks, moves } = deps({ rows: [row({ state: 'touched', touches: 1 })], leads: [l] });
    const out = await handleReactivationReply(d, ACC, l, 'напомните через месяц');
    expect(out).toMatchObject({ handled: true, kind: 'think' });
    expect(tasks).toMatchObject([{ text: expect.stringContaining('через месяц') }]);
    expect(moves).toHaveLength(1);
    expect(st.rows).toMatchObject([{ state: 'postponed' }]);
  });

  it('«подумаю» без срока: агент напомнит сам через 7 дней', async () => {
    const l = lead();
    const { d, st, tasks, moves } = deps({ rows: [row({ state: 'touched', touches: 1 })], leads: [l] });
    const out = await handleReactivationReply(d, ACC, l, 'надо подумать');
    expect(out).toMatchObject({ handled: true, action: 'reminder_scheduled' });
    expect(tasks).toHaveLength(0);
    expect(moves).toHaveLength(0);
    expect(st.rows).toMatchObject([{ state: 'reminder', nextTouchAt: new Date(NOW.getTime() + 7 * DAY) }]);
  });

  it('повторный отказ: шаблон «Отказ» в WhatsApp и письмом, сделка остаётся в отказе', async () => {
    const l = lead();
    const { d, st, sent, emails, moves, tasks, settings } = deps({ rows: [row({ state: 'touched', touches: 1 })], leads: [l] });
    const out = await handleReactivationReply(d, ACC, l, 'не интересно');
    expect(out).toMatchObject({ handled: true, kind: 'refusal', action: 'final_template' });
    expect(sent).toMatchObject([{ text: settings.reactivation.finalTemplate }]);
    expect(settings.reactivation.finalTemplate).toContain('отдел качества');
    expect(emails).toMatchObject([{ text: settings.reactivation.finalTemplate }]);
    expect(moves).toHaveLength(0);
    expect(tasks).toHaveLength(0);
    expect(st.rows).toMatchObject([{ state: 'done', finalSent: true, stopReason: 'client_refused' }]);
  });

  it('обратная связь на шаблон «Отказ» ложится в сделку, агент не отвечает', async () => {
    const l = lead();
    const { d, notes, sent, tasks } = deps({ rows: [row({ state: 'done', finalSent: true, touches: 2 })], leads: [l] });
    const out = await handleReactivationReply(d, ACC, l, 'Выбрали другого, у них дешевле');
    expect(out).toMatchObject({ handled: true, kind: 'feedback', action: 'note' });
    expect(notes).toMatchObject([{ text: expect.stringContaining('Выбрали другого') }]);
    expect(sent).toHaveLength(0);
    expect(tasks).toHaveLength(0);
  });

  it('второй ответ после закрытия догона агент тоже не комментирует', async () => {
    const l = lead();
    const { d, notes, sent } = deps({ rows: [row({ state: 'done', finalSent: true, touches: 2 })], leads: [l] });
    await handleReactivationReply(d, ACC, l, 'и ещё сроки у вас большие');
    await handleReactivationReply(d, ACC, l, 'всё, спасибо');
    expect(notes).toHaveLength(2);
    expect(sent).toHaveLength(0);
  });
});
