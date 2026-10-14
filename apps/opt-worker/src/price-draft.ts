/* eslint-disable no-console -- консольная утилита: вывод для заказчика */
import { loadEnv } from '@core/shared';
import { createOptCore, researchablePositions, runResearchJob, type KpPayload } from '@opt/kp';

/**
 * Поиск цен по позициям последнего черновика сделки из консоли (RFD-AI-AGENT-OPT-PRICE, этап 5) — тот же
 * runResearchJob, что в очереди kp-research, но без очереди: для приёмки до выхода кнопки «Найти цены» в виджете.
 * Результат пишется в черновик (цена, market, пометки) и в журнал, как при нажатии кнопки.
 *
 *   node apps/opt-worker/dist/price-draft.js --account 28528549 --lead 30013995            # все позиции без цены
 *   node apps/opt-worker/dist/price-draft.js --account 28528549 --lead 30013995 --index 0 [--force] [--replace]
 */
const args = parseArgs(process.argv.slice(2));
const accountId = Number(args.account);
const leadId = Number(args.lead);
if (!Number.isInteger(accountId) || accountId <= 0) fail('укажите --account <id аккаунта amoCRM>');
if (!Number.isInteger(leadId) || leadId <= 0) fail('укажите --lead <id сделки>');

const env = loadEnv();
const core = createOptCore(env);
try {
  const draft = await core.kp.latestByLead(accountId, leadId);
  if (!draft) fail(`у сделки ${leadId} нет черновика КП — сначала «Собрать КП»`);
  if (draft.status !== 'draft') fail(`черновик ${draft.id} в статусе ${draft.status}: КП уже собрано, создайте новый черновик`);
  const payload = draft.payload as unknown as Partial<KpPayload>;
  const { constants } = await core.kp.getSettings(accountId);
  const which = args.index !== undefined ? [Number(args.index)] : 'all';
  const positions = researchablePositions(payload, which, constants.maxPositionsPerRun ?? 30);
  console.log(`Черновик ${draft.id} (версия ${draft.version}), позиций ${payload.items?.length ?? 0}, к поиску: ${positions.length ? positions.join(', ') : 'нет (у всех есть цена — укажите --index)'}`);
  for (const requestIndex of positions) {
    const line = payload.items?.find((l) => l.request_index === requestIndex);
    const started = Date.now();
    console.log(`\n— Позиция ${requestIndex}: ${line?.name}${line?.size ? `, ${line.size}` : ''} —`);
    try {
      const r = await runResearchJob(core, { accountId, draftId: draft.id, requestIndex, userId: null, force: args.force === 'true', replace: args.replace === 'true' || which !== 'all' });
      console.log(`${r.status}${r.cached ? ' (из кэша)' : ''}; цена ${r.price === null ? 'не поставлена' : `${r.price.toLocaleString('ru-RU')} ₽`}${r.keptManagerPrice ? ' (цена менеджера сохранена)' : ''}; пометки: ${r.notes.join('; ') || '—'}; запись kp_price_research #${r.researchId}; ${Math.round((Date.now() - started) / 1000)} с`);
    } catch (err) {
      console.log(`ошибка: ${(err as Error).message}`);
    }
  }
  const fresh = await core.kp.byId(accountId, draft.id);
  const items = (fresh?.payload as unknown as Partial<KpPayload> | undefined)?.items ?? [];
  console.log('\n— Черновик после поиска —');
  console.table(items.map((l) => ({ позиция: l.request_index, название: l.name.slice(0, 50), размер: l.size, 'цена, ₽': l.price ?? '', источник: l.priceSource ?? '', медиана: l.market?.median ?? '', источников: l.market?.count ?? '', коэффициент: l.coefficient ?? '' })));
  const notes = ((fresh?.payload as unknown as Partial<KpPayload> | undefined)?.needs_manager ?? []).filter((n) => n.request_index >= 0);
  if (notes.length) console.log(`Пометки: ${notes.map((n) => `[${n.request_index}] ${n.reason}`).join('; ')}`);
} finally {
  await core.close();
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
  console.error(`price-draft: ${msg}`);
  process.exit(2);
}
