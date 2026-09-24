import type { CatalogRepo } from '@ai-door/catalog';
import type { KnowledgeRepo } from '@ai-door/knowledge';
import type { PricingRules } from '@ai-door/pricing';
import type { ClientMemory, MemoryPatch } from '@ai-door/db';
import type { z } from 'zod';

export interface LeadContext {
  leadId: number;
  name: string;
  budget: number | null;
  statusId: number | null;
  pipelineId: number | null;
  contactName: string | null;
  hasPhone: boolean;
  hasEmail: boolean;
  tags: string[];
  recentNotes: string[];
}

export interface HandoffRequest {
  reason: HandoffReason;
  summary: string;
}

export const HANDOFF_REASONS = [
  'client_request',
  'complaint',
  'discount',
  'custom_order',
  'legal_entity',
  'wholesale',
  'return',
  'no_answer',
  'other',
] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

/** Доступ к CRM для инструментов: боевой (amo) или песочница. */
export interface CrmPort {
  getContext(): Promise<LeadContext | null>;
  addNote(text: string): Promise<void>;
  /** Задача ответственному по сделке (или указанному в настройках). */
  createTask(t: { text: string; taskTypeId: number; deadlineMin: number }): Promise<void>;
}

export const TASK_KINDS = ['callback', 'send_offer', 'check_availability', 'measure', 'other'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** Память клиента для инструментов. */
export interface MemoryPort {
  get(): Promise<ClientMemory>;
  update(patch: MemoryPatch): Promise<ClientMemory>;
}

export interface ToolContext {
  accountId: number;
  catalog: CatalogRepo;
  knowledge: KnowledgeRepo;
  crm: CrmPort;
  /** Правила расчёта аккаунта; null — не настроены. */
  pricing?: PricingRules | null;
  memory?: MemoryPort;
  /** Типы и сроки задач из настроек. */
  tasks?: Partial<Record<TaskKind, { taskTypeId: number; deadlineMin: number }>>;
}

export interface Source {
  type: 'product' | 'knowledge';
  id: string;
  title: string;
  url?: string | null;
  date?: string;
}

export interface ToolOutcome {
  /** Отдаётся модели как tool_result (JSON). */
  content: unknown;
  /** Инструмент ничего не нашёл. */
  empty?: boolean;
  sources?: Source[];
  /** Запрошена передача менеджеру — ход завершается. */
  handoff?: HandoffRequest;
  /** Черновик детализации, посчитанный в этом ходе. */
  calculation?: unknown;
}

export interface AgentTool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Имя для API (только [a-zA-Z0-9_-]). */
  name: string;
  /** Имя из ТЗ (раздел 4) для журнала. */
  specName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  input: S;
  run(ctx: ToolContext, input: z.infer<S>): Promise<ToolOutcome>;
}

export const defineTool = <S extends z.ZodTypeAny>(t: AgentTool<S>): AgentTool<S> => t;
