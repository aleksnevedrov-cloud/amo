/* eslint-disable no-console -- консольная утилита: вывод для заказчика */
import { loadEnv } from '@core/shared';
import { createOptCore, parseSizeMm, priceToleranceOf, researchMarketPrice, resolveOptRoute, type KpLine, type KpRequestItem, type MarketResearchInput } from '@opt/kp';

/**
 * Консольный прогон поиска рыночной цены по одной позиции (RFD-AI-AGENT-OPT-PRICE, этап 2):
 * показать заказчику карточку, запрос, принятые и отклонённые предложения и статистику до того,
 * как поиск подключится к черновику. В базу ничего не пишет, ключ модели — из настроек аккаунта.
 *
 *   node apps/opt-worker/dist/research-one.js --account 28528549 --lead 123 [--index 0]
 *   node apps/opt-worker/dist/research-one.js --account 28528549 --text "Дверь Профиль Дорс 2.47U белый 2000×800" [--price 12000]
 * Удешевление (RFD-AI-AGENT-OPT-PRICE-2-FIX, п. 6): --context low|medium|high — объём текста источников в контексте
 * модели (search_context_size), --max-calls N — не больше N вызовов веб-поиска; --positions N — позиций в заявке
 * для оценки стоимости (по черновику — его число строк).
 */
const args = parseArgs(process.argv.slice(2));
const accountId = Number(args.account);
if (!Number.isInteger(accountId) || accountId <= 0) fail('укажите --account <id аккаунта amoCRM>');
if (!args.lead && !args.text) fail('укажите --lead <id сделки> (позиция черновика) или --text "<строка позиции>"');

const env = loadEnv();
const core = createOptCore(env);
/** Число строк черновика — для оценки стоимости заявки; по --text неизвестно. */
let positionsInDraft: number | null = null;
try {
  const ai = await core.ai(accountId);
  if (!ai) fail('LLM не настроена: задайте ключ провайдера в настройках «Модель»');
  const { settings } = await core.settings.get(accountId);
  const route = resolveOptRoute(settings);
  const kpSettings = await core.kp.getSettings(accountId);
  const input = args.lead ? await inputFromDraft(accountId, Number(args.lead), Number(args.index ?? 0)) : inputFromText(String(args.text), args.price ? Number(args.price) : null);

  console.log(`Модель: ${route.primary.provider}:${route.primary.model}${route.fallback ? ` (резерв ${route.fallback.provider}:${route.fallback.model})` : ''}`);
  console.log(`Позиция: ${input.item.name}${input.line.size ? `, ${input.line.size}` : ''}, ${input.line.qty} шт${input.managerPrice ? `, цена менеджера ${input.managerPrice} ₽` : ''}`);
  if (input.requirements.length) console.log(`Требования: ${input.requirements.join('; ')}`);

  const searchContext = args.context === 'low' || args.context === 'medium' || args.context === 'high' ? args.context : undefined;
  const maxSearchCalls = args['max-calls'] ? Number(args['max-calls']) : undefined;
  if (searchContext || maxSearchCalls) console.log(`Параметры поиска: контекст источников ${searchContext ?? 'по умолчанию'}, вызовов не больше ${maxSearchCalls ?? 'без лимита'}`);
  const started = Date.now();
  const r = await researchMarketPrice(ai.llm, route, input, {
    analogPriceTolerance: priceToleranceOf({ priceTolerance: kpSettings.constants.analogPriceTolerancePct === undefined ? undefined : kpSettings.constants.analogPriceTolerancePct / 100 }),
    manufacturerDomains: kpSettings.constants.manufacturerDomains,
    pricing: settings.billing.pricing,
    ...(searchContext ? { searchContext } : {}),
    ...(maxSearchCalls && maxSearchCalls > 0 ? { maxSearchCalls } : {}),
  });

  console.log('\n— Карточка позиции —');
  console.log(JSON.stringify(r.card, null, 2));
  console.log(`\n— Поисковый запрос —\n${r.query}`);
  console.log(`\n— Итог: ${r.status}${r.error ? ` — ${r.error}` : ''} —`);
  console.log(`Вызовов веб-поиска: ${r.webSearchCalls}; источников: ${r.sources.length}; предложений: ${r.offers.length}; ${Math.round((Date.now() - started) / 1000)} с; ${r.cost.inputTokens}/${r.cost.outputTokens} токенов, $${r.cost.usd.toFixed(4)}`);
  // Стоимость заявки: цена позиции × число позиций; курс — из настроек «Биллинг».
  const positions = Math.max(1, Number(args.positions ?? positionsInDraft ?? 10));
  const rate = settings.billing.usdRubRate;
  const perRequest = r.cost.usd * positions;
  console.log(`Стоимость: позиция $${r.cost.usd.toFixed(3)} (${(r.cost.usd * rate).toFixed(0)} ₽), заявка из ${positions} позиций ≈ $${perRequest.toFixed(2)} (${(perRequest * rate).toFixed(0)} ₽); из них веб-поиск $${(r.webSearchCalls * 0.01).toFixed(2)}, токены $${(r.cost.usd - r.webSearchCalls * 0.01).toFixed(3)}`);
  if (!searchContext && !maxSearchCalls) console.log('Дешевле: повторить с --context low --max-calls 3 (меньше текста источников в контексте и не больше трёх вызовов поиска) и сравнить статистику');
  if (r.offers.length) {
    console.log('\n— Предложения (принятые первыми, сайты производителей выше) —');
    console.table(
      r.offers.map((j) => ({
        принято: j.accepted ? 'да' : 'нет',
        причина: j.reason ?? '',
        'цена за шт, ₽': j.unitPrice ?? '',
        'как на сайте': `${j.offer.price} ${j.offer.currency}/${j.offer.unit}`,
        НДС: j.offer.vatStated + (j.offer.vatRateStated ? ` ${j.offer.vatRateStated}%` : ''),
        производитель: j.manufacturer ? 'да' : '',
        продавец: j.offer.seller,
        модель: [j.offer.factory, j.offer.model].filter(Boolean).join(' '),
        размер: j.offer.heightMm && j.offer.widthMm ? `${j.offer.widthMm}×${j.offer.heightMm}` : '',
        пометки: j.notes.join('; '),
        формула: j.formula ?? '',
        url: j.offer.url,
        найдено: j.offer.foundAt,
      })),
    );
  }
  if (r.stats) console.log(`\n— Статистика по принятым: мин ${r.stats.min} ₽, медиана ${r.stats.median} ₽, макс ${r.stats.max} ₽, предложений ${r.stats.count} (за штуку) —`);
  else console.log('\n— Статистики нет: принятых предложений нет, цена не ставится —');
  if (r.analog) console.log(`\n— Аналог —\n${r.analog.suggestion.reason}\nцена за шт: ${r.analog.unitPrice ?? '—'} ₽; ${r.analog.url}; найдено ${r.analog.foundAt}`);
  if (r.sources.length) console.log(`\n— Источники поиска —\n${r.sources.map((s) => `${s.url}${s.title ? ` — ${s.title}` : ''}`).join('\n')}`);
} finally {
  await core.close();
}

