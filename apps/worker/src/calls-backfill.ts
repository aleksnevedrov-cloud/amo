/* eslint-disable no-console -- консольная утилита: вывод для заказчика */
import { loadEnv } from '@core/shared';
import { previewCallsBackfill, runCallsPoll } from '@core/calls';
import { buildCallsDeps } from './calls-deps.ts';

/**
 * Догрузка старых записей разговоров (RFD-AI-AGENT-CALLS-RETAIL, п. 5): примечания-звонки за N дней назад, скачивание,
 * расшифровка в отложенном режиме SpeechKit. Без --yes печатает число звонков, минуты, будущие примечания и оценку
 * стоимости — и ничего не запускает. Расшифровку и итоги по дням делают плановые задания воркера (calls-poll,
 * calls-day-summary) — общая очередь и общий предел «не больше 2 звонков одновременно».
 *
 *   docker compose exec worker node apps/worker/dist/calls-backfill.js --days 30            # оценка
 *   docker compose exec worker node apps/worker/dist/calls-backfill.js --days 30 --yes      # запуск
 *   … --account <id>   — только один аккаунт (по умолчанию все, где звонки включены)
 */
const args = parseArgs(process.argv.slice(2));
const days = Number(args.days);
if (!Number.isInteger(days) || days <= 0 || days > 366) fail('укажите --days <1…366>');
const onlyAccount = args.account ? Number(args.account) : null;
if (onlyAccount !== null && (!Number.isInteger(onlyAccount) || onlyAccount <= 0)) fail('--account должен быть числом');
const yes = args.yes === true;

const env = loadEnv();
const { deps, settings, close } = buildCallsDeps(env);
try {
  const accounts = (await deps.accountIds()).filter((id) => onlyAccount === null || id === onlyAccount);
  if (!accounts.length) fail(onlyAccount ? `аккаунт ${onlyAccount} не подключён` : 'подключённых аккаунтов нет');
  let any = false;
  for (const accountId of accounts) {
    const { settings: s } = await settings.get(accountId);
    if (!s.calls.callsEnabled) {
      console.log(`Аккаунт ${accountId}: звонки выключены в настройках — пропуск`);
      continue;
    }
    const p = await previewCallsBackfill(deps, accountId, days);
    console.log(`Аккаунт ${accountId}, последние ${days} дн.: примечаний-звонков ${p.found}, из них новых с записью и не короче ${s.calls.minDurationSec} с — ${p.newCalls} (${p.newMinutes} мин); коротких / без записи / уже в базе — ${p.found - p.newCalls}`);
    console.log(`  Будущих примечаний «Итог разговоров за день» (сделка или контакт × день): ${p.futureNotes}`);
    console.log(`  Оценка: расшифровка (SpeechKit, отложенный режим, ${deps.keys.speechkit ? 'ключ есть' : 'ключа нет — пойдёт OpenAI'}) ≈ ${p.estimate.sttRub} ₽; итоги моделью ${p.estimate.model} ≈ $${p.estimate.llmUsd} (${p.estimate.llmRub} ₽); итого ≈ ${p.estimate.totalRub} ₽`);
    if (!p.newCalls) continue;
    any = true;
    if (!yes) continue;
    const r = await runCallsPoll(deps, accountId, { sinceDays: days, sttMode: 'deferred', maxDownloads: 1000, transcribe: false });
    console.log(`  Запущено: новых в базе ${r.inserted}, скачано ${r.downloaded}, недоступно ${r.unavailable}, ошибок скачивания ${r.failed}${r.errors.length ? `, сбой сбора: ${r.errors.join('; ')}` : ''}`);
    console.log('  Расшифровка (отложенный режим, до суток) — в плановом опросе; итоги по дням — в ближайшем запуске итога дня. Ход — в журнале («Звонки: …», «Итог разговоров за …»).');
  }
  if (any && !yes) console.log('\nНичего не запущено. Для запуска добавьте --yes.');
} finally {
  await close();
}

function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}

function fail(msg: string): never {
  console.error(`Ошибка: ${msg}`);
  process.exit(1);
}
