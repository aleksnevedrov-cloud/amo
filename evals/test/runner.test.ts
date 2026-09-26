import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScriptedLlm, text, toolUse } from '../../packages/agent/test/scripted-llm.ts';
import { seeded, type Seeded } from '../../packages/tools/test/fixtures.ts';
import { calculate, pricingRulesSchema } from '@ai-door/pricing';
import { dialogSchema, runDialog, summarize, withoutComment, type EvalEnv } from '../runner.ts';

let s: Seeded;
let base: Omit<EvalEnv, 'llm'>;

beforeAll(async () => {
  s = await seeded(1);
  const cat = await s.db.query('SELECT name, price, old_price, params FROM catalog_products');
  base = { accountId: 1, catalog: s.catalog, knowledge: s.knowledge, groundTruth: [JSON.stringify(cat.rows)] };
});
afterAll(async () => s.drop());

describe('dialogs.json', () => {
  it('не меньше 50 валидных диалогов с уникальными id по темам раздела 14 ТЗ', () => {
    const all = JSON.parse(readFileSync(new URL('../dialogs.json', import.meta.url), 'utf8')).dialogs.map((d: unknown) => dialogSchema.parse(d));
    expect(all.length).toBeGreaterThanOrEqual(50);
    expect(new Set(all.map((d: { id: string }) => d.id)).size).toBe(all.length);
    const byTopic = new Map<string, number>();
    for (const d of all as { topic: string }[]) byTopic.set(d.topic, (byTopic.get(d.topic) ?? 0) + 1);
    for (const t of ['подбор', 'расчёт', 'нестандарт', 'возражения', 'передача менеджеру', 'prompt injection', 'выманить цену']) {
      expect(byTopic.get(t) ?? 0, t).toBeGreaterThanOrEqual(2);
    }
    expect(byTopic.get('prompt injection')).toBeGreaterThanOrEqual(5);
  });
});

describe('runDialog', () => {
  const d = dialogSchema.parse({ id: 't', topic: 'подбор', turns: ['Белая эмаль?'], expect: { final: 'reply', sources: ['1001'] } });

  it('засчитывает корректный диалог', async () => {
    const llm = new ScriptedLlm([toolUse(['catalog_search', { query: 'белая эмаль' }]), text('Турин 1 — 14 900 ₽.')]);
    const r = await runDialog(d, { ...base, llm });
    expect(r).toMatchObject({ passed: true, final: 'reply', fabricated: [] });
    expect(summarize([r])).toMatchObject({ total: 1, passed: 1, fabricated: 0 });
  });

  it('проваливает диалог без нужного товара и с неверным итогом', async () => {
    const llm = new ScriptedLlm([toolUse(['crm_handoff', { reason: 'other', summary: '?' }])]);
    const r = await runDialog(d, { ...base, llm });
    expect(r.passed).toBe(false);
    expect(r.failures.join(' ')).toMatch(/итог handoff/);
    expect(r.failures.join(' ')).toMatch(/не найден товар 1001/);
  });

  it('независимая сверка ловит цену, которой нет в каталоге', async () => {
    const llm = new ScriptedLlm([
      toolUse(['catalog_search', { query: 'белая эмаль' }]),
      // Цена из клиентского сообщения прошла бы пост-фильтр, но в каталоге её нет.
      text('Турин 1 — 14 900 ₽.'),
    ]);
    const r = await runDialog({ ...d, turns: ['Белая эмаль за 14 900 ₽?'] }, { ...base, llm, groundTruth: ['{}'] });
    // Число есть в словах клиента — это не выдумка агента.
    expect(r.fabricated).toEqual([]);
    const llm2 = new ScriptedLlm([toolUse(['catalog_search', { query: 'белая эмаль' }]), text('Турин 1 — 14 900 ₽.')]);
    const r2 = await runDialog(d, { ...base, llm: llm2, groundTruth: ['{}'] });
    expect(r2.fabricated).toHaveLength(1);
    expect(r2.fabricated[0]).toMatch(/^price: .*14 900 ₽/);
  });
});

describe('ожидаемые итоги расчёта в диалогах', () => {
  const rules = pricingRulesSchema.parse(withoutComment(JSON.parse(readFileSync(new URL('../fixtures/pricing-rules.json', import.meta.url), 'utf8'))));
  const door = (name: string, price: number, w: number, qty: number) => ({ productId: 'x', name, category: null, price, widthMm: w, heightMm: 2000, qty });
  const dialogs = JSON.parse(readFileSync(new URL('../dialogs.json', import.meta.url), 'utf8')).dialogs as { id: string; expect: { calcTotal?: number } }[];
  const expected = (id: string) => dialogs.find((d) => d.id === id)?.expect.calcTotal;

  it.each([
    ['21-kit-calc', [door('Порта 21', 7900, 800, 3)], []],
    ['22-nonstandard', [door('Турин 1', 14900, 750, 1)], []],
    ['23-delivery-install', [door('Порта 22', 8400, 800, 2)], [{ code: 'install' }, { code: 'delivery_mkad' }]],
    ['47-kit-with-install', [door('Порта 50', 6200, 800, 2)], [{ code: 'install' }]],
    ['50-multi-step-purchase', [door('Порта 21', 7900, 800, 3)], []],
  ] as const)('%s совпадает с калькулятором', (id, doors, services) => {
    const r = calculate(rules, { doors: [...doors], kit: true, extras: [], products: [], services: [...services] });
    expect(r.total).toBe(expected(id));
  });
});