/** Позиция из последнего черновика сделки: строка items[index] и её request_item. */
async function inputFromDraft(acc: number, leadId: number, index: number): Promise<MarketResearchInput> {
  if (!Number.isInteger(leadId) || leadId <= 0) fail('--lead должен быть числом');
  const draft = await core.kp.latestByLead(acc, leadId);
  if (!draft) fail(`у сделки ${leadId} нет черновика КП — сначала нажмите «Собрать черновик»`);
  const payload = draft.payload as { items?: KpLine[]; request_items?: KpRequestItem[]; requirements?: string[] };
  const line = payload.items?.[index];
  if (!line) fail(`в черновике ${draft.id} нет строки с индексом ${index} (строк: ${payload.items?.length ?? 0})`);
  const item = payload.request_items?.[line.request_index] ?? { raw: line.name, name: line.name, width_mm: null, height_mm: null, qty: line.qty };
  positionsInDraft = payload.items?.length ?? null;
  console.log(`Черновик ${draft.id} от ${draft.createdAt.toISOString()}, строка ${index} из ${positionsInDraft ?? '?'}`);
  return { line, item, requirements: payload.requirements ?? [], managerPrice: line.price };
}

/** Позиция из строки аргумента: размер («1400x2700», «1,4х2,7 м», «2000×800») вынимается кодом, меньшее — ширина. */
function inputFromText(text: string, managerPrice: number | null): MarketResearchInput {
  const size = parseSizeMm(text);
  return {
    line: { name: text, size: size ? `${size.widthMm}×${size.heightMm} мм` : '', qty: 1, price: managerPrice },
    item: { raw: text, name: text, width_mm: size?.widthMm ?? null, height_mm: size?.heightMm ?? null },
    requirements: [],
    managerPrice,
  };
}

function parseArgs(argv: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[a.slice(2)] = next;
        i += 1;
      } else out[a.slice(2)] = 'true';
    }
  }
  return out;
}

function fail(msg: string): never {
  console.error(`research-one: ${msg}`);
  process.exit(2);
}
