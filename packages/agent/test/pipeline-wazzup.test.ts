import { DialogRepo, JournalRepo, MemoryRepo, SettingsRepo, SuggestionsRepo, widgetSettingsSchema, type WazzupContentItem } from '@ai-door/db';
import { PricingRepo } from '@ai-door/pricing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seeded, type Seeded } from '../../tools/test/fixtures.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { DialogPipeline, type DocumentAnalyzer } from '../src/pipeline.ts';
import { fakeAmo } from './fake-amo.ts';
import { ScriptedLlm, text } from './scripted-llm.ts';

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

/** Заглушка, которую ставит hook Salesbot, когда {{message_text}} пустой (клиент прислал фото/файл). */
const PLACEHOLDER = '(клиент отправил сообщение без текста — вложение или стикер)';

const withPhone = {
  lead: { id: 0, name: 'x', price: 0, status_id: 10, pipeline_id: 1, responsible_user_id: 3, created_at: 0, custom_fields_values: null, _embedded: { contacts: [{ id: 88, is_main: true }] } },
  contact: { id: 88, name: 'Алена', custom_fields_values: [{ field_code: 'PHONE', values: [{ value: '+7 (977) 379-34-80' }, { value: '8 977 379 34 80' }] }] },
};

function analyzer(): DocumentAnalyzer & { inputs: unknown[] } {
  const inputs: unknown[] = [];
  return {
    inputs,
    async analyze(input) {
      inputs.push({ ...input, bytes: input.bytes.byteLength });
      return {
        id: 1,
        kind: 'measurement',
        text: '[Фото «IMG_2.jpg»] Межкомнатная дверь, белая эмаль, глухая.',
        note: '[AI] Разбор фото «IMG_2.jpg»',
        memoryOpenings: [],
        costUsd: 0.01,
        model: 'test-vision',
      };
    },
  };
}

function wazzupFake(items: WazzupContentItem[]) {
  const calls: { phones: string[]; from: Date; to: Date }[] = [];
  const consumed: number[] = [];
  return {
    calls,
    consumed,
    async historyByPhone() {
      return [];
    },
    async incomingContent(_acc: number, phones: string[], from: Date, to: Date) {
      calls.push({ phones, from, to });
      return items;
    },
    async markConsumed(_acc: number, ids: number[]) {
      consumed.push(...ids);
    },
  };
}

async function setup(steps: ConstructorParameters<typeof ScriptedLlm>[0], wazzup: ReturnType<typeof wazzupFake>, docs = analyzer()) {
  await new SettingsRepo(s.db).save(ACC, 1, widgetSettingsSchema.parse({ enabled: true, mode: 'auto' }));
  const llm = new ScriptedLlm(steps);
  const fake = fakeAmo(withPhone);
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
    download: async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/jpeg' }),
    documents: docs,
    wazzup,
    wazzupRetryMs: 0,
  };
  return { fake, ...deps, pipeline: new DialogPipeline(deps) };
}

describe('вложения клиента из Wazzup (Salesbot их не передаёт)', () => {
  it('сообщение без текста → фото из вебхука разбирается, журнал note, вложение помечено использованным', async () => {
    const wz = wazzupFake([{ id: 501, contentUri: 'https://store.wazzup24.com/x/IMG_2.jpg', contentType: 'image', text: '[image]', sentAt: new Date() }]);
    const docs = analyzer();
    const t = await setup([text('Вижу: белая глухая дверь в эмали. Подберём похожую.')], wz, docs);
    await t.dialog.enqueue(ACC, lead, PLACEHOLDER, 'https://test.amocrm.ru/c/1', null);
    const out = await t.pipeline.processLead(ACC, lead);
    expect(out.status).toBe('replied');
    // Оба номера контакта нормализованы в один chatId.
    expect(wz.calls[0]!.phones).toEqual(['79773793480']);
    expect(wz.consumed).toEqual([501]);
    expect(docs.inputs[0]).toMatchObject({ filename: 'IMG_2.jpg', mime: 'image/jpeg', source: 'chat' });
    const userMsg = JSON.stringify(t.llm.requests[0]!.messages);
    expect(userMsg).toContain('белая эмаль');
    expect(userMsg).not.toContain('без текста');
    const log = await t.journal.list(ACC, { leadId: lead });
    expect(log.find((e) => e.summary.startsWith('Вложение из Wazzup: image'))).toBeTruthy();
  });

  it('в Wazzup за окно ничего нет → одна повторная попытка и заглушка остаётся', async () => {
    const wz = wazzupFake([]);
    const t = await setup([text('Пришлите, пожалуйста, фото ещё раз.')], wz);
    await t.dialog.enqueue(ACC, lead, PLACEHOLDER, 'https://test.amocrm.ru/c/1', null);
    const out = await t.pipeline.processLead(ACC, lead);
    expect(out.status).toBe('replied');
    expect(wz.calls.length).toBe(2);
    expect(JSON.stringify(t.llm.requests[0]!.messages)).toContain('без текста');
  });

  it('обычный текст без вложения в Wazzup не ищется', async () => {
    const wz = wazzupFake([]);
    const t = await setup([text('Здравствуйте!')], wz);
    await t.dialog.enqueue(ACC, lead, 'Добрый день', 'https://test.amocrm.ru/c/1', null);
    await t.pipeline.processLead(ACC, lead);
    expect(wz.calls.length).toBe(0);
  });
});
