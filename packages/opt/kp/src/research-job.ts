import type { JournalKind } from '@core/db';
import { BRANDS, completeProfile, componentOfDoor, doorTitleOf, gostDesignation, profileOfRow, lookupPrice, priceModelOf, type ComponentKind, type GostProfile, type KbPrice, type PriceHit } from '@opt/kb';
import type { OptCore } from './deps.ts';
import { lineCategory, NO_PRICE, requestProfile, tidyName, type KpLine, type KpLineWeb, type KpPayload, type KpRequestItem } from './draft.ts';
import { doorComponentKind, matchComponentDoor, type ComponentDoorMatch } from './component-door.ts';
import { VAT_ASSUMED_NOTE, type MarketResearchInput } from './market-research.ts';
import { DEFAULT_CACHE_DAYS, researchWithCache, sizeOfInput, type CachedResearch } from './research-repo.ts';
import { resolveOptRoute } from './settings.ts';
import { planSites, siteWhy, type SitePlan } from './site-rank.ts';
import { hostMatches } from './market-research.ts';

/**
 * Цена позиции черновика как задание воркера. Очередь kp-research (Redis опта, база 1), jobId research-{accountId}-{draftId}-{requestIndex} —
 * повторное нажатие не плодит заданий. KB-WEB-ROWS: цена — только из прайсов базы знаний; веб-поиска нет, строки прайса нет —
 * «уточнить у менеджера». Повтор BullMQ (1 раз через 30 с) — для ошибок сети и БД.
 */

export const KP_RESEARCH_QUEUE = 'kp-research';
export const RESEARCH_JOB = 'research';
export const DEFAULT_MAX_POSITIONS_PER_RUN = 30;
/** Прежние настройки веб-поиска (RFD-AI-AGENT-OPT-KB, раздел 4–5): остаются в настройках аккаунта, с KB-WEB-ROWS не используются. */
export const DEFAULT_MAX_SEARCH_CALLS = 5;
export const DEFAULT_WEB_SEARCH_DAILY_USD = 5;

