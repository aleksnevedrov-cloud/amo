/* eslint-disable no-console -- консольная утилита: вывод для заказчика */
import { AmoApiClient } from '@core/amo';
import { MailAttachmentsRepo } from '@core/db';
import { loadEnv } from '@core/shared';
import { queueLeadFiles } from '@retail/mail';
import { buildCallsDeps } from './calls-deps.ts';

/**
 * RFD-AI-AGENT-FILES-PRIORITY: поставить файлы сделки из amoCRM (вложения писем карточки, файлы «Файлы» сделки) в очередь
 * отложенного разбора — для файлов, которые упёрлись в дневной лимит до этой доработки и в очередь не попали. Файлы скачиваются
 * из amo на том, строки — mail_attachments со статусом deferred; разбор — ближайшим проходом wazzup-files (до 5 минут), текст
 * уйдёт в историю сделки и в открытую задачу «…из-за дневного лимита». Ничего в amo не меняет.
 *
 *   docker compose exec worker node apps/worker/dist/files-defer.js --lead <id сделки> [--name <часть имени файла>] [--account <id>]
 */
const args = parseArgs(process.argv.slice(2));
const leadId = Number(args.lead);
if (!Number.isInteger(leadId) || leadId <= 0) fail('укажите --lead <id сделки>');
const nameFilter = typeof args.name === 'string' ? args.name.toLowerCase() : null;

const env = loadEnv();
const { deps, db, close } = buildCallsDeps(env);
try {
  const accounts = args.account ? [Number(args.account)] : await deps.accountIds();
  const accountId = accounts[0];
  if (!accountId) fail('подключённых аккаунтов нет');
  const account = await deps.accounts.get(accountId);
  if (!account || account.uninstalledAt) fail(`аккаунт ${accountId} не подключён`);
  const api = new AmoApiClient(account.accountDomain, () => deps.tokenService.getAccessToken(accountId), deps.fetch);
  // Общая часть с заданием deal-files (RFD-AI-AGENT-DEAL-FILES): те же ключи amo-file:<uuid>, те же пропуски дублей.
  const r = await queueLeadFiles({ attachments: new MailAttachmentsRepo(db), journal: deps.journal, root: process.env.MAIL_FILES_ROOT ?? '/data' }, accountId, leadId, api, { reason: 'поставлен в очередь командой files-defer', maxFileMb: (await deps.settingsFor(accountId)).dealFiles.maxFileMb, nameFilter, journal: true });
  console.log(`Сделка ${leadId}: файлов в карточке${nameFilter ? ` по фильтру «${args.name}»` : ''} — ${r.files}`);
  for (const f of r.queued) console.log(`  ${f.name} (${f.bytes} байт): в очереди отложенных, строка ${f.id}`);
  for (const f of r.skipped) console.log(`  ${f.name}: пропущен — ${f.reason}`);
  for (const f of r.failed) console.log(`  ${f.name}: не скачан — ${f.error}`);
  if (!r.files) console.log('  ничего не поставлено');
  else console.log('Разбор — ближайшим проходом wazzup-files (до 5 минут); проверить: calls-inspect.js --files-usage и журнал deal_file.');
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
