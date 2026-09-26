// Нагрузка (раздел 13–14 ТЗ): 100 одновременных диалогов через конвейер с имитацией LLM и amo.
// Меряет время от постановки в очередь до ответа (p50/p95) и проверяет, что ни одно сообщение не потерялось.
// Нужен PostgreSQL (TEST_DATABASE_URL). LLM не вызывается — проверяется наш код, БД и пул соединений.
import { mkdirSync, writeFileSync } from 'node:fs';
import { DialogPipeline, Orchestrator, type AmoAccess, type LlmClient, type LlmRequest, type LlmResponse } from '@ai-door/agent';
import { AmoApiClient } from '@ai-door/amo';
import { DialogRepo, JournalRepo, MemoryRepo, OutcomesRepo, SettingsRepo, SuggestionsRepo, widgetSettingsSchema } from '@ai-door/db';
import { PricingRepo } from '@ai-door/pricing';
import { seeded } from '../packages/tools/test/fixtures.ts';

const N = Number(process.argv[2] ?? 100);
const LLM_LATENCY_MS = Number(process.env.PERF_LLM_MS ?? 800);
const ACC = 1;

/** LLM с задержкой: сначала поиск по каталогу, потом ответ с ценой из результата. */
class SlowLlm implements LlmClient {
  calls = 0;
  async create(req: LlmRequest): Promise<LlmResponse> {
    this.calls += 1;
    await new Promise((r) => setTimeout(r, LLM_LATENCY_MS));
    const last = req.messages.at(-1);
    const hasToolResult = Array.isArray(last?.content) && last.content.some((b) => (b as { type: string }).type === 'tool_result');
    const content = hasToolResult
      ? [{ type: 'text', text: 'Порта 21 — 7 900 ₽, есть в наличии: https://rf-dveri.ru/catalog/test-1004/', citations: null }]
      : [{ type: 'tool_use', id: `tu_${this.calls}`, name: 'catalog_search', input: { query: 'Порта 21' } }];
    return {
      id: `m${this.calls}`, type: 'message', role: 'assistant', model: 'claude-opus-5', content, stop_reason: hasToolResult ? 'end_turn' : 'tool_use', stop_sequence: null,
      usage: { input_tokens: 3000, output_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    } as unknown as LlmResponse;
  }
}

const s = await seeded(ACC);
const settings = new SettingsRepo(s.db);
await settings.save(ACC, 1, widgetSettingsSchema.parse({ enabled: true, mode: 'auto', where: { batchWindowSec: 0 } }));
const dialog = new DialogRepo(s.db);
const sent: number[] = [];
const amoFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  await new Promise((r) => setTimeout(r, 30)); // сетевой лаг amo
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
  if (url.pathname.startsWith('/api/v4/leads/') && (init?.method ?? 'GET') === 'GET' && !url.pathname.endsWith('/notes')) {
    return json({ id: Number(url.pathname.split('/').pop()), name: 'x', price: 0, status_id: 10, pipeline_id: 1, responsible_user_id: 3, created_at: 0, custom_fields_values: null, _embedded: { contacts: [] } });
  }
  if (url.pathname === '/api/v4/events') return new Response(null, { status: 204 });
  return json({});
}) as typeof fetch;
const access: AmoAccess = { api: new AmoApiClient('perf.amocrm.ru', async () => 'T', amoFetch, async () => undefined), accessToken: async () => 'T', accountDomain: 'perf.amocrm.ru' };
const llm = new SlowLlm();
const pipeline = new DialogPipeline({
  settings, dialog, journal: new JournalRepo(s.db), catalog: s.catalog, knowledge: s.knowledge, pricing: new PricingRepo(s.db), memory: new MemoryRepo(s.db),
  suggestions: new SuggestionsRepo(s.db), orchestrator: new Orchestrator(llm), llm, outcomes: new OutcomesRepo(s.db),
  amo: async () => access,
  send: async (_a, _u, messages) => void sent.push(messages.length),
});

const started = Date.now();
const leads = Array.from({ length: N }, (_, i) => 90_000 + i);
await Promise.all(leads.map((l) => dialog.enqueue(ACC, l, 'Сколько стоит Порта 21?', `https://perf.amocrm.ru/c/${l}`)));
const durations = await Promise.all(
  leads.map(async (l) => {
    const t0 = Date.now();
    const out = await pipeline.processLead(ACC, l);
    if (out.status !== 'replied') throw new Error(`lead ${l}: ${out.status}`);
    return Date.now() - t0;
  }),
);
const wall = Date.now() - started;
durations.sort((a, b) => a - b);
const q = (p: number) => durations[Math.min(durations.length - 1, Math.floor((p / 100) * durations.length))] ?? 0;
const journal = await s.db.query("SELECT count(*) AS n FROM ai_journal WHERE account_id = $1 AND kind = 'reply'", [ACC]);
const report = [
  `# Нагрузка: ${N} одновременных диалогов`,
  '',
  `LLM-имитация: ${LLM_LATENCY_MS} мс на вызов, 2 вызова на диалог (поиск + ответ); amo-имитация: 30 мс на запрос.`,
  `Всё вместе: ${wall} мс. Время диалога: p50 ${q(50)} мс, p95 ${q(95)} мс, max ${q(100)} мс.`,
  `Ответов отправлено: ${sent.filter((x) => x === 1).length} из ${N}; записей «reply» в журнале: ${journal.rows[0].n}.`,
  `Цель ТЗ (раздел 13): ≤ 15 с p95 без учёта времени самой модели — ${q(95) - 2 * LLM_LATENCY_MS} мс накладных расходов на p95.`,
].join('\n');
console.log(report);
mkdirSync(new URL('results/', import.meta.url), { recursive: true });
writeFileSync(new URL(`results/perf-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`, import.meta.url), `${report}\n`);
await s.drop();
if (sent.filter((x) => x === 1).length !== N || Number(journal.rows[0].n) !== N) process.exit(1);