export interface ResearchJob {
  accountId: number;
  draftId: number;
  requestIndex: number;
  userId: number | null;
  /** Прежний флаг «искать в интернете» (до KB-WEB-ROWS); задание его не читает — цена только из прайса. */
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
  // KB-WEB-ROWS: цена из интернета (по рынку / по аналогу) от прежнего поиска считается ценой не из прайса — такие позиции ищутся заново.
  const idx = which === 'all' ? goods.filter((l) => l.price === null || l.priceSource === 'research' || l.priceSource === 'analog').map((l) => l.request_index) : which.filter((i) => goods.some((l) => l.request_index === i));
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
    const input = researchInputOf(payload, line);
    const size = sizeOfInput(input);
    // KB-COMPONENT-DOOR: коробка / наличник / добор / порог — только из строки прайса своей двери этой заявки; не ясно, какой —
    // вопрос менеджеру; чужие двери не используются.
    const componentKind = doorComponentKind(payload, line);
    if (componentKind) return await priceComponentByDoor(core, job, draft.leadId, payload, line, componentKind, lineLabel);
    // KP-AGENT-V2, п. 4: 1) прайс заказчика по ГОСТ-профилю; 2) нет строки — интернет (сайты по комментариям), цену выбирает
    // менеджер; бренд клиента вне прайса — сначала вопрос «аналог по ГОСТ»; 3) ничего — вопрос «введите цену».
    // KB-PRICE-SHEETS: комплектующее / фурнитура ищутся в контексте ближайшей двери заявки выше (её ID товара в прайсе).
    const category = lineCategory(line);
    if (line.excluded) return { researchId: 0, status: 'none', cached: true, price: null, keptManagerPrice: false, notes: ['позиция исключена менеджером'], fromKb: true };
    // Цена подтверждена в опроснике (интернет / своя) — подбор её не трогает.
    if (line.price !== null && (line.priceSource === 'web_confirmed' || line.priceSource === 'manager') && !job.replace) return { researchId: 0, status: 'ok', cached: true, price: line.price, keptManagerPrice: true, notes: [], fromKb: true };
    const doorProductId = category === 'component' || category === 'hardware' ? await doorContextOf(core, accountId, payload, line) : null;
    // KB-DOOR-MATCH-2, п. 4: такая же строка заявки (то же название двери) уже получила ID товара — эта получает тот же.
    // При замене цен (replace) ID соседних строк мог остаться от прежнего подбора — тогда каждая строка подбирается заново.
    // Ответ опросника «модель» / «аналог» — ID товара, выбранный менеджером.
    const sibling = category === 'door' && !job.replace ? siblingProductOf(payload, line) : null;
    const productId = line.chosenProductId ?? sibling;
    // Поля профиля, уточнённые в опроснике, — дописываются к тексту позиции для подбора по ГОСТ-профилю.
    const fixText = profileFixText(line.profileFix);
    const query = { name: input.item.name || line.name, raw: [input.item.raw, input.item.details ?? '', fixText].filter(Boolean).join(' | '), widthMm: size.widthMm, heightMm: size.heightMm, features: input.item.features ?? null, category, doorProductId, productId };
    let hit = await lookupPrice(core.kb.prices, core.kb.aliases, accountId, query);
    // Комплект фурнитуры (OPT-025 = 2×OPT-029 + 2×OPT-030 + OPT-031): входящие тарифы, названные в заявке отдельно, не удваиваются.
    if (hit && category === 'hardware' && hit.outcome === 'priced' && hit.row.tariffId) {
      const set = await hardwareSetOf(core, accountId, payload, line, hit.row.tariffId, doorProductId);
      if (set) hit = { ...hit, price: null, outcome: 'included', includedIn: set, notes: [...hit.notes, `${hit.row.model} (${hit.row.tariffId}) входит в комплект «${set}» той же позиции — отдельно не считается`] };
    }
    // Тариф «Дополнений» без цены — дальше интернет (п. 4.5), как и позиция без строки прайса.
    const noPriceTariff = hit && (category === 'hardware' || hit.row.category === 'hardware') && hit.outcome === 'not_priced' && !hit.ambiguous;
    if (hit && !noPriceTariff) {
      const applied = await applyKbPriceToDraft(core, accountId, draftId, requestIndex, hit, Boolean(job.replace));
      const priceText = hit.outcome === 'included' ? 'входит в цену блока' : hit.ambiguous ? 'несколько моделей в прайсе — вопрос менеджеру' : hit.outcome === 'not_priced' || hit.price === null ? 'в прайсе цены нет — уточнить у менеджера' : `${hit.price.toLocaleString('ru-RU')} ₽${hit.outcome === 'estimate' ? ' (сметная цена)' : ''}`;
      await core.journal.add({
        accountId,
        leadId: draft.leadId,
        kind: KP_PRICE_RESEARCH_KIND,
        summary: `Цена по позиции «${lineLabel}»: ${priceText} из прайса (${hit.label})${hit.stale ? ' — цена устарела' : ''}${applied.keptManagerPrice ? ' — цена менеджера сохранена' : ''}`,
        details: { draftId, requestIndex, source: 'kb', kbPriceId: hit.row.id, basis: hit.basis, match: hit.match, stale: hit.stale, price: hit.price, outcome: hit.outcome ?? 'priced', doorProductId, notes: hit.notes, webSearchCalls: 0, costUsd: 0, userId: job.userId, keptManagerPrice: applied.keptManagerPrice },
      });
      const price = hit.outcome === 'not_priced' ? null : hit.price;  // null — «уточнить у менеджера», не 0 ₽ (KB-HW-NULL)
      return { researchId: 0, status: 'ok', cached: true, price: applied.keptManagerPrice ? line.price : price, keptManagerPrice: applied.keptManagerPrice, notes: hit.notes, fromKb: true };
    }
    // Тариф «Дополнений» без цены: позиция — фурнитура (категорию даёт строка прайса), дальше — интернет.
    if (noPriceTariff && category !== 'hardware') await patchLine(core, accountId, draftId, requestIndex, (l) => ({ ...l, category: 'hardware' }), null);
    // Ручная цена менеджера остаётся: заменить её нечем.
    const keptManagerPrice = line.priceSource === 'manager' && line.price !== null;
    if (keptManagerPrice) return { researchId: 0, status: 'ok', cached: true, price: line.price, keptManagerPrice: true, notes: [], fromKb: true };
    const text = `${input.item.name || line.name} | ${input.item.raw} | ${input.item.details ?? ''}`;
    const profile = line.gostProfile ?? (category === 'door' ? requestProfile({ name: input.item.name || line.name, raw: input.item.raw, details: input.item.details ?? null }) : null);
    // П. 3.4: бренд клиента вне прайса (Аква, Ставерн, Pleskovdoor) — сначала вопрос «аналог по ГОСТ допустим?» с подходящими
    // строками прайса по профилю (без бренда); «искать бренд в интернете» — по ответу менеджера.
    if (category === 'door' && profile?.brand && !line.askWeb && !line.chosenProductId) {
      const plain = stripBrand(query.name);
      const analog = await lookupPrice(core.kb.prices, core.kb.aliases, accountId, { ...query, name: plain, raw: stripBrand(query.raw ?? ''), productId: null });
      const options = analog ? (analog.ambiguousModels?.length ? analog.ambiguousModels.map((m) => ({ ...m, price: null })) : analog.row.productId ? [{ productId: analog.row.productId, model: analog.row.model, price: analog.price }] : []) : [];
      await patchLine(core, accountId, draftId, requestIndex, (l) => ({ ...l, ...EMPTY_PRICE, priceLabel: `бренд «${profile.brand}» вне прайса — вопрос «аналог»`, analogOptions: options, web: null }), [`уточнить у менеджера: «${profile.brand}» в прайсе нет — аналог по ГОСТ${options.length ? `: ${options.map((o) => o.productId).join(', ')}` : ' не найден'}, или искать в интернете`]);
      await core.journal.add({ accountId, leadId: draft.leadId, kind: KP_PRICE_RESEARCH_KIND, summary: `Цена по позиции «${lineLabel}»: бренд «${profile.brand}» в прайсе нет — вопрос «аналог по ГОСТ»${options.length ? ` (варианты: ${options.map((o) => o.productId).join(', ')})` : ''}`, details: { draftId, requestIndex, source: 'kb', outcome: 'analog_question', brand: profile.brand, options: options.map((o) => o.productId), webSearchCalls: 0, costUsd: 0, userId: job.userId } });
      return { researchId: 0, status: 'none', cached: true, price: null, keptManagerPrice: false, notes: [], fromKb: true };
    }
    return await priceFromWeb(core, job, draft.leadId, payload, line, input, profile, text, lineLabel);
  } catch (err) {
    await core.journal.add({ accountId, leadId: draft.leadId, kind: KP_PRICE_ERROR_KIND, summary: `Поиск цены не выполнен: ${lineLabel} — ${(err as Error).message}`, details: { draftId, requestIndex, userId: job.userId } }).catch(() => undefined);
    throw err;
  }
}

