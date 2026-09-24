import { DialogRepo, JournalRepo, MemoryRepo, SettingsRepo, SuggestionsRepo, widgetSettingsSchema, type WidgetSettingsInput } from '@ai-door/db';
import { PricingRepo, pricingRulesSchema } from '@ai-door/pricing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seeded, type Seeded } from '../../tools/test/fixtures.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { DialogPipeline } from '../src/pipeline.ts';
import { fakeAmo, type FakeAmoState } from './fake-amo.ts';
import { ScriptedLlm, text, toolUse } from './scripted-llm.ts';

let s: Seeded;
let lead = 5000;
const ACC = 1;

beforeAll(async () => {
  s = await seeded(ACC);
  await new PricingRepo(s.db).save(
    ACC,
    1,
    pricingRulesSchema.parse({
      components: [
        { code: 'box', name: 'Коробка телескоп', qtyPerDoor: 2.5, defaultPrice: 1200 },
        { code: 'casing', name: 'Наличник телескоп', qtyPerDoor: 5, defaultPrice: 800 },
      ],
      services: [{ code: 'delivery_mkad', name: 'Доставка в пределах МКАД', unit: 'fixed', price: 1500 }],
    }),
  );
});
afterAll(async () => s.drop());
beforeEach(() => {
  lead += 1;
});

async function setup(
  steps: ConstructorParameters<typeof ScriptedLlm>[0],
  settings: WidgetSettingsInput = {},
  amo: Partial<FakeAmoState> = {},
  extra: { stt?: boolean } = {},
) {
  await new SettingsRepo(s.db).save(ACC, 1, widgetSettingsSchema.parse({ enabled: true, mode: 'auto', ...settings }));
  const llm = new ScriptedLlm(steps);
  const fake = fakeAmo(amo);
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
    ...(extra.stt
      ? {
          stt: () => ({ name: 'fake', transcribe: async () => 'Нужна белая дверь в спальню' }),
          download: async () => ({ bytes: new Uint8Array([1]), mime: 'audio/ogg' }),
        }
      : {}),
  };
  return { fake, ...deps, pipeline: new DialogPipeline(deps) };
}

const withContact = { lead: { id: 0, name: 'x', price: 0, status_id: 10, pipeline_id: 1, responsible_user_id: 3, created_at: 0, custom_fields_values: null, _embedded: { contacts: [{ id: 77, is_main: true }] } } };
const toolNames = (req: { tools?: unknown[] }) => (req.tools ?? []).map((t) => (t as { name: string }).name);

describe('режим «Полуавто»', () => {
  it('ответ становится черновиком, клиенту ничего не уходит', async () => {
    const t = await setup([text('Здравствуйте! Какие двери вас интересуют?')], { mode: 'semi' });
    await t.dialog.enqueue(ACC, lead, 'Добрый день', 'https://test.amocrm.ru/c/1');
    const out = await t.pipeline.processLead(ACC, lead);
    expect(out.status).toBe('drafted');
    expect(t.fake.state.sent).toEqual([{ returnUrl: 'https://test.amocrm.ru/c/1', messages: [] }]);
    const [draft] = await t.suggestions.listForLead(ACC, lead);
    expect(draft).toMatchObject({ kind: 'draft', status: 'pending', text: 'Здравствуйте! Какие двери вас интересуют?' });
    expect((await t.dialog.history(ACC, lead)).map((m) => m.role)).toEqual(['client']);
  });
});

describe('подсказки', () => {
  it('на паузе после менеджера — подсказка, только читающие инструменты', async () => {
    const t = await setup([text('Подскажите клиенту модель Турин 1.')], {}, { events: [{ id: 'e', type: 'outgoing_chat_message', entity_id: 0, created_by: 5, created_at: 0 }] });
    await t.dialog.enqueue(ACC, lead, 'А белые есть?', null);
    expect((await t.pipeline.processLead(ACC, lead)).status).toBe('hinted');
    expect(toolNames(t.llm.requests[0]!)).toEqual(['catalog_search', 'catalog_get_product', 'knowledge_search', 'crm_get_context', 'price_calculate']);
    expect((await t.suggestions.listForLead(ACC, lead))[0]).toMatchObject({ kind: 'hint', text: 'Подскажите клиенту модель Турин 1.' });
    expect((await t.dialog.state(ACC, lead)).paused).toBe(true);
  });

  it('режим «Только подсказки»', async () => {
    const t = await setup([text('Можно предложить Порта 21.')], { mode: 'hints' });
    await t.dialog.enqueue(ACC, lead, 'Нужна недорогая дверь', 'https://test.amocrm.ru/c/2');
    expect((await t.pipeline.processLead(ACC, lead)).status).toBe('hinted');
    expect(t.fake.state.sent[0]?.messages).toEqual([]);
    expect(toolNames(t.llm.requests[0]!)).not.toContain('crm_handoff');
  });
});

