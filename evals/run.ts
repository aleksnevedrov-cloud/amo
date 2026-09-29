// Прогон эталонных диалогов на реальной модели (критерии 3–4 приёмки 1.1.0).
// Нужны PostgreSQL (TEST_DATABASE_URL) и ключ провайдера: ANTHROPIC_API_KEY и/или OPENAI_API_KEY.
//   pnpm --filter @ai-door/evals eval                       — Anthropic, модель из настроек по умолчанию
//   pnpm --filter @ai-door/evals eval -- --model openai:gpt-5
//   pnpm --filter @ai-door/evals eval -- --compare anthropic:claude-opus-5,openai:gpt-5 [--only 01-]
// Каталог и база знаний — тестовые (fixtures). Резервная модель не используется: измеряется сама модель.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gatewayFromResolver, createProvider, parseModelKey, PROVIDERS, type ModelRef, type ProviderId } from '@ai-door/llm';
import { pricingRulesSchema } from '@ai-door/pricing';
import { widgetSettingsSchema } from '@ai-door/db';
import { seeded } from '../packages/tools/test/fixtures.ts';
import { dialogSchema, runDialog, summarize, withoutComment, type DialogReport, type EvalSummary } from './runner.ts';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = opt('only') ?? args.find((a) => !a.startsWith('--') && !args.includes(`--${a}`) && args.indexOf(a) === 0);
const modelArgs = (opt('compare') ?? opt('model') ?? 'anthropic:claude-opus-5').split(',').map((s) => s.trim()).filter(Boolean);
const models: ModelRef[] = modelArgs.map((k) => {
  const ref = parseModelKey(k);
  if (!ref) throw new Error(`Модель задаётся как provider:model, получено «${k}»`);
  return ref;
});

const keys: Partial<Record<ProviderId, string>> = { anthropic: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY };
for (const m of models) {
  if (!keys[m.provider]) {
    console.error(`Задайте ${PROVIDERS[m.provider].envKey} для ${m.provider}/${m.model}`);
    process.exit(2);
  }
}

const dialogs = (JSON.parse(readFileSync(new URL('dialogs.json', import.meta.url), 'utf8')).dialogs as unknown[])
  .map((d) => dialogSchema.parse(d))
  .filter((d) => !only || d.id.startsWith(only));

const s = await seeded(1);
const catalogDump = await s.db.query('SELECT name, price, old_price, params, description FROM catalog_products');
const kbDump = await s.db.query('SELECT content FROM knowledge_chunks');
const groundTruth = [JSON.stringify(catalogDump.rows), JSON.stringify(kbDump.rows)];
const adapters = new Map<ProviderId, ReturnType<typeof createProvider>>();
const llm = gatewayFromResolver((id) => {
  const key = keys[id];
  if (!key) return null;
  if (!adapters.has(id)) adapters.set(id, createProvider(id, key));
  return adapters.get(id) ?? null;
}, Object.keys(keys).filter((k) => keys[k as ProviderId]) as ProviderId[]);
const pricing = pricingRulesSchema.parse(withoutComment(JSON.parse(readFileSync(new URL('fixtures/pricing-rules.json', import.meta.url), 'utf8'))));

const byModel: { ref: ModelRef; reports: DialogReport[]; summary?: EvalSummary }[] = models.map((ref) => ({ ref, reports: [] }));
try {
  for (const d of dialogs) {
    await Promise.all(
      byModel.map(async (m) => {
        const settings = widgetSettingsSchema.parse({ enabled: true, mode: 'auto', model: { provider: m.ref.provider, model: m.ref.model, fallbackModel: null } });
        const r = await runDialog(d, { accountId: 1, catalog: s.catalog, knowledge: s.knowledge, llm, route: { primary: m.ref, fallback: null }, settings, groundTruth, pricing });
        m.reports.push(r);
        const tag = byModel.length > 1 ? `[${m.ref.provider}/${m.ref.model}] ` : '';
        console.log(`${r.passed ? '✓' : '✗'} ${tag}${r.id} [${r.final}${r.handoffReason ? `:${r.handoffReason}` : ''}] ${r.failures.join('; ')}`);
      }),
    );
  }
} finally {
  await s.drop();
}

for (const m of byModel) m.summary = summarize(m.reports, dialogs);
mkdirSync(new URL('results/', import.meta.url), { recursive: true });
const file = new URL(`results/${new Date().toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url);
writeFileSync(file, JSON.stringify({ models: byModel }, null, 2));
for (const m of byModel) {
  const sum = m.summary as EvalSummary;
  console.log(
    `\n${m.ref.provider}/${m.ref.model}: ${sum.passed}/${sum.total} пройдено · выдуманных данных: ${sum.fabricated} · передача менеджеру: ${sum.handoffOk}/${sum.handoffExpected} · ` +
      `отклонений пост-фильтром: ${sum.rejections} · p95 ${Math.round(sum.p95LatencyMs / 1000)} с · $${sum.costUsd.toFixed(3)} (≈ $${sum.avgCostUsd.toFixed(4)} за диалог)`,
  );
}
console.log(`Отчёт: ${file.pathname}`);
process.exit(byModel.every((m) => m.summary && m.summary.passed === m.summary.total && m.summary.fabricated === 0) ? 0 : 1);
