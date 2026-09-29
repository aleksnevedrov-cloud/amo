import type { ChatRoute, LlmGateway, ProviderId, UnifiedMessage, UnifiedPart, UnifiedTool } from '@ai-door/llm';
import type { Role, WidgetSettings } from '@ai-door/db';
import { toolByName, type AgentTool, type HandoffRequest, type Source, type ToolContext } from '@ai-door/tools';
import { checkFacts, describeViolations, type FactViolation } from './factcheck.ts';
import { asGateway, type LlmClient } from './llm.ts';
import { addCost, costOfResponse, ZERO_COST, type Cost } from './pricing.ts';
import { buildSystem, type DynamicContext } from './prompt.ts';
import { resolveRoute } from './route.ts';
import type { CalcResult } from '@ai-door/pricing';

export interface HistoryMessage {
  role: Role;
  text: string;
}

export interface ToolCallTrace {
  name: string;
  specName: string;
  input: unknown;
  ok: boolean;
  empty: boolean;
  error?: string;
  durationMs: number;
}

interface Common {
  toolCalls: ToolCallTrace[];
  sources: Source[];
  cost: Cost;
  /** Провайдер и фактическая модель последнего ответа. */
  provider: ProviderId;
  model: string;
  /** Что запрашивали по настройкам (отличается от model при резервной модели или серверном fallback). */
  requestedModel: string;
  /** Хотя бы один ответ хода дала резервная модель. */
  fallbackUsed: boolean;
  /** Суммарное время ответов модели за ход, мс. */
  latencyMs: number;
  /** Сколько раз ответ отклонял пост-фильтр. */
  rejections: FactViolation[][];
  /** Последний расчёт price_calculate в этом ходе — черновик детализации. */
  calculation?: CalcResult;
}

export type TurnResult =
  | (Common & { kind: 'reply'; text: string; missed: boolean })
  | (Common & { kind: 'handoff'; handoff: HandoffRequest })
  | (Common & { kind: 'blocked'; reason: string });

export interface TurnInput {
  settings: WidgetSettings;
  history: HistoryMessage[];
  /** Новые сообщения клиента (склеенная серия). */
  incoming: string[];
  ctx: ToolContext;
  tools: readonly AgentTool[];
  now?: Date;
  dynamic?: DynamicContext;
  /** Данные клиента из памяти (бюджет, размеры) — допустимые числа для пост-фильтра. */
  clientFacts?: string[];
  /** Провайдер и модель хода; по умолчанию — из настроек (глобально). */
  route?: ChatRoute;
}

const MAX_ITERATIONS = 8;
const MAX_REJECTIONS = 2;
const SEARCH_TOOLS = new Set(['catalog_search', 'catalog_get_product', 'knowledge_search']);
const CATALOG_TOOLS = new Set(['catalog_search', 'catalog_get_product']);

/**
 * История диалога → единые сообщения. Менеджер — сторона продавца (assistant) с пометкой.
 * История из amoCRM и памяти — только текст, поэтому подходит любому провайдеру (раздел 3 ТЗ).
 */
export function toApiMessages(history: HistoryMessage[], incoming: string[]): UnifiedMessage[] {
  const items: { role: 'user' | 'assistant'; text: string }[] = history.map((m) => ({
    role: m.role === 'client' ? 'user' : 'assistant',
    text: m.role === 'manager' ? `(Сообщение менеджера) ${m.text}` : m.text,
  }));
  if (incoming.length) items.push({ role: 'user', text: incoming.join('\n') });
  const merged: { role: 'user' | 'assistant'; text: string }[] = [];
  for (const it of items) {
    const last = merged.at(-1);
    if (last && last.role === it.role) last.text += `\n${it.text}`;
    else merged.push({ ...it });
  }
  while (merged[0]?.role === 'assistant') merged.shift();
  return merged.map((m) => ({ role: m.role, content: m.text }));
}

/** Инструменты агента → единое описание (одна JSON Schema на инструмент). */
export const toUnifiedTools = (tools: readonly AgentTool[]): UnifiedTool[] =>
  tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> }));

export class Orchestrator {
  private readonly gateway: LlmGateway;

  constructor(llm: LlmClient | LlmGateway) {
    this.gateway = asGateway(llm);
  }

