import { DialogRepo, JournalRepo, MemoryRepo, SettingsRepo, SuggestionsRepo, widgetSettingsSchema, type WidgetSettingsInput } from '@ai-door/db';
import { PricingRepo } from '@ai-door/pricing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seeded, type Seeded } from '../../tools/test/fixtures.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { DialogPipeline } from '../src/pipeline.ts';
import { fakeAmo } from './fake-amo.ts';
import { ScriptedLlm, text, toolUse } from './scripted-llm.ts';

let s: Seeded;
let lead = 9000;
const ACC = 1;
beforeAll(async () => {
  s = await seeded(ACC);
});
afterAll(async () => s.drop());
beforeEach(() => {
  lead += 1;
});

const META = { from: 'ivan@client.ru', fromName: 'Иван', subject: 'Двери', messageId: '<m1@client.ru>', references: [] };

async function setup(steps: ConstructorParameters<typeof ScriptedLlm>[0], settings: WidgetSettingsInput = {}, managerReplied = false) {
  await new SettingsRepo(s.db).save(ACC, 1, widgetSettingsSchema.parse({ enabled: true, mode: 'auto', ...settings }));
  const llm = new ScriptedLlm(steps);
  const fake = fakeAmo();
  const emails: { leadId: number; meta: Record<string, unknown>; text: string }[] = [];
  const deps = {
    settings: new SettingsRepo(s.db),
    dialog: new DialogRepo(s.db),
    journal: new JournalRepo(s.db),
    catalog: s.catalog,
    knowledge: s.knowledge,
    pricing: new PricingRepo(s.db),
    memory: new MemoryRepo(s.db),
    suggestions: new SuggestionsRepo(s.db),
    orchestrator: new Orchestrator(llm),
    llm,
    amo: async () => fake.access,
    send: fake.send,
    email: {
      reply: async (_a: number, leadId: number, meta: Record<string, unknown>, t: string) => void emails.push({ leadId, meta, text: t }),
      managerRepliedSince: async () => managerReplied,
    },
  };
  return { fake, emails, ...deps, pipeline: new DialogPipeline(deps) };
}

const enqueueEmail = (d: DialogRepo, text = 'Тема письма: Двери\nНужна белая дверь в эмали') =>
  d.enqueue(ACC, lead, text, null, null, { channel: 'email', meta: META });

describe('почта в конвейере', () => {
  it('ответ уходит письмом на письмо клиента, модель знает о канале', async () => {
    const t = await setup([toolUse(['catalog_search', { query: 'белая эмаль' }]), text('Добрый день!\n\nРекомендую Турин 1 — 14 900 ₽.')]);
    await enqueueEmail(t.dialog);
    expect((await t.pipeline.processLead(ACC, lead)).status).toBe('replied');
    expect(t.emails).toEqual([{ leadId: lead, meta: META, text: 'Добрый день!\n\nРекомендую Турин 1 — 14 900 ₽.' }]);
    expect(t.fake.state.sent).toEqual([]);
    expect(JSON.stringify(t.llm.requests[0]!.system)).toContain('Канал: электронная почта');
  });

  it('менеджер ответил клиенту письмом — AI на паузе', async () => {
    const t = await setup([], { hints: { whenPaused: false } }, true);
    await enqueueEmail(t.dialog);
    expect(await t.pipeline.processLead(ACC, lead)).toEqual({ status: 'skipped', reason: 'manager' });
    expect(t.emails).toEqual([]);
    expect((await t.dialog.state(ACC, lead)).pauseReason).toBe('manager_message');
  });

  it('передача менеджеру: фраза клиенту письмом', async () => {
    const t = await setup([toolUse(['crm_handoff', { reason: 'legal_entity', summary: 'ООО, счёт' }])]);
    await enqueueEmail(t.dialog, 'Тема письма: Счёт\nНужен счёт на ООО');
    expect(await t.pipeline.processLead(ACC, lead)).toEqual({ status: 'handoff', reason: 'legal_entity' });
    expect(t.emails[0]?.text).toBe('Передаю ваш вопрос менеджеру — он свяжется с вами в ближайшее время.');
  });

  it('«Полуавто»: черновик с данными письма для отправки после одобрения', async () => {
    const t = await setup([text('Добрый день! Какие размеры проёмов?')], { mode: 'semi' });
    await enqueueEmail(t.dialog);
    expect((await t.pipeline.processLead(ACC, lead)).status).toBe('drafted');
    expect(t.emails).toEqual([]);
    const [draft] = await t.suggestions.listForLead(ACC, lead);
    expect(draft?.details).toMatchObject({ channel: 'email', emailMeta: META });
  });

  it('ошибка SMTP попадает в журнал', async () => {
    const t = await setup([text('Добрый день!')]);
    t.pipeline = new DialogPipeline({ ...t, email: { reply: async () => { throw new Error('SMTP 535'); }, managerRepliedSince: async () => false } });
    await enqueueEmail(t.dialog);
    await t.pipeline.processLead(ACC, lead);
    const kinds = (await t.journal.list(ACC, { leadId: lead })).map((r) => [r.kind, r.summary]);
    expect(kinds[0]).toEqual(['error', 'Не удалось отправить ответ клиенту']);
  });
});
