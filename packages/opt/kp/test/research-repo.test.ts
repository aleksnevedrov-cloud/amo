// Хранение результатов поиска цен и кэш (RFD-AI-AGENT-OPT-PRICE, этап 3): миграция 002, репозиторий, researchWithCache.
import { AccountsRepo, type Db } from '@core/db';
import type { ChatRoute, LlmGateway, RoutedRequest, RoutedResponse } from '@core/llm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MarketResearchInput, MarketResearchResult } from '../src/market-research.ts';
import { KpRepo } from '../src/repo.ts';
import { itemKey, KpPriceResearchRepo, queryKey, researchWithCache, rowToResult } from '../src/research-repo.ts';
import { freshOptDb } from './setup.ts';

const route: ChatRoute = { primary: { provider: 'openai', model: 'gpt-5' }, fallback: null };
const CARD = { kind: 'door', factory: null, model: null, collection: null, finish: 'окраска', color: 'L429 Indigo', glazing: null, heightMm: 2700, widthMm: 1400, leaves: 2, equipment: null, fireRating: null, standards: [] };

/** Модель: карточка, затем предложения (или ошибка); счётчик вызовов показывает, сработал ли кэш. */
function fakeLlm(offers: unknown): LlmGateway & { calls: number } {
  const g = {
    calls: 0,
    async chat(req: RoutedRequest): Promise<RoutedResponse> {
      g.calls += 1;
      if (req.webSearch && offers instanceof Error) throw offers;
      const text = JSON.stringify(req.webSearch ? offers : CARD);
      return { text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, cacheWriteTokens: 0, ...(req.webSearch ? { webSearchCalls: 2 } : {}) }, provider: 'openai', model: 'gpt-5', assistantMessage: { role: 'assistant', content: text }, latencyMs: 1, ...(req.webSearch ? { sources: [{ url: 'https://dveri.ru/p1' }, { url: 'https://dveri.ru/p2' }, { url: 'https://dveri.ru/p3' }] } : {}), fallbackUsed: false, requested: route.primary, attempts: [] };
    },
    providers: async () => ['openai' as const],
    provider: async () => null,
  };
  return g;
}
const offer = (url: string, price: number) => ({ url, seller: 'dveri', title: 'Дверь', price, currency: 'RUB', unit: 'piece', quantityInUnit: null, inStock: true, vatStated: 'included', vatRateStated: null, sourceKind: 'retail', includesDelivery: null, deliveryRub: null, factory: null, model: null, design: [], standards: [], widthMm: 1400, heightMm: 2700, kind: 'door', leaves: 2 });
const text = 'Дверь межкомнатная двухпольная из массива лиственницы 1400x2700 мм, окраска L429 Indigo, 2 шт';
const input: MarketResearchInput = { line: { name: text, size: '1400×2700 мм', qty: 2, price: null }, item: { raw: text, name: text, width_mm: 1400, height_mm: 2700 }, requirements: [] };

