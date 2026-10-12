/**
 * Этап 4, шаг 7: перенос данных КП из БД розницы (ai_door) в БД опта (ai_door_opt) — ТЗ разделение, 6.2.
 * Переносятся только kp_settings (1 запись), kp_drafts (7 черновиков), ключ OpenAI и файл шаблона с проверкой md5.
 * Токены amoCRM НЕ переносятся: у опта своя интеграция. Исходная БД только читается.
 *
 * Режимы: без флагов — dry-run (показать, что будет перенесено); --apply — выполнить.
 * Повторный --apply безопасен: настройки и ключ обновляются, черновики с уже существующими id пропускаются.
 *
 * Переменные окружения:
 *   SRC_DATABASE_URL, SRC_TOKEN_ENCRYPTION_KEY, SRC_FILES_ROOT   — розница (/opt/ai-door/src/.env, том maildata → /data)
 *   DST_DATABASE_URL, DST_TOKEN_ENCRYPTION_KEY, DST_FILES_ROOT   — опт (/opt/agent-opt/.env, том opt_data → /data)
 *   ACCOUNT_ID — аккаунт amoCRM (28528549)
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SecretBox } from '@core/shared';
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`задайте ${k}`);
  return v;
};
const accountId = Number(env('ACCOUNT_ID'));
const src = new pg.Client({ connectionString: env('SRC_DATABASE_URL') });
const dst = new pg.Client({ connectionString: env('DST_DATABASE_URL') });
const srcBox = new SecretBox(env('SRC_TOKEN_ENCRYPTION_KEY'));
const dstBox = new SecretBox(env('DST_TOKEN_ENCRYPTION_KEY'));
const srcRoot = env('SRC_FILES_ROOT');
const dstRoot = env('DST_FILES_ROOT');

const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex');
const row = (name: string, value: string) => console.log(`  ${name.padEnd(28)} ${value}`);

await src.connect();
await dst.connect();
try {
  console.log(`${APPLY ? 'ПЕРЕНОС' : 'ПРОВЕРКА (dry-run)'}: аккаунт ${accountId}`);

  // Опт должен уже знать аккаунт: строка появляется при установке интеграции опта (OAuth).
  const dstAccount = await dst.query('SELECT id, account_domain FROM accounts WHERE id = $1', [accountId]);
  if (!dstAccount.rowCount) throw new Error(`в БД опта нет аккаунта ${accountId}: сначала установите интеграцию «Агент опт» в amoCRM`);
  row('аккаунт в БД опта', String(dstAccount.rows[0].account_domain));

  const settings = await src.query('SELECT * FROM kp_settings WHERE account_id = $1', [accountId]);
  const drafts = await src.query('SELECT * FROM kp_drafts WHERE account_id = $1 ORDER BY id', [accountId]);
  const secret = await src.query('SELECT value_enc FROM account_secrets WHERE account_id = $1 AND kind = $2', [accountId, 'openai']);
  const dstDrafts = await dst.query<{ id: number }>('SELECT id FROM kp_drafts WHERE account_id = $1', [accountId]);
  const existing = new Set(dstDrafts.rows.map((r) => Number(r.id)));
  const s = settings.rows[0] as Record<string, unknown> | undefined;

  row('kp_settings в рознице', s ? `есть (шаблон ${String(s.template_name ?? '—')}, md5 ${String(s.template_md5 ?? '—')})` : 'нет');
  row('kp_drafts в рознице', `${drafts.rowCount} шт. (статусы: ${drafts.rows.map((d) => String(d.status)).join(', ') || '—'})`);
  row('kp_drafts уже в опте', `${existing.size} шт.`);
  row('ключ OpenAI в рознице', secret.rowCount ? 'есть' : 'нет');

  // Шаблон: файл берётся с диска розницы, md5 сверяется с записью в kp_settings.
  const srcTemplate = s?.template_path ? String(s.template_path) : null;
  // Путь в kp_settings розницы — внутри её контейнера (/data/...); здесь том смонтирован в SRC_FILES_ROOT.
  const local = srcTemplate ? (srcTemplate.startsWith(srcRoot) ? srcTemplate : join(srcRoot, srcTemplate.replace(/^\/data\/?/, ''))) : null;
  const dstTemplate = join(dstRoot, 'kp', String(accountId), 'template.docx');
  let templateBytes: Buffer | null = null;
  if (local) {
    templateBytes = await readFile(local).catch(() => null);
    if (!templateBytes) row('файл шаблона', `НЕ НАЙДЕН: ${local}`);
    else {
      const sum = md5(templateBytes);
      row('файл шаблона', `${local}, ${templateBytes.length} байт, md5 ${sum}${sum === s?.template_md5 ? ' (совпадает с записью)' : ' (НЕ совпадает с записью в kp_settings!)'}`);
      row('куда', dstTemplate);
    }
  }

  if (!APPLY) {
    console.log('dry-run: ничего не записано. Для переноса запустите с --apply.');
  } else {
    await dst.query('BEGIN');
    if (s) {
      await dst.query(
        `INSERT INTO kp_settings (account_id, template_path, template_name, template_md5, template_updated_at, constants, certs_dir, numbering, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, now())
         ON CONFLICT (account_id) DO UPDATE SET template_path = EXCLUDED.template_path, template_name = EXCLUDED.template_name,
           template_md5 = EXCLUDED.template_md5, template_updated_at = EXCLUDED.template_updated_at, constants = EXCLUDED.constants,
           certs_dir = EXCLUDED.certs_dir, numbering = EXCLUDED.numbering, updated_at = now()`,
        [accountId, templateBytes ? dstTemplate : null, s.template_name, s.template_md5, s.template_updated_at, JSON.stringify(s.constants ?? {}), s.certs_dir, JSON.stringify(s.numbering ?? {})],
      );
    }
    let copied = 0;
    for (const d of drafts.rows as Record<string, unknown>[]) {
      if (existing.has(Number(d.id))) continue;
      await dst.query(
        `INSERT INTO kp_drafts (id, account_id, lead_id, status, payload, docx_path, pdf_path, kp_no, created_by, created_at, built_at, sent_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12)`,
        [d.id, accountId, d.lead_id, d.status, JSON.stringify(d.payload ?? {}), d.docx_path, d.pdf_path, d.kp_no, d.created_by, d.created_at, d.built_at, d.sent_at],
      );
      copied++;
    }
    await dst.query(`SELECT setval('kp_drafts_id_seq', GREATEST((SELECT COALESCE(MAX(id), 0) FROM kp_drafts), 1))`);
    if (secret.rowCount) {
      const plain = srcBox.decrypt(String(secret.rows[0].value_enc));
      await dst.query(
        `INSERT INTO account_secrets (account_id, kind, value_enc, updated_by) VALUES ($1, 'openai', $2, NULL)
         ON CONFLICT (account_id, kind) DO UPDATE SET value_enc = EXCLUDED.value_enc, updated_at = now()`,
        [accountId, dstBox.encrypt(plain)],
      );
    }
    await dst.query('COMMIT');
    if (templateBytes && local) {
      await mkdir(dirname(dstTemplate), { recursive: true });
      await copyFile(local, dstTemplate);
      const check = md5(await readFile(dstTemplate));
      row('шаблон скопирован', `md5 ${check}${check === md5(templateBytes) ? ' (совпадает)' : ' (НЕ СОВПАДАЕТ — проверьте копирование!)'}`);
    }
    row('перенесено', `kp_settings ${s ? 1 : 0}, kp_drafts ${copied} новых (пропущено ${drafts.rows.length - copied}), ключ OpenAI ${secret.rowCount ? 'да' : 'нет'}`);
  }
} finally {
  await src.end();
  await dst.end();
}