/** Пометки позиции, которые ставит сам поиск цен (их мы заменяем при повторе); остальное — слова менеджера или разбора. */
export const ownNote = (reason: string) => reason === NO_PRICE || reason.startsWith('ограничение расчёта') || reason.startsWith('предварительно, по аналогу') || reason.startsWith('аналог, пересчёт по площади') || reason === VAT_ASSUMED_NOTE || reason === 'цены не найдены' || reason.startsWith('поиск цены:') || reason.startsWith('цена из базы:') || reason.startsWith('цена устарела') || reason.startsWith('цвет уточнить') || reason.startsWith('уточнить у менеджера') || reason.startsWith('вопрос по комплектующему');

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
      // KB-DOOR-MATCH-2, п. 5: «входит в цену блока» и «нет цены» — без цены (не 0 ₽).
      next.price = outcome === 'not_priced' || outcome === 'included' ? null : hit.price;
      next.priceSource = 'price_file';
      next.priceLabel = hit.label;
      next.priceStale = hit.stale;
      // Несколько моделей прайса подошли одинаково — строка прайса не выбрана: ни ID записи, ни ID товара.
      next.kbPriceId = hit.ambiguous ? null : hit.row.id;
      next.priceOutcome = outcome;
      delete next.question;
      next.productId = hit.row.category === 'door' && lineCategory(line) === 'door' && (outcome === 'priced' || outcome === 'estimate') ? hit.row.productId : null;
      next.includedIn = outcome === 'included' ? hit.includedIn ?? null : null;
      // KP-AGENT-V2, п. 5: несколько моделей прайса — варианты вопроса «выбор модели»; нестандарт (правила / площадь) — вопрос
      // «нестандарт»; цена из прайса снимает прежние цены интернета и варианты аналога.
      next.modelOptions = hit.ambiguousModels?.length ? hit.ambiguousModels : null;
      next.nonstandard = lineCategory(line) === 'door' && (outcome === 'priced' || outcome === 'estimate') && (hit.basis === 'rules' || hit.basis === 'area') ? { basis: hit.basis, basePrice: hit.row.price, note: hit.notes.find((n) => /^нестандарт|пересчёт по площади/.test(n)) ?? (hit.basis === 'area' ? 'пересчёт по площади' : 'нестандартный размер по правилам прайса') } : null;
      if (outcome === 'priced' || outcome === 'estimate' || outcome === 'included') {
        next.web = null;
        next.analogOptions = null;
      }
      // Синоним прайса увёл позицию в другую категорию («Фрамуга» — фурнитура): плитка и таблица КП следуют за строкой базы.
      // Строка двери-контекста («входит в блок» / «нет цены» у комплектующего) категорию позиции не меняет; тариф «Дополнений» без цены —
      // меняет (KB-HW-NULL: «СПД40 …» — фурнитура, а не дверь).
      if (hit.row.category !== 'service' && hit.row.category !== 'door' && hit.row.category !== (next.category ?? 'door')) next.category = hit.row.category;
      delete next.coefficient;
      // KP-NAME: модель и покрытие строки прайса — в наименование КП, комплектация — строкой под позицией; у веб-записей и правок — нет.
      const own = hit.row.origin === 'price_list' && (outcome === 'priced' || outcome === 'estimate');
      next.priceModel = own ? priceModelOf(hit.row) : null;
      next.equipment = own ? hit.row.equipment : null;
      next.priceAbbr = own ? hit.row.abbr : null;
      // KP-AGENT-V2, п. 3: профиль двери дополняется строкой прайса, к которой она отнесена; обозначение по ГОСТ — по её шаблону.
      if (lineCategory(next) === 'door') {
        const item = payload.request_items?.[requestIndex];
        const q = line.gostProfile ?? (item ? requestProfile(item) : null);
        const full = q ? completeProfile(q, own && !hit.ambiguous ? profileOfRow(hit.row) : null) : null;
        next.gostProfile = full;
        next.gostDesignation = full && own && !hit.ambiguous ? gostDesignation(hit.row.card?.designation ?? null, full) : null;
      }
      // Примечания под позицией в КП: вкладка «Подбор», фразы нестандарта (эталон, производство, огнестойкость).
      const production = hit.notes.filter((n) => /подлежат уточнению на производстве|огнестойкость исполнения|^нестандарт /.test(n));
      next.quoteNotes = [...(hit.quoteNotes ?? []), ...production];
      if (!next.quoteNotes.length) delete next.quoteNotes;
    }
    items[i] = next;
    const needs = (payload.needs_manager ?? []).filter((n) => !(n.request_index === requestIndex && ownNote(n.reason)));
    if (next.price === null && outcome !== 'not_priced' && outcome !== 'included') needs.push({ request_index: requestIndex, reason: NO_PRICE });
    for (const n of hit.notes) needs.push({ request_index: requestIndex, reason: n.startsWith('цена устарела') || n.startsWith('цвет уточнить') || n.startsWith('уточнить у менеджера') ? n : `цена из базы: ${n}` });
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

