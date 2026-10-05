import { DialogRepo, JournalRepo, MemoryRepo, SettingsRepo, SuggestionsRepo, widgetSettingsSchema, type WazzupChatKind, type WazzupContentItem } from '@ai-door/db';
import { PricingRepo } from '@ai-door/pricing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seeded, type Seeded } from '../../tools/test/fixtures.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { DialogPipeline, type DocumentAnalyzer } from '../src/pipeline.ts';
import { fakeAmo, type FakeAmoState } from './fake-amo.ts';
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

function wazzupFake(items: WazzupContentItem[], byLead: WazzupContentItem[] = [], chat: WazzupChatKind | null = null) {
  const calls: { phones: string[]; from: Date; to: Date }[] = [];
  const leadCalls: { leadId: number; from: Date; to: Date }[] = [];
  const consumed: number[] = [];
  return {
    calls,
    leadCalls,
    consumed,
    async historyByPhone() {
      return [];
    },
    async incomingContent(_acc: number, phones: string[], from: Date, to: Date) {
      calls.push({ phones, from, to });
      return items;
    },
    async incomingContentByLead(_acc: number, leadId: number, from: Date, to: Date) {
      leadCalls.push({ leadId, from, to });
      return byLead;
    },
    async resolveChatKind() {
      return chat ?? ({ kind: 'unknown', chatType: null, chatId: null, chatName: null } as WazzupChatKind);
    },
    async markConsumed(_acc: number, ids: number[]) {
      consumed.push(...ids);
    },
  };
}

