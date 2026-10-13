/* eslint-disable no-console -- консольная утилита: вывод для заказчика */
import { loadEnv } from '@core/shared';
import { createOptCore, ImapMailReader, leadMailSearch } from '@opt/kp';

/**
 * Проверка чтения ящика по сделке без сборки КП (RFD-AI-AGENT-OPT-MAIL-READ-4): те же критерии, что
 * у кнопки «Собрать черновик», тот же ImapMailReader (только чтение). Печатает папку, дату, тему,
 * отправителя и имена вложений найденного письма и диагностику по папкам. Текст письма не выводится,
 * в сделку и в базу ничего не пишется.
 *
 *   node apps/opt-worker/dist/mail-check.js --account 28528549 --lead 30013995
 *   node apps/opt-worker/dist/mail-check.js --account 28528549 --from stoptpostavka@yandex.ru [--around 2026-10-12] [--subject "…"]
 */
const args = parseArgs(process.argv.slice(2));
const accountId = Number(args.account);
if (!Number.isInteger(accountId) || accountId <= 0) fail('укажите --account <id аккаунта amoCRM>');
if (!args.lead && !args.from) fail('укажите --lead <id сделки> или --from <e-mail отправителя>');

const env = loadEnv();
const core = createOptCore(env);
try {
  const { settings } = await core.settings.get(accountId);
  const m = settings.mail;
  if (!m.username || !m.imapHost) fail('во вкладке «Письмо» не заданы логин или IMAP-сервер');
  const password = await core.secrets.get(accountId, 'smtp');
  if (!password) fail('пароль ящика не сохранён во вкладке «Письмо»');

  let search;
  if (args.lead) {
    const leadId = Number(args.lead);
    if (!Number.isInteger(leadId) || leadId <= 0) fail('--lead должен быть числом');
    const amo = await core.amoFor(accountId);
    const r = await leadMailSearch(amo, leadId);
    console.log(`Сделка ${leadId}: писем в карточке ${r.mails}; отправитель последнего входящего: ${r.letterFrom ?? '—'}; e-mail контакта: ${r.contactEmail || '—'}`);
    if (!r.search.from) fail('в карточке нет e-mail отправителя — искать нечего');
    search = r.search;
  } else {
    search = { from: String(args.from), around: args.around ? new Date(String(args.around)) : new Date(), subject: args.subject ? String(args.subject) : null };
    if (Number.isNaN(search.around.getTime())) fail('--around должен быть датой, например 2026-10-12');
  }
  console.log(`Ящик: ${m.username} @ ${m.imapHost}:${m.imapPort} (${m.imapSecure ? 'TLS' : 'без TLS'}); ищем от ${search.from}, около ${search.around.toISOString().slice(0, 10)}${search.subject ? `, тема «${search.subject}»` : ''}`);

  const started = Date.now();
  const r = await new ImapMailReader({ host: m.imapHost, port: m.imapPort, secure: m.imapSecure, username: m.username, password }).findLatest(search);
  console.log(`Папки открыты только на чтение: ${r.readOnly ? 'да' : 'НЕТ'}; ${Math.round((Date.now() - started) / 1000)} с`);
  console.log(`Критерии: ${JSON.stringify(r.diag.criteria)}`);
  console.table(r.diag.folders.map((f) => ({ папка: f.path, 'спец.': f.specialUse ?? '', 'в окне дат': f.inWindow, 'от отправителя': f.bySender, 'без даты просмотрено': f.scannedWithoutDate, 'без даты от отправителя': f.bySenderWithoutDate })));
  if (r.diag.skippedFolders.length) console.log(`Пропущены: ${r.diag.skippedFolders.join(', ')}`);
  if (r.diag.fallbackWithoutDate) console.log('Сработал запасной проход без даты');
  if (r.diag.errors.length) console.log(`Ошибки SEARCH: ${r.diag.errors.join('; ')}`);
  if (r.mail) {
    console.log('\n— Найдено —');
    console.log(`папка: ${r.mail.folder}; uid: ${r.mail.uid}; совпадение: ${r.mail.matchedBy === 'address' ? 'точный адрес' : 'только домен'}`);
    console.log(`дата: ${r.mail.date ? r.mail.date.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' МСК' : '—'}; от: ${r.mail.from}`);
    console.log(`тема: ${r.mail.subject || '—'}`);
    console.log(`вложений ${r.mail.attachments.length}: ${r.mail.attachments.map((a) => `${a.filename ?? a.contentType} (${Math.round(a.size / 1024)} КБ${a.inline ? ', встроенное' : ''})`).join('; ') || '—'}`);
    console.log(`текст: ${r.mail.text.length} символов (не выводится)`);
  } else {
    console.log('\n— Письмо не найдено —');
  }
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
  console.error(`mail-check: ${msg}`);
  process.exit(2);
}