/**
 * Строка прайса двери заявки: по уже найденной цене двери (kbPriceId) или подбором по базе здесь же (без записи в черновик).
 * Кэш — по тексту двери: 30 одинаковых строк «ДВ CPL» подбираются один раз.
 */
export async function doorRowsOf(core: OptCore, accountId: number, payload: Partial<KpPayload>): Promise<Map<number, KbPrice | null>> {
  const out = new Map<number, KbPrice | null>();
  const cache = new Map<string, Promise<KbPrice | null>>();
  for (const door of (payload.items ?? []).filter((l) => lineCategory(l) === 'door')) {
    // Дверь без однозначной строки прайса («уточнить у менеджера»: несколько моделей, особое исполнение) — строки прайса нет.
    if (door.priceOutcome === 'not_priced' && !door.kbPriceId) {
      out.set(door.request_index, null);
      continue;
    }
    if (door.kbPriceId) {
      const row = await core.kb.prices.byId(accountId, door.kbPriceId);
      if (row && row.category === 'door') {
        out.set(door.request_index, row);
        continue;
      }
    }
    const input = researchInputOf(payload, door);
    const size = sizeOfInput(input);
    const key = `${input.item.name}|${input.item.raw}|${size.widthMm}|${size.heightMm}`;
    let p = cache.get(key);
    if (!p) {
      p = lookupPrice(core.kb.prices, core.kb.aliases, accountId, { name: input.item.name || door.name, raw: input.item.raw, widthMm: size.widthMm, heightMm: size.heightMm, features: input.item.features ?? null, category: 'door', productId: siblingProductOf(payload, door) }).then((h) => (h && h.row.category === 'door' && h.outcome !== 'not_priced' ? h.row : null));
      cache.set(key, p);
    }
    out.set(door.request_index, await p);
  }
  return out;
}

