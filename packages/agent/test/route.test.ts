import { widgetSettingsSchema } from '@ai-door/db';
import { OpenAIProvider, type OpenAIRequest, type OpenAIResponseT } from '@ai-door/llm';
import { PHASE1_TOOLS, SandboxCrm, type ToolContext } from '@ai-door/tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seeded, type Seeded } from '../../tools/test/fixtures.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { createAiProvider } from '../src/provider.ts';
import { resolveRoute } from '../src/route.ts';
import { summarizeDialog } from '../src/summary.ts';

describe('resolveRoute: сделка > этап > воронка > настройки', () => {
  const settings = widgetSettingsSchema.parse({
    model: {
      provider: 'openai',
      model: 'gpt-5',
      fallbackModel: 'claude-sonnet-5',
      fallbackProvider: 'anthropic',
      overrides: { pipelines: { '1': { provider: 'anthropic', model: 'claude-opus-5' } }, statuses: { '10': { provider: 'openai', model: 'gpt-5-mini' } } },
    },
  });

  it('иерархия переопределений', () => {
    expect(resolveRoute(settings)).toEqual({ primary: { provider: 'openai', model: 'gpt-5' }, fallback: { provider: 'anthropic', model: 'claude-sonnet-5' } });
    expect(resolveRoute(settings, { pipelineId: 1 }).primary).toEqual({ provider: 'anthropic', model: 'claude-opus-5' });
    expect(resolveRoute(settings, { pipelineId: 1, statusId: 10 }).primary).toEqual({ provider: 'openai', model: 'gpt-5-mini' });
    expect(resolveRoute(settings, { pipelineId: 1, statusId: 10, lead: { provider: 'anthropic', model: 'claude-haiku-4-5' } }).primary).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5' });
  });

  it('резервная того же провайдера по умолчанию; совпадающая с основной — не резерв', () => {
    const s = widgetSettingsSchema.parse({ model: { provider: 'openai', model: 'gpt-5', fallbackModel: 'gpt-5-mini' } });
    expect(resolveRoute(s).fallback).toEqual({ provider: 'openai', model: 'gpt-5-mini' });
    expect(resolveRoute(s, { lead: { provider: 'openai', model: 'gpt-5-mini' } }).fallback).toBeNull();
    // Настройки 1.0.1 без новых полей читаются как раньше.
    const old = widgetSettingsSchema.parse({ model: { provider: 'anthropic', model: 'claude-opus-5', fallbackModel: 'claude-sonnet-5', effort: 'low', maxTokens: 4096 } });
    expect(resolveRoute(old)).toEqual({ primary: { provider: 'anthropic', model: 'claude-opus-5' }, fallback: { provider: 'anthropic', model: 'claude-sonnet-5' } });
  });
});

/** Скриптованный OpenAI Responses API: инструмент → результат → текст. */
function scriptedOpenAi(steps: ((req: OpenAIRequest) => Partial<OpenAIResponseT>)[]) {
  const requests: OpenAIRequest[] = [];
  const base = { id: 'r', object: 'response', created_at: 1, status: 'completed', model: 'gpt-5-2025-08-07', error: null, incomplete_details: null, output: [], usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 500 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1100 } };
  return {
    requests,
    provider: new OpenAIProvider({
      async create(req) {
        requests.push(structuredClone(req));
        const step = steps.shift();
        if (!step) throw new Error('шаги закончились');
        return { ...base, ...step(req) } as unknown as OpenAIResponseT;
      },
    }),
  };
}