async function setup(steps: ConstructorParameters<typeof ScriptedLlm>[0], wazzup: ReturnType<typeof wazzupFake>, docs = analyzer(), amo: Partial<FakeAmoState> = withPhone, mode: 'auto' | 'semi' | 'hints' = 'auto') {
  await new SettingsRepo(s.db).save(ACC, 1, widgetSettingsSchema.parse({ enabled: true, mode }));
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
    const out: { status: string; reason?: string } = await t.pipeline.processLead(ACC, lead);
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
    const out: { status: string; reason?: string } = await t.pipeline.processLead(ACC, lead);
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

const PHONE_FIELD = (v: string) => [{ field_code: 'PHONE', values: [{ value: v }] }];

const twoContacts: Partial<FakeAmoState> = {
  lead: {
    id: 0, name: 'x', price: 0, status_id: 10, pipeline_id: 1, responsible_user_id: 3, created_at: 0,
    custom_fields_values: null, _embedded: { contacts: [{ id: 88, is_main: true }, { id: 89 }] },
  },
  contact: { id: 88, name: 'Мария', custom_fields_values: PHONE_FIELD('+7 900 000-00-00') },
  contacts: {
    88: { id: 88, name: 'Мария', custom_fields_values: PHONE_FIELD('+7 900 000-00-00') },
    89: { id: 89, name: 'Второй', custom_fields_values: PHONE_FIELD('+7 995 507-29-44') },
  },
};

const noContacts: Partial<FakeAmoState> = {
  lead: {
    id: 0, name: 'x', price: 0, status_id: 10, pipeline_id: 1, responsible_user_id: 3, created_at: 0,
    custom_fields_values: null, _embedded: { contacts: [] },
  },
  contact: null,
};

describe('вложения: все контакты сделки и запасной поиск по чату', () => {
  it('телефон у второго контакта тоже идёт в поиск', async () => {
    const wz = wazzupFake([{ id: 601, contentUri: 'https://store.wazzup24.com/x/IMG_9.jpg', contentType: 'image', text: '[image]', sentAt: new Date() }]);
    const t = await setup([text('Вижу фото.')], wz, analyzer(), twoContacts);
    await t.dialog.enqueue(ACC, lead, PLACEHOLDER, 'https://test.amocrm.ru/c/1', null);
    await t.pipeline.processLead(ACC, lead);
    expect(wz.calls[0]!.phones).toEqual(['79000000000', '79955072944']);
    expect(wz.consumed).toEqual([601]);
  });

  it('телефонов нет — берём вложение по чату, связанному со сделкой', async () => {
    const wz = wazzupFake([], [{ id: 602, contentUri: 'https://store.wazzup24.com/x/IMG_8.jpg', contentType: 'image', text: '[image]', sentAt: new Date() }]);
    const t = await setup([text('Вижу фото.')], wz, analyzer(), noContacts);
    await t.dialog.enqueue(ACC, lead, PLACEHOLDER, 'https://test.amocrm.ru/c/1', null);
    await t.pipeline.processLead(ACC, lead);
    expect(wz.calls.length).toBe(0);
    expect(wz.leadCalls[0]!.leadId).toBe(lead);
    expect(wz.consumed).toEqual([602]);
  });

  it('нигде не нашли — в журнале остаётся след с телефонами', async () => {
    const wz = wazzupFake([], []);
    const t = await setup([text('Пришлите фото ещё раз.')], wz, analyzer(), twoContacts);
    await t.dialog.enqueue(ACC, lead, PLACEHOLDER, 'https://test.amocrm.ru/c/1', null);
    await t.pipeline.processLead(ACC, lead);
    const log = await t.journal.list(ACC, { leadId: lead });
    const miss = log.find((e) => e.summary === 'Вложение не найдено');
    expect(miss).toBeTruthy();
    expect(JSON.stringify(miss!.details)).toContain('79955072944');
  });
});

describe('бот Salesbot, когда ответа клиенту нет', () => {
  const RETURN = 'https://test.amocrm.ru/api/v4/salesbot/8147/continue/555';

  it('режим подсказки: бота останавливаем, чтобы следующее сообщение клиента запустило его заново', async () => {
    const t = await setup([text('Подсказка менеджеру.')], wazzupFake([]), analyzer(), withPhone, 'hints');
    await t.dialog.enqueue(ACC, lead, 'Сделаете дешевле?', RETURN, null);
    await t.pipeline.processLead(ACC, lead);
    const stop = t.fake.state.calls.find((c) => c.path === '/api/v4/bots/8147/stop');
    expect(stop).toBeTruthy();
    expect(stop!.method).toBe('POST');
    expect(stop!.body).toEqual({ entity_id: lead, entity_type: 'leads' });
  });

  it('ответ отправлен — бота не трогаем', async () => {
    const t = await setup([text('Здравствуйте!')], wazzupFake([]));
    await t.dialog.enqueue(ACC, lead, 'Добрый день', RETURN, null);
    const out: { status: string; reason?: string } = await t.pipeline.processLead(ACC, lead);
    expect(out.status).toBe('replied');
    expect(t.fake.state.calls.some((c) => c.path.endsWith('/stop'))).toBe(false);
  });
});

const ALLOWED_CHAT = '79296519427-1595920633';
const GROUP_HEAD = 'Дмитрий +79518884966\n>>>>>>>>>>>>>>>>>>\n';
const inGroup = (chatId: string): WazzupChatKind =>
  ({ kind: 'group', chatType: 'whatsgroup', chatId, chatName: 'Бухгалтерия' }) as WazzupChatKind;

describe('групповые чаты', () => {
  it('чат не опознан, но текст с подписью автора — молчим', async () => {
    const t = await setup([text('Ответ в группу.')], wazzupFake([]));
    await t.dialog.enqueue(ACC, lead, `${GROUP_HEAD}Говорят не видят приглашение`, 'https://test.amocrm.ru/c/1', null);
    const out: { status: string; reason?: string } = await t.pipeline.processLead(ACC, lead);
    expect(out.status).toBe('skipped');
    expect(out.reason).toBe('group_chat');
  });

  it('разрешённая группа без обращения — молчим', async () => {
    const t = await setup([text('Ответ в группу.')], wazzupFake([], [], inGroup(ALLOWED_CHAT)));
    await t.dialog.enqueue(ACC, lead, `${GROUP_HEAD}Счёт оплатили`, 'https://test.amocrm.ru/c/1', null);
    const out: { status: string; reason?: string } = await t.pipeline.processLead(ACC, lead);
    expect(out.status).toBe('skipped');
    expect(out.reason).toBe('group_no_mention');
  });

  it('разрешённая группа с обращением — отвечаем', async () => {
    const t = await setup([text('Готово.')], wazzupFake([], [], inGroup(ALLOWED_CHAT)));
    await t.dialog.enqueue(ACC, lead, `${GROUP_HEAD}@Амма посчитай дверь`, 'https://test.amocrm.ru/c/1', null);
    const out: { status: string; reason?: string } = await t.pipeline.processLead(ACC, lead);
    expect(out.status).toBe('replied');
  });

  it('личный чат не задет', async () => {
    const t = await setup([text('Здравствуйте!')], wazzupFake([]));
    await t.dialog.enqueue(ACC, lead, 'Добрый день', 'https://test.amocrm.ru/c/1', null);
    const out: { status: string; reason?: string } = await t.pipeline.processLead(ACC, lead);
    expect(out.status).toBe('replied');
  });
});

describe('задача менеджеру, когда ответа клиенту нет', () => {
  const client = () => ({ at: new Date().toISOString(), text: 'Сможем добавить?' });

  it('менеджер ответил в чате — задачу не ставим', async () => {
    const t = await setup([text('x')], wazzupFake([]), analyzer(), {
      ...withPhone,
      events: [
        { id: '1', type: 'outgoing_chat_message', entity_id: lead, created_by: 7, created_at: Math.floor(Date.now() / 1000) },
      ],
    });
    const r = await t.pipeline.checkUnanswered(ACC, lead, client());
    expect(r.status).toBe('answered');
  });

  it('ответа нет — ставим задачу с причиной и текстом клиента', async () => {
    const t = await setup([text('x')], wazzupFake([]));
    await t.journal.add({
      accountId: ACC,
      leadId: lead,
      kind: 'blocked',
      summary: 'Ответ не отправлен',
      details: { reason: 'manager_active' },
    });
    const r = await t.pipeline.checkUnanswered(ACC, lead, client());
    expect(r.status).toBe('task_created');
    const post = t.fake.state.calls.find((c) => c.path === '/api/v4/tasks' && c.method === 'POST');
    expect(post).toBeTruthy();
    const body = (post!.body as { text: string }[])[0];
    expect(body!.text).toContain('менеджер ведёт диалог');
    expect(body!.text).toContain('Сможем добавить?');
  });

  it('незакрытая задача агента есть — вторую не создаём', async () => {
    const t = await setup([text('x')], wazzupFake([]), analyzer(), {
      ...withPhone,
      openTasks: [{ id: 5, text: 'AI: клиент написал 10:00, ответа нет больше часа.' }],
    });
    const r = await t.pipeline.checkUnanswered(ACC, lead, client());
    expect(r.status).toBe('task_exists');
  });
});