/** Правка своей строки черновика с проверкой версии (как applyKbPriceToDraft): поля строки и пометки менеджеру по позиции. */
async function patchLine(core: OptCore, accountId: number, draftId: number, requestIndex: number, patch: (l: KpLine) => KpLine, notes: string[] | null): Promise<KpLine> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const draft = await core.kp.byId(accountId, draftId);
    if (!draft) throw new Error(`черновик ${draftId} не найден`);
    const payload = draft.payload as unknown as Partial<KpPayload>;
    const items = [...(payload.items ?? [])];
    const i = items.findIndex((l) => l.request_index === requestIndex);
    if (i < 0) throw new Error(`в черновике ${draftId} нет позиции ${requestIndex}`);
    const next = patch(items[i] as KpLine);
    items[i] = next;
    // notes = null — пометки менеджеру по позиции не трогаются (уже записаны applyKbPriceToDraft).
    const needs = notes === null ? (payload.needs_manager ?? []) : (payload.needs_manager ?? []).filter((n) => !(n.request_index === requestIndex && ownNote(n.reason)));
    for (const n of notes ?? []) needs.push({ request_index: requestIndex, reason: n });
    if (await core.kp.setPayloadIfVersion(draftId, draft.version, { ...payload, items, needs_manager: needs } as unknown as Record<string, unknown>)) return next;
  }
  throw new Error(`черновик ${draftId} меняется параллельно — позиция ${requestIndex} не записана`);
}

/**
 * KB-COMPONENT-DOOR: цена коробки / наличника / добора / порога по двери этой заявки. Дверь — выбор менеджера (componentDoor) или
 * однозначное сопоставление (matchComponentDoor); иначе — вопрос «К какой двери считать …?» со списком дверей, без цены.
 */
