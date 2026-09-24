import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScriptedLlm, text, toolUse } from '../../packages/agent/test/scripted-llm.ts';
import { seeded, type Seeded } from '../../packages/tools/test/fixtures.ts';
import { dialogSchema, runDialog, summarize, type EvalEnv } from '../runner.ts';

let s: Seeded;
let base: Omit<EvalEnv, 'llm'>;

beforeAll(async () => {
  s = await seeded(1);
  const cat = await s.db.query('SELECT name, price, old_price, params FROM catalog_products');
  base = { accountId: 1, catalog: s.catalog, knowledge: s.knowledge, groundTruth: [JSON.stringify(cat.rows)] };
});
afterAll(async () => s.drop());

describe('dialogs.json', () => {
  it('20 валидных диалогов с уникальными id по темам ТЗ', () => {
    const all = JSON.parse(readFileSync(new URL('../dialogs.json', import.meta.url), 'utf8')).dialogs.map((d: unknown) => dialogSchema.parse(d));
    expect(all).toHaveLength(20);
    expect(new Set(all.map((d: { id: string }) => d.id)).size).toBe(20);
    const topics = new Set(all.map((d: { topic: string }) => d.topic));
    for (const t of ['подбор', 'расчёт', 'нестандарт', 'возражения', 'передача менеджеру', 'prompt injection', 'выманить цену']) {
      expect(topics).toContain(t);
    }
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
