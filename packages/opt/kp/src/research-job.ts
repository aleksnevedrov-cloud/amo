import type { JournalKind } from '@core/db';
import type { OptCore } from './deps.ts';
import { NO_PRICE, type KpLine, type KpPayload, type KpRequestItem } from './draft.ts';
import type { MarketResearchInput } from './market-research.ts';
import { manufacturerCoefficient, offerPrice, type OfferPrice } from './offer-price.ts';
import { DEFAULT_CACHE_DAYS, researchWithCache, type CachedResearch } from './research-repo.ts';
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

export interface ResearchJob {
  accountId: number;
  draftId: number;
  requestIndex: number;
  userId: number | null;
  /** «Искать заново»: кэш не читается. */
  force?: boolean;
  /** Заменить цену, введённую менеджером руками; без флага такая цена не трогается. */
  replace?: boolean;
}

export const researchJobId = (accountId: number, draftId: number, requestIndex: number) => `research-${accountId}-${draftId}-${requestIndex}`;

/** Типы событий журнала опта по ценам; в общий JournalKind (packages/core) не добавляются — ядро не меняем. */
export const KP_PRICE_RESEARCH_KIND = 'kp_price_research' as JournalKind;
export const KP_PRICE_ERROR_KIND = 'kp_price_error' as JournalKind;

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
}

/** Вход исследования из строки черновика и позиции заявки. */
export function researchInputOf(payload: Partial<KpPayload>, line: KpLine): MarketResearchInput {
  const item: KpRequestItem = payload.request_items?.[line.request_index] ?? { raw: line.name, name: line.name, width_mm: null, height_mm: null, qty: line.qty };
  return { line, item, requirements: payload.requirements ?? [], managerPrice: line.priceSource === 'manager' ? line.price : null };
}

/** Позиции, по которым имеет смысл искать: без цены (режим «по всем») или заданные явно. */
export function researchablePositions(payload: Partial<KpPayload>, which: number[] | 'all', max = DEFAULT_MAX_POSITIONS_PER_RUN): number[] {
  const items = payload.items ?? [];
  const idx = which === 'all' ? items.filter((l) => l.price === null).map((l) => l.request_index) : which.filter((i) => items.some((l) => l.request_index === i));
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
      ...(constants.maxSearchCalls ? { maxSearchCalls: constants.maxSearchCalls } : {}),
    });
    const price = offerPrice(r.result, { manufacturer: manufacturerCoefficient(r.result.card?.factory, constants.manufacturerCoefficients), general: constants.priceCoefficient });
    const applied = await applyResearchToDraft(core, accountId, draftId, requestIndex, price, r, Boolean(job.replace));
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
    }
    items[i] = next;
    const notes = price.notes;
    const needs = (payload.needs_manager ?? []).filter((n) => !(n.request_index === requestIndex && (n.reason === NO_PRICE || n.reason.startsWith('ограничение расчёта') || n.reason.startsWith('предварительно, по аналогу') || n.reason === 'цены не найдены' || n.reason.startsWith('поиск цены:'))));
    // Без цены пометка «цена не задана» остаётся: менеджеру всё равно её вводить.
    if (next.price === null) needs.push({ request_index: requestIndex, reason: NO_PRICE });
    for (const n of notes) needs.push({ request_index: requestIndex, reason: price.status === 'failed' ? `поиск цены: ${n}` : n });
    const ok = await core.kp.setPayloadIfVersion(draftId, draft.version, { ...payload, items, needs_manager: needs } as unknown as Record<string, unknown>);
    if (ok) return { keptManagerPrice };
  }
  throw new Error(`черновик ${draftId} меняется параллельно — цена позиции ${requestIndex} не записана`);
}
