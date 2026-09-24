import { checkFacts, Orchestrator, type HistoryMessage, type LlmClient, type TurnResult } from '@ai-door/agent';
import type { CatalogRepo } from '@ai-door/catalog';
import { widgetSettingsSchema, type WidgetSettings } from '@ai-door/db';
import type { KnowledgeRepo } from '@ai-door/knowledge';
import { PHASE1_TOOLS, SandboxCrm } from '@ai-door/tools';
import { z } from 'zod';

const oneOrMany = z.union([z.string(), z.array(z.string())]).transform((v) => (Array.isArray(v) ? v : [v]));

export const dialogSchema = z.object({
  id: z.string(),
  topic: z.string(),
  turns: z.array(z.string()).min(1),
  expect: z.object({
    final: oneOrMany,
    reasons: z.array(z.string()).optional(),
    sources: z.array(z.string()).optional(),
    anySources: z.array(z.string()).optional(),
    mustNotMention: z.array(z.string()).optional(),
    mustContain: z.array(z.string()).optional(),
    mustNotContain: z.array(z.string()).optional(),
  }),
});
export type Dialog = z.infer<typeof dialogSchema>;

export interface DialogReport {
  id: string;
  topic: string;
  passed: boolean;
  failures: string[];
  /** Независимая сверка цифр со всем каталогом и базой знаний. */
  fabricated: string[];
  final: TurnResult['kind'];
  handoffReason: string | null;
  transcript: HistoryMessage[];
  sources: string[];
  rejections: number;
  costUsd: number;
  latencyMs: number[];
}

export interface EvalEnv {
  accountId: number;
  catalog: CatalogRepo;
  knowledge: KnowledgeRepo;
  llm: LlmClient;
  settings?: WidgetSettings;
  /** Полный дамп данных (каталог + база знаний) для независимой сверки. */
  groundTruth: string[];
}

export async function runDialog(d: Dialog, env: EvalEnv): Promise<DialogReport> {
  const settings = env.settings ?? widgetSettingsSchema.parse({ enabled: true, mode: 'auto' });
  const orchestrator = new Orchestrator(env.llm);
  const history: HistoryMessage[] = [];
  const sources = new Set<string>();
  const latencyMs: number[] = [];
  let last: TurnResult | null = null;
  let costUsd = 0;
  let rejections = 0;

  for (const turn of d.turns) {
    const started = Date.now();
    last = await orchestrator.runTurn({
      settings,
      history,
      incoming: [turn],
      ctx: { accountId: env.accountId, catalog: env.catalog, knowledge: env.knowledge, crm: new SandboxCrm() },
      tools: PHASE1_TOOLS,
    });
    latencyMs.push(Date.now() - started);
    costUsd += last.cost.usd;
    rejections += last.rejections.length;
    for (const s of last.sources) sources.add(s.id);
    history.push({ role: 'client', text: turn });
    if (last.kind === 'reply') history.push({ role: 'ai', text: last.text });
    else break;
  }
  const result = last as TurnResult;
  const aiText = history.filter((m) => m.role === 'ai').map((m) => m.text).join('\n');
  const clientTexts = history.filter((m) => m.role === 'client').map((m) => m.text);
  const failures: string[] = [];
  const e = d.expect;

  if (!e.final.includes(result.kind)) {
    failures.push(`итог ${result.kind}${result.kind === 'blocked' ? ` (${result.reason})` : ''}, ожидался ${e.final.join('/')}`);
  }
  const reason = result.kind === 'handoff' ? result.handoff.reason : null;
  if (e.reasons && result.kind === 'handoff' && !e.reasons.includes(reason ?? '')) {
    failures.push(`причина передачи ${reason}, ожидалась ${e.reasons.join('/')}`);
  }
  for (const id of e.sources ?? []) if (!sources.has(id)) failures.push(`не найден товар ${id}`);
  if (e.anySources && !e.anySources.some((id) => sources.has(id))) {
    failures.push(`не найден ни один из товаров ${e.anySources.join(', ')}`);
  }
  for (const id of e.mustNotMention ?? []) {
    const p = await env.catalog.get(env.accountId, id);
    if (p && aiText.includes(p.name)) failures.push(`упомянут неподходящий товар ${p.name}`);
  }
  const lower = aiText.toLowerCase();
  for (const t of e.mustContain ?? []) if (!lower.includes(t.toLowerCase())) failures.push(`в ответе нет «${t}»`);
  for (const t of e.mustNotContain ?? []) if (lower.includes(t.toLowerCase())) failures.push(`в ответе есть «${t}»`);

  // Независимая сверка: любая цена/срок в ответах должны существовать в каталоге, базе знаний или словах клиента.
  const fabricated = checkFacts({
    reply: aiText,
    toolResults: env.groundTruth,
    clientTexts,
    catalogConsulted: true,
  }).map((v) => `${v.kind}: ${v.fragment}`);
  if (fabricated.length) failures.push(`выдуманные данные: ${fabricated.join('; ')}`);

  return {
    id: d.id,
    topic: d.topic,
    passed: failures.length === 0,
    failures,
    fabricated,
    final: result.kind,
    handoffReason: reason,
    transcript: history,
    sources: [...sources],
    rejections,
    costUsd,
    latencyMs,
  };
}

export function summarize(reports: DialogReport[]) {
  const lat = reports.flatMap((r) => r.latencyMs).sort((a, b) => a - b);
  const p95 = lat.length ? lat[Math.min(lat.length - 1, Math.ceil(lat.length * 0.95) - 1)] : 0;
  return {
    total: reports.length,
    passed: reports.filter((r) => r.passed).length,
    fabricated: reports.reduce((n, r) => n + r.fabricated.length, 0),
    rejections: reports.reduce((n, r) => n + r.rejections, 0),
    costUsd: reports.reduce((n, r) => n + r.costUsd, 0),
    p95LatencyMs: p95,
  };
}
