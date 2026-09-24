import Anthropic from '@anthropic-ai/sdk';
import { DialogRepo, JournalRepo, SettingsRepo, widgetSettingsSchema, type WidgetSettingsInput } from '@ai-door/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seeded, type Seeded } from '../../tools/test/fixtures.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { DialogPipeline } from '../src/pipeline.ts';
import { fakeAmo, type FakeAmoState } from './fake-amo.ts';
import { ScriptedLlm, text, toolUse } from './scripted-llm.ts';

let s: Seeded;
let lead = 100;
const ACC = 1;

beforeAll(async () => {
  s = await seeded(ACC);
});
afterAll(async () => s.drop());
beforeEach(() => {
  lead += 1;
});

async function setup(steps: ConstructorParameters<typeof ScriptedLlm>[0], settings: WidgetSettingsInput = {}, amo: Partial<FakeAmoState> = {}) {
  await new SettingsRepo(s.db).save(ACC, 1, widgetSettingsSchema.parse({ enabled: true, mode: 'auto', ...settings }));
  const llm = new ScriptedLlm(steps);
  const fake = fakeAmo(amo);
  const dialog = new DialogRepo(s.db);
  const journal = new JournalRepo(s.db);
  const pipeline = new DialogPipeline({
    settings: new SettingsRepo(s.db),
    dialog,
    journal,
    catalog: s.catalog,
    knowledge: s.knowledge,
    orchestrator: new Orchestrator(llm),
    amo: async () => fake.access,
    send: fake.send,
  });
  return { llm, fake, dialog, journal, pipeline };
}

const journalKinds = async (j: JournalRepo) => (await j.list(ACC, { leadId: lead })).map((r) => r.kind).reverse();

