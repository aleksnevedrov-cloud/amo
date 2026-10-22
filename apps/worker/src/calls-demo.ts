/* eslint-disable no-console -- консольная утилита: вывод для заказчика */
import { loadEnv } from '@core/shared';
import { runCallsDemo } from '@core/calls';
import { buildCallsDeps } from './calls-deps.ts';

/**
 * Итог дня по одной сделке (RFD-AI-AGENT-CALLS-DEMO, DAY-FULL): звонки сделки и её контактов за день, расшифровка
 * (асинхронный SpeechKit, ожидание до 5 минут), лента дня из всех источников и итог тем же кодом, что calls-day-summary.
 * Без --post ничего не пишет в amoCRM и таблицы итогов — печатает хронологию (первые 30 записей), итог и стоимость.
 *
 *   docker compose exec worker node apps/worker/dist/calls-demo.js --lead <id сделки> [--date ГГГГ-ММ-ДД] [--post] [--account <id>]
 */
const args = parseArgs(process.argv.slice(2));
const leadId = Number(args.lead);
if (!Number.isInteger(leadId) || leadId <= 0) fail('укажите --lead <id сделки>');
const date = typeof args.date === 'string' ? args.date : undefined;
if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('--date в формате ГГГГ-ММ-ДД');

const env = loadEnv();
const { deps, close } = buildCallsDeps(env);
try {
  const accounts = args.account ? [Number(args.account)] : await deps.accountIds();
  const accountId = accounts[0];
  if (!accountId) fail('подключённых аккаунтов нет');
  if (accounts.length > 1) console.log(`Аккаунтов несколько, берём ${accountId}; другой — --account <id>`);
  const r = await runCallsDemo(deps, { accountId, leadId, date, post: args.post === true, out: (line) => console.log(line) });
  console.log(`\nИтого: день ${r.day || '—'}, звонков ${r.calls}, расшифровано ${r.transcribed}, не готово ${r.notReady}, записей ленты ${r.items} (новых ${r.newItems})${r.posted ? `, опубликовано: итог ${r.posted.summaryId}${r.posted.noteId ? `, примечание ${r.posted.noteId}` : ''}` : ''}`);
} finally {
  await close();
}

function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[a.slice(2)] = next;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}

function fail(msg: string): never {
  console.error(`Ошибка: ${msg}`);
  process.exit(1);
}
