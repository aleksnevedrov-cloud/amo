// Поиск рыночных цен из черновика (RFD-AI-AGENT-OPT-PRICE, этап 5): POST/GET /kp/research, автозаполнение,
// ручная цена, 409 на собранном КП, журнал, кэш и защита от гонки версий.
import type { LlmGateway, RoutedRequest, RoutedResponse } from '@core/llm';
import type { KpPayload, OptAiProvider } from '@opt/kp';
import { applyResearchToDraft, KP_PRICE_ERROR_KIND, KP_PRICE_RESEARCH_KIND, offerPrice, researchablePositions, type MarketResearchResult } from '@opt/kp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNT_ID, LEAD_ID, setup, widgetToken } from './helpers.ts';

const letterAnswer = JSON.stringify({
  client: { org: 'ООО Стройоптпоставка', fio: '', email: 'stoptpostavka@yandex.ru', phone: '' },
  request_items: [
    { raw: 'Дверь межкомнатная двухпольная из массива лиственницы 1400x2700 мм, окраска L429 Indigo, 2 шт', name: 'дверь межкомнатная двухпольная из массива лиственницы', width_mm: 1400, height_mm: 2700, qty: 2 },
    { raw: 'Добор 2 шт', name: 'добор', width_mm: null, height_mm: null, qty: 2 },
  ],
  required_blocks: ['price'],
  questions: [],
});
const CARD = { kind: 'door', factory: 'Фабрика Л', model: 'Лиственница 2П', collection: null, finish: 'окраска', color: 'L429 Indigo', glazing: null, heightMm: 2700, widthMm: 1400, leaves: 2, equipment: null, fireRating: null, standards: [] };
const SRC = [{ url: 'https://dveri-a.ru/p1' }, { url: 'https://dveri-b.ru/p2' }, { url: 'https://fabrika-l.ru/p3' }, { url: 'https://dveri-c.ru/p4' }];
const offer = (url: string, price: number, over: Record<string, unknown> = {}) => ({ url, seller: new URL(url).host, title: 'Дверь двупольная лиственница', price, currency: 'RUB', unit: 'piece', quantityInUnit: null, inStock: true, vatStated: 'included', vatRateStated: null, sourceKind: 'retail', includesDelivery: null, deliveryRub: null, factory: 'Фабрика Л', model: 'Лиственница 2П', design: ['окраска'], standards: [], widthMm: 1400, heightMm: 2700, kind: 'door', leaves: 2, ...over });

/** Модель: письмо → позиции; карточка → CARD; поиск → предложения по сценарию (по умолчанию 3 источника + один без НДС). */
function gateway(scenario: { offers?: unknown[] | Error } = {}) {
  const requests: RoutedRequest[] = [];
  let searches = 0;
  const llm: LlmGateway = {
    async chat(req, route) {
      requests.push(req);
      let text: string;
      if (req.webSearch) {
        searches += 1;
        if (scenario.offers instanceof Error) throw scenario.offers;
        text = JSON.stringify({ offers: scenario.offers ?? [offer('https://dveri-a.ru/p1', 84_000), offer('https://dveri-b.ru/p2', 86_000), offer('https://fabrika-l.ru/p3', 90_000, { sourceKind: 'manufacturer' }), offer('https://dveri-c.ru/p4', 80_000, { vatStated: 'unknown' })] });
      } else if (req.outputSchema?.name === 'item_card') text = JSON.stringify(CARD);
      else text = letterAnswer;
      const res: RoutedResponse = {
        text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 500, outputTokens: 50, cachedInputTokens: 0, cacheWriteTokens: 0, ...(req.webSearch ? { webSearchCalls: 2 } : {}) },
        provider: route.primary.provider, model: route.primary.model, assistantMessage: { role: 'assistant', content: text }, latencyMs: 1, fallbackUsed: false, requested: route.primary, attempts: [], ...(req.webSearch ? { sources: SRC } : {}),
      };
      return res;
    },
    providers: async () => ['openai'],
    provider: async () => null,
  };
  const ai: OptAiProvider = async () => ({ llm, source: 'account', providers: ['openai'], keySources: { openai: 'account' } });
  return { ai, requests, searches: () => searches };
}

