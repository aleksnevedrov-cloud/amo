import Anthropic from '@anthropic-ai/sdk';
import { widgetSettingsSchema } from '@ai-door/db';
import { PHASE1_TOOLS, SandboxCrm, type ToolContext } from '@ai-door/tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seeded, type Seeded } from '../../tools/test/fixtures.ts';
import { createWithFallback, LlmUnavailableError } from '../src/llm.ts';
import { Orchestrator, toApiMessages } from '../src/orchestrator.ts';
import { costOf } from '../src/pricing.ts';
import { msg, ScriptedLlm, text, toolUse } from './scripted-llm.ts';

let s: Seeded;
let ctx: ToolContext;
const settings = widgetSettingsSchema.parse({ enabled: true, mode: 'auto' });

beforeAll(async () => {
  s = await seeded();
  ctx = { accountId: 1, catalog: s.catalog, knowledge: s.knowledge, crm: new SandboxCrm() };
});
afterAll(async () => s.drop());

const run = (llm: ScriptedLlm, incoming: string[], history: { role: 'client' | 'ai' | 'manager'; text: string }[] = []) =>
  new Orchestrator(llm).runTurn({ settings, history, incoming, ctx, tools: PHASE1_TOOLS });

describe('Orchestrator', () => {
  it('ищет в каталоге и отвечает подтверждённой ценой', async () => {
    const llm = new ScriptedLlm([
      toolUse(['catalog_search', { query: 'белая дверь эмаль' }]),
      text('Рекомендую Турин 1 эмаль белая — 14 900 ₽, в наличии: https://rf-dveri.ru/catalog/test-1001/'),
    ]);
    const r = await run(llm, ['Нужна белая дверь в эмали']);
    expect(r.kind).toBe('reply');
    expect(r.toolCalls).toMatchObject([{ name: 'catalog_search', specName: 'catalog.search', ok: true, empty: false }]);
    expect(r.sources[0]).toMatchObject({ type: 'product', id: '1001' });
    expect(r.cost.usd).toBeCloseTo(2 * costOf('claude-opus-5', { input_tokens: 1000, output_tokens: 100 }).usd);

    const req = llm.requests[0]!;
    expect(req.model).toBe('claude-opus-5');
    expect(req.output_config).toEqual({ effort: 'low' });
    expect((req.system as { cache_control?: unknown }[])[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(req.tools?.map((t) => (t as { name: string }).name)).toEqual(PHASE1_TOOLS.map((t) => t.name));
    // Второй запрос содержит tool_result с данными каталога.
    const last = llm.requests[1]!.messages.at(-1)!;
    expect(JSON.stringify(last.content)).toContain('14900');
  });

  it('выдуманная цена не уходит клиенту: перегенерация', async () => {
    const llm = new ScriptedLlm([
      text('Дверь Турин 1 стоит 12 000 ₽.'),
      toolUse(['catalog_get_product', { id: '1001' }]),
      text('Турин 1 — 14 900 ₽.'),
    ]);
    const r = await run(llm, ['Сколько стоит Турин 1?']);
    expect(r).toMatchObject({ kind: 'reply', text: 'Турин 1 — 14 900 ₽.' });
    expect(r.rejections).toHaveLength(1);
    const correction = llm.requests[1]!.messages.at(-1)!;
    expect(String(correction.content)).toMatch(/Автоматическая проверка.*12 000 ₽/);
  });

  it('после трёх отказов пост-фильтра — blocked', async () => {
    const llm = new ScriptedLlm([text('Цена 1 ₽'), text('Цена 2 ₽'), text('Цена 3 ₽')]);
    const r = await run(llm, ['Цена?']);
    expect(r.kind).toBe('blocked');
    if (r.kind === 'blocked') expect(r.reason).toMatch(/fact_check/);
  });

  it('crm_handoff завершает ход без ответа клиенту', async () => {
    const llm = new ScriptedLlm([toolUse(['crm_handoff', { reason: 'discount', summary: 'Просит скидку' }])]);
    const r = await run(llm, ['Дадите скидку 15%?']);
    expect(r).toMatchObject({ kind: 'handoff', handoff: { reason: 'discount', summary: 'Просит скидку' } });
    expect(llm.requests).toHaveLength(1);
  });

  it('некорректные параметры инструмента возвращаются модели как ошибка', async () => {
    const llm = new ScriptedLlm([toolUse(['catalog_get_product', {}]), text('Уточните, пожалуйста, модель.')]);
    const r = await run(llm, ['А эта?']);
    expect(r.kind).toBe('reply');
    expect(r.toolCalls[0]).toMatchObject({ ok: false, error: expect.stringMatching(/Некорректные/) });
    expect(JSON.stringify(llm.requests[1]!.messages.at(-1)!.content)).toContain('"is_error":true');
  });

  it('промах, если поиск ничего не нашёл', async () => {
    const llm = new ScriptedLlm([
      toolUse(['catalog_search', { query: 'раздвижная перегородка купе' }], ['knowledge_search', { query: 'перегородки купе' }]),
      text('Таких моделей в каталоге не нашёл. Подскажите, для какого помещения нужна перегородка?'),
    ]);
    const r = await run(llm, ['Есть перегородки-купе?']);
    expect(r).toMatchObject({ kind: 'reply', missed: true });
    // Параллельные вызовы — в одном сообщении с двумя tool_result.
    expect((llm.requests[1]!.messages.at(-1)!.content as unknown[]).length).toBe(2);
  });

  it('refusal и max_tokens → blocked', async () => {
    expect((await run(new ScriptedLlm([msg([], 'refusal')]), ['x'])).kind).toBe('blocked');
    expect((await run(new ScriptedLlm([msg([], 'max_tokens')]), ['x'])).kind).toBe('blocked');
  });
});

describe('createWithFallback', () => {
  const overloaded = new Anthropic.InternalServerError(529, { type: 'error' }, 'Overloaded', new Headers());

  it('переключается на резервную модель при сбое основной', async () => {
    const llm = new ScriptedLlm([overloaded, text('ok', 'claude-sonnet-5')]);
    const res = await createWithFallback(llm, { model: 'claude-opus-5', max_tokens: 10, messages: [] }, 'claude-sonnet-5');
    expect(res.model).toBe('claude-sonnet-5');
    expect(llm.requests[1]!.model).toBe('claude-sonnet-5');
  });

  it('при сбое обеих — LlmUnavailableError', async () => {
    const llm = new ScriptedLlm([overloaded, overloaded]);
    await expect(
      createWithFallback(llm, { model: 'claude-opus-5', max_tokens: 10, messages: [] }, 'claude-sonnet-5'),
    ).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it('ошибку запроса (400) не маскирует переключением', async () => {
    const bad = new Anthropic.BadRequestError(400, { type: 'error' }, 'bad', new Headers());
    await expect(createWithFallback(new ScriptedLlm([bad]), { model: 'm', max_tokens: 1, messages: [] }, 'f')).rejects.toBe(bad);
  });
});

describe('toApiMessages', () => {
  it('склеивает подряд идущие и убирает ведущие ответы продавца', () => {
    const m = toApiMessages(
      [
        { role: 'manager', text: 'Здравствуйте!' },
        { role: 'client', text: 'Привет' },
        { role: 'client', text: 'Нужна дверь' },
        { role: 'ai', text: 'Какая?' },
        { role: 'manager', text: 'Могу помочь' },
      ],
      ['Белая', '80 см'],
    );
    expect(m).toEqual([
      { role: 'user', content: 'Привет\nНужна дверь' },
      { role: 'assistant', content: 'Какая?\n(Сообщение менеджера) Могу помочь' },
      { role: 'user', content: 'Белая\n80 см' },
    ]);
  });
});

describe('costOf', () => {
  it('учитывает кэш и неизвестные модели', () => {
    expect(costOf('claude-opus-5', { input_tokens: 1_000_000, output_tokens: 0 }).usd).toBe(5);
    expect(costOf('claude-opus-5', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }).usd).toBeCloseTo(0.5);
    expect(costOf('claude-sonnet-5', { input_tokens: 0, output_tokens: 1_000_000 }).usd).toBe(10);
    expect(costOf('unknown', { input_tokens: 1_000_000, output_tokens: 0 }).usd).toBe(10);
  });
});