export async function priceComponentByDoor(core: OptCore, job: ResearchJob, leadId: number, payload: Partial<KpPayload>, line: KpLine, kind: ComponentKind, lineLabel: string): Promise<ResearchJobResult> {
  const { accountId, draftId, requestIndex } = job;
  const managerPrice = line.priceSource === 'manager' && line.price !== null && !job.replace;
  if (managerPrice) return { researchId: 0, status: 'ok', cached: true, price: line.price, keptManagerPrice: true, notes: [], fromKb: true };
  const doorRows = await doorRowsOf(core, accountId, payload);
  const doorAt = (ri: number | null | undefined) => (ri === null || ri === undefined ? null : ((payload.items ?? []).find((l) => l.request_index === ri && lineCategory(l) === 'door') ?? null));
  // Порядок (KB-COMPONENT-DOOR-GROUP): дверь, выбранная менеджером для этой строки («изменить дверь») → однозначное сопоставление
  // (такие строки в группы не попадают) → ответ менеджера на группу похожих строк → вопрос группы.
  const lineChoice = line.componentDoorBy === 'group' ? null : doorAt(line.componentDoor);
  const auto = lineChoice ? null : matchComponentDoor(payload, line, doorRows);
  const groupKey = auto?.kind === 'question' ? auto.question.group : null;
  const groupDoor = groupKey ? doorAt(payload.componentDoorGroups?.[groupKey]) : null;
  const match: ComponentDoorMatch = lineChoice
    ? { kind: 'door', door: lineChoice, row: doorRows.get(lineChoice.request_index) ?? null, reason: 'выбор менеджера для этой строки' }
    : groupDoor && auto?.kind === 'question'
      ? { kind: 'door', door: groupDoor, row: doorRows.get(groupDoor.request_index) ?? null, reason: `ответ менеджера по группе «${auto.question.groupTitle}»` }
      : (auto as ComponentDoorMatch);
  const viaGroup = Boolean(groupDoor && !lineChoice && match.kind === 'door' && match.door === groupDoor);
  const journal = (summary: string, details: Record<string, unknown>) => core.journal.add({ accountId, leadId, kind: KP_PRICE_RESEARCH_KIND, summary: `Цена по позиции «${lineLabel}»: ${summary}`, details: { draftId, requestIndex, source: 'kb_component_door', componentKind: kind, webSearchCalls: 0, costUsd: 0, userId: job.userId, ...details } });
  if (match.kind === 'no_doors') {
    const note = `уточнить у менеджера: в заявке нет дверей — ${kind} не к чему привязать, цену из прайса другой двери агент не берёт`;
    await patchLine(core, accountId, draftId, requestIndex, (l) => ({ ...l, price: null, priceSource: 'price_file', priceLabel: 'нет двери в заявке', priceOutcome: 'not_priced', question: null, kbPriceId: null, priceModel: null, equipment: null, priceAbbr: null }), [note]);
    await journal('в заявке нет дверей — цена не поставлена, уточнить у менеджера', { outcome: 'not_priced' });
    return { researchId: 0, status: 'ok', cached: true, price: null, keptManagerPrice: false, notes: [note], fromKb: true };
  }
  if (match.kind === 'question') {
    const q = match.question;
    const variants = q.options.map((o) => `${o.productId ? `${o.productId} ` : ''}${o.model}${o.size ? ` ${o.size}` : ''} × ${o.qty.toLocaleString('ru-RU')}`).join('; ');
    const note = `вопрос по комплектующему: группа «${q.groupTitle}» — ${q.reason === 'many' ? 'подходит несколько дверей заявки' : 'ни одна дверь заявки не подходит однозначно'}: ${variants}; ответ — в блоке «Вопросы по комплектующим»`;
    await patchLine(core, accountId, draftId, requestIndex, (l) => ({ ...l, price: null, priceSource: 'price_file', priceLabel: 'вопрос: к какой двери', priceOutcome: 'question', question: q, componentDoorGroup: q.group, componentDoorBy: l.componentDoorBy === 'line' ? 'line' : null, kbPriceId: null, priceModel: null, equipment: null, priceAbbr: null }), [note]);
    await journal(`вопрос менеджеру — ${q.text} (вариантов ${q.options.length})`, { outcome: 'question', options: q.options });
    return { researchId: 0, status: 'ok', cached: true, price: null, keptManagerPrice: false, notes: [note], fromKb: true };
  }
  const door = match.door;
  const row = match.row;
  const doorName = tidyName(door.name);
  if (!row || row.origin !== 'price_list') {
    const note = `уточнить у менеджера: дверь «${doorName}» (поз. ${door.request_index + 1}) не подобрана в прайсе — цены на ${kind} к ней в прайсе нет`;
    await patchLine(core, accountId, draftId, requestIndex, (l) => ({ ...l, price: null, priceSource: 'price_file', priceLabel: `по двери «${doorName}»`, priceOutcome: 'not_priced', question: null, kbPriceId: null, priceModel: null, equipment: null, priceAbbr: null }), [note]);
    await journal(`дверь «${doorName}» не подобрана в прайсе — цена не поставлена`, { outcome: 'not_priced', doorRequestIndex: door.request_index });
    return { researchId: 0, status: 'ok', cached: true, price: null, keptManagerPrice: false, notes: [note], fromKb: true };
  }
  const hit = await componentOfDoor(core.kb.prices, accountId, row, kind);
  const why = `по двери ${doorTitleOf(row)} (поз. ${door.request_index + 1}): ${match.reason}`;
  const withWhy: PriceHit = { ...hit, notes: [why, ...hit.notes] };
  await applyKbPriceToDraft(core, accountId, draftId, requestIndex, withWhy, true);
  // Откуда дверь — для плитки («по группе …» / «для этой строки») и для «Найти цены»: строка группы следует за ответом группы.
  await patchLine(core, accountId, draftId, requestIndex, (l) => ({ ...l, componentDoorBy: lineChoice ? 'line' : viaGroup ? 'group' : null, componentDoorGroup: viaGroup ? groupKey : null, componentDoor: lineChoice ? lineChoice.request_index : viaGroup ? (groupDoor as KpLine).request_index : null }), null);
  const priceText = hit.outcome === 'included' ? 'входит в цену блока' : hit.price === null ? 'в прайсе цены нет — уточнить у менеджера' : `${hit.price.toLocaleString('ru-RU')} ₽`;
  await journal(`${priceText} ${hit.label}, веб-поиск не вызывался`, { outcome: hit.outcome ?? 'priced', kbPriceId: hit.row.id, price: hit.price, doorRequestIndex: door.request_index, doorProductId: row.productId, notes: withWhy.notes });
  return { researchId: 0, status: 'ok', cached: true, price: hit.price, keptManagerPrice: false, notes: withWhy.notes, fromKb: true };
}

/** Нормализованное название двери для сравнения одинаковых строк заявки (без размера, количества и регистра). */
const doorNameKey = (payload: Partial<KpPayload>, l: KpLine) => tidyName(payload.request_items?.[l.request_index]?.name ?? l.name).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

/** KB-DOOR-MATCH-2, п. 4: ID товара, уже выбранный для такой же строки заявки (то же название двери), — чтобы строки не расходились. */
export function siblingProductOf(payload: Partial<KpPayload>, line: KpLine): string | null {
  const key = doorNameKey(payload, line);
  const same = (payload.items ?? []).filter((l) => l.request_index !== line.request_index && lineCategory(l) === 'door' && l.productId && (l.priceOutcome === 'priced' || l.priceOutcome === 'estimate') && doorNameKey(payload, l) === key);
  return same[0]?.productId ?? null;
}

/** Строка без цены: прайсовые поля сброшены (не 0 ₽). */
const EMPTY_PRICE: Partial<KpLine> = { price: null, priceSource: undefined, priceOutcome: 'not_priced', priceStale: false, kbPriceId: null, productId: null, priceModel: null, equipment: null, priceAbbr: null, market: null, includedIn: null, nonstandard: null, modelOptions: null };