  async runTurn(input: TurnInput): Promise<TurnResult> {
    const { settings, ctx, tools } = input;
    const route = input.route ?? resolveRoute(settings);
    const messages = toApiMessages(input.history, input.incoming);
    const clientTexts = [
      ...input.history.filter((m) => m.role === 'client').map((m) => m.text),
      ...input.incoming,
      ...(input.clientFacts ?? []),
    ];
    const apiTools = toUnifiedTools(tools);
    const system = buildSystem(settings, input.now, input.dynamic);

    const common: Common = {
      toolCalls: [],
      sources: [],
      cost: ZERO_COST,
      provider: route.primary.provider,
      model: route.primary.model,
      requestedModel: route.primary.model,
      fallbackUsed: false,
      latencyMs: 0,
      rejections: [],
    };
    const toolResults: string[] = [];

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const res = await this.gateway.chat(
        {
          system,
          messages,
          tools: apiTools,
          maxTokens: settings.model.maxTokens,
          effort: settings.model.effort,
          temperature: settings.model.temperature ?? null,
          cacheKey: `ai-door-${ctx.accountId}`,
        },
        route,
      );
      common.cost = addCost(common.cost, costOfResponse({ provider: res.provider, model: res.model }, res.usage, settings.billing.pricing));
      common.model = res.model;
      common.provider = res.provider;
      common.fallbackUsed ||= res.fallbackUsed;
      common.latencyMs += res.latencyMs;
      messages.push(res.assistantMessage);

      if (res.stopReason === 'tool_call' && res.toolCalls.length) {
        const outcomes = await Promise.all(res.toolCalls.map((u) => this.execTool(tools, ctx, u, common)));
        const handoff = outcomes.find((o) => o.handoff)?.handoff;
        if (handoff) return { ...common, kind: 'handoff', handoff };
        for (const o of outcomes) toolResults.push(o.json);
        // Все результаты — одним сообщением пользователя.
        const parts: UnifiedPart[] = res.toolCalls.map((u, k) => {
          const o = outcomes[k] ?? { json: '{}', isError: true };
          return { type: 'tool_result', toolCallId: u.id, name: u.name, content: o.json, ...(o.isError ? { isError: true } : {}) };
        });
        messages.push({ role: 'user', content: parts });
        continue;
      }
      if (res.stopReason === 'pause' || (res.stopReason === 'tool_call' && !res.toolCalls.length)) continue;
      if (res.stopReason === 'refusal') return { ...common, kind: 'blocked', reason: 'refusal' };
      if (res.stopReason === 'max_tokens') return { ...common, kind: 'blocked', reason: 'max_tokens' };

      const text = (res.text ?? '').trim();
      if (!text) return { ...common, kind: 'blocked', reason: 'empty_reply' };

      const violations = checkFacts({
        reply: text,
        toolResults,
        clientTexts,
        catalogConsulted: common.toolCalls.some((c) => CATALOG_TOOLS.has(c.name) && c.ok),
        forbiddenTopics: settings.behavior.forbiddenTopics,
      });
      if (violations.length === 0) {
        const searches = common.toolCalls.filter((c) => SEARCH_TOOLS.has(c.name));
        const missed = searches.length > 0 && searches.every((c) => c.empty || !c.ok);
        return { ...common, kind: 'reply', text, missed };
      }
      common.rejections.push(violations);
      if (common.rejections.length > MAX_REJECTIONS) {
        return { ...common, kind: 'blocked', reason: `fact_check: ${describeViolations(violations)}` };
      }
      messages.push({
        role: 'user',
        content:
          `[Автоматическая проверка — это не сообщение клиента] Ответ не отправлен: ${describeViolations(violations)}. ` +
          'Получите данные через инструменты или уберите неподтверждённое, затем напишите ответ клиенту заново.',
      });
    }
    return { ...common, kind: 'blocked', reason: 'too_many_iterations' };
  }

  private async execTool(
    tools: readonly AgentTool[],
    ctx: ToolContext,
    use: { id: string; name: string; args: Record<string, unknown> },
    common: Common,
  ): Promise<{ json: string; isError: boolean; handoff?: HandoffRequest }> {
    const started = Date.now();
    const tool = toolByName(tools, use.name);
    const trace: ToolCallTrace = {
      name: use.name,
      specName: tool?.specName ?? use.name,
      input: use.args,
      ok: false,
      empty: false,
      durationMs: 0,
    };
    common.toolCalls.push(trace);
    try {
      if (!tool) throw new Error(`Неизвестный инструмент ${use.name}`);
      const parsed = tool.input.safeParse(use.args);
      if (!parsed.success) throw new Error(`Некорректные параметры: ${parsed.error.issues.map((x) => x.message).join('; ')}`);
      const out = await tool.run(ctx, parsed.data);
      trace.ok = true;
      trace.empty = Boolean(out.empty);
      for (const s of out.sources ?? []) {
        if (!common.sources.some((x) => x.type === s.type && x.id === s.id)) common.sources.push(s);
      }
      if (out.calculation) common.calculation = out.calculation as CalcResult;
      return { json: JSON.stringify(out.content), isError: false, ...(out.handoff ? { handoff: out.handoff } : {}) };
    } catch (err) {
      trace.error = (err as Error).message;
      return { json: JSON.stringify({ error: trace.error }), isError: true };
    } finally {
      trace.durationMs = Date.now() - started;
    }
  }
}