describe('расчёт и память', () => {
  it('итог из price_calculate проходит пост-фильтр, черновик детализации — в примечание', async () => {
    const t = await setup(
      [
        toolUse(['price_calculate', { doors: [{ product_id: '1004', width_mm: 800, height_mm: 2000, qty: 2 }], services: [{ code: 'delivery_mkad' }] }]),
        // 7 900 × 2 + коробка 5 × 1 200 + наличник 10 × 800 + доставка 1 500 = 31 300
        text('Две двери Порта 21 с коробкой, наличниками и доставкой — 31 300 ₽. Расчёт предварительный.'),
      ],
      {},
      withContact,
    );
    await t.dialog.enqueue(ACC, lead, 'Посчитайте 2 двери Порта 21 80 см с доставкой', 'https://test.amocrm.ru/c/3');
    const out = await t.pipeline.processLead(ACC, lead);
    expect(out.status).toBe('replied');
    const note = t.fake.state.calls.find((c) => c.method === 'POST' && c.path.endsWith('/notes'));
    expect(JSON.stringify(note?.body)).toContain('Черновик детализации');
    expect(JSON.stringify(note?.body)).toContain('Коробка телескоп — 5 шт.');
    expect((await t.memory.get(ACC, 'contact:77')).data.last_calculation).toMatchObject({ total_rub: 31300, complete: true });
    // Коды для расчёта — в системной инструкции.
    expect(JSON.stringify(t.llm.requests[0]!.system)).toContain('delivery_mkad');
  });

  it('память по контакту подхватывается в новой сделке', async () => {
    const t1 = await setup(
      [toolUse(['memory_save', { budget_rub: 45000, preferences: { color: 'белый' } }]), text('Запомнил: белые двери, бюджет 45 000 ₽.')],
      {},
      withContact,
    );
    await t1.dialog.enqueue(ACC, lead, 'Хочу белые двери, бюджет 45 000', null);
    expect((await t1.pipeline.processLead(ACC, lead)).status).toBe('replied');

    lead += 1;
    const t2 = await setup([text('Рад снова помочь! В пределах 45 000 ₽ подберу белые модели.')], {}, withContact);
    await t2.dialog.enqueue(ACC, lead, 'Здравствуйте, снова я', null);
    // Бюджет из памяти — допустимое число для пост-фильтра.
    expect((await t2.pipeline.processLead(ACC, lead)).status).toBe('replied');
    const sys = JSON.stringify(t2.llm.requests[0]!.system);
    expect(sys).toContain('Бюджет клиента: 45000 ₽');
    expect(sys).toContain('color: белый');
  });
});

describe('голосовые', () => {
  it('расшифровка попадает в модель', async () => {
    const t = await setup([text('Для спальни подойдёт Турин 1.')], { stt: { provider: 'yandex' } }, {}, { stt: true });
    await t.dialog.enqueue(ACC, lead, '', null, { url: 'https://drive.amocrm.ru/v.ogg', type: 'voice' });
    await t.pipeline.processLead(ACC, lead);
    expect(t.llm.requests[0]!.messages.at(-1)!.content).toBe('[Голосовое сообщение] Нужна белая дверь в спальню');
  });

  it('без расшифровки — пометка для агента', async () => {
    const t = await setup([text('Пожалуйста, напишите вопрос текстом.')]);
    await t.dialog.enqueue(ACC, lead, '', null, { url: 'https://drive.amocrm.ru/v.ogg', type: 'voice' });
    await t.pipeline.processLead(ACC, lead);
    expect(String(t.llm.requests[0]!.messages.at(-1)!.content)).toMatch(/расшифровка выключена/);
  });
});

describe('лимиты', () => {
  it('превышение дневного лимита: передача менеджеру', async () => {
    const t = await setup([], { limits: { dailyRub: 0.01, onExceed: 'handoff' } });
    await t.journal.add({ accountId: ACC, kind: 'reply', summary: 'x', costRub: 5 });
    await t.dialog.enqueue(ACC, lead, 'Привет', null);
    expect(await t.pipeline.processLead(ACC, lead)).toEqual({ status: 'handoff', reason: 'other' });
    expect(t.llm.requests).toHaveLength(0);
  });

  it('превышение дневного лимита: переход в подсказки', async () => {
    const t = await setup([text('Подсказка менеджеру')], { limits: { dailyRub: 0.01, onExceed: 'hints' } });
    await t.dialog.enqueue(ACC, lead, 'Привет', null);
    expect((await t.pipeline.processLead(ACC, lead)).status).toBe('hinted');
  });

  it('лимит ответов AI в сделке', async () => {
    const t = await setup([], { limits: { maxAiMessagesPerLead: 1 } });
    await t.dialog.addMessage(ACC, lead, 'ai', 'уже отвечал');
    await t.dialog.enqueue(ACC, lead, 'Ещё вопрос', null);
    expect(await t.pipeline.processLead(ACC, lead)).toEqual({ status: 'handoff', reason: 'other' });
  });
});

describe('резюме при передаче', () => {
  it('резюме от модели — в примечание и в память клиента', async () => {
    const t = await setup(
      [
        toolUse(['crm_handoff', { reason: 'discount', summary: 'Просит скидку' }]),
        text('Потребность: 3 белые двери.\nОткрытые вопросы: скидка.\nСледующий шаг: позвонить клиенту.'),
      ],
      {},
      withContact,
    );
    await t.dialog.enqueue(ACC, lead, 'Сделаете скидку на 3 двери?', 'https://test.amocrm.ru/c/9');
    expect(await t.pipeline.processLead(ACC, lead)).toEqual({ status: 'handoff', reason: 'discount' });
    const note = t.fake.state.calls.find((c) => c.method === 'POST' && c.path.endsWith('/notes'));
    expect(JSON.stringify(note?.body)).toContain('Следующий шаг: позвонить клиенту');
    expect((await t.memory.get(ACC, 'contact:77')).summary).toMatch(/3 белые двери/);
    expect(t.fake.state.sent.at(-1)?.messages).toEqual(['Передаю ваш вопрос менеджеру — он свяжется с вами в ближайшее время.']);
  });
});
