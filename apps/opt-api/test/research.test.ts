// «Найти цены» из черновика: POST/GET /kp/research, ручная цена, 409 на собранном КП, журнал и защита от гонки версий.
// KB-WEB-ROWS: цена позиции — только из прайса базы знаний; веб-поиска нет, строки прайса нет — «уточнить у менеджера»;
// цены прежнего веб-поиска и строки базы не из прайса (веб, правка менеджера) в черновик и документ не идут.
import type { LlmGateway, RoutedRequest, RoutedResponse } from '@core/llm';
import type { KpPayload, OptAiProvider } from '@opt/kp';
import { applyKbPriceToDraft, KP_PRICE_RESEARCH_KIND, researchablePositions } from '@opt/kp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNT_ID, LEAD_ID, setup, widgetToken } from './helpers.ts';

const letterAnswer = JSON.stringify({
  client: { org: 'ООО Стройоптпоставка', fio: '', email: 'stoptpostavka@yandex.ru', phone: '' },
  request_items: [
    { raw: 'Дверь межкомнатная двухпольная из массива лиственницы 1400x2700 мм, окраска L429 Indigo, 2 шт', name: 'дверь межкомнатная двухпольная из массива лиственницы', width_mm: 1400, height_mm: 2700, qty: 2 },
    { raw: 'Ручка дверная 2 шт', name: 'ручка дверная', width_mm: null, height_mm: null, qty: 2 },
  ],
  required_blocks: ['price'],
  questions: [],
});
const CARD = { kind: 'door', factory: 'Фабрика Л', model: 'Лиственница 2П', collection: null, finish: 'окраска', color: 'L429 Indigo', glazing: null, heightMm: 2700, widthMm: 1400, leaves: 2, equipment: null, fireRating: null, standards: [] };

/** Модель: письмо → позиции; карточка → CARD. Веб-поиск (webSearch) считается — с KB-WEB-ROWS он не должен вызываться. */
function gateway() {
  const requests: RoutedRequest[] = [];
  let searches = 0;
  const llm: LlmGateway = {
    async chat(req, route) {
      requests.push(req);
      if (req.webSearch) searches += 1;
      const text = req.webSearch ? JSON.stringify({ offers: [] }) : req.outputSchema?.name === 'item_card' ? JSON.stringify(CARD) : letterAnswer;
      const res: RoutedResponse = {
        text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 500, outputTokens: 50, cachedInputTokens: 0, cacheWriteTokens: 0 },
        provider: route.primary.provider, model: route.primary.model, assistantMessage: { role: 'assistant', content: text }, latencyMs: 1, fallbackUsed: false, requested: route.primary, attempts: [],
      };
      return res;
    },
    providers: async () => ['openai'],
    provider: async () => null,
  };
  const ai: OptAiProvider = async () => ({ llm, source: 'account', providers: ['openai'], keySources: { openai: 'account' } });
  return { ai, requests, searches: () => searches };
}

type Line = KpPayload['items'][number];
type Need = { request_index: number; reason: string };