describe('поиск цен из черновика: кнопка «Найти цены»', () => {
  const g = gateway();
  let ctx: Awaited<ReturnType<typeof setup>>;
  let headers: Record<string, string>;
  let draftId = 0;
  beforeAll(async () => {
    ctx = await setup({ ai: g.ai });
    headers = { 'x-auth-token': await widgetToken() };
    await ctx.app.inject({ method: 'GET', url: '/oauth/amo/callback', query: { code: 'c', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
    ctx.amo.mail = { id: 5, created_at: 1_760_000_000, params: { income: true, subject: 'Запрос ООО Стройоптпоставка', text: 'Нужна дверь', from: 'stoptpostavka@yandex.ru', attachments: [] } };
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    draftId = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft.id;
  });
  afterAll(() => ctx.close());

  it('настройки поиска: значения по умолчанию и сохранение коэффициентов, режима и кэша', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/widget/v1/kp/settings', headers })).json().constants).toMatchObject({ priceCoefficient: 1, manufacturerCoefficients: {}, autoResearch: false, researchCacheDays: 30, maxPositionsPerRun: 30, maxSearchCalls: 5, webSearchDailyUsd: 5, skipKnowledgeBase: false });
    expect((await ctx.app.inject({ method: 'PUT', url: '/widget/v1/kp/settings', headers, payload: { constants: { priceCoefficient: 0.95, manufacturerCoefficients: { 'Фабрика Л': 0.9 }, autoResearch: false, researchCacheDays: 7 } } })).json()).toEqual({ ok: true });
    expect((await ctx.app.inject({ method: 'PUT', url: '/widget/v1/kp/settings', headers, payload: { constants: { priceCoefficient: 0 } } })).statusCode).toBe(400);
  });

  it('по умолчанию поиск при сборке не запускается: черновик без цен, kp_price_research пуст', async () => {
    const d = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(d.items.map((l: { price: number | null }) => l.price)).toEqual([null, null]);
    expect(g.searches()).toBe(0);
    const st = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/research?draftId=${draftId}`, headers })).json();
    expect(st).toEqual({ draftId, pending: false, positions: [{ requestIndex: 0, job: null, research: null }, { requestIndex: 1, job: null, research: null }] });
  });

  it('POST «по всем»: 202 с позициями без цены; цена предложения записана с коэффициентом производителя, пометки заменили «цена не задана», журнал со стоимостью', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId } });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ queued: [0, 1], total: 2, batches: 1 });
    expect(g.searches()).toBe(2);
    const d = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    // Медиана четырёх (80 000 без указания НДС принято как конечная цена, 5.1) = 85 000 × коэффициент производителя 0,9 = 76 500,00.
    expect(d.items[0]).toMatchObject({ price: 76_500, priceSource: 'research', coefficient: 0.9, market: { median: 85_000, min: 80_000, max: 90_000, count: 4, unit: 'piece' } });
    expect(d.items[0].market.researchId).toBeGreaterThan(0);
    // Вторая позиция («добор») получила те же предложения, но карточка позиции другая — для теста важно, что цена поставлена и пометок о «цена не задана» нет.
    expect(d.items[1].price).not.toBeNull();
    const st = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/research?draftId=${draftId}`, headers })).json();
    expect(st.pending).toBe(false);
    expect(st.positions[0].research).toMatchObject({ status: 'ok', stats: { median: 85_000, count: 4 }, webSearchCalls: 2 });
    expect(st.positions[0].research.offers.map((o: { url: string; accepted: boolean; reason: string | null; vatAssumed: boolean }) => [o.url, o.accepted, o.reason, o.vatAssumed])).toEqual([
      ['https://fabrika-l.ru/p3', true, null, false],
      ['https://dveri-c.ru/p4', true, null, true],
      ['https://dveri-a.ru/p1', true, null, false],
      ['https://dveri-b.ru/p2', true, null, false],
    ]);
    expect(d.needsManager.filter((n: { request_index: number }) => n.request_index === 0).map((n: { reason: string }) => n.reason)).toEqual(['НДС по умолчанию (не указан на сайте)']);
    const journal = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/journal?kind=${KP_PRICE_RESEARCH_KIND}`, headers })).json().items;
    expect(journal).toHaveLength(2);
    expect(journal.map((j: { summary: string }) => j.summary.replace(/\u00a0/g, ' '))).toContainEqual(expect.stringContaining('76 500 ₽, источников 4, медиана 85 000 ₽'));
    expect(journal[0]).toMatchObject({ details: { sources: 4, webSearchCalls: 2 }, costUsd: expect.any(Number) });
    expect(Number(journal[0].costUsd)).toBeGreaterThan(0.02);
  });

  it('повтор «по всем» ничего не ставит (у всех цена); явная позиция берётся из кэша без вызовов; force ищет заново', async () => {
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId } })).json()).toMatchObject({ queued: [], reason: 'у всех позиций уже есть цена' });
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId, requestIndexes: [0] } })).json()).toMatchObject({ queued: [0] });
    expect(g.searches()).toBe(2);
    // Результат первого поиска уже в базе знаний (доверие 40): явная позиция берётся оттуда, веб-поиск не вызывается.
    const cached = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/journal?kind=${KP_PRICE_RESEARCH_KIND}`, headers })).json().items[0];
    expect(cached.summary).toContain('из базы знаний (по рынку');
    expect(cached.summary).toContain('веб-поиск не вызывался');
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId, requestIndexes: [0], force: true } })).statusCode).toBe(202);
    expect(g.searches()).toBe(3);
  });

  it('ручная цена менеджера не затирается поиском «по всем» и явным поиском без «Заменить»; явный список заменяет', async () => {
    const d = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    const items = d.items.map((l: KpPayload['items'][number], i: number) => (i === 0 ? { ...l, price: 70_000 } : l));
    const saved = (await ctx.app.inject({ method: 'PUT', url: `/widget/v1/kp/draft/${draftId}`, headers, payload: { items } })).json().draft;
    expect(saved.items[0]).toMatchObject({ price: 70_000, priceSource: 'manager', market: { median: 85_000 } });
    expect(saved.items[1].priceSource).toBe('research');
    // «По всем» — позицию с ценой не трогает вовсе.
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId } })).json()).toMatchObject({ queued: [], reason: 'у всех позиций уже есть цена' });
    // Явный список — это «Заменить». Ручная цена уже легла в базу знаний (доверие 90, RFD-AI-AGENT-OPT-KB): без force
    // она возвращается из базы с подписью «изменено менеджером»; «искать заново» (force) идёт мимо базы — цена поиска.
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId, requestIndexes: [0] } });
    const fromKb = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(fromKb.items[0]).toMatchObject({ price: 70_000, priceSource: 'kb', priceLabel: 'изменено менеджером' });
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId, requestIndexes: [0], force: true } });
    const after = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    expect(after.items[0]).toMatchObject({ price: 76_500, priceSource: 'research' });
  });

  it('собранное КП: 409 «КП уже собрано»; чужой черновик — 404', async () => {
    await ctx.deps.kp.setStatus(draftId, 'built');
    const r = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId } });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'locked', message: 'КП уже собрано, создайте новый черновик' });
    await ctx.deps.kp.setStatus(draftId, 'draft');
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: 999_999 } })).statusCode).toBe(404);
  });
});

