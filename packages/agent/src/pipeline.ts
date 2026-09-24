import type { AmoApiClient } from '@ai-door/amo';
import type { CatalogRepo } from '@ai-door/catalog';
import type { DialogRepo, JournalRepo, PendingMessage, SettingsRepo, WidgetSettings } from '@ai-door/db';
import type { KnowledgeRepo } from '@ai-door/knowledge';
import { AmoCrm, PHASE1_TOOLS, type HandoffReason } from '@ai-door/tools';
import { LlmUnavailableError } from './llm.ts';
import type { Orchestrator, TurnResult } from './orchestrator.ts';

export interface AmoAccess {
  api: AmoApiClient;
  accessToken(): Promise<string>;
  accountDomain: string;
}

export interface PipelineDeps {
  settings: SettingsRepo;
  dialog: DialogRepo;
  journal: JournalRepo;
  catalog: CatalogRepo;
  knowledge: KnowledgeRepo;
  orchestrator: Orchestrator;
  amo(accountId: number): Promise<AmoAccess>;
  /** Ответ в чат через Salesbot (continue). Пустой список — просто продолжить бота. */
  send(access: AmoAccess, returnUrl: string, messages: string[]): Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export type PipelineOutcome =
  | { status: 'empty' }
  | { status: 'skipped'; reason: string }
  | { status: 'replied'; text: string }
  | { status: 'handoff'; reason: HandoffReason };

const REASON_TEXT: Record<HandoffReason, string> = {
  client_request: 'Клиент просит связаться с менеджером',
  complaint: 'Жалоба / недовольство клиента',
  discount: 'Вопрос о скидке',
  custom_order: 'Нестандартный заказ',
  legal_entity: 'Покупка на юрлицо',
  wholesale: 'Оптовый заказ',
  return: 'Возврат / рекламация',
  no_answer: 'AI не нашёл ответа',
  other: 'Нужен менеджер',
};

/** Сколько смотреть назад, если AI ещё не отвечал в сделке. */
const MANAGER_LOOKBACK_MS = 7 * 24 * 3600_000;

export class DialogPipeline {
  constructor(private readonly d: PipelineDeps) {}

  /** Обрабатывает накопившуюся серию сообщений клиента по сделке. */
  async processLead(accountId: number, leadId: number): Promise<PipelineOutcome> {
    try {
      return await this.process(accountId, leadId);
    } finally {
      await this.flushSendErrors(accountId, leadId);
    }
  }

  private async process(accountId: number, leadId: number): Promise<PipelineOutcome> {
    const pending = await this.d.dialog.takePending(accountId, leadId);
    if (!pending.length) return { status: 'empty' };
    for (const m of pending) await this.d.dialog.addMessage(accountId, leadId, 'client', m.text);

    const { settings } = await this.d.settings.get(accountId);
    const access = await this.d.amo(accountId);
    const skip = async (reason: string, summary: string): Promise<PipelineOutcome> => {
      await this.release(access, pending, []);
      await this.d.journal.add({ accountId, leadId, kind: 'skipped', summary, details: { reason } });
      return { status: 'skipped', reason };
    };

    if (!settings.enabled || settings.mode === 'off') return skip('disabled', 'AI выключен');
    // Фаза 1: клиенту пишет только режим «Автоматический». Полуавто и подсказки — фаза 2.
    if (settings.mode !== 'auto') return skip('mode', `Режим «${settings.mode}» — ответ клиенту не отправляется`);

    const state = await this.d.dialog.state(accountId, leadId);
    if (state.paused) return skip('paused', `AI на паузе: ${state.pauseReason ?? ''}`);

    const lead = await access.api.getLead(leadId);
    if (!lead) return skip('no_lead', 'Сделка не найдена');
    if (settings.where.pipelineIds && !settings.where.pipelineIds.includes(lead.pipeline_id)) {
      return skip('pipeline', 'Воронка не входит в список работы AI');
    }
    if (settings.where.disabledStatusIds.includes(lead.status_id)) {
      await this.d.dialog.pause(accountId, leadId, 'status_without_ai');
      return skip('status', 'Этап сделки — «без AI»');
    }

    // Менеджер уже пишет клиенту — AI замолкает (раздел 6 ТЗ).
    const now = this.d.now?.() ?? new Date();
    const since = state.lastAiAt ?? new Date(now.getTime() - MANAGER_LOOKBACK_MS);
    const outgoing = await access.api.getOutgoingChatEvents(leadId, since);
    if (outgoing.some((e) => e.created_by > 0)) {
      await this.d.dialog.pause(accountId, leadId, 'manager_message');
      await this.d.journal.add({ accountId, leadId, kind: 'pause', summary: 'Менеджер написал клиенту — AI на паузе' });
      return skip('manager', 'Менеджер ведёт диалог');
    }

    if (settings.limits.dailyRub !== null) {
      const spent = await this.d.journal.spentTodayRub(accountId);
      if (spent >= settings.limits.dailyRub) {
        return skip('limit', `Дневной лимит ${settings.limits.dailyRub} ₽ исчерпан (${spent.toFixed(2)} ₽)`);
      }
    }

    const history = (await this.d.dialog.history(accountId, leadId, 40)).map((m) => ({ role: m.role, text: m.text }));
    // Новые сообщения уже в истории — отдаём историю без них и их отдельно.
    const past = history.slice(0, history.length - pending.length);
    const ctx = {
      accountId,
      catalog: this.d.catalog,
      knowledge: this.d.knowledge,
      crm: new AmoCrm(access.api, leadId),
    };

    let result: TurnResult;
    try {
      result = await this.d.orchestrator.runTurn({
        settings,
        history: past,
        incoming: pending.map((m) => m.text),
        ctx,
        tools: PHASE1_TOOLS,
        now,
      });
    } catch (err) {
      const unavailable = err instanceof LlmUnavailableError;
      await this.d.journal.add({
        accountId,
        leadId,
        kind: 'error',
        summary: unavailable ? 'LLM недоступна (основная и резервная модели)' : `Ошибка AI: ${(err as Error).message}`,
      });
      return this.handoff(access, settings, accountId, leadId, pending, 'no_answer', 'AI временно недоступен. Клиент ждёт ответа.');
    }

    const cost = { costUsd: result.cost.usd, costRub: result.cost.usd * settings.billing.usdRubRate };
    const details = {
      model: result.model,
      toolCalls: result.toolCalls,
      sources: result.sources,
      rejections: result.rejections,
      incoming: pending.map((m) => m.text),
    };
    const tokens = { inputTokens: result.cost.inputTokens, outputTokens: result.cost.outputTokens, ...cost };

    if (result.kind === 'handoff') {
      await this.d.journal.add({ accountId, leadId, kind: 'handoff', summary: REASON_TEXT[result.handoff.reason], details, ...tokens });
      return this.handoff(access, settings, accountId, leadId, pending, result.handoff.reason, result.handoff.summary);
    }
    if (result.kind === 'blocked') {
      await this.d.journal.add({ accountId, leadId, kind: 'blocked', summary: `Ответ не отправлен: ${result.reason}`, details, ...tokens });
      return this.handoff(access, settings, accountId, leadId, pending, 'no_answer', `AI не смог дать проверенный ответ (${result.reason}).`);
    }

    const misses = await this.d.dialog.registerTurn(accountId, leadId, result.missed);
    if (settings.where.typingDelay) await (this.d.sleep ?? defaultSleep)(Math.min(1500 + result.text.length * 25, 8000));
    await this.d.journal.add({ accountId, leadId, kind: 'reply', summary: result.text, details, ...tokens });

    if (misses >= 2) {
      await this.d.dialog.addMessage(accountId, leadId, 'ai', result.text);
      return this.handoff(access, settings, accountId, leadId, pending, 'no_answer', 'AI дважды подряд не нашёл ответа.', [result.text]);
    }
    await this.release(access, pending, [result.text]);
    await this.d.dialog.addMessage(accountId, leadId, 'ai', result.text);
    return { status: 'replied', text: result.text };
  }

