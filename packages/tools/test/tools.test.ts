import { AmoApiClient } from '@ai-door/amo';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AmoCrm,
  catalogGetProduct,
  catalogSearch,
  crmAddNote,
  crmGetContext,
  crmHandoff,
  knowledgeSearch,
  PHASE1_TOOLS,
  SandboxCrm,
  type ToolContext,
} from '../src/index.ts';
import { seeded, type Seeded } from './fixtures.ts';

let s: Seeded;
let ctx: ToolContext;
let crm: SandboxCrm;

beforeAll(async () => {
  s = await seeded();
  crm = new SandboxCrm();
  ctx = { accountId: 1, catalog: s.catalog, knowledge: s.knowledge, crm };
});
afterAll(async () => s.drop());

describe('реестр', () => {
  it('имена уникальны и допустимы для API, схемы согласованы с zod', () => {
    const names = PHASE1_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of PHASE1_TOOLS) {
      expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(t.inputSchema.type).toBe('object');
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
  });
});

describe('catalog_search / catalog_get_product', () => {
  it('ищет и отдаёт цену, наличие, ссылку и источники', async () => {
    const r = await catalogSearch.run(ctx, catalogSearch.input.parse({ query: 'входная дверь с терморазрывом' }));
    const first = (r.content as { products: Record<string, unknown>[] }).products[0];
    expect(first).toMatchObject({ id: '2001', price_rub: 42000, availability: 'в наличии' });
    expect(r.sources?.[0]).toMatchObject({ type: 'product', id: '2001' });
  });

  it('пустой результат помечается empty', async () => {
    const r = await catalogSearch.run(ctx, { query: 'раздвижная перегородка купе' });
    expect(r.empty).toBe(true);
  });

  it('карточка с описанием и датой данных', async () => {
    const r = await catalogGetProduct.run(ctx, { id: 'TUR-2-I' });
    expect(r.content).toMatchObject({ id: '1002', price_rub: 16500, old_price_rub: 17900, description: expect.any(String) });
    expect((await catalogGetProduct.run(ctx, { id: 'nope' })).empty).toBe(true);
  });

  it('невалидный ввод отклоняется схемой', () => {
    expect(() => catalogSearch.input.parse({ max_price: -1 })).toThrow();
    expect(() => catalogGetProduct.input.parse({})).toThrow();
  });
});

describe('knowledge_search', () => {
  it('находит условия доставки с источником', async () => {
    const r = await knowledgeSearch.run(ctx, { query: 'сколько стоит доставка по москве' });
    const f = (r.content as { fragments: { text: string }[] }).fragments;
    expect(f[0]?.text).toContain('1500 ₽');
    expect(r.sources?.[0]).toMatchObject({ type: 'knowledge', date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });
});

describe('crm-инструменты', () => {
  it('контекст и примечание в песочнице', async () => {
    expect((await crmGetContext.run(ctx, {})).content).toMatchObject({ name: 'Тестовая сделка (песочница)' });
    await crmAddNote.run(ctx, { text: 'Проём 800x2000' });
    expect(crm.notes).toEqual(['[AI] Проём 800x2000']);
  });

  it('handoff возвращает запрос на передачу', async () => {
    const r = await crmHandoff.run(ctx, crmHandoff.input.parse({ reason: 'discount', summary: 'Просит скидку 10%' }));
    expect(r.handoff).toEqual({ reason: 'discount', summary: 'Просит скидку 10%' });
    expect(() => crmHandoff.input.parse({ reason: 'bad', summary: 'x' })).toThrow();
  });
});

describe('AmoCrm', () => {
  it('маскирует телефоны и e-mail перед отправкой в LLM', async () => {
    const routes: Record<string, unknown> = {
      '/api/v4/leads/5': {
        id: 5,
        name: 'Заявка с сайта +7 916 123-45-67',
        price: 50000,
        status_id: 10,
        pipeline_id: 1,
        responsible_user_id: 3,
        created_at: 0,
        custom_fields_values: null,
        _embedded: { contacts: [{ id: 9, is_main: true }], tags: [{ name: 'сайт' }] },
      },
      '/api/v4/contacts/9': {
        id: 9,
        name: 'Иван Петров',
        first_name: 'Иван',
        custom_fields_values: [
          { field_id: 1, field_code: 'PHONE', values: [{ value: '+79161234567' }] },
          { field_id: 2, field_code: 'EMAIL', values: [{ value: 'ivan@mail.ru' }] },
        ],
      },
      '/api/v4/leads/5/notes': { _embedded: { notes: [{ id: 1, note_type: 'common', created_at: 0, created_by: 3, params: { text: 'Перезвонить на ivan@mail.ru' } }] } },
    };
    const f = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      return new Response(JSON.stringify(routes[path] ?? {}), { status: routes[path] ? 200 : 404 });
    }) as typeof fetch;
    const c = new AmoCrm(new AmoApiClient('test.amocrm.ru', async () => 'T', f), 5);
    const lead = await c.getContext();
    expect(lead).toMatchObject({ contactName: 'Иван', hasPhone: true, hasEmail: true, budget: 50000, tags: ['сайт'] });
    const json = JSON.stringify(lead);
    expect(json).not.toContain('123-45-67');
    expect(json).not.toContain('ivan@mail.ru');
  });
});
