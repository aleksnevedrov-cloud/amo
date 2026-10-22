/* eslint-disable no-console -- консольная утилита: вывод для заказчика */
import { loadEnv } from '@core/shared';
import { createOptCore, previewCallsBackfill, runCallsPoll } from '@opt/kp';

/**
 * Догрузка старых записей разговоров (RFD-AI-AGENT-OPT-CALLS, этапы 2–3, п. 5): примечания-звонки за N дней назад,
 * скачивание записей, расшифровка в отложенном режиме SpeechKit. Без --yes только печатает, сколько звонков найдено,
 * их длительность и ориентировочную стоимость, и ничего не запускает. Расшифровку и разбор делает плановый опрос
 * воркера (calls-poll, раз в 10 минут) — общая очередь и общий предел «не больше 2 звонков одновременно».
 *
 *   docker compose exec opt-worker node apps/opt-worker/dist/calls-backfill.js --days 30            # оценка
 *   docker compose exec opt-worker node apps/opt-worker/dist/calls-backfill.js --days 30 --yes      # запуск
 *   … --account <id>   — только один аккаунт (по умолчанию все, где разбор звонков включён)
 */
const args = parseArgs(process.argv.slice(2));
const days = Number(args.days);
if (!Number.isInteger(days) || days <= 0 || days > 366) fail('укажите --days <1…366>');
const onlyAccount = args.account ? Number(args.account) : null;
if (onlyAccount !== null && (!Number.isInteger(onlyAccount) || onlyAccount <= 0)) fail('--account должен быть числом');
const yes = args.yes === true;

const env = loadEnv();
const core = createOptCore(env);
try {
  const accounts = (await core.calls.installedAccountIds()).filter((id) => onlyAccount === null || id === onlyAccount);
  if (!accounts.length) fail(onlyAccount ? `аккаунт ${onlyAccount} не подключён к «Агенту опт»` : 'подключённых аккаунтов нет');
  let any = false;
  for (const accountId of accounts) {
    const { settings } = await core.settings.get(accountId);
    if (!settings.calls?.enabled) {
      console.log(`Аккаунт ${accountId}: разбор звонков выключен в настройках — пропуск`);
      continue;
    }
    const p = await previewCallsBackfill(core, accountId, days);
    console.log(`Аккаунт ${accountId}, последние ${days} дн.: примечаний-звонков ${p.found}, из них новых с записью и не короче ${settings.calls.minDurationSec} с — ${p.newCalls} (${p.newMinutes} мин); коротких / без записи / уже в базе — ${p.found - p.newCalls}`);
    console.log(`  Оценка: расшифровка (SpeechKit, отложенный режим, ${env.YANDEX_SPEECHKIT_API_KEY ? 'ключ есть' : 'ключа нет — пойдёт OpenAI'}) ≈ ${p.estimate.sttRub} ₽; разбор моделью ${p.estimate.model} ≈ $${p.estimate.llmUsd} (${p.estimate.llmRub} ₽); итого ≈ ${p.estimate.totalRub} ₽`);
    if (!p.newCalls) continue;
    any = true;
    if (!yes) continue;
    const r = await runCallsPoll(core, accountId, { sinceDays: days, sttMode: 'deferred', maxDownloads: 1000, process: false });
    console.log(`  Запущено: новых в базе ${r.inserted}, скачано ${r.downloaded}, недоступно ${r.unavailable}, ошибок скачивания ${r.failed}${r.errors.length ? `, сбой сбора: ${r.errors.join('; ')}` : ''}`);
    console.log('  Расшифровка (отложенный режим, до суток) и разбор пойдут в плановом опросе воркера; ход — в журнале виджета («Звонки: …»).');
  }
  if (any && !yes) console.log('\nНичего не запущено. Для запуска добавьте --yes.');
} finally {
  await core.close();
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