describe('DialogPipeline', () => {
  it('склеивает серию, отвечает последнему боту, остальных продолжает', async () => {
    const t = await setup([toolUse(['catalog_search', { query: 'входная терморазрыв' }]), text('Подойдёт Страж Термо — 42 000 ₽, в наличии.')]);
    await t.dialog.enqueue(ACC, lead, 'Здравствуйте', 'https://test.amocrm.ru/c/1');
    await t.dialog.enqueue(ACC, lead, 'Нужна входная дверь в дом', 'https://test.amocrm.ru/c/2');
    const out = await t.pipeline.processLead(ACC, lead);

    expect(out).toEqual({ status: 'replied', text: 'Подойдёт Страж Термо — 42 000 ₽, в наличии.' });
    expect(t.fake.state.sent).toEqual([
      { returnUrl: 'https://test.amocrm.ru/c/1', messages: [] },
      { returnUrl: 'https://test.amocrm.ru/c/2', messages: ['Подойдёт Страж Термо — 42 000 ₽, в наличии.'] },
    ]);
    // В модель ушли оба сообщения одним ходом.
    expect(t.llm.requests[0]!.messages.at(-1)!.content).toBe('Здравствуйте\nНужна входная дверь в дом');
    expect((await t.dialog.history(ACC, lead)).map((m) => m.role)).toEqual(['client', 'client', 'ai']);
    const [entry] = await t.journal.list(ACC, { leadId: lead });
    expect(entry).toMatchObject({ kind: 'reply' });
    expect(entry!.costRub).toBeGreaterThan(0);
    expect(entry!.details).toMatchObject({ toolCalls: [expect.objectContaining({ specName: 'catalog.search' })] });
  });

  it('AI замолкает после сообщения менеджера', async () => {
    const t = await setup([], {}, { events: [{ id: 'e1', type: 'outgoing_chat_message', entity_id: 0, created_by: 555, created_at: 0 }] });
    await t.dialog.enqueue(ACC, lead, 'Ну что там?', 'https://test.amocrm.ru/c/3');
    expect(await t.pipeline.processLead(ACC, lead)).toEqual({ status: 'skipped', reason: 'manager' });
    expect(t.llm.requests).toHaveLength(0);
    expect(t.fake.state.sent).toEqual([{ returnUrl: 'https://test.amocrm.ru/c/3', messages: [] }]);
    expect((await t.dialog.state(ACC, lead)).pauseReason).toBe('manager_message');

    // Следующее сообщение клиента — AI всё ещё молчит.
    await t.dialog.enqueue(ACC, lead, 'Алло?', null);
    expect(await t.pipeline.processLead(ACC, lead)).toEqual({ status: 'skipped', reason: 'paused' });
    expect(await journalKinds(t.journal)).toEqual(['pause', 'skipped', 'skipped']);
  });

  it('сообщения бота (created_by = 0) не ставят паузу', async () => {
    const t = await setup([text('Здравствуйте! Какая дверь вас интересует?')], {}, {
      events: [{ id: 'e2', type: 'outgoing_chat_message', entity_id: 0, created_by: 0, created_at: 0 }],
    });
    await t.dialog.enqueue(ACC, lead, 'Добрый день', null);
    expect((await t.pipeline.processLead(ACC, lead)).status).toBe('replied');
  });

  it('режим «Выкл», этап без AI, воронка не из списка', async () => {
    const off = await setup([], { mode: 'off' });
    await off.dialog.enqueue(ACC, lead, 'x', null);
    expect(await off.pipeline.processLead(ACC, lead)).toEqual({ status: 'skipped', reason: 'disabled' });

    lead += 1;
    const st = await setup([], { where: { disabledStatusIds: [10] } });
    await st.dialog.enqueue(ACC, lead, 'x', null);
    expect(await st.pipeline.processLead(ACC, lead)).toEqual({ status: 'skipped', reason: 'status' });

    lead += 1;
    const pl = await setup([], { where: { pipelineIds: [2] } });
    await pl.dialog.enqueue(ACC, lead, 'x', null);
    expect(await pl.pipeline.processLead(ACC, lead)).toEqual({ status: 'skipped', reason: 'pipeline' });
  });

  it('передача менеджеру: задача, примечание, этап, фраза, пауза', async () => {
    const t = await setup([toolUse(['crm_handoff', { reason: 'wholesale', summary: 'Опт 40 дверей' }])], {
      handoff: { statusId: 777, taskTypeId: 2, taskDeadlineMin: 30 },
    });
    await t.dialog.enqueue(ACC, lead, 'Нужно 40 дверей для гостиницы', 'https://test.amocrm.ru/c/4');
    expect(await t.pipeline.processLead(ACC, lead)).toEqual({ status: 'handoff', reason: 'wholesale' });

    const task = t.fake.state.calls.find((c) => c.path === '/api/v4/tasks');
    expect(task?.body).toEqual([expect.objectContaining({ task_type_id: 2, entity_id: lead, text: expect.stringContaining('Оптовый заказ') })]);
    expect(t.fake.state.calls.some((c) => c.method === 'PATCH' && (c.body as { status_id: number }).status_id === 777)).toBe(true);
    expect(t.fake.state.calls.some((c) => c.method === 'POST' && c.path.endsWith('/notes'))).toBe(true);
    expect(t.fake.state.sent[0]?.messages).toEqual(['Передаю ваш вопрос менеджеру — он свяжется с вами в ближайшее время.']);
    expect((await t.dialog.state(ACC, lead)).paused).toBe(true);
  });

  it('заблокированный пост-фильтром ответ не уходит клиенту — передача менеджеру', async () => {
    const t = await setup([text('Цена 1 ₽'), text('Цена 2 ₽'), text('Цена 3 ₽')]);
    await t.dialog.enqueue(ACC, lead, 'Сколько стоит?', 'https://test.amocrm.ru/c/5');
    expect(await t.pipeline.processLead(ACC, lead)).toEqual({ status: 'handoff', reason: 'no_answer' });
    const sentText = t.fake.state.sent.flatMap((x) => x.messages).join(' ');
    expect(sentText).not.toMatch(/Цена \d ₽/);
    expect(await journalKinds(t.journal)).toEqual(['blocked', 'handoff']);
  });

  it('два промаха подряд — передача менеджеру', async () => {
    const miss = () => [toolUse(['catalog_search', { query: 'перегородка купе' }]), text('Такого в каталоге нет. Уточните, пожалуйста, что нужно?')];
    const t = await setup([...miss(), ...miss()]);
    await t.dialog.enqueue(ACC, lead, 'Перегородки купе есть?', null);
    expect((await t.pipeline.processLead(ACC, lead)).status).toBe('replied');
    await t.dialog.enqueue(ACC, lead, 'Раздвижные', 'https://test.amocrm.ru/c/6');
    expect(await t.pipeline.processLead(ACC, lead)).toEqual({ status: 'handoff', reason: 'no_answer' });
    expect(t.fake.state.sent.at(-1)?.messages).toHaveLength(2);
  });

  it('недоступность LLM — задача менеджеру', async () => {
    const err = new Anthropic.InternalServerError(529, { type: 'error' }, 'Overloaded', new Headers());
    const t = await setup([err, err]);
    await t.dialog.enqueue(ACC, lead, 'Привет', null);
    expect(await t.pipeline.processLead(ACC, lead)).toEqual({ status: 'handoff', reason: 'no_answer' });
    expect(t.fake.state.calls.some((c) => c.path === '/api/v4/tasks')).toBe(true);
  });

  it('дневной лимит ₽', async () => {
    const t = await setup([], { limits: { dailyRub: 0.01 } });
    await t.journal.add({ accountId: ACC, kind: 'reply', summary: 'x', costRub: 1 });
    await t.dialog.enqueue(ACC, lead, 'Привет', null);
    expect(await t.pipeline.processLead(ACC, lead)).toEqual({ status: 'skipped', reason: 'limit' });
  });

  it('ошибка отправки в чат попадает в журнал', async () => {
    const t = await setup([text('Здравствуйте!')], {}, { failSend: true });
    await t.dialog.enqueue(ACC, lead, 'Привет', 'https://test.amocrm.ru/c/7');
    await t.pipeline.processLead(ACC, lead);
    expect(await journalKinds(t.journal)).toEqual(['reply', 'error']);
  });

  it('пустая очередь', async () => {
    const t = await setup([]);
    expect(await t.pipeline.processLead(ACC, lead)).toEqual({ status: 'empty' });
  });
});
