import type { JournalKind } from '@core/db';
import { categoryMedian, componentKindOf, featureKeyOf, featuresOf, lookupPrice, mergeFeatures, priceModelOf, searchTokensOf, WEB_BAND, webPriceRealistic, type PriceHit } from '@opt/kb';
import type { OptCore } from './deps.ts';
import { lineCategory, NO_PRICE, type KpLine, type KpPayload, type KpRequestItem } from './draft.ts';
import { cleanName, VAT_ASSUMED_NOTE, type MarketResearchInput } from './market-research.ts';
import { manufacturerCoefficient, offerPrice, type OfferPrice } from './offer-price.ts';
import { DEFAULT_CACHE_DAYS, researchWithCache, sizeOfInput, type CachedResearch } from './research-repo.ts';
import { resolveOptRoute } from './settings.ts';

/**
 * Поиск рыночной цены по позиции черновика как задание воркера (RFD-AI-AGENT-OPT-PRICE, этап 5).
 * Очередь kp-research (Redis опта, база 1), jobId research-{accountId}-{draftId}-{requestIndex} —
 * повторное нажатие не плодит заданий. Ошибки модели и веб-поиска приходят из market-research
 * статусом failed и в журнал; повтор BullMQ (1 раз через 30 с) — только для прочих ошибок (сеть, БД).
 */

export const KP_RESEARCH_QUEUE = 'kp-research';
export const RESEARCH_JOB = 'research';
export const DEFAULT_MAX_POSITIONS_PER_RUN = 30;
/** RFD-AI-AGENT-OPT-KB, раздел 4–5: не больше 5 вызовов web_search на позицию, дневной лимит веб-поиска $5. */
export const DEFAULT_MAX_SEARCH_CALLS = 5;
export const DEFAULT_WEB_SEARCH_DAILY_USD = 5;

export interface ResearchJob {
  accountId: number;
  draftId: number;
  requestIndex: number;
  userId: number | null;
  /** «Искать заново» / «Искать в интернете»: база знаний и кэш не читаются. */
  force?: boolean;
  /** Заменить цену, введённую менеджером руками; без флага такая цена не трогается. */
  replace?: boolean;
  /** Порция и число порций при постановке всех позиций (KB-COMPONENTS, п. 6) — для журнала и логов. */
  batch?: number;
  batches?: number;
}

export const researchJobId = (accountId: number, draftId: number, requestIndex: number) => `research-${accountId}-${draftId}-${requestIndex}`;

/** Типы событий журнала опта по ценам; в общий JournalKind (packages/core) не добавляются — ядро не меняем. */
export const KP_PRICE_RESEARCH_KIND = 'kp_price_research' as JournalKind;
export const KP_PRICE_ERROR_KIND = 'kp_price_error' as JournalKind;
/** Порция позиций за одну постановку «Найти цены» (KB-COMPONENTS, п. 6): все позиции без цены ставятся порциями по 20 подряд. */
export const RESEARCH_BATCH = 20;
const CATEGORY_LABEL: Record<string, string> = { door: 'двери', component: 'комплектующие', hardware: 'фурнитура', service: 'работы' };

export class DraftLockedError extends Error {
  override name = 'DraftLockedError';
}

export interface ResearchJobResult {
  researchId: number;
  status: 'ok' | 'none' | 'failed';
  cached: boolean;
  price: number | null;
  /** Цена не записана: менеджер задал её руками, а replace не передан. */
  keptManagerPrice: boolean;
  notes: string[];
  /** Цена взята из базы знаний (kb_prices) — веб-поиск не вызывался. */
  fromKb?: boolean;
}

/** Вход исследования из строки черновика и позиции заявки. */
export function researchInputOf(payload: Partial<KpPayload>, line: KpLine): MarketResearchInput {
  const item: KpRequestItem = payload.request_items?.[line.request_index] ?? { raw: line.name, name: line.name, width_mm: null, height_mm: null, qty: line.qty };
  return { line, item, requirements: payload.requirements ?? [], managerPrice: line.priceSource === 'manager' ? line.price : null, category: lineCategory(line) };
}