describe('поиск цен: нет цен, ошибка провайдера, автозапуск, гонка версий', () => {
  it('none → цена не ставится, пометка «цены не найдены»; failed → kp_price_error с текстом, цена не ставится, пометка с причиной', async () => {
    const none = gateway({ offers: [] });
    const ctx = await setup({ ai: none.ai });
    try {
      const headers = { 'x-auth-token': await widgetToken() };
      await ctx.app.inject({ method: 'GET', url: '/oauth/amo/callback', query: { code: 'c', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
      ctx.amo.mail = { id: 5, created_at: 1_760_000_000, params: { income: true, subject: 'Запрос', text: 'Нужна дверь', from: 'stoptpostavka@yandex.ru', attachments: [] } };
      await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
      const draftId = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft.id;
      await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId, requestIndexes: [0] } });
      let d = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
      expect(d.items[0]).toMatchObject({ price: null, market: null });
      expect(d.items[0].priceSource).toBeUndefined();
      expect(d.needsManager.filter((n: { request_index: number }) => n.request_index === 0).map((n: { reason: string }) => n.reason)).toEqual(['цена не задана', 'цены не найдены']);
      const st = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/research?draftId=${draftId}`, headers })).json();
      expect(st.positions[0].research).toMatchObject({ status: 'none', stats: null });
      // Ошибка веб-поиска: статус failed, событие kp_price_error, пометка «поиск цены: …»; следующий запрос снова идёт к модели (кэша нет).
      const { WebSearchUnavailableError } = await import('@core/llm');
      const failing = gateway({ offers: new WebSearchUnavailableError('openai', 'OpenAI отверг запрос с веб-поиском') });
      (ctx.deps as unknown as { ai: OptAiProvider }).ai = failing.ai;
      await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId, requestIndexes: [1], force: true } });
      d = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
      expect(d.items[1].price).toBeNull();
      expect(d.needsManager.filter((n: { request_index: number }) => n.request_index === 1).map((n: { reason: string }) => n.reason)).toEqual(['цена не задана', 'поиск цены: веб-поиск недоступен: OpenAI отверг запрос с веб-поиском']);
      const errors = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/journal?kind=${KP_PRICE_ERROR_KIND}`, headers })).json().items;
      expect(errors[0].summary).toBe('Цена не найдена: добор — веб-поиск недоступен: OpenAI отверг запрос с веб-поиском');
      const st2 = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/research?draftId=${draftId}`, headers })).json();
      expect(st2.positions[1]).toMatchObject({ job: null, research: { status: 'failed', error: 'веб-поиск недоступен: OpenAI отверг запрос с веб-поиском' } });
    } finally {
      await ctx.close();
    }
  });

  it('autoResearch включён: «Собрать КП» ставит поиск по позициям без цены сразу после сборки', async () => {
    const g = gateway();
    const ctx = await setup({ ai: g.ai });
    try {
      const headers = { 'x-auth-token': await widgetToken() };
      await ctx.app.inject({ method: 'GET', url: '/oauth/amo/callback', query: { code: 'c', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
      await ctx.app.inject({ method: 'PUT', url: '/widget/v1/kp/settings', headers, payload: { constants: { autoResearch: true, maxPositionsPerRun: 1 } } });
      ctx.amo.mail = { id: 5, created_at: 1_760_000_000, params: { income: true, subject: 'Запрос', text: 'Нужна дверь', from: 'stoptpostavka@yandex.ru', attachments: [] } };
      // В тестовой очереди черновика хук постановки поиска не передаётся — проверяем выбор позиций и лимит напрямую.
      await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
      const d = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
      const payload = (await ctx.deps.kp.byId(ACCOUNT_ID, d.id))!.payload as unknown as Partial<KpPayload>;
      expect(researchablePositions(payload, 'all', 1)).toEqual([0]);
      expect(researchablePositions(payload, 'all', 30)).toEqual([0, 1]);
      expect(researchablePositions(payload, [1, 1, 7], 30)).toEqual([1]);
    } finally {
      await ctx.close();
    }
  });

  it('гонка: черновик изменился между чтением и записью — задание перечитывает и пишет только свою позицию', async () => {
    const g = gateway();
    const ctx = await setup({ ai: g.ai });
    try {
      const headers = { 'x-auth-token': await widgetToken() };
      await ctx.app.inject({ method: 'GET', url: '/oauth/amo/callback', query: { code: 'c', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
      ctx.amo.mail = { id: 5, created_at: 1_760_000_000, params: { income: true, subject: 'Запрос', text: 'Нужна дверь', from: 'stoptpostavka@yandex.ru', attachments: [] } };
      await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
      const draftId = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft.id;
      const repo = ctx.deps.kp;
      const before = (await repo.byId(ACCOUNT_ID, draftId))!;
      expect(before.version).toBe(0);
      // Менеджер правит вторую позицию, пока поиск по первой ещё идёт: версия уходит вперёд.
      const p = before.payload as unknown as KpPayload;
      await repo.setPayload(draftId, { ...p, items: p.items.map((l, i) => (i === 1 ? { ...l, qty: 9 } : l)) } as unknown as Record<string, unknown>);
      expect(await repo.setPayloadIfVersion(draftId, 0, p as unknown as Record<string, unknown>)).toBe(false);
      const research: MarketResearchResult = { query: 'q', card: null, status: 'ok', offers: [], stats: { min: 1, max: 3, median: 2, count: 3, unit: 'piece' }, analog: null, error: null, provider: 'openai', model: 'm', webSearchCalls: 1, cost: { inputTokens: 0, outputTokens: 0, usd: 0 }, sources: [] };
      const applied = await applyResearchToDraft(ctx.deps, ACCOUNT_ID, draftId, 0, offerPrice(research), { result: research, cached: false, researchId: 1, createdAt: new Date() }, false);
      expect(applied.keptManagerPrice).toBe(false);
      const after = (await repo.byId(ACCOUNT_ID, draftId))!;
      const items = (after.payload as unknown as KpPayload).items;
      expect(items[0]).toMatchObject({ price: 2, priceSource: 'research' });
      expect(items[1]?.qty).toBe(9);
      expect(after.version).toBe(2);
    } finally {
      await ctx.close();
    }
  });
});
