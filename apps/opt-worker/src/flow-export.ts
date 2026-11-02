/* eslint-disable no-console -- консольная утилита: вывод для заказчика */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '@core/shared';
import { createOptCore, type KpPayload } from '@opt/kp';

/**
 * Выгрузка сделки в эталонный набор KP-AGENT-V2 (tests/fixtures/flow/<сделка>/): файлы сделки из amo, письмо из последнего
 * черновика КП (тема, текст, позиции письма) и черновик эталона expected.draft.json — позиции, размеры и количества, как их
 * собрал агент. Менеджер сверяет expected.draft.json с заявкой, исправляет и сохраняет как expected.json; после этого сделка
 * входит в набор (apps/opt-api/test/flow.test.ts). Ключ модели и пароли в файлы не пишутся; письмо клиента — только текст.
 *
 *   docker compose run --rm --no-deps -v /opt/agent-opt/flow:/flow opt-worker node apps/opt-worker/dist/flow-export.js \
 *     --account 28528549 --out /flow --deal 89813=30008823 --deal 89933=30017381 --deal 90018=30021357 --deal 90025=30022107
 *
 * --deal <номер сделки>=<id сделки в amo>; без «=» номер считается id сделки.
 */
const argv = process.argv.slice(2);
const accountId = Number(valueOf('--account'));
const out = valueOf('--out') ?? 'tests/fixtures/flow';
const pairs = argv.flatMap((a, i) => (a === '--deal' && argv[i + 1] ? [argv[i + 1] as string] : [])).map((s) => {
  const [deal, lead] = s.split('=');
  return { deal: Number(deal), lead: Number(lead ?? deal) };
});
if (!Number.isInteger(accountId) || accountId <= 0) fail('укажите --account <id аккаунта amoCRM>');
if (!pairs.length || pairs.some((p) => !p.deal || !p.lead)) fail('укажите хотя бы одну --deal <номер>=<id сделки в amo>');

const env = loadEnv();
const core = createOptCore(env);
try {
  const amo = await core.amoFor(accountId);
  for (const { deal, lead } of pairs) {
    const dir = join(out, String(deal));
    mkdirSync(dir, { recursive: true });
    const draft = await core.kp.latestByLead(accountId, lead);
    const p = (draft?.payload ?? {}) as Partial<KpPayload>;
    const files = await amo.listLeadFiles(lead, 50).catch((err: Error) => {
      console.error(`сделка ${deal}: список файлов не получен — ${err.message}`);
      return [];
    });
    const saved: string[] = [];
    for (const f of files) {
      // Наши КП и сертификаты в набор не идут — только файлы клиента.
      if (/^(KP[-_]|kp_dveri)/i.test(f.name)) continue;
      try {
        const { bytes } = await amo.downloadFile(f);
        writeFileSync(join(dir, f.name), bytes);
        saved.push(f.name);
      } catch (err) {
        console.error(`сделка ${deal}: файл «${f.name}» не скачан — ${(err as Error).message}`);
      }
    }
    // Заявка без файлов — позиции письма сохраняются ответом модели разбора, чтобы набор не зависел от ключа модели.
    const dealJson = {
      deal,
      leadId: lead,
      source: 'real',
      title: p.source?.mail?.subject ?? `сделка ${deal}`,
      note: `выгружено flow-export ${new Date().toISOString().slice(0, 10)} из черновика ${draft?.id ?? '—'}`,
      letter: { subject: p.source?.mail?.subject ?? '', text: p.letterText ?? '' },
      files: saved.map((name) => ({ name })),
      ...(saved.length ? {} : { letterItems: p.request_items ?? [] }),
    };
    writeFileSync(join(dir, 'deal.json'), `${JSON.stringify(dealJson, null, 2)}\n`);
    const goods = (p.items ?? []).filter((l) => !(l.kind === 'service' || l.category === 'service'));
    const expected = {
      positions: goods.map((l) => ({ name: l.name, size: l.size, qty: l.qty, door: l.category === 'door' })),
      mustAsk: [{ type: 'delivery' }, { type: 'price_validity' }],
      note: 'ЧЕРНОВИК ЭТАЛОНА: позиции, как их собрал агент. Сверьте с заявкой (названия, размеры, количества, какие строки — двери), исправьте и сохраните как expected.json.',
    };
    writeFileSync(join(dir, 'expected.draft.json'), `${JSON.stringify(expected, null, 2)}\n`);
    console.log(`сделка ${deal} (amo ${lead}): черновик ${draft?.id ?? 'нет'}, файлов ${saved.length}${saved.length ? ` (${saved.join(', ')})` : ''}, позиций ${goods.length} → ${dir}`);
  }
} finally {
  await core.close();
}

function valueOf(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function fail(msg: string): never {
  console.error(`flow-export: ${msg}`);
  process.exit(2);
}