/** Позиции, по которым имеет смысл искать: без цены (режим «по всем») или заданные явно. */
export function researchablePositions(payload: Partial<KpPayload>, which: number[] | 'all', max = DEFAULT_MAX_POSITIONS_PER_RUN): number[] {
  const items = payload.items ?? [];
  // Работы и услуги (kind = service) в поиск цен не отправляются ни «все», ни по номеру (XLSX-2, п. 3).
  const goods = items.filter((l) => !(l.kind === 'service' || lineCategory(l) === 'service'));
  const idx = which === 'all' ? goods.filter((l) => l.price === null).map((l) => l.request_index) : which.filter((i) => goods.some((l) => l.request_index === i));
  return [...new Set(idx)].slice(0, Math.max(1, max));
}

export async function runResearchJob(core: OptCore, job: ResearchJob): Promise<ResearchJobResult> {
  const { accountId, draftId, requestIndex } = job;
  const draft = await core.kp.byId(accountId, draftId);
  if (!draft) throw new Error(`черновик ${draftId} не найден`);
  if (draft.status !== 'draft') throw new DraftLockedError('КП уже собрано, создайте новый черновик');
  const payload = draft.payload as unknown as Partial<KpPayload>;
  const line = payload.items?.find((l) => l.request_index === requestIndex);
  if (!line) throw new Error(`в черновике ${draftId} нет позиции ${requestIndex}`);
  const lineLabel = `${line.name}${line.size ? `, ${line.size}` : ''}`;
  try {
    const ai = await core.ai(accountId);
    if (!ai) throw new Error('LLM не настроена: задайте ключ провайдера в настройках «Модель»');
    const { settings } = await core.settings.get(accountId);
    const route = resolveOptRoute(settings);
    const { constants } = await core.kp.getSettings(accountId);
    const input = researchInputOf(payload, line);
    const size = sizeOfInput(input);
    // 1. База знаний (RFD-AI-AGENT-OPT-KB): модель и размер из kb_prices → базовая цена × правила нестандарта, без веб-поиска.
    //    force («искать заново» / «искать в интернете») идёт мимо базы и кэша.
    if (!job.force && !constants.skipKnowledgeBase) {
      // KB-MATCH: подбор по признакам (тип, материал, Г/О, покрытие, огнестойкость, створки, порог, …) — прайс в приоритете, веб не перебивает.
      // KB-PRICE-SHEETS: комплектующее / фурнитура ищутся в контексте ближайшей двери заявки выше (её ID товара в прайсе).
      const category = lineCategory(line);
      const doorProductId = category === 'component' || category === 'hardware' ? await doorContextOf(core, accountId, payload, line) : null;
      let hit = await lookupPrice(core.kb.prices, core.kb.aliases, accountId, { name: input.item.name || line.name, raw: input.item.raw, widthMm: size.widthMm, heightMm: size.heightMm, features: input.item.features ?? null, category, doorProductId });
      // Комплект фурнитуры (OPT-025 = 2×OPT-029 + 2×OPT-030 + OPT-031): входящие тарифы, названные в заявке отдельно, не удваиваются.
      if (hit && category === 'hardware' && hit.outcome === 'priced' && hit.row.tariffId) {
        const set = await hardwareSetOf(core, accountId, payload, line, hit.row.tariffId, doorProductId);
        if (set) hit = { ...hit, price: 0, outcome: 'included', includedIn: set, notes: [...hit.notes, `${hit.row.model} (${hit.row.tariffId}) входит в комплект «${set}» той же позиции — отдельно не считается`] };
      }
      if (hit) {
        const applied = await applyKbPriceToDraft(core, accountId, draftId, requestIndex, hit, Boolean(job.replace));
        const priceText = hit.outcome === 'included' ? 'входит в цену блока' : hit.outcome === 'not_priced' ? 'в прайсе цены нет — уточнить у менеджера' : `${hit.price.toLocaleString('ru-RU')} ₽${hit.outcome === 'estimate' ? ' (сметная цена)' : ''}`;
        await core.journal.add({
          accountId,
          leadId: draft.leadId,
          kind: KP_PRICE_RESEARCH_KIND,
          summary: `Цена по позиции «${lineLabel}»: ${priceText} из базы знаний (${hit.label}), веб-поиск не вызывался${hit.stale ? ' — цена устарела' : ''}${applied.keptManagerPrice ? ' — цена менеджера сохранена' : ''}`,
          details: { draftId, requestIndex, source: 'kb', kbPriceId: hit.row.id, basis: hit.basis, match: hit.match, stale: hit.stale, price: hit.price, outcome: hit.outcome ?? 'priced', doorProductId, notes: hit.notes, webSearchCalls: 0, costUsd: 0, userId: job.userId, keptManagerPrice: applied.keptManagerPrice },
        });
        const price = hit.outcome === 'not_priced' ? null : hit.price;
        return { researchId: 0, status: 'ok', cached: true, price: applied.keptManagerPrice ? line.price : price, keptManagerPrice: applied.keptManagerPrice, notes: hit.notes, fromKb: true };
      }
    }
    // 2. Дневной лимит веб-поиска в $: достигнут — цена не ищется, пометка в блок и запись в журнал.
    const dailyLimit = constants.webSearchDailyUsd ?? DEFAULT_WEB_SEARCH_DAILY_USD;
    const spent = await core.research.spentTodayUsd(accountId);
    if (spent >= dailyLimit) {
      const message = `дневной лимит веб-поиска $${dailyLimit} исчерпан (потрачено $${spent.toFixed(2)}) — цена не искалась; добавьте цену в базу знаний или введите руками`;
      const failed: CachedResearch = { result: { query: '', card: null, status: 'failed', offers: [], stats: null, analog: null, error: message, provider: null, model: null, webSearchCalls: 0, cost: { inputTokens: 0, outputTokens: 0, usd: 0 }, sources: [] }, cached: false, researchId: 0, createdAt: new Date() };
      await applyResearchToDraft(core, accountId, draftId, requestIndex, offerPrice(failed.result), failed, false);
      await core.journal.add({ accountId, leadId: draft.leadId, kind: KP_PRICE_ERROR_KIND, summary: `Цена не найдена: ${lineLabel} — ${message}`, details: { draftId, requestIndex, limitUsd: dailyLimit, spentUsd: spent, userId: job.userId } });
      return { researchId: 0, status: 'failed', cached: false, price: null, keptManagerPrice: false, notes: [message] };
    }
    const r: CachedResearch = await researchWithCache(core.research, ai.llm, route, input, {
      accountId,
      draftId,
      requestIndex,
      force: job.force,
      cacheDays: constants.researchCacheDays ?? DEFAULT_CACHE_DAYS,
      analogPriceTolerance: constants.analogPriceTolerancePct === undefined ? undefined : constants.analogPriceTolerancePct / 100,
      manufacturerDomains: constants.manufacturerDomains,
      pricing: settings.billing.pricing,
      ...(constants.searchContext ? { searchContext: constants.searchContext } : {}),
      maxSearchCalls: constants.maxSearchCalls ?? DEFAULT_MAX_SEARCH_CALLS,
    });
    // 3. Реалистичность веб-цены (KB-MATCH, п. 4): медиана веб-источников вне 40–300 % медианы прайса по той же группе
    //    признаков — цена отбрасывается, в базу не пишется, менеджеру — пометка и запись в журнале.
    const queryFeatures = mergeFeatures(featuresOf(`${input.item.name || line.name} | ${input.item.raw}`), input.item.features ?? null);
    const priceListRows = await core.kb.prices.listByOrigin(accountId, 'price_list').catch(() => []);
    // KB-COMPONENTS, п. 2: медиана — по категории позиции (двери по группе признаков, комплектующие своего вида, фурнитура по
    // первому слову); у категории без прайсовой группы фильтр не применяется.
    const category = lineCategory(line);
    const groupMedian = categoryMedian(priceListRows, { category, features: queryFeatures, componentKind: componentKindOf(`${input.item.name || line.name} ${input.item.raw}`), tokens: searchTokensOf(input.item.name || line.name, input.item.raw) });
    if (r.result.status === 'ok' && r.result.stats && !webPriceRealistic(r.result.stats.median, groupMedian)) {
      const webPrice = r.result.stats.median;
      const message = `веб-цена ${webPrice.toLocaleString('ru-RU')} ₽ отброшена: вне диапазона прайса (медиана прайса по группе «${CATEGORY_LABEL[category]}» ${(groupMedian as number).toLocaleString('ru-RU')} ₽, допустимо ${WEB_BAND.min * 100}–${WEB_BAND.max * 100} %); добавьте цену в базу знаний или введите руками`;
      const failed: CachedResearch = { ...r, result: { ...r.result, status: 'failed', error: message, stats: null } };
      await applyResearchToDraft(core, accountId, draftId, requestIndex, offerPrice(failed.result), failed, Boolean(job.replace));
      const costRub = r.result.cost.usd * settings.billing.usdRubRate;
      await core.journal.add({
        accountId,
        leadId: draft.leadId,
        kind: KP_PRICE_ERROR_KIND,
        summary: `Цена не найдена: ${lineLabel} — веб-цена ${webPrice.toLocaleString('ru-RU')} ₽ отброшена: вне диапазона прайса (медиана по группе ${(groupMedian as number).toLocaleString('ru-RU')} ₽)`,
        details: { draftId, requestIndex, researchId: r.researchId, status: 'failed', cached: r.cached, reason: 'web_price_unrealistic', webMedian: webPrice, priceListMedian: groupMedian, band: WEB_BAND, featureKey: featureKeyOf(queryFeatures), category, sources: r.result.stats.count, webSearchCalls: r.result.webSearchCalls, costUsd: r.result.cost.usd, costRub, provider: r.result.provider, model: r.result.model, userId: job.userId },
        inputTokens: r.result.cost.inputTokens,
        outputTokens: r.result.cost.outputTokens,
        costUsd: r.result.cost.usd,
        costRub,
      });
      return { researchId: r.researchId, status: 'failed', cached: r.cached, price: null, keptManagerPrice: false, notes: [message] };
    }
    const price = offerPrice(r.result, { manufacturer: manufacturerCoefficient(r.result.card?.factory, constants.manufacturerCoefficients), general: constants.priceCoefficient });
    const applied = await applyResearchToDraft(core, accountId, draftId, requestIndex, price, r, Boolean(job.replace));
    // 4. Найденное веб-поиском — в базу знаний с доверием 40 и с признаками позиции (KB-MATCH, п. 3): следующая заявка
    //    с той же моделью обойдётся без поиска, но строка прайса с теми же признаками всегда выше этой записи.
    if (!r.cached && r.result.status === 'ok' && r.result.stats) {
      const card = r.result.card;
      const accepted = r.result.offers.find((o) => o.accepted);
      await core.kb.prices
        // Модель — как названа в заявке (так её ищет следующая заявка), фабрика — из карточки, признаки — из текста и разбора письма.
        .upsert({ accountId, model: cleanName(input.item.name || line.name), factory: card?.factory ?? null, widthMm: card?.widthMm ?? size.widthMm, heightMm: card?.heightMm ?? size.heightMm, price: r.result.stats.median, origin: 'web', vat: 'included', url: accepted?.offer.url ?? null, note: `медиана ${r.result.stats.count} источников, запрос: ${r.result.query}`.slice(0, 500), createdBy: job.userId, features: queryFeatures, category })
        .catch(() => undefined);
    }
    const costRub = r.result.cost.usd * settings.billing.usdRubRate;
    const kind = r.result.status === 'failed' ? KP_PRICE_ERROR_KIND : KP_PRICE_RESEARCH_KIND;
    const stats = r.result.stats;
    await core.journal.add({
      accountId,
      leadId: draft.leadId,
      kind,
      summary:
        r.result.status === 'failed'
          ? `Цена не найдена: ${lineLabel} — ${r.result.error}`
          : `Цена по позиции «${lineLabel}»: ${price.price === null ? 'не найдена' : `${price.price.toLocaleString('ru-RU')} ₽`}${stats ? `, источников ${stats.count}, медиана ${stats.median.toLocaleString('ru-RU')} ₽` : price.basis === 'analog' ? ', по аналогу' : ''}${r.cached ? ' (из кэша)' : ''}${applied.keptManagerPrice ? ' — цена менеджера сохранена' : ''}`,
      details: { draftId, requestIndex, researchId: r.researchId, status: r.result.status, cached: r.cached, sources: stats?.count ?? 0, median: stats?.median ?? null, min: stats?.min ?? null, max: stats?.max ?? null, price: price.price, basis: price.basis, coefficient: price.coefficient, notes: price.notes, webSearchCalls: r.result.webSearchCalls, costUsd: r.result.cost.usd, costRub, provider: r.result.provider, model: r.result.model, userId: job.userId, keptManagerPrice: applied.keptManagerPrice },
      inputTokens: r.result.cost.inputTokens,
      outputTokens: r.result.cost.outputTokens,
      costUsd: r.result.cost.usd,
      costRub,
    });
    return { researchId: r.researchId, status: r.result.status, cached: r.cached, price: applied.keptManagerPrice ? line.price : price.price, keptManagerPrice: applied.keptManagerPrice, notes: price.notes };
  } catch (err) {
    await core.journal.add({ accountId, leadId: draft.leadId, kind: KP_PRICE_ERROR_KIND, summary: `Поиск цены не выполнен: ${lineLabel} — ${(err as Error).message}`, details: { draftId, requestIndex, userId: job.userId } }).catch(() => undefined);
    throw err;
  }
}