describe('оркестратор на OpenAI', () => {
  let s: Seeded;
  let ctx: ToolContext;
  const settings = widgetSettingsSchema.parse({ enabled: true, mode: 'auto', model: { provider: 'openai', model: 'gpt-5', fallbackModel: null } });
  beforeAll(async () => {
    s = await seeded();
    ctx = { accountId: 1, catalog: s.catalog, knowledge: s.knowledge, crm: new SandboxCrm() };
  });
  afterAll(async () => s.drop());

  it('вызов каталога через function_call, результат через function_call_output, ответ проходит пост-фильтр', async () => {
    const { provider, requests } = scriptedOpenAi([
      () => ({
        output: [
          { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc' },
          { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'catalog_search', arguments: JSON.stringify({ query: 'белая дверь эмаль' }), status: 'completed' },
        ],
      }),
      () => ({ output: [{ type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Рекомендую Турин 1 эмаль белая — 14 900 ₽, в наличии: https://rf-dveri.ru/catalog/test-1001/', annotations: [] }] }] }),
    ]);
    const ai = createAiProvider({ accountKey: async () => null, serverKeys: { openai: 'sk-srv' }, make: () => provider });
    const acc = (await ai(1))!;
    expect(acc.providers).toEqual(['openai']);
    const r = await acc.orchestrator.runTurn({ settings, history: [], incoming: ['Нужна белая дверь в эмали'], ctx, tools: PHASE1_TOOLS });
    expect(r).toMatchObject({ kind: 'reply', provider: 'openai', model: 'gpt-5-2025-08-07', requestedModel: 'gpt-5', fallbackUsed: false });
    expect(r.toolCalls).toMatchObject([{ name: 'catalog_search', ok: true, empty: false }]);
    expect(r.sources[0]).toMatchObject({ type: 'product', id: '1001' });
    // Стоимость по тарифу gpt-5 с учётом cached_tokens: 2 ответа × (500×1.25 + 500×0.125 + 100×10) / 1e6.
    expect(r.cost.usd).toBeCloseTo(2 * (500 * 1.25 + 500 * 0.125 + 100 * 10) / 1e6, 6);
    expect(r.cost.inputTokens).toBe(2000);

    const first = requests[0]!;
    expect(first.model).toBe('gpt-5');
    expect(first.reasoning).toEqual({ effort: 'low' });
    expect((first.tools as { name: string }[]).map((t) => t.name)).toEqual(PHASE1_TOOLS.map((t) => t.name));
    expect(first.instructions).toContain('точность данных');
    // Второй запрос: items первого ответа как есть (reasoning + function_call) и function_call_output с данными каталога.
    const input = requests[1]!.input as { type?: string; call_id?: string; output?: string }[];
    expect(input.map((i) => i.type ?? 'message')).toEqual(['message', 'reasoning', 'function_call', 'function_call_output']);
    expect(input.at(-1)).toMatchObject({ call_id: 'call_1' });
    expect(input.at(-1)!.output).toContain('14900');
  });

  it('несколько вызовов за ход и ошибка параметров; резюме на OpenAI', async () => {
    const { provider, requests } = scriptedOpenAi([
      () => ({
        output: [
          { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'catalog_search', arguments: '{"query":"перегородка купе"}', status: 'completed' },
          { type: 'function_call', id: 'fc_2', call_id: 'c2', name: 'catalog_get_product', arguments: '{}', status: 'completed' },
        ],
      }),
      () => ({ output: [{ type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Таких моделей не нашёл. Для какого помещения?', annotations: [] }] }] }),
      () => ({ output: [{ type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Потребность: перегородка.', annotations: [] }] }] }),
    ]);
    const o = new Orchestrator({ chat: async (req, route) => ({ ...(await provider.chat({ ...req, model: route.primary.model })), fallbackUsed: false, requested: route.primary, attempts: [] }), providers: async () => ['openai'], provider: async () => provider });
    const r = await o.runTurn({ settings, history: [], incoming: ['Есть перегородки-купе?'], ctx, tools: PHASE1_TOOLS });
    expect(r).toMatchObject({ kind: 'reply', missed: true });
    expect(r.toolCalls[1]).toMatchObject({ ok: false, error: expect.stringMatching(/Некорректные/) });
    const outputs = (requests[1]!.input as { type?: string; call_id?: string; output?: string }[]).filter((i) => i.type === 'function_call_output');
    expect(outputs.map((i) => i.call_id)).toEqual(['c1', 'c2']);
    expect(outputs[1]!.output).toContain('error');

    const sum = await summarizeDialog(o['gateway'], settings, { history: [{ role: 'client', text: 'Перегородка' }] });
    expect(sum).toMatchObject({ text: 'Потребность: перегородка.', provider: 'openai', fallbackUsed: false });
    expect(requests[2]!.instructions).toContain('резюме');
  });

  it('оба ключа: приоритет своего ключа, кэш по набору ключей, резервная модель другого провайдера', async () => {
    const made: string[] = [];
    const ai = createAiProvider({
      accountKey: async (id, provider) => (id === 1 && provider === 'openai' ? 'sk-own' : null),
      serverKeys: { anthropic: 'sk-ant-srv', openai: 'sk-srv' },
      make: (provider, key) => {
        made.push(`${provider}:${key}`);
        return { id: provider, listModels: async () => [], validateKey: async () => ({ ok: true }), chat: async () => { throw new Error('x'); } };
      },
    });
    const a = (await ai(1))!;
    expect(a).toMatchObject({ source: 'account', providers: ['anthropic', 'openai'], keySources: { anthropic: 'server', openai: 'account' } });
    const b = (await ai(2))!;
    expect(b).toMatchObject({ source: 'server', keySources: { anthropic: 'server', openai: 'server' } });
    expect(await ai(1)).toBe(a);
    expect(await ai(3)).toBe(b);
    expect(made.sort()).toEqual(['anthropic:sk-ant-srv', 'openai:sk-own', 'openai:sk-srv']);
    expect(await ai(1).then((x) => x?.llm.providers())).toEqual(['anthropic', 'openai']);
  });
});
