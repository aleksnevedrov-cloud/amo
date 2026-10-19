// «Найти цены» и опросник (KP-AGENT-V2): прайс → интернет по сайтам из «Базы знаний» → вопрос менеджеру; цену из интернета
// выбирает менеджер; подтверждённая цена — «кандидат в прайс»; ответы переносятся на «Собрать заново»; документ — при 0
// блокирующих вопросов. Цены прежнего веб-поиска и строки базы не из прайса в черновик не идут (KB-WEB-ROWS).
import type { LlmGateway, RoutedRequest, RoutedResponse } from '@core/llm';
import type { KpPayload, OptAiProvider } from '@opt/kp';
import { readFileSync } from 'node:fs';
import { applyKbPriceToDraft, KP_PRICE_RESEARCH_KIND, researchablePositions, resolveKpPath } from '@opt/kp';
import PizZip from 'pizzip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNT_ID, answerSurvey, LEAD_ID, setup, widgetToken } from './helpers.ts';

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
const SRC = [{ url: 'https://dveri-a.ru/p1' }, { url: 'https://dveri-b.ru/p2' }, { url: 'https://fabrika-l.ru/p3' }, { url: 'https://dveri-c.ru/p4' }];
const offer = (url: string, price: number, over: Record<string, unknown> = {}) => ({ url, seller: new URL(url).host, title: 'Дверь двупольная лиственница', price, currency: 'RUB', unit: 'piece', quantityInUnit: null, inStock: true, vatStated: 'included', vatRateStated: null, sourceKind: 'retail', includesDelivery: null, deliveryRub: null, factory: 'Фабрика Л', model: 'Лиственница 2П', design: ['окраска'], standards: [], widthMm: 1400, heightMm: 2700, kind: 'door', leaves: 2, ...over });