/** Пометки позиции, которые ставит сам поиск цен (их мы заменяем при повторе); остальное — слова менеджера или разбора. */
const ownNote = (reason: string) => reason === NO_PRICE || reason.startsWith('ограничение расчёта') || reason.startsWith('предварительно, по аналогу') || reason.startsWith('аналог, пересчёт по площади') || reason === VAT_ASSUMED_NOTE || reason === 'цены не найдены' || reason.startsWith('поиск цены:') || reason.startsWith('цена из базы:') || reason.startsWith('цена устарела') || reason.startsWith('цвет уточнить');

/**
 * Цена из базы знаний в строку черновика: price, priceSource = kb, подпись и пометка «устарела», ссылка на kb_prices;
 * coefficient сбрасывается (это не рыночная цена), прошлая рыночная статистика market остаётся справочно.
 * Ручная цена менеджера без replace не трогается.
 */
export async function applyKbPriceToDraft(core: OptCore, accountId: number, draftId: number, requestIndex: number, hit: PriceHit, replace: boolean): Promise<{ keptManagerPrice: boolean }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const draft = await core.kp.byId(accountId, draftId);
    if (!draft) throw new Error(`черновик ${draftId} не найден`);
    const payload = draft.payload as unknown as Partial<KpPayload>;
    const items = [...(payload.items ?? [])];
    const i = items.findIndex((l) => l.request_index === requestIndex);
    if (i < 0) throw new Error(`в черновике ${draftId} нет позиции ${requestIndex}`);
    const line = items[i] as KpLine;
    const keptManagerPrice = line.priceSource === 'manager' && line.price !== null && !replace;
    const next: KpLine = { ...line };
    const outcome = hit.outcome ?? 'priced';
    if (!keptManagerPrice) {
      // KB-PRICE-SHEETS: «в прайсе цены нет» — цена остаётся пустой (не 0 ₽), «входит в блок» — 0 без строки в таблице КП.
      next.price = outcome === 'not_priced' ? null : hit.price;
      next.priceSource = 'kb';
      next.priceLabel = hit.label;
      next.priceStale = hit.stale;
      next.kbPriceId = hit.row.id;
      next.priceOutcome = outcome;
      next.productId = hit.row.category === 'door' ? hit.row.productId : null;
      next.includedIn = outcome === 'included' ? hit.includedIn ?? null : null;
      // Синоним прайса увёл позицию в другую категорию («Фрамуга» — фурнитура): плитка и таблица КП следуют за строкой базы.
      if (hit.row.category !== 'service' && hit.row.category !== (next.category ?? 'door') && outcome !== 'included' && outcome !== 'not_priced') next.category = hit.row.category;
      delete next.coefficient;
      // KP-NAME: модель и покрытие строки прайса — в наименование КП, комплектация — строкой под позицией; у веб-записей и правок — нет.
      const own = hit.row.origin === 'price_list' && (outcome === 'priced' || outcome === 'estimate');
      next.priceModel = own ? priceModelOf(hit.row) : null;
      next.equipment = own ? hit.row.equipment : null;
      next.priceAbbr = own ? hit.row.abbr : null;
      // Примечания под позицией в КП: вкладка «Подбор», фразы нестандарта (эталон, производство, огнестойкость).
      const production = hit.notes.filter((n) => /подлежат уточнению на производстве|огнестойкость исполнения|^нестандарт /.test(n));
      next.quoteNotes = [...(hit.quoteNotes ?? []), ...production];
      if (!next.quoteNotes.length) delete next.quoteNotes;
    }
    items[i] = next;
    const needs = (payload.needs_manager ?? []).filter((n) => !(n.request_index === requestIndex && ownNote(n.reason)));
    if (next.price === null && outcome !== 'not_priced') needs.push({ request_index: requestIndex, reason: NO_PRICE });
    for (const n of hit.notes) needs.push({ request_index: requestIndex, reason: n.startsWith('цена устарела') || n.startsWith('цвет уточнить') || n.startsWith('уточнить у менеджера') ? n : `цена из базы: ${n}` });
    const ok = await core.kp.setPayloadIfVersion(draftId, draft.version, { ...payload, items, needs_manager: needs } as unknown as Record<string, unknown>);
    if (ok) return { keptManagerPrice };
  }
  throw new Error(`черновик ${draftId} меняется параллельно — цена позиции ${requestIndex} не записана`);
}