describe('«Найти цены» из черновика: только прайс (KB-WEB-ROWS)', () => {
  const g = gateway();
  let ctx: Awaited<ReturnType<typeof setup>>;
  let headers: Record<string, string>;
  let draftId = 0;
  const draft = async () => (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft as { items: Line[]; needsManager: Need[] };
  const reasons = (d: { needsManager: Need[] }, i: number) => d.needsManager.filter((n) => n.request_index === i).map((n) => n.reason);
  beforeAll(async () => {
    ctx = await setup({ ai: g.ai });
    headers = { 'x-auth-token': await widgetToken() };
    await ctx.app.inject({ method: 'GET', url: '/oauth/amo/callback', query: { code: 'c', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
    ctx.amo.mail = { id: 5, created_at: 1_760_000_000, params: { income: true, subject: 'Запрос ООО Стройоптпоставка', text: 'Нужна дверь', from: 'stoptpostavka@yandex.ru', attachments: [] } };
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    draftId = (await draft() as unknown as { id: number }).id;
  });
  afterAll(() => ctx.close());

  it('настройки: значения по умолчанию и сохранение', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/widget/v1/kp/settings', headers })).json().constants).toMatchObject({ autoResearch: false, maxPositionsPerRun: 30 });
    expect((await ctx.app.inject({ method: 'PUT', url: '/widget/v1/kp/settings', headers, payload: { constants: { autoResearch: false, maxPositionsPerRun: 40 } } })).json()).toEqual({ ok: true });
  });

  it('по умолчанию поиск при сборке не запускается: черновик без цен, состояние поиска пусто', async () => {
    expect((await draft()).items.map((l) => l.price)).toEqual([null, null]);
    const st = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/research?draftId=${draftId}`, headers })).json();
    expect(st).toEqual({ draftId, pending: false, positions: [{ requestIndex: 0, job: null, research: null }, { requestIndex: 1, job: null, research: null }] });
  });

  it('POST «по всем» без прайса: позиции — «нет в прайсе», «уточнить у менеджера», без цены; веб-поиска нет, модель для цен не нужна', async () => {
    // Без ключей модели «Найти цены» работает: цена берётся только из прайса.
    const ai = ctx.deps.ai;
    (ctx.deps as unknown as { ai: OptAiProvider }).ai = async () => null;
    const r = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId } });
    (ctx.deps as unknown as { ai: OptAiProvider }).ai = ai;
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ queued: [0, 1], total: 2, batches: 1 });
    expect(g.searches()).toBe(0);
    const d = await draft();
    expect(d.items.map((l) => [l.price, l.priceOutcome, l.priceLabel])).toEqual([[null, 'not_priced', 'нет в прайсе'], [null, 'not_priced', 'нет в прайсе']]);
    expect(reasons(d, 1)).toEqual(['уточнить у менеджера: «ручка дверная» в прайсе нет — введите цену вручную']);
    const journal = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/journal?kind=${KP_PRICE_RESEARCH_KIND}`, headers })).json().items;
    expect(journal.map((j: { summary: string }) => j.summary)).toContain('Цена по позиции «ручка дверная»: в прайсе нет — уточнить у менеджера');
    expect(journal.every((j: { details: { webSearchCalls: number } }) => j.details.webSearchCalls === 0)).toBe(true);
  });

  it('цена прежнего веб-поиска и строка базы не из прайса (веб, правка менеджера) снимаются: «уточнить у менеджера»; строки базы не удаляются', async () => {
    const webRow = await ctx.deps.kb.prices.upsert({ accountId: ACCOUNT_ID, model: 'ручка дверная', price: 1_425, origin: 'web', vat: 'included', note: 'медиана 1 источника' });
    const stored = (await ctx.deps.kp.byId(ACCOUNT_ID, draftId))!.payload as unknown as KpPayload;
    await ctx.deps.kp.setPayload(draftId, {
      ...stored,
      items: stored.items.map((l, i) => (i === 0 ? { ...l, price: 40_029.67, priceSource: 'research', priceLabel: 'по рынку (19.10.2026)', priceOutcome: undefined, coefficient: 1, market: { median: 40_029.67, min: 40_029.67, max: 40_029.67, count: 1, unit: 'piece', researchId: 1, researchedAt: '2026-10-19T10:00:00Z' } } : { ...l, price: 1_425, priceSource: 'kb', priceLabel: 'по рынку (19.10.2026)', priceOutcome: 'priced', kbPriceId: webRow })),
    } as unknown as Record<string, unknown>);
    // «По всем» берёт и позиции с ценой не из прайса.
    expect(researchablePositions((await ctx.deps.kp.byId(ACCOUNT_ID, draftId))!.payload as unknown as KpPayload, 'all')).toEqual([0]);
    const r = (await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId } })).json();
    expect(r).toMatchObject({ queued: [0, 1] });
    expect(g.searches()).toBe(0);
    const d = await draft();
    expect(d.items.map((l) => [l.price, l.priceSource, l.priceOutcome, l.kbPriceId ?? null])).toEqual([[null, 'kb', 'not_priced', null], [null, 'kb', 'not_priced', null]]);
    expect(d.items[0]!.coefficient).toBeUndefined();
    expect(d.items[0]!.market ?? null).toBeNull();
    expect(reasons(d, 1)).toEqual(['уточнить у менеджера: «ручка дверная» в прайсе нет — введите цену вручную']);
    // Веб-строка базы осталась на месте (удаление — только после выгрузки и решения заказчика), но в подбор не идёт.
    expect(await ctx.deps.kb.prices.byId(ACCOUNT_ID, webRow)).toMatchObject({ origin: 'web', price: 1_425 });
    const notes = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/journal?kind=note', headers })).json().items;
    expect(notes[0].summary).toBe('Цены не из прайса сняты: 2 поз. (из интернета или из базы не по прайсу) — «уточнить у менеджера»');
  });

  it('ручная цена менеджера: остаётся и при «Найти цены», и при «Найти цену» по строке; в базу знаний не пишется', async () => {
    const d = await draft();
    const saved = (await ctx.app.inject({ method: 'PUT', url: `/widget/v1/kp/draft/${draftId}`, headers, payload: { items: d.items.map((l, i) => (i === 0 ? { ...l, price: 70_000 } : l)) } })).json().draft;
    expect(saved.items[0]).toMatchObject({ price: 70_000, priceSource: 'manager' });
    expect(await ctx.deps.kb.prices.listByOrigin(ACCOUNT_ID, 'manager')).toEqual([]);
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId } })).json()).toMatchObject({ queued: [1] });
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId, requestIndexes: [0] } });
    expect((await draft()).items[0]).toMatchObject({ price: 70_000, priceSource: 'manager' });
  });

  it('собранное КП: 409 «КП уже собрано»; чужой черновик — 404', async () => {
    await ctx.deps.kp.setStatus(draftId, 'built');
    const r = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId } });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'locked', message: 'КП уже собрано, создайте новый черновик' });
    await ctx.deps.kp.setStatus(draftId, 'draft');
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: 999_999 } })).statusCode).toBe(404);
  });

  it('KB-COMPONENT-DOOR: добор к двери, которой нет в прайсе, — «уточнить у менеджера», цены нет', async () => {
    const payload = (await ctx.deps.kp.byId(ACCOUNT_ID, draftId))!.payload as unknown as KpPayload;
    const dobor = { request_index: 2, page_id: null, name: 'Добор', size: '', qty: 2, price: null, lead_time: '', discount: 0, category: 'component' as const };
    await ctx.deps.kp.setPayload(draftId, { ...payload, items: [...payload.items, dobor], request_items: [...payload.request_items, { raw: 'Добор 2 шт', name: 'Добор', width_mm: null, height_mm: null, qty: 2, category: 'component' }] } as unknown as Record<string, unknown>);
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId, requestIndexes: [2] } });
    expect(g.searches()).toBe(0);
    const after = await draft();
    expect(after.items[2]).toMatchObject({ price: null, priceOutcome: 'not_priced' });
    expect(reasons(after, 2)).toEqual(['уточнить у менеджера: дверь «Дверь межкомнатная двухпольная из массива лиственницы, окраска L429 Indigo» (поз. 1) не подобрана в прайсе — цены на добор к ней в прайсе нет']);
  });
});

describe('поиск цен: автозапуск, гонка версий', () => {
  it('autoResearch: выбор позиций без цены и лимит', async () => {
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
      const rowId = await ctx.deps.kb.prices.upsert({ accountId: ACCOUNT_ID, model: 'Лиственница 2П', price: 2, origin: 'price_list', vat: 'included' });
      const row = (await ctx.deps.kb.prices.byId(ACCOUNT_ID, rowId))!;
      const applied = await applyKbPriceToDraft(ctx.deps, ACCOUNT_ID, draftId, 0, { row, price: 2, basis: 'base', match: 'exact', similarity: 1, confidence: 70, stale: false, validityDays: 90, notes: [], label: 'по базе: прайс', outcome: 'priced' }, false);
      expect(applied.keptManagerPrice).toBe(false);
      const after = (await repo.byId(ACCOUNT_ID, draftId))!;
      const items = (after.payload as unknown as KpPayload).items;
      expect(items[0]).toMatchObject({ price: 2, priceSource: 'kb' });
      expect(items[1]?.qty).toBe(9);
      expect(after.version).toBe(2);
    } finally {
      await ctx.close();
    }
  });
});
