/* eslint-disable no-console -- консольная утилита: вывод для заказчика */
import { loadEnv } from '@core/shared';
import { addDays, amoRaw, mskDayStart, type CallTranscript } from '@core/calls';
import { buildCallsDeps } from './calls-deps.ts';

/**
 * Проверка меток говорящих на реальной записи (RFD-AI-AGENT-CALLS-RETAIL, п. 8): по последнему расшифрованному звонку
 * печатает первые 10 реплик с метками и ролями и начало сырого ответа SpeechKit (transcript.rawSample). Если у всех реплик
 * «говорящий —», поле метки в ответе другое — видно по сырому ответу, правка в parseSpeechKitLines.
 *
 *   docker compose exec worker node apps/worker/dist/calls-inspect.js [--account <id>] [--id <id звонка>]
 *
 * RFD-AI-AGENT-CALLS-DAY-FIX2, п. 3: список итогов дня, опубликованных за календарный день (МСК), с названиями сделок из amo —
 * сделка, примечание, время публикации, первая строка. Ничего не меняет.
 *
 *   docker compose exec worker node apps/worker/dist/calls-inspect.js --day-summaries ГГГГ-ММ-ДД [--until ЧЧ:ММ] [--account <id>]
 */
const args = parseArgs(process.argv.slice(2));
const env = loadEnv();
const { deps, close } = buildCallsDeps(env);
try {
  const accounts = args.account ? [Number(args.account)] : await deps.accountIds();
  if (typeof args['day-summaries'] === 'string') {
    await listDaySummaries(accounts, args['day-summaries'], typeof args.until === 'string' ? args.until : null);
    await close();
    process.exit(0);
  }
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

async function listDaySummaries(accounts: number[], day: string, until: string | null): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('--day-summaries в формате ГГГГ-ММ-ДД');
  if (until && !/^([01]\d|2[0-3]):[0-5]\d$/.test(until)) throw new Error('--until в формате ЧЧ:ММ');
  const from = mskDayStart(day);
  const to = until ? new Date(`${day}T${until}:00+03:00`) : mskDayStart(addDays(day, 1));
  for (const accountId of accounts) {
    const rows = await deps.days.listCreatedBetween(accountId, from, to);
    const account = await deps.accounts.get(accountId);
    const names = new Map<number, string>();
    if (account && rows.length) {
      const amo = amoRaw(account.accountDomain, () => deps.tokenService.getAccessToken(accountId), deps.fetch);
      const ids = [...new Set(rows.map((r) => r.leadId).filter((x): x is number => x !== null))];
      for (let i = 0; i < ids.length; i += 50) {
        const res = await amo.get<{ _embedded?: { leads?: { id: number; name: string }[] } }>(`/api/v4/leads?${ids.slice(i, i + 50).map((id) => `filter[id][]=${id}`).join('&')}`).catch(() => null);
        for (const l of res?._embedded?.leads ?? []) names.set(l.id, l.name);
      }
    }
    console.log(`Аккаунт ${accountId}: итогов дня, опубликованных ${day} ${until ? `до ${until}` : 'за сутки'} (МСК) — ${rows.length}${rows.filter((r) => r.noteId).length !== rows.length ? `, из них с примечанием ${rows.filter((r) => r.noteId).length}` : ''}`);
    for (const r of rows) {
      const time = r.createdAt.toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
      const where = r.leadId !== null ? `сделка «${names.get(r.leadId) ?? '?'}» (${r.leadId})` : `контакт ${r.contactId}`;
      console.log(`  ${time}  ${where}  итог ${r.id} за ${r.day}  примечание ${r.noteId ?? '—'}  ${(r.noteText ?? '').split('\n')[0] ?? ''}`);
    }
  }
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