  /** Передача менеджеру: пауза, задача, резюме, этап (опционально), фраза клиенту. */
  private async handoff(
    access: AmoAccess,
    settings: WidgetSettings,
    accountId: number,
    leadId: number,
    pending: PendingMessage[],
    reason: HandoffReason,
    summary: string,
    before: string[] = [],
  ): Promise<PipelineOutcome> {
    await this.d.dialog.pause(accountId, leadId, `handoff:${reason}`);
    const phrase = settings.behavior.handoffPhrase;
    const h = settings.handoff;
    const now = this.d.now?.() ?? new Date();
    const steps = await Promise.allSettled([
      access.api.createTask({
        text: `AI: ${REASON_TEXT[reason]}. ${summary}`.slice(0, 1000),
        completeTill: new Date(now.getTime() + h.taskDeadlineMin * 60_000),
        leadId,
        taskTypeId: h.taskTypeId,
        ...(h.responsibleUserId ? { responsibleUserId: h.responsibleUserId } : {}),
      }),
      access.api.addLeadNote(leadId, `[AI] Передано менеджеру: ${REASON_TEXT[reason]}\n${summary}`),
      h.statusId ? access.api.setLeadStatus(leadId, h.statusId) : Promise.resolve(),
    ]);
    const failed = steps.filter((s) => s.status === 'rejected').map((s) => String((s as PromiseRejectedResult).reason));
    await this.release(access, pending, [...before, phrase]);
    await this.d.dialog.addMessage(accountId, leadId, 'ai', phrase);
    await this.d.journal.add({
      accountId,
      leadId,
      kind: 'handoff',
      summary: `Передано менеджеру: ${REASON_TEXT[reason]}`,
      details: { reason, summary, errors: failed },
    });
    return { status: 'handoff', reason };
  }

  /** Отвечает последнему боту пачки, остальные просто продолжает. */
  private async release(access: AmoAccess, pending: PendingMessage[], messages: string[]): Promise<void> {
    const sink = this.sendErrors.get(key(pending)) ?? [];
    const withUrl = pending.filter((m) => m.returnUrl);
    for (const [i, m] of withUrl.entries()) {
      try {
        await this.d.send(access, m.returnUrl as string, i === withUrl.length - 1 ? messages : []);
      } catch (err) {
        sink.push((err as Error).message);
        this.sendErrors.set(key(pending), sink);
      }
    }
  }

  /** Ошибки отправки по сделке (воркер обрабатывает сделки параллельно). */
  private readonly sendErrors = new Map<string, string[]>();

  /** Ошибки отправки в Salesbot за последний processLead (для журнала). */
  private async flushSendErrors(accountId: number, leadId: number): Promise<void> {
    const k = `${accountId}:${leadId}`;
    const errors = this.sendErrors.get(k);
    if (!errors?.length) return;
    this.sendErrors.delete(k);
    await this.d.journal.add({ accountId, leadId, kind: 'error', summary: 'Не удалось отправить ответ в чат', details: { errors } });
  }
}

const key = (pending: PendingMessage[]) => `${pending[0]?.accountId}:${pending[0]?.leadId}`;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
