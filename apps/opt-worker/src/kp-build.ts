/* eslint-disable no-console -- консольная утилита: вывод для заказчика */
import { loadEnv } from '@core/shared';
import { buildDraftDocument, createOptCore, KpBuildError } from '@opt/kp';

/**
 * Сборка документа КП из консоли (RFD-AI-AGENT-OPT-KP-DOWNLOAD, п. 2г) — та же buildDraftDocument, что у кнопки
 * «Собрать документ»: DOCX по шаблону, PDF через LibreOffice, файлы в сделку, запись в kp_drafts и журнал kp_build.
 * Для серверной приёмки: видно пути, размеры, что приложено в amo и почему сборка не прошла.
 *
 *   docker compose run --rm --no-deps opt-worker node apps/opt-worker/dist/kp-build.js --account 28528549 --draft 29
 *   docker compose run --rm --no-deps opt-worker node apps/opt-worker/dist/kp-build.js --account 28528549 --lead 30021357   # последний черновик сделки
 */
const args = parseArgs(process.argv.slice(2));
const accountId = Number(args.account);
if (!Number.isInteger(accountId) || accountId <= 0) fail('укажите --account <id аккаунта amoCRM>');
if (!args.draft && !args.lead) fail('укажите --draft <id черновика> или --lead <id сделки>');

const env = loadEnv();
const core = createOptCore(env);
try {
  let draftId = Number(args.draft);
  if (args.lead) {
    const latest = await core.kp.latestByLead(accountId, Number(args.lead));
    if (!latest) fail(`у сделки ${args.lead} нет черновика КП — сначала «Собрать КП»`);
    draftId = latest.id;
  }
  const draft = await core.kp.byId(accountId, draftId);
  if (!draft) fail(`черновик ${draftId} не найден у аккаунта ${accountId}`);
  const items = ((draft.payload as { items?: { price: number | null }[] }).items ?? []);
  console.log(`Черновик ${draft.id}, сделка ${draft.leadId}, статус ${draft.status}, позиций ${items.length}, с ценой ${items.filter((l) => l.price !== null).length}; KP_FILES_ROOT=${core.filesRoot}`);
  const s = await core.kp.getSettings(accountId);
  console.log(`Шаблон: ${s.templatePath ?? '— (не загружен)'}${s.templateName ? ` (${s.templateName}, md5 ${s.templateMd5})` : ''}; сертификаты: ${s.certsDir ?? '—'}`);
  const started = Date.now();
  try {
    const r = await buildDraftDocument(core, { accountId, draftId: draft.id, userId: null });
    console.log(`\nСобрано: КП ${r.kpNo} за ${(r.ms / 1000).toFixed(1)} с${r.pdf ? '' : ` — PDF не собран: ${r.pdfError ?? 'причина не указана'}`}`);
    console.table(r.files.map((f) => ({ вид: f.kind, файл: f.name, 'размер, байт': f.bytes, 'путь (от KP_FILES_ROOT)': f.path })));
    console.log(`Сертификаты: ${r.certificates.length ? r.certificates.join(', ') : 'нет'}`);
    console.log(`В сделку приложено: ${r.attached.length ? r.attached.join(', ') : 'ничего (нет доступа к amo или загрузка не удалась)'}`);
    console.log(`kp_drafts #${r.draft.id}: status=${r.draft.status}, kp_no=${r.draft.kpNo}, docx_path=${r.draft.docxPath}, pdf_path=${r.draft.pdfPath ?? 'null'}, built_at=${r.draft.builtAt?.toISOString() ?? 'null'}`);
  } catch (err) {
    if (err instanceof KpBuildError) fail(`${err.code}: ${err.message}${err.latestDraftId ? ` (последний черновик: ${err.latestDraftId})` : ''} — ${Math.round((Date.now() - started) / 1000)} с`);
    throw err;
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
  console.error(`kp-build: ${msg}`);
  process.exit(2);
}
