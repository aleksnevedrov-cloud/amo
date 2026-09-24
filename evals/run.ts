// Прогон эталонных диалогов на реальной модели.
// Нужны ANTHROPIC_API_KEY и PostgreSQL (TEST_DATABASE_URL). Каталог и база знаний — тестовые (fixtures).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { AnthropicLlm } from '@ai-door/agent';
import { seeded } from '../packages/tools/test/fixtures.ts';
import { dialogSchema, runDialog, summarize, type DialogReport } from './runner.ts';

const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.error('Задайте ANTHROPIC_API_KEY');
  process.exit(2);
}
const only = process.argv[2];
const dialogs = (JSON.parse(readFileSync(new URL('dialogs.json', import.meta.url), 'utf8')).dialogs as unknown[])
  .map((d) => dialogSchema.parse(d))
  .filter((d) => !only || d.id.startsWith(only));

const s = await seeded(1);
const catalogDump = await s.db.query('SELECT name, price, old_price, params, description FROM catalog_products');
const kbDump = await s.db.query('SELECT content FROM knowledge_chunks');
const groundTruth = [JSON.stringify(catalogDump.rows), JSON.stringify(kbDump.rows)];
const llm = new AnthropicLlm(key);

const reports: DialogReport[] = [];
try {
  for (const d of dialogs) {
    const r = await runDialog(d, { accountId: 1, catalog: s.catalog, knowledge: s.knowledge, llm, groundTruth });
    reports.push(r);
    console.log(`${r.passed ? '✓' : '✗'} ${r.id} [${r.final}${r.handoffReason ? `:${r.handoffReason}` : ''}] ${r.failures.join('; ')}`);
  }
} finally {
  await s.drop();
}
const summary = summarize(reports);
mkdirSync(new URL('results/', import.meta.url), { recursive: true });
const file = new URL(`results/${new Date().toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url);
writeFileSync(file, JSON.stringify({ summary, reports }, null, 2));
console.log(
  `\nИтого: ${summary.passed}/${summary.total} пройдено · выдуманных данных: ${summary.fabricated} · ` +
    `отклонений пост-фильтром: ${summary.rejections} · p95 ${Math.round((summary.p95LatencyMs ?? 0) / 1000)} с · $${summary.costUsd.toFixed(3)}`,
);
console.log(`Отчёт: ${file.pathname}`);
process.exit(summary.passed === summary.total && summary.fabricated === 0 ? 0 : 1);