/**
 * Автозаполнение строки черновика: цена предложения, market, priceSource, coefficient; пометки раздела 8.1 — в
 * needs_manager по позиции вместо «цена не задана». Пишется только своя позиция с проверкой версии: при гонке
 * черновик перечитывается и правка повторяется.
 */
export async function applyResearchToDraft(core: OptCore, accountId: number, draftId: number, requestIndex: number, price: OfferPrice, r: CachedResearch, replace: boolean): Promise<{ keptManagerPrice: boolean }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const draft = await core.kp.byId(accountId, draftId);
    if (!draft) throw new Error(`черновик ${draftId} не найден`);
    const payload = draft.payload as unknown as Partial<KpPayload>;
    const items = [...(payload.items ?? [])];
    const i = items.findIndex((l) => l.request_index === requestIndex);
    if (i < 0) throw new Error(`в черновике ${draftId} нет позиции ${requestIndex}`);
    const line = items[i] as KpLine;
    const keptManagerPrice = line.priceSource === 'manager' && line.price !== null && !replace;
    const market = r.result.stats ? { ...r.result.stats, researchId: r.researchId, researchedAt: r.createdAt.toISOString() } : null;
    const next: KpLine = { ...line, market };
    if (price.price !== null && !keptManagerPrice) {
      next.price = price.price;
      next.priceSource = price.basis === 'analog' ? 'analog' : 'research';
      next.coefficient = price.coefficient.value;
      next.priceLabel = `${price.basis === 'analog' ? 'по аналогу' : 'по рынку'} (${r.createdAt.toLocaleDateString('ru-RU')})`;
      next.priceStale = false;
      next.kbPriceId = null;
      next.priceModel = null;
      next.equipment = null;
      next.priceAbbr = null;
    }
    items[i] = next;
    const notes = price.notes;
    const needs = (payload.needs_manager ?? []).filter((n) => !(n.request_index === requestIndex && ownNote(n.reason)));
    // Без цены пометка «цена не задана» остаётся: менеджеру всё равно её вводить.
    if (next.price === null) needs.push({ request_index: requestIndex, reason: NO_PRICE });
    for (const n of notes) needs.push({ request_index: requestIndex, reason: price.status === 'failed' ? `поиск цены: ${n}` : n });
    const ok = await core.kp.setPayloadIfVersion(draftId, draft.version, { ...payload, items, needs_manager: needs } as unknown as Record<string, unknown>);
    if (ok) return { keptManagerPrice };
  }
  throw new Error(`черновик ${draftId} меняется параллельно — цена позиции ${requestIndex} не записана`);
}

