import { describe, expect, it } from 'vitest';
import { canCreateTask, isClosedLead, taskBlockSummary, taskScope, type TaskGuardLead } from '../src/task-guard.ts';

/** Воронка «Двери» и три этапа, на которых агент ставит задачи. */
const DVERI = 1873498;
const ZAKAZ = 50;
const PODGOTOVKA = 51;
const PAMYATKA = 52;
const DOSTAVKA = 53;
const SCOPE = { pipelineId: DVERI, statusIds: [ZAKAZ, PODGOTOVKA, PAMYATKA] };

const lead = (p: Partial<TaskGuardLead> = {}): TaskGuardLead => ({
  id: 29995033,
  status_id: ZAKAZ,
  pipeline_id: DVERI,
  closed_at: null,
  ...p,
});

function api(open: { id: number; text: string }[] = [], fail = false) {
  const calls: number[] = [];
  return {
    calls,
    api: {
      async openLeadTasks(leadId: number) {
        calls.push(leadId);
        if (fail) throw new Error('amo недоступна');
        return open;
      },
    },
  };
}

describe('isClosedLead', () => {
  it('системные этапы закрытия: 142 «Успешно», 143 «Закрыто и не реализовано»', () => {
    expect(isClosedLead(lead({ status_id: 142 }))).toBe(true);
    expect(isClosedLead(lead({ status_id: 143 }))).toBe(true);
  });

  it('заполненный closed_at означает закрытую сделку на любом этапе', () => {
    expect(isClosedLead(lead({ closed_at: 1760000000 }))).toBe(true);
  });

  it('открытая сделка', () => {
    expect(isClosedLead(lead())).toBe(false);
    expect(isClosedLead(lead({ closed_at: 0 }))).toBe(false);
  });
});

describe('canCreateTask — воронка «Двери»', () => {
  it('своя воронка и разрешённый этап — задача ставится', async () => {
    const { api: a } = api();
    expect(await canCreateTask(a, lead(), SCOPE)).toEqual({ allowed: true });
  });

  it('чужая воронка («Фабрики») — отказ, задачи amo не запрашиваются', async () => {
    const { api: a, calls } = api();
    const r = await canCreateTask(a, lead({ pipeline_id: 999 }), SCOPE);
    expect(r).toMatchObject({ allowed: false, reason: 'other_pipeline' });
    expect(calls).toHaveLength(0);
    expect(taskBlockSummary(r)).toBe('Задача не поставлена: воронка вне списка работы агента');
  });
});

describe('canCreateTask — этапы «Заказ», «Подготовка заказа», «Памятка»', () => {
  it.each([
    ['Заказ', ZAKAZ],
    ['Подготовка заказа', PODGOTOVKA],
    ['Памятка', PAMYATKA],
  ])('этап «%s» разрешён', async (_name, statusId) => {
    const { api: a } = api();
    expect((await canCreateTask(a, lead({ status_id: statusId }), SCOPE)).allowed).toBe(true);
  });

  it('этап «Доставка» вне списка — отказ', async () => {
    const { api: a } = api();
    const r = await canCreateTask(a, lead({ status_id: DOSTAVKA }), SCOPE);
    expect(r).toMatchObject({ allowed: false, reason: 'other_status' });
    expect(taskBlockSummary(r)).toBe('Задача не поставлена: этап вне списка работы агента');
  });

  it('список этапов пуст — ограничения по этапу нет', async () => {
    const { api: a } = api();
    expect((await canCreateTask(a, lead({ status_id: DOSTAVKA }), { pipelineId: DVERI, statusIds: [] })).allowed).toBe(true);
  });
});

describe('canCreateTask — закрытые сделки', () => {
  it('закрытая сделка в своей воронке — отказ раньше всех прочих проверок', async () => {
    const { api: a, calls } = api();
    const r = await canCreateTask(a, lead({ status_id: 143 }), SCOPE);
    expect(r).toMatchObject({ allowed: false, reason: 'closed' });
    expect(calls).toHaveLength(0);
    expect(taskBlockSummary(r)).toBe('Задача не поставлена: сделка закрыта');
  });

  it('сделка «81250» (#29549539): закрыта в феврале, задача не ставится', async () => {
    const { api: a } = api();
    const r = await canCreateTask(a, { id: 29549539, status_id: 142, pipeline_id: DVERI, closed_at: 1739000949 }, SCOPE);
    expect(r.reason).toBe('closed');
  });
});

