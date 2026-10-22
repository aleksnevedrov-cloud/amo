/* eslint-disable no-console -- консольная утилита: вывод для заказчика */
import { loadEnv } from '@core/shared';
import type { CallTranscript } from '@core/calls';
import { buildCallsDeps } from './calls-deps.ts';

/**
 * Проверка меток говорящих на реальной записи (RFD-AI-AGENT-CALLS-RETAIL, п. 8): по последнему расшифрованному звонку
 * печатает первые 10 реплик с метками и ролями и начало сырого ответа SpeechKit (transcript.rawSample). Если у всех реплик
 * «говорящий —», поле метки в ответе другое — видно по сырому ответу, правка в parseSpeechKitLines.
 *
 *   docker compose exec worker node apps/worker/dist/calls-inspect.js [--account <id>] [--id <id звонка>]
 */
const args = parseArgs(process.argv.slice(2));
const env = loadEnv();
const { deps, close } = buildCallsDeps(env);
try {
  const accounts = args.account ? [Number(args.account)] : await deps.accountIds();
  let shown = false;
  for (const accountId of accounts) {
    const row = args.id ? await deps.calls.get(accountId, Number(args.id)) : await deps.calls.lastTranscribed(accountId);
    if (!row || !row.transcript || 'pending' in row.transcript) continue;
    shown = true;
    const t = row.transcript as CallTranscript;
    console.log(`Аккаунт ${accountId}, звонок ${row.id}: ${row.direction === 'in' ? 'входящий' : 'исходящий'} ${row.phone}, ${row.calledAt.toISOString()}, ${row.durationSec} с, статус ${row.status}${row.leadId ? `, сделка ${row.leadId}` : ''}`);
    console.log(`Расшифровка: ${t.provider} / ${t.mode} / ${t.model}; реплик ${t.segments.length}, говорящих ${t.speakers}, длительность по расшифровке ${t.durationSec ?? '—'} с`);
    for (const s of t.segments.slice(0, 10)) {
      const time = s.startMs === null ? '—:——' : `${Math.floor(s.startMs / 60000)}:${String(Math.floor((s.startMs / 1000) % 60)).padStart(2, '0')}`;
      console.log(`  [${time}] говорящий ${s.speaker ?? '—'}${s.role ? ` (${s.role === 'manager' ? 'менеджер' : s.role === 'client' ? 'клиент' : '?'})` : ''}: ${s.text.slice(0, 160)}`);
    }
    console.log(`Сырой ответ (начало):\n${(t.rawSample ?? '(не сохранён)').slice(0, 1500)}`);
    if (!t.segments.some((s) => s.speaker)) console.log('\nВНИМАНИЕ: меток говорящих нет — проверьте поле в сыром ответе (speakerTag / channelTag) и парсер parseSpeechKitLines.');
    if (!args.account) break;
  }
  if (!shown) console.log('Расшифрованных звонков пока нет.');
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