/**
 * KB-PRICE-SHEETS: дверь-контекст для комплектующего / фурнитуры — ближайшая дверь заявки выше по номеру позиции.
 * У неё уже есть ID товара (цена из прайса поставлена) — берётся он; иначе дверь подбирается по базе здесь же, без записи
 * в черновик (позиции считаются параллельно, порядок не гарантирован).
 */
export async function doorContextOf(core: OptCore, accountId: number, payload: Partial<KpPayload>, line: KpLine): Promise<string | null> {
  const doors = (payload.items ?? []).filter((l) => l.request_index < line.request_index && lineCategory(l) === 'door').sort((a, b) => b.request_index - a.request_index);
  const door = doors[0];
  if (!door) return null;
  if (door.productId) return door.productId;
  if (door.kbPriceId) {
    const row = await core.kb.prices.byId(accountId, door.kbPriceId);
    if (row?.productId) return row.productId;
  }
  const input = researchInputOf(payload, door);
  const size = sizeOfInput(input);
  const hit = await lookupPrice(core.kb.prices, core.kb.aliases, accountId, { name: input.item.name || door.name, raw: input.item.raw, widthMm: size.widthMm, heightMm: size.heightMm, features: input.item.features ?? null, category: 'door' });
  return hit?.row.productId ?? null;
}

