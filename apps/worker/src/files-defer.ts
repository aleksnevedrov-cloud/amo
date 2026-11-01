/* eslint-disable no-console -- консольная утилита: вывод для заказчика */
import { AmoApiClient } from '@core/amo';
import { MailAttachmentsRepo } from '@core/db';
import { loadEnv } from '@core/shared';
import { deferFileToDisk } from '@retail/mail';
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
  const files = await api.listLeadFiles(leadId, 100);
  const picked = files.filter((f) => !nameFilter || f.name.toLowerCase().includes(nameFilter));
  console.log(`Сделка ${leadId}: файлов в карточке ${files.length}${nameFilter ? `, по фильтру «${args.name}» — ${picked.length}` : ''}`);
  const attachments = new MailAttachmentsRepo(db);
  for (const f of picked) {
    try {
      const { bytes, mime } = await api.downloadFile(f);
      const row = await deferFileToDisk({ attachments, root: process.env.MAIL_FILES_ROOT ?? '/data' }, { accountId, leadId, filename: f.name, mime: mime ?? f.mime ?? 'application/octet-stream', bytes, key: `amo-file:${f.uuid}`, error: 'поставлен в очередь командой files-defer (дневной лимит)' });
      console.log(`  ${f.name} (${bytes.byteLength} байт, ${mime ?? f.mime ?? '—'}): ${row.created ? `в очереди отложенных, строка ${row.id}` : `уже в очереди (строка ${row.id})`}`);
    } catch (err) {
      console.log(`  ${f.name}: не скачан — ${(err as Error).message}`);
    }
  }
  if (!picked.length) console.log('  ничего не поставлено');
  else console.log('Разбор — ближайшим проходом wazzup-files (до 5 минут); проверить: calls-inspect.js --files-usage и журнал «Разобрано отложенное вложение».');
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
