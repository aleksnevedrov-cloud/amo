import { describe, expect, it } from 'vitest';
import { widgetSettingsSchema } from '@ai-door/db';
import { sweepNewLeads, sweepStages, type SweepDeps } from '../src/task-sweep.ts';

const ACC = 1;

interface FakeLead {
  id: number;
  name: string;
  status_id: number;
  pipeline_id: number;
  responsible_user_id: number;
  created_at: number;
  updated_at?: number;
}

function deps(opts: {
  leads: FakeLead[];
  openTasks?: Record<number, number>;
  sweep?: Record<string, unknown>;
  history?: { role: string; text: string; createdAt: Date }[];
  summary?: string | null;
}): { d: SweepDeps; created: { leadId: number; text: string }[] } {
  const created: { leadId: number; text: string }[] = [];
  const settings = widgetSettingsSchema.parse({ taskSweep: { ...(opts.sweep ?? {}) } });
  const api = {
    listLeads: async () => opts.leads,
    openLeadTasks: async (leadId: number) =>
      Array.from({ length: opts.openTasks?.[leadId] ?? 0 }, (_, i) => ({ id: i + 1, text: 'x' })),
    createTask: async (t: { leadId: number; text: string }) => {
      created.push({ leadId: t.leadId, text: t.text });
      return 1;
    },
  };
  const d = {
    settings: { get: async () => ({ settings, version: 1 }) },
    dialog: { history: async () => opts.history ?? [] },
    journal: { add: async () => undefined },
    amo: async () => ({ api }),
    summarize: opts.summary === undefined ? undefined : async () => opts.summary,
    now: () => new Date('2026-10-07T12:00:00Z'),
  } as unknown as SweepDeps;
  return { d, created };
}

const lead = (id: number, extra: Partial<FakeLead> = {}): FakeLead => ({
  id,
  name: `Сделка ${id}`,
  status_id: 100,
  pipeline_id: 10,
  responsible_user_id: 7,
  created_at: 0,
  ...extra,
});

describe('автопостановка задач', () => {
  it('ставит задачу сделке без открытых задач', async () => {
    const { d, created } = deps({ leads: [lead(1)] });
    const res = await sweepNewLeads(d, ACC);
    expect(res.created).toBe(1);
    expect(created[0]?.leadId).toBe(1);
    expect(created[0]?.text.startsWith('AI:')).toBe(true);
  });

  it('не ставит вторую задачу, если одна уже открыта', async () => {
    const { d, created } = deps({ leads: [lead(2)], openTasks: { 2: 1 } });
    const res = await sweepNewLeads(d, ACC);
    expect(res.created).toBe(0);
    expect(res.skipped).toBe(1);
    expect(created).toHaveLength(0);
  });

  it('пропускает сделки без ответственного, пока неразобранное выключено', async () => {
    const { d, created } = deps({ leads: [lead(3, { responsible_user_id: 0 })] });
    const res = await sweepNewLeads(d, ACC);
    expect(res.created).toBe(0);
    expect(created).toHaveLength(0);
  });

  it('вечерний обход уважает потолок за запуск', async () => {
    const { d, created } = deps({
      leads: [lead(4), lead(5), lead(6)],
      sweep: { pipelineId: 10, statusIds: [100], maxPerRun: 2 },
    });
    const res = await sweepStages(d, ACC);
    expect(res.created).toBe(2);
    expect(created).toHaveLength(2);
  });

  it('вечерний обход молчит без воронки в настройках', async () => {
    const { d, created } = deps({ leads: [lead(7)] });
    const res = await sweepStages(d, ACC);
    expect(res.created).toBe(0);
    expect(created).toHaveLength(0);
  });

  it('вечерний обход пропускает сделку, обновлённую сегодня', async () => {
    const ts = Math.floor(new Date('2026-10-07T09:00:00Z').getTime() / 1000);
    const { d, created } = deps({
      leads: [lead(13, { updated_at: ts })],
      sweep: { pipelineId: 10, statusIds: [100], maxPerRun: 5 },
      summary: null,
    });
    const res = await sweepStages(d, ACC);
    expect(res.created).toBe(0);
    expect(created).toHaveLength(0);
  });

  it('вечерний обход ставит задачу по сделке без движения за день', async () => {
    const ts = Math.floor(new Date('2026-10-05T09:00:00Z').getTime() / 1000);
    const { d, created } = deps({
      leads: [lead(14, { updated_at: ts })],
      sweep: { pipelineId: 10, statusIds: [100], maxPerRun: 5 },
      summary: null,
    });
    const res = await sweepStages(d, ACC);
    expect(res.created).toBe(1);
  });

  it('постановка по новой сделке не смотрит на дату обновления', async () => {
    const ts = Math.floor(new Date('2026-10-07T09:00:00Z').getTime() / 1000);
    const { d, created } = deps({ leads: [lead(15, { updated_at: ts })], summary: null });
    await sweepNewLeads(d, ACC);
    expect(created).toHaveLength(1);
  });

  it('кладёт в комментарий сводку переписки за день', async () => {
    const { d, created } = deps({
      leads: [lead(8)],
      history: [{ role: 'client', text: 'Нужна белая дверь', createdAt: new Date('2026-10-07T09:00:00Z') }],
      summary: 'Клиент ждёт счёт на белую дверь.',
    });
    await sweepNewLeads(d, ACC);
    expect(created[0]?.text).toContain('Клиент ждёт счёт');
  });

  it('без модели собирает комментарий из хвоста переписки', async () => {
    const { d, created } = deps({
      leads: [lead(9)],
      history: [{ role: 'client', text: 'Скиньте реквизиты', createdAt: new Date('2026-10-07T10:00:00Z') }],
      summary: null,
    });
    await sweepNewLeads(d, ACC);
    expect(created[0]?.text).toContain('Скиньте реквизиты');
  });

  it('пишет про пустой день, если общения не было', async () => {
    const { d, created } = deps({ leads: [lead(10)], summary: null });
    await sweepNewLeads(d, ACC);
    expect(created[0]?.text).toContain('не было');
  });

  it('не ставит задачу, если сотрудник сегодня писал клиенту в мессенджере', async () => {
    const { d, created } = deps({ leads: [lead(11)], summary: null });
    d.managerWroteSince = async () => new Date('2026-10-07T11:00:00Z');
    await sweepNewLeads(d, ACC);
    expect(created).toHaveLength(0);
  });

  it('ставит задачу, когда в мессенджере сегодня тихо', async () => {
    const { d, created } = deps({ leads: [lead(12)], summary: null });
    d.managerWroteSince = async () => null;
    await sweepNewLeads(d, ACC);
    expect(created).toHaveLength(1);
  });
});