/**
 * Другая фурнитура той же двери (между этой дверью и следующей), в состав которой входит тариф позиции («Включено»
 * комплекта называет его ID): возвращает название комплекта или null.
 */
export async function hardwareSetOf(core: OptCore, accountId: number, payload: Partial<KpPayload>, line: KpLine, tariffId: string, doorProductId: string | null): Promise<string | null> {
  const items = [...(payload.items ?? [])].sort((a, b) => a.request_index - b.request_index);
  const me = items.findIndex((l) => l.request_index === line.request_index);
  if (me < 0) return null;
  let from = me;
  while (from > 0 && lineCategory(items[from - 1] as KpLine) !== 'door') from -= 1;
  let to = me;
  while (to + 1 < items.length && lineCategory(items[to + 1] as KpLine) !== 'door') to += 1;
  const id = tariffId.toLowerCase();
  for (const other of items.slice(from, to + 1)) {
    if (other.request_index === line.request_index || lineCategory(other) !== 'hardware') continue;
    const row = other.kbPriceId ? await core.kb.prices.byId(accountId, other.kbPriceId) : null;
    const hit = row ? null : await lookupPrice(core.kb.prices, core.kb.aliases, accountId, { name: other.name, widthMm: null, heightMm: null, category: 'hardware', doorProductId });
    const set = row ?? hit?.row ?? null;
    if (set && set.tariffId && set.tariffId !== tariffId && (set.card?.includes ?? '').toLowerCase().includes(id)) return set.model;
  }
  return null;
}