describe('canCreateTask — вторая задача', () => {
  it('в сделке уже есть незакрытая задача — вторую не ставим', async () => {
    const { api: a } = api([{ id: 77, text: 'AI: клиент написал 20:33, ответа нет больше часа.' }]);
    const r = await canCreateTask(a, lead(), SCOPE);
    expect(r).toMatchObject({ allowed: false, reason: 'has_task', details: { taskIds: [77] } });
    expect(taskBlockSummary(r)).toBe('Задача не поставлена: в сделке уже есть незакрытая задача');
  });

  it('чужая задача менеджера тоже блокирует — дубль не нужен', async () => {
    const { api: a } = api([{ id: 90, text: 'Перезвонить клиенту' }]);
    expect((await canCreateTask(a, lead(), SCOPE)).reason).toBe('has_task');
  });

  it('открытых задач нет — ставим', async () => {
    const { api: a } = api([]);
    expect((await canCreateTask(a, lead(), SCOPE)).allowed).toBe(true);
  });

  it('список задач недоступен — не блокируем, но помечаем в details', async () => {
    const { api: a } = api([], true);
    const r = await canCreateTask(a, lead(), SCOPE);
    expect(r.allowed).toBe(true);
    expect(r.details).toMatchObject({ tasksCheckFailed: 'amo недоступна' });
  });
});

describe('taskScope', () => {
  it('берёт воронку и этапы из настроек', () => {
    expect(taskScope({ taskSweep: { pipelineId: DVERI, statusIds: [ZAKAZ, PAMYATKA] } })).toEqual({
      pipelineId: DVERI,
      statusIds: [ZAKAZ, PAMYATKA],
    });
  });
});

/**
 * Реактивация отказной сделки (RFD-AI-AGENT-REAKTIVATSIYA): сделку вернули с «Отказа»
 * на этап заказа, но `closed_at` в amo остался от прежнего закрытия.
 */
describe('флаг reactivated', () => {
  it('остаточный closed_at не считается закрытием, если этап открытый', () => {
    const l = lead({ status_id: ZAKAZ, closed_at: 1759000000 });
    expect(isClosedLead(l)).toBe(true);
    expect(isClosedLead(l, { reactivated: true })).toBe(false);
  });

  it('этап «Закрыто и не реализовано» флаг не открывает', async () => {
    const l = lead({ status_id: 143, closed_at: 1759000000 });
    expect(isClosedLead(l, { reactivated: true })).toBe(true);
    const { api: a } = api();
    expect(await canCreateTask(a, l, SCOPE, { reactivated: true })).toMatchObject({ allowed: false, reason: 'closed' });
  });

  it('задача ставится в возвращённую сделку, но этап и воронка проверяются как обычно', async () => {
    const { api: a, calls } = api();
    expect(await canCreateTask(a, lead({ closed_at: 1759000000 }), SCOPE, { reactivated: true })).toMatchObject({ allowed: true });
    expect(calls).toEqual([29995033]);
    expect(await canCreateTask(a, lead({ status_id: DOSTAVKA, closed_at: 1759000000 }), SCOPE, { reactivated: true })).toMatchObject({
      allowed: false,
      reason: 'other_status',
    });
    expect(await canCreateTask(a, lead({ pipeline_id: 777, closed_at: 1759000000 }), SCOPE, { reactivated: true })).toMatchObject({
      allowed: false,
      reason: 'other_pipeline',
    });
  });

  it('вторая задача не ставится и в возвращённой сделке', async () => {
    const { api: a } = api([{ id: 9, text: 'AI: перезвонить' }]);
    expect(await canCreateTask(a, lead({ closed_at: 1759000000 }), SCOPE, { reactivated: true })).toMatchObject({
      allowed: false,
      reason: 'has_task',
    });
  });
});
