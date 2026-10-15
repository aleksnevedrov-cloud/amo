// RFD-AI-AGENT-OPT-KB, этап 4: ответ на вопрос покупателя из базы (top-5 фрагментов, ссылки на источники), выгрузка цен в xlsx.
import ExcelJS from 'exceljs';
import type { LlmGateway, RoutedRequest, RoutedResponse } from '@core/llm';
import type { OptAiProvider } from '@opt/kp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeEmbedder } from '../../../packages/opt/kb/test/setup.ts';
import { ACCOUNT_ID, setup, widgetToken } from './helpers.ts';

/** Модель: отвечает по фрагментам, ссылаясь на [1]; запросы запоминаются. */
function gateway() {
  const requests: RoutedRequest[] = [];
  const llm: LlmGateway = {
    async chat(req, route) {
      requests.push(req);
      const prompt = String(req.messages[0]?.content ?? '');
      // Отвечает, только если вопрос про скидку и фрагмент со скидкой в контексте есть; иначе — как настоящая модель без ответа.
      const question = /Вопрос покупателя: (.*)/.exec(prompt)?.[1] ?? '';
      const text = /скидк/i.test(question) && /12 %/.test(prompt) ? 'Скидка опт от 50 полотен — 12 % [1].' : 'В базе знаний ответа нет.';
      const res: RoutedResponse = { text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 400, outputTokens: 30, cachedInputTokens: 0, cacheWriteTokens: 0 }, provider: route.primary.provider, model: route.primary.model, assistantMessage: { role: 'assistant', content: text }, latencyMs: 1, fallbackUsed: false, requested: route.primary, attempts: [] };
      return res;
    },
    providers: async () => ['openai'],
    provider: async () => null,
  };
  const ai: OptAiProvider = async () => ({ llm, source: 'account', providers: ['openai'], keySources: { openai: 'account' } });
  return { ai, requests };
}

describe('opt-api: ответ покупателю из базы знаний и выгрузка цен', () => {
  const g = gateway();
  let ctx: Awaited<ReturnType<typeof setup>>;
  let headers: Record<string, string>;
  beforeAll(async () => {
    ctx = await setup({ ai: g.ai, embedder: fakeEmbedder().embedder });
    headers = { 'x-auth-token': await widgetToken() };
    await ctx.deps.accounts.upsertInstalled({ id: ACCOUNT_ID, subdomain: 'aleksnevedrov', accountDomain: 'aleksnevedrov.amocrm.ru' });
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/sources/text', headers, payload: { title: 'Скидки', content: 'Скидка опт от 50 полотен — 12 %' } });
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/sources/text', headers, payload: { title: 'Сроки', content: 'Срок поставки полотен — 10 рабочих дней.' } });
  });
  afterAll(() => ctx.close());

  it('«какая скидка от 50 полотен» → ответ со ссылкой [1] на заметку «Скидки», журнал kb_search со стоимостью', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/answer', headers, payload: { question: 'какая скидка от 50 полотен' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ question: 'какая скидка от 50 полотен', answer: 'Скидка опт от 50 полотен — 12 % [1].', reason: null, provider: 'openai', model: 'gpt-5.5' });
    expect(r.json().sources[0]).toMatchObject({ n: 1, label: expect.stringMatching(/^заметка «Скидки» \(/), excerpt: 'Скидка опт от 50 полотен — 12 %' });
    expect(r.json().cost.usd).toBeGreaterThan(0);
    // Модель получила только фрагменты базы и вопрос, без веб-поиска.
    const prompt = String(g.requests.at(-1)?.messages[0]?.content ?? '');
    expect(prompt).toContain('Вопрос покупателя: какая скидка от 50 полотен');
    expect(prompt).toContain('[1] (заметка «Скидки»');
    expect(g.requests.at(-1)?.webSearch).toBeUndefined();
    const journal = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/journal?kind=kb_search', headers })).json().items as { summary: string; costUsd: number }[];
    expect(journal[0]?.summary).toBe('Ответ из базы знаний на «какая скидка от 50 полотен»: Скидка опт от 50 полотен — 12 % [1].');
    expect(Number(journal[0]?.costUsd)).toBeGreaterThan(0);
  });

  it('нет подходящих фрагментов — модель не вызывается; фрагменты есть, но ответа нет — «ответа нет» с причиной; без LLM — 409', async () => {
    const before = g.requests.length;
    const none = (await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/answer', headers, payload: { question: 'цвет фурнитуры по умолчанию' } })).json();
    // Полнотекстовый поиск ничего не нашёл, но эмбеддинг-поиск вернул ближайшие фрагменты — модель сказала «ответа нет».
    expect(none.answer).toBeNull();
    expect(none.reason).toMatch(/нет|не содержат/);
    expect(g.requests.length - before).toBeLessThanOrEqual(1);
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/answer', headers, payload: { question: 'x' } })).statusCode).toBe(400);
  });

  it('выгрузка цен в xlsx: base64 в JSON, лист «Цены» с шапкой и строками', async () => {
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/prices', headers, payload: { model: 'ДПГ сота', widthMm: 800, heightMm: 2000, price: 3450, origin: 'purchase', factory: 'Текона' } });
    const r = await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/prices/export', headers });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ filename: expect.stringMatching(/^kb-prices-\d{4}-\d{2}-\d{2}\.xlsx$/), rows: 1 });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(r.json().contentBase64, 'base64') as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Цены')!;
    expect(ws.rowCount).toBe(2);
    expect((ws.getRow(2).values as unknown[]).slice(1, 8)).toEqual(['ДПГ сота', 'Текона', '800×2000', 800, 2000, 'шт', 3450]);
    expect((ws.getRow(2).values as unknown[])[11]).toBe('закупка');
  });
});