describe('KpPriceResearchRepo на БД опта', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let draftId: number;
  beforeAll(async () => {
    ({ db, drop } = await freshOptDb());
    await new AccountsRepo(db).upsertInstalled({ id: 1, subdomain: 'acc', accountDomain: 'acc.amocrm.ru' });
    draftId = await new KpRepo(db).createDraft(1, 30013995, { items: [] }, null);
  });
  afterAll(() => drop());

  it('ключи кэша: нижний регистр, ё→е, одиночные пробелы; ключ позиции — наименование и размер', () => {
    expect(queryKey('  Дверь   ДВУХПОЛЬНАЯ «Лиственница» ёлка  купить ')).toBe('дверь двухпольная лиственница елка купить');
    expect(itemKey(input)).toBe('дверь межкомнатная двухпольная из массива лиственницы 1400x2700 мм, окраска l429 indigo, 2 шт 1400x2700');
    expect(itemKey({ ...input, item: { ...input.item, width_mm: null, height_mm: null } })).toMatch(/ x$/);
  });

  it('новый поиск сохраняется с черновиком и позицией; повтор той же позиции берётся из кэша без вызовов модели; force ищет заново', async () => {
    const repo = new KpPriceResearchRepo(db);
    const llm = fakeLlm({ offers: [offer('https://dveri.ru/p1', 30_000), offer('https://dveri.ru/p2', 32_000), offer('https://dveri.ru/p3', 31_000)] });
    const first = await researchWithCache(repo, llm, route, input, { accountId: 1, draftId, requestIndex: 0 });
    expect(first.cached).toBe(false);
    expect(first.result.status).toBe('ok');
    expect(first.result.stats?.median).toBe(31_000);
    expect(llm.calls).toBe(2);
    const row = await repo.byId(1, first.researchId);
    expect(row).toMatchObject({ draftId, requestIndex: 0, status: 'ok', queryKey: queryKey(first.result.query), itemKey: itemKey(input), webSearchCalls: 2, provider: 'openai', model: 'gpt-5' });
    expect(row?.costUsd).toBeGreaterThan(0.02);
    expect(row?.offers).toHaveLength(3);
    expect(row?.stats).toEqual({ min: 30_000, max: 32_000, median: 31_000, count: 3, unit: 'piece' });
    expect(row?.sources).toHaveLength(3);
    // Повтор (например, «Собрать заново» по той же заявке): кэш по позиции, модель не вызывается.
    const again = await researchWithCache(repo, llm, route, input, { accountId: 1, draftId: null, requestIndex: 0 });
    expect(again).toMatchObject({ cached: true, researchId: first.researchId });
    expect(again.result.stats?.median).toBe(31_000);
    expect(again.result.cost.usd).toBe(0);
    expect(llm.calls).toBe(2);
    // «Искать заново» — кэш обходится, новая строка.
    const forced = await researchWithCache(repo, llm, route, input, { accountId: 1, draftId, requestIndex: 0, force: true });
    expect(forced.cached).toBe(false);
    expect(forced.researchId).not.toBe(first.researchId);
    expect(llm.calls).toBe(4);
    expect((await repo.listByDraft(1, draftId)).map((r) => r.id)).toEqual([forced.researchId, first.researchId]);
    // Чужой аккаунт свой кэш не видит.
    expect(await repo.latestByItemKey(2, itemKey(input))).toBeNull();
    expect(await repo.byId(2, first.researchId)).toBeNull();
  });

  it('срок кэша: старше cacheDays — не берётся; latestByQueryKey по нормализованному запросу', async () => {
    const repo = new KpPriceResearchRepo(db);
    const llm = fakeLlm({ offers: [offer('https://dveri.ru/p1', 10_000)] });
    const other: MarketResearchInput = { ...input, item: { ...input.item, name: 'Полотно Турин 1', raw: 'Полотно Турин 1' }, line: { ...input.line, name: 'Полотно Турин 1' } };
    const r = await researchWithCache(repo, llm, route, other, { accountId: 1, draftId, requestIndex: 1 });
    expect(await repo.latestByQueryKey(1, queryKey(r.result.query))).toMatchObject({ id: r.researchId });
    expect(await repo.latestByQueryKey(1, r.result.query.toUpperCase().replace(/\s+/g, '   ').trim())).toBeNull();
    expect(await repo.latestByQueryKey(1, queryKey(r.result.query.toUpperCase().replace(/\s+/g, '   ')))).toMatchObject({ id: r.researchId });
    await db.query("UPDATE kp_price_research SET created_at = now() - interval '8 days' WHERE id = $1", [r.researchId]);
    expect(await repo.latestByItemKey(1, itemKey(other), 7)).toBeNull();
    expect(await repo.latestByItemKey(1, itemKey(other), 30)).toMatchObject({ id: r.researchId });
    const stale = await researchWithCache(repo, llm, route, other, { accountId: 1, draftId, requestIndex: 1 });
    expect(stale.cached).toBe(false);
    expect(llm.calls).toBe(4);
    // cacheDays: 0 — кэш выключен.
    expect((await researchWithCache(repo, llm, route, other, { accountId: 1, draftId, requestIndex: 1, cacheDays: 0 })).cached).toBe(false);
  });

  it('failed сохраняется (виден в журнале), но в кэш не идёт — следующий запрос снова идёт к модели; none кэшируется', async () => {
    const repo = new KpPriceResearchRepo(db);
    const bad = fakeLlm(new (await import('@core/llm')).WebSearchUnavailableError('openai', 'OpenAI отверг запрос с веб-поиском'));
    const failedInput: MarketResearchInput = { ...input, item: { ...input.item, name: 'Дверь Браво', raw: 'Дверь Браво' }, line: { ...input.line, name: 'Дверь Браво' } };
    const f = await researchWithCache(repo, bad, route, failedInput, { accountId: 1, draftId, requestIndex: 2 });
    expect(f.result.status).toBe('failed');
    expect(f.result.error).toContain('веб-поиск недоступен');
    expect((await repo.byId(1, f.researchId))?.status).toBe('failed');
    expect(await repo.latestByItemKey(1, itemKey(failedInput))).toBeNull();
    const good = fakeLlm({ offers: [] });
    const n = await researchWithCache(repo, good, route, failedInput, { accountId: 1, draftId, requestIndex: 2 });
    expect(n).toMatchObject({ cached: false, result: { status: 'none' } });
    expect((await researchWithCache(repo, good, route, failedInput, { accountId: 1, draftId, requestIndex: 2 })).cached).toBe(true);
    expect(good.calls).toBe(2);
  });

  it('rowToResult: строка кэша → результат с нулевой стоимостью и теми же предложениями', async () => {
    const repo = new KpPriceResearchRepo(db);
    const rows = await repo.listByDraft(1, draftId);
    const ok = rows.find((r) => r.status === 'ok')!;
    const res: MarketResearchResult = rowToResult(ok);
    expect(res).toMatchObject({ status: 'ok', query: ok.query, webSearchCalls: 0, cost: { usd: 0 } });
    expect(res.offers.map((o) => o.accepted)).toEqual([true, true, true]);
  });
});