/** Поля профиля из опросника — текстом к позиции для подбора («двупольная», «ДПС», «EI60», «ГОСТ 475-2016»). */
function profileFixText(fix: Record<string, string> | null | undefined): string {
  if (!fix) return '';
  const out: string[] = [];
  for (const [k, v] of Object.entries(fix)) {
    const val = String(v ?? '').trim();
    if (!val) continue;
    if (k === 'leaves') out.push(val === '2' ? 'двупольная' : val === '1' ? 'однопольная' : val);
    else if (k === 'fill') out.push(/^г/i.test(val) ? 'глухая' : /^о/i.test(val) ? 'остеклённая' : val);
    else if (k === 'gost') out.push(/гост/i.test(val) ? val : `ГОСТ ${val}`);
    else if (k !== 'qty' && k !== 'size') out.push(val);
  }
  return out.join(' ');
}

/** Название без бренда клиента — для подбора аналога по ГОСТ-профилю. */
function stripBrand(text: string): string {
  let t = text;
  for (const b of BRANDS) t = t.replace(new RegExp(b.rx.source, 'gi'), ' ');
  return t.replace(/\(\s*\)/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Засчитанные источники интернета → цены позиции: min / медиана / max, фабрики, разброс, сайты (п. 4.2). */
export function webOf(r: CachedResearch, plan: SitePlan | null): KpLineWeb | null {
  const accepted = r.result.offers.filter((j) => j.accepted && !(plan?.excluded ?? []).some((x) => hostMatches(j.offer.url, x.host)));
  if (!accepted.length) return null;
  const prices = accepted.map((j) => j.unitPrice ?? j.offer.price).filter((p) => p > 0).sort((a, b) => a - b);
  if (!prices.length) return null;
  const mid = Math.floor(prices.length / 2);
  const median = prices.length % 2 ? (prices[mid] as number) : Math.round((((prices[mid - 1] as number) + (prices[mid] as number)) / 2) * 100) / 100;
  const min = prices[0] as number;
  const max = prices[prices.length - 1] as number;
  const factory = accepted.filter((j) => j.manufacturer).length;
  const order = (url: string) => {
    const i = plan?.prefer.findIndex((x) => hostMatches(url, x.host)) ?? -1;
    return i < 0 ? 1000 : i;
  };
  const sources = [...accepted]
    .sort((a, b) => Number(b.manufacturer) - Number(a.manufacturer) || order(a.offer.url) - order(b.offer.url))
    .slice(0, 12)
    .map((j) => ({ url: j.offer.url, seller: j.offer.seller, price: j.offer.price, unitPrice: j.unitPrice, foundAt: j.offer.foundAt, manufacturer: j.manufacturer, site: siteWhy(j.offer.url, plan) }));
  return { query: r.result.query, researchedAt: r.createdAt.toISOString(), researchId: r.researchId, min, median, max, count: prices.length, factorySources: factory, spreadPct: median ? Math.round(((max - min) / median) * 100) : 0, enough: prices.length >= 3 || factory >= 1, sources, excludedSites: (plan?.excluded ?? []).map((x) => x.host) };
}

/**
 * П. 4.2: строки прайса нет — интернет. Сайты по комментариям из «Базы знаний» (фабрики → подходящие → без комментария →
 * любые; «… нет» — не используется); источник засчитывается при совпадении модели и размера (market-research). В КП цена
 * автоматически не ставится — вопрос «цена из интернета» в опроснике; нет ни одного источника — вопрос «введите цену».
 */
async function priceFromWeb(core: OptCore, job: ResearchJob, leadId: number, payload: Partial<KpPayload>, line: KpLine, input: MarketResearchInput, profile: GostProfile | null, text: string, lineLabel: string): Promise<ResearchJobResult> {
  const { accountId, draftId, requestIndex } = job;
  const noPrice = async (why: string, details: Record<string, unknown> = {}): Promise<ResearchJobResult> => {
    const note = `уточнить у менеджера: «${tidyName(input.item.name || line.name)}» — ${why}; введите цену`;
    await patchLine(core, accountId, draftId, requestIndex, (l) => ({ ...l, ...EMPTY_PRICE, priceLabel: 'нет в прайсе и в интернете', web: null }), [note]);
    await core.journal.add({ accountId, leadId, kind: KP_PRICE_RESEARCH_KIND, summary: `Цена по позиции «${lineLabel}»: ${why} — вопрос «введите цену»`, details: { draftId, requestIndex, source: 'web', outcome: 'not_priced', userId: job.userId, ...details } });
    return { researchId: 0, status: 'none', cached: true, price: null, keptManagerPrice: false, notes: [note] };
  };
  const ai = await core.ai(accountId);
  if (!ai) return noPrice('в прайсе нет, интернет не проверялся: модель не настроена');
  const { settings } = await core.settings.get(accountId);
  const route = resolveOptRoute(settings);
  const { constants } = await core.kp.getSettings(accountId);
  const dailyLimit = constants.webSearchDailyUsd ?? DEFAULT_WEB_SEARCH_DAILY_USD;
  const spent = await core.research.spentTodayUsd(accountId);
  if (spent >= dailyLimit) return noPrice(`в прайсе нет; дневной лимит веб-поиска $${dailyLimit} исчерпан`, { limitUsd: dailyLimit, spentUsd: spent });
  const sites = await core.kb.repo.sites(accountId).catch(() => []);
  const plan = planSites(sites, profile, text);
  const factoryHosts = plan.prefer.filter((x) => x.factory).map((x) => x.host);
  const r = await researchWithCache(core.research, ai.llm, route, input, {
    accountId,
    draftId,
    requestIndex,
    force: job.force,
    cacheDays: constants.researchCacheDays ?? DEFAULT_CACHE_DAYS,
    manufacturerDomains: [...(constants.manufacturerDomains ?? []), ...factoryHosts],
    pricing: settings.billing.pricing,
    ...(constants.searchContext ? { searchContext: constants.searchContext } : {}),
    maxSearchCalls: constants.maxSearchCalls ?? DEFAULT_MAX_SEARCH_CALLS,
    sites: { prefer: plan.prefer.map((x) => ({ host: x.host, why: x.why })), exclude: plan.excluded.map((x) => x.host) },
  });
  const costRub = r.result.cost.usd * settings.billing.usdRubRate;
  const web = r.result.status === 'failed' ? null : webOf(r, plan);
  const cost = { inputTokens: r.result.cost.inputTokens, outputTokens: r.result.cost.outputTokens, costUsd: r.result.cost.usd, costRub };
  if (!web) {
    const why = r.result.status === 'failed' ? `в прайсе нет; поиск в интернете не выполнен: ${r.result.error}` : 'нет ни в прайсе, ни в интернете';
    const res = await noPrice(why, { researchId: r.researchId, webSearchCalls: r.result.webSearchCalls, costUsd: r.result.cost.usd });
    await core.journal.add({ accountId, leadId, kind: r.result.status === 'failed' ? KP_PRICE_ERROR_KIND : KP_PRICE_RESEARCH_KIND, summary: `Поиск в интернете: ${lineLabel} — ${r.result.status === 'failed' ? r.result.error : 'подходящих предложений нет'}`, details: { draftId, requestIndex, researchId: r.researchId, query: r.result.query, sites: plan.prefer.map((x) => x.host), excluded: plan.excluded.map((x) => x.host), webSearchCalls: r.result.webSearchCalls, userId: job.userId }, ...cost });
    return { ...res, researchId: r.researchId, cached: r.cached };
  }
  const warn = [!web.enough ? `источников ${web.count}, фабрики нет` : '', web.spreadPct > 30 ? `разброс ${web.spreadPct} %` : ''].filter(Boolean).join('; ');
  const note = `цены из интернета: ${web.min.toLocaleString('ru-RU')} – ${web.max.toLocaleString('ru-RU')} ₽, медиана ${web.median.toLocaleString('ru-RU')} ₽ (${web.count} источн.${web.factorySources ? `, с фабрики ${web.factorySources}` : ''})${warn ? ` — ${warn}` : ''}; итоговую цену выберите в опроснике`;
  await patchLine(core, accountId, draftId, requestIndex, (l) => ({ ...l, ...EMPTY_PRICE, priceLabel: 'цены из интернета — выбор менеджера', web, analogOptions: l.analogOptions ?? null }), [`уточнить у менеджера: ${note}`]);
  await core.journal.add({ accountId, leadId, kind: KP_PRICE_RESEARCH_KIND, summary: `Цены из интернета по позиции «${lineLabel}»: ${note}`, details: { draftId, requestIndex, source: 'web', researchId: r.researchId, cached: r.cached, query: r.result.query, min: web.min, median: web.median, max: web.max, count: web.count, factory: web.factorySources, spreadPct: web.spreadPct, sites: plan.prefer.map((x) => ({ host: x.host, why: x.why })), excluded: plan.excluded.map((x) => x.host), webSearchCalls: r.result.webSearchCalls, userId: job.userId }, ...cost });
  return { researchId: r.researchId, status: 'ok', cached: r.cached, price: null, keptManagerPrice: false, notes: [note] };
}

