import { sameModel, type ChatRoute, type ModelRef } from '@ai-door/llm';
import type { WidgetSettings } from '@ai-door/db';

export interface RouteContext {
  pipelineId?: number | null;
  statusId?: number | null;
  /** Переопределение для сделки из панели карточки. */
  lead?: ModelRef | null;
}

/**
 * Провайдер и модель для хода (раздел 3 ТЗ): сделка > этап > воронка > глобальная настройка.
 * Резервная модель — из настроек; если совпадает с основной, резерва нет.
 */
export function resolveRoute(settings: WidgetSettings, ctx: RouteContext = {}): ChatRoute {
  const m = settings.model;
  const statuses = m.overrides?.statuses ?? {};
  const pipelines = m.overrides?.pipelines ?? {};
  const primary: ModelRef =
    ctx.lead ??
    (ctx.statusId != null ? statuses[String(ctx.statusId)] : undefined) ??
    (ctx.pipelineId != null ? pipelines[String(ctx.pipelineId)] : undefined) ??
    { provider: m.provider ?? 'anthropic', model: m.model };
  const fallback: ModelRef | null = m.fallbackModel ? { provider: m.fallbackProvider ?? m.provider ?? 'anthropic', model: m.fallbackModel } : null;
  return { primary, fallback: sameModel(fallback, primary) ? null : fallback };
}

/** Основная и резервная модели для интерфейса (какая модель отвечает в сделке). */
export function describeRoute(route: ChatRoute): string {
  const f = route.fallback ? ` (резерв: ${route.fallback.provider}/${route.fallback.model})` : '';
  return `${route.primary.provider}/${route.primary.model}${f}`;
}