/** Модель: письмо → позиции; карточка → CARD; веб-поиск → предложения (по умолчанию 4, одно — с фабрики). */
function gateway() {
  const requests: RoutedRequest[] = [];
  let searches = 0;
  const state: { offers: unknown[] } = { offers: [offer('https://dveri-a.ru/p1', 84_000), offer('https://dveri-b.ru/p2', 86_000), offer('https://fabrika-l.ru/p3', 90_000, { sourceKind: 'manufacturer' }), offer('https://dveri-c.ru/p4', 80_000)] };
  const llm: LlmGateway = {
    async chat(req, route) {
      requests.push(req);
      if (req.webSearch) searches += 1;
      const text = req.webSearch ? JSON.stringify({ offers: state.offers }) : req.outputSchema?.name === 'item_card' ? JSON.stringify(CARD) : letterAnswer;
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
  return { ai, requests, searches: () => searches, state };
}

type Line = KpPayload['items'][number];
type Need = { request_index: number; reason: string };
type Q = { key: string; type: string; blocking: boolean; title: string; text: string; requestIndexes: number[]; options: { id: string; label: string; price?: number | null }[]; web?: { min: number; median: number; max: number; count: number; factorySources: number; enough: boolean; sources: { url: string; site: string | null }[]; excludedSites: string[] } | null; answer: unknown; askClient: string | null };
type Draft = { id: number; items: Line[]; needsManager: Need[]; survey: Q[]; counters: { positions: number; open: number; blocking: number; unpriced: number }; delivery: unknown; priceValidity: string | null };

describe('«Найти цены» и опросник (KP-AGENT-V2)', () => {
  const g = gateway();
  let ctx: Awaited<ReturnType<typeof setup>>;
  let headers: Record<string, string>;
  let draftId = 0;
  const draft = async () => (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft as Draft;
  const reasons = (d: { needsManager: Need[] }, i: number) => d.needsManager.filter((n) => n.request_index === i).map((n) => n.reason);
  const answer = async (key: string, body: Record<string, unknown>) => ctx.app.inject({ method: 'POST', url: `/widget/v1/kp/draft/${draftId}/answer`, headers, payload: { key, ...body } });
  beforeAll(async () => {
    ctx = await setup({ ai: g.ai });
    headers = { 'x-auth-token': await widgetToken() };
    await ctx.app.inject({ method: 'GET', url: '/oauth/amo/callback', query: { code: 'c', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
    ctx.amo.mail = { id: 5, created_at: 1_760_000_000, params: { income: true, subject: 'Запрос ООО Стройоптпоставка', text: 'Нужна дверь, доставка по адресу: г. Москва, ул. Строителей, 1', from: 'stoptpostavka@yandex.ru', attachments: [] } };
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    draftId = (await draft()).id;
  });
  afterAll(() => ctx.close());

  it('настройки: значения по умолчанию', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/widget/v1/kp/settings', headers })).json().constants).toMatchObject({ autoResearch: false, maxPositionsPerRun: 30 });
    expect((await ctx.app.inject({ method: 'PUT', url: '/widget/v1/kp/settings', headers, payload: { constants: { autoResearch: false, maxPositionsPerRun: 40 } } })).json()).toEqual({ ok: true });
  });

  it('по умолчанию поиск при сборке не запускается; опросник сразу спрашивает неполную позицию, цену, доставку и срок действия цены', async () => {
    const d = await draft();
    expect(d.items.map((l) => l.price)).toEqual([null, null]);
    expect(g.searches()).toBe(0);
    expect(d.survey.map((q) => q.type)).toEqual(['incomplete', 'enter_price', 'enter_price', 'delivery', 'price_validity']);
    expect(d.counters).toEqual({ positions: 2, open: 5, blocking: 5, unpriced: 2 });
    // Двупольная дверь из письма: ГОСТ и вид не названы — вопрос «неполная позиция», не догадка.
    expect(d.survey[0]).toMatchObject({ key: 'incomplete:дверь межкомнатная двухпольная из массива лиственницы, окраска l429 indigo|1400×2700 мм', blocking: true, text: expect.stringContaining('не указано — ГОСТ, вид изделия, глухая / остеклённая') });
    expect(d.survey[0]?.askClient).toContain('Уточните, пожалуйста, по позиции');
  });

  it('сайты по комментарию: фабрика — первой, «Межкомнатных нет» — исключён; цены интернета показаны, но в КП не поставлены', async () => {
    const site = async (url: string, comment: string | null, isFactory: boolean) => {
      const id = await ctx.deps.kb.repo.createSource({ accountId: ACCOUNT_ID, kind: 'url', title: url, original: url });
      const r = await ctx.app.inject({ method: 'PUT', url: `/widget/v1/kb/sources/${id}/site`, headers, payload: { comment, isFactory } });
      expect(r.statusCode).toBe(200);
      return r.json().source;
    };
    expect(await site('https://fabrika-l.ru', 'Двери из массива лиственницы, межкомнатные', true)).toMatchObject({ isFactory: true, comment: 'Двери из массива лиственницы, межкомнатные' });
    await site('https://dveri-c.ru', 'Только стальные. Межкомнатных нет', false);
    expect((await ctx.app.inject({ method: 'PUT', url: '/widget/v1/kb/sources/999999/site', headers, payload: { comment: 'x' } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'PUT', url: '/widget/v1/kb/sources/1/site', headers, payload: { comment: 'x'.repeat(2001) } })).statusCode).toBe(400);
    const r = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId } });
    expect(r.json()).toMatchObject({ queued: [0, 1] });
    expect(g.searches()).toBeGreaterThanOrEqual(1);
    // В запросе поиска — сайты по порядку и исключённые.
    const searchReq = g.requests.find((q) => q.webSearch);
    const content = String(searchReq?.messages[0]?.content ?? '');
    expect(content).toContain('Сначала проверьте эти сайты (по порядку), затем любые магазины:\n- fabrika-l.ru — фабрика; по комментарию: «Двери из массива лиственницы, межкомнатные»');
    expect(content).toContain('Не используйте сайты: dveri-c.ru');
    const d = await draft();
    // Цена в КП не поставлена; предложение dveri-c.ru отброшено; медиана трёх: 86 000.
    expect(d.items[0]).toMatchObject({ price: null, priceLabel: 'цены из интернета — выбор менеджера' });
    const q = d.survey.find((x) => x.type === 'web_price' && x.requestIndexes.includes(0)) as Q;
    expect(q).toMatchObject({ blocking: true, title: 'Цена из интернета' });
    expect(q.web).toMatchObject({ min: 84_000, median: 86_000, max: 90_000, count: 3, factorySources: 1, enough: true, excludedSites: ['dveri-c.ru'] });
    expect(q.web?.sources[0]).toMatchObject({ url: 'https://fabrika-l.ru/p3', site: 'фабрика; по комментарию: «Двери из массива лиственницы, межкомнатные»' });
    expect(q.web?.sources.map((s) => s.url)).not.toContain('https://dveri-c.ru/p4');
    expect(q.options.map((o) => [o.id, o.price])).toEqual([['median', 86_000], ['min', 84_000], ['max', 90_000], ['no_price', undefined]]);
    const journal = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/journal?kind=${KP_PRICE_RESEARCH_KIND}`, headers })).json().items;
    expect(journal.map((j: { summary: string }) => j.summary)).toContainEqual(expect.stringContaining('Цены из интернета по позиции'));
  });

  it('ответ «медиана» — цена web_confirmed, «кандидат в прайс»; своя цена — manager; без суммы доставки — 400', async () => {
    const d = await draft();
    const web = d.survey.find((x) => x.type === 'web_price' && x.requestIndexes.includes(0)) as Q;
    expect((await answer(web.key, { option: 'nope' })).statusCode).toBe(400);
    const r = await answer(web.key, { option: 'median' });
    expect(r.statusCode).toBe(200);
    const after = r.json().draft as Draft;
    expect(after.items[0]).toMatchObject({ price: 86_000, priceSource: 'web_confirmed', priceOutcome: 'priced', priceLabel: 'из интернета (3 источн.), выбрал менеджер' });
    expect(after.survey.find((x) => x.key === web.key)?.answer).toMatchObject({ option: 'median', price: 86_000 });
    const cands = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/candidates', headers })).json().items;
    expect(cands).toMatchObject([{ model: 'Дверь межкомнатная двухпольная из массива лиственницы, окраска L429 Indigo', size: '1400×2700 мм', price: 86_000, source: 'web_confirmed', url: 'https://fabrika-l.ru/p3', leadId: LEAD_ID }]);
    // Кандидат в подбор не идёт: в kb_prices ничего не записано.
    expect(await ctx.deps.kb.prices.listByOrigin(ACCOUNT_ID, 'web')).toEqual([]);
    const exp = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/kb/candidates/export', headers })).json();
    expect(exp).toMatchObject({ rows: 1, filename: expect.stringMatching(/^kb-candidates-.*\.xlsx$/) });
    // Ручка: своя цена.
    const handle = after.survey.find((x) => !x.answer && x.requestIndexes.includes(1) && (x.type === 'web_price' || x.type === 'enter_price')) as Q;
    const own = (await answer(handle.key, { price: 1_250 })).json().draft as Draft;
    expect(own.items[1]).toMatchObject({ price: 1_250, priceSource: 'manager', priceLabel: 'введена менеджером' });
    // Доставка без суммы — 400; с суммой — строка доставки будет в КП.
    expect((await answer('delivery', { option: 'delivery', fields: { address: 'г. Москва, ул. Строителей, 1', sum: '' } })).statusCode).toBe(400);
    const del = (await answer('delivery', { option: 'delivery', fields: { address: 'г. Москва, ул. Строителей, 1', sum: '4 500' } })).json().draft as Draft;
    expect(del.delivery).toEqual({ mode: 'delivery', address: 'г. Москва, ул. Строителей, 1', sum: 4500 });
  });

  it('документ — только при 0 блокирующих: срок цены открыт → 409 (неполная позиция с ценой — вопрос, но не блокирует); после ответов — DOCX', async () => {
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/template', headers, payload: { filename: 'kp.docx', contentBase64: templateDocx() } });
    const blocked = (await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/build', headers, payload: { draftId } })).json();
    expect(blocked).toMatchObject({ error: 'open_questions', message: 'ответьте на вопросы опросника, которые блокируют КП: 1 («Срок действия цены»)' });
    const d = await draft();
    const inc = d.survey.find((x) => x.type === 'incomplete') as Q;
    expect(inc).toMatchObject({ blocking: false, answer: null });
    await answer(inc.key, { fields: { gost: '475-2016', kind: 'ДН', fill: 'Г' } });
    await answer('price_validity', { fields: { text: '30 календарных дней' } });
    const ready = await draft();
    expect(ready.counters).toMatchObject({ blocking: 0 });
    expect(ready.priceValidity).toBe('30 календарных дней');
    const built = (await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/build', headers, payload: { draftId } })).json();
    expect(built).toMatchObject({ draft: { status: 'built' } });
    const doc = await ctx.deps.kp.byId(ACCOUNT_ID, draftId);
    expect(doc?.docxPath).toBeTruthy();
    // KP-AGENT-V2, п. 6: доставка — последней строкой и в итоге; источников цен (сайтов) в документе нет.
    const text = new PizZip(readFileSync(resolveKpPath(ctx.deps.filesRoot, doc!.docxPath!))).file('word/document.xml')!.asText().replace(/\u00a0/g, ' ').replace(/<[^>]+>/g, '');
    expect(text).toContain('3. Доставка по адресу: г. Москва, ул. Строителей, 1 — 4 500 ₽; итого 179 000 ₽');
    expect(text).not.toMatch(/fabrika-l|dveri-[abc]|https?:/);
    await ctx.deps.kp.setStatus(draftId, 'draft');
  });

  it('«Собрать заново»: ответы переносятся — цены, доставка, срок действия; веб-поиск не повторяется', async () => {
    const before = g.searches();
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const d = await draft();
    expect(d.id).not.toBe(draftId);
    draftId = d.id;
    expect(d.items.map((l) => [l.price, l.priceSource])).toEqual([[86_000, 'web_confirmed'], [1_250, 'manager']]);
    expect(d.delivery).toEqual({ mode: 'delivery', address: 'г. Москва, ул. Строителей, 1', sum: 4500 });
    expect(d.survey.filter((q) => q.blocking && !q.answer)).toEqual([]);
    // «Найти цены» по всем: у всех цена — ничего не ставится, интернет не вызывается.
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId } })).json()).toMatchObject({ queued: [], reason: 'у всех позиций уже есть цена' });
    expect(g.searches()).toBe(before);
  });

  it('цена прежнего веб-поиска и строка базы не из прайса снимаются (KB-WEB-ROWS); строки базы не удаляются', async () => {
    const webRow = await ctx.deps.kb.prices.upsert({ accountId: ACCOUNT_ID, model: 'ручка дверная', price: 1_425, origin: 'web', vat: 'included', note: 'медиана 1 источника' });
    const stored = (await ctx.deps.kp.byId(ACCOUNT_ID, draftId))!.payload as unknown as KpPayload;
    await ctx.deps.kp.setPayload(draftId, {
      ...stored,
      answers: {},
      items: stored.items.map((l, i) => (i === 0 ? { ...l, price: 40_029.67, priceSource: 'research', priceLabel: 'по рынку (19.10.2026)', priceOutcome: undefined, coefficient: 1 } : { ...l, price: 1_425, priceSource: 'price_file', priceLabel: 'по рынку (19.10.2026)', priceOutcome: 'priced', kbPriceId: webRow })),
    } as unknown as Record<string, unknown>);
    g.state.offers = [];
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId } });
    const d = await draft();
    expect(d.items.map((l) => [l.price, l.priceOutcome, l.kbPriceId ?? null])).toEqual([[null, 'not_priced', null], [null, 'not_priced', null]]);
    expect(d.items[0]!.coefficient).toBeUndefined();
    // Интернет — из кэша прежнего поиска (за сутки не повторяется): цена снова не ставится, только вопрос менеджеру.
    expect(reasons(d, 1)).toEqual([expect.stringMatching(/^уточнить у менеджера: цены из интернета: .* итоговую цену выберите в опроснике$/)]);
    expect(d.survey.find((q) => q.type === 'web_price' && q.requestIndexes.includes(1))).toMatchObject({ blocking: true, answer: null });
    expect(await ctx.deps.kb.prices.byId(ACCOUNT_ID, webRow)).toMatchObject({ origin: 'web', price: 1_425 });
    const notes = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/journal?kind=note', headers })).json().items;
    expect(notes.map((n: { summary: string }) => n.summary)).toContain('Цены не из прайса сняты: 2 поз. (из интернета или из базы не по прайсу) — «уточнить у менеджера»');
  });

  it('ручная цена менеджера: остаётся и при «Найти цены», и при «Найти цену» по строке; в базу знаний не пишется', async () => {
    const d = await draft();
    const saved = (await ctx.app.inject({ method: 'PUT', url: `/widget/v1/kp/draft/${draftId}`, headers, payload: { items: d.items.map((l, i) => (i === 0 ? { ...l, price: 70_000 } : l)) } })).json().draft;
    expect(saved.items[0]).toMatchObject({ price: 70_000, priceSource: 'manager' });
    expect(await ctx.deps.kb.prices.listByOrigin(ACCOUNT_ID, 'manager')).toEqual([]);
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId } });
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId, requestIndexes: [0] } });
    expect((await draft()).items[0]).toMatchObject({ price: 70_000, priceSource: 'manager' });
  });

  it('без ключа модели «Найти цены» работает: нет прайса — «введите цену», интернет не вызывается', async () => {
    const ai = ctx.deps.ai;
    (ctx.deps as unknown as { ai: OptAiProvider }).ai = async () => null;
    const before = g.searches();
    const r = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId, requestIndexes: [1] } });
    (ctx.deps as unknown as { ai: OptAiProvider }).ai = ai;
    expect(r.statusCode).toBe(202);
    expect(g.searches()).toBe(before);
    expect(reasons(await draft(), 1)).toEqual(['уточнить у менеджера: «ручка дверная» — в прайсе нет, интернет не проверялся: модель не настроена; введите цену']);
  });

  it('собранное КП: 409 «КП уже собрано»; чужой черновик — 404; неизвестный вопрос — 404', async () => {
    await ctx.deps.kp.setStatus(draftId, 'built');
    const r = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId } });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'locked', message: 'КП уже собрано, создайте новый черновик' });
    expect((await answer('delivery', { option: 'pickup' })).statusCode).toBe(409);
    await ctx.deps.kp.setStatus(draftId, 'draft');
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: 999_999 } })).statusCode).toBe(404);
    expect((await answer('web_price:нет такой|', { option: 'median' })).statusCode).toBe(404);
  });

  it('KB-COMPONENT-DOOR: добор к двери, которой нет в прайсе, — «уточнить у менеджера», цены нет, в интернет не ходим', async () => {
    const payload = (await ctx.deps.kp.byId(ACCOUNT_ID, draftId))!.payload as unknown as KpPayload;
    const dobor = { request_index: 2, page_id: null, name: 'Добор', size: '', qty: 2, price: null, lead_time: '', discount: 0, category: 'component' as const };
    await ctx.deps.kp.setPayload(draftId, { ...payload, items: [...payload.items, dobor], request_items: [...payload.request_items, { raw: 'Добор 2 шт', name: 'Добор', width_mm: null, height_mm: null, qty: 2, category: 'component' }] } as unknown as Record<string, unknown>);
    const before = g.searches();
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId, requestIndexes: [2] } });
    expect(g.searches()).toBe(before);
    const after = await draft();
    expect(after.items[2]).toMatchObject({ price: null, priceOutcome: 'not_priced' });
    expect(reasons(after, 2)).toEqual(['уточнить у менеджера: дверь «Дверь межкомнатная двухпольная из массива лиственницы, окраска L429 Indigo» (поз. 1) не подобрана в прайсе — цены на добор к ней в прайсе нет']);
  });

  it('answerSurvey (помощник тестов) закрывает блокирующие вопросы', async () => {
    const d = await answerSurvey(ctx.app, headers, LEAD_ID);
    expect(d.survey.filter((q) => q.blocking && !q.answer && q.type !== 'component_door')).toEqual([]);
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
      const p = before.payload as unknown as KpPayload;
      await repo.setPayload(draftId, { ...p, items: p.items.map((l, i) => (i === 1 ? { ...l, qty: 9 } : l)) } as unknown as Record<string, unknown>);
      expect(await repo.setPayloadIfVersion(draftId, 0, p as unknown as Record<string, unknown>)).toBe(false);
      const rowId = await ctx.deps.kb.prices.upsert({ accountId: ACCOUNT_ID, model: 'Лиственница 2П', price: 2, origin: 'price_list', vat: 'included' });
      const row = (await ctx.deps.kb.prices.byId(ACCOUNT_ID, rowId))!;
      const applied = await applyKbPriceToDraft(ctx.deps, ACCOUNT_ID, draftId, 0, { row, price: 2, basis: 'base', match: 'exact', similarity: 1, confidence: 70, stale: false, validityDays: 90, notes: [], label: 'по базе: прайс', outcome: 'priced' }, false);
      expect(applied.keptManagerPrice).toBe(false);
      const after = (await repo.byId(ACCOUNT_ID, draftId))!;
      const items = (after.payload as unknown as KpPayload).items;
      expect(items[0]).toMatchObject({ price: 2, priceSource: 'price_file' });
      expect(items[1]?.qty).toBe(9);
      expect(after.version).toBe(2);
    } finally {
      await ctx.close();
    }
  });
});

/** Минимальный DOCX-шаблон: строки позиций и итог. */
function templateDocx(): string {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{{#items}}{{n}}. {{name}} — {{sum}}; {{/items}}итого {{grand_total}} ₽</w:t></w:r></w:p></w:body></w:document>');
  return zip.generate({ type: 'base64' });
}
