import type { AmoApiClient } from '@ai-door/amo';
import type { CatalogRepo } from '@ai-door/catalog';
import {
  memorySubject,
  memoryToText,
  type DialogRepo,
  type JournalEntry,
  type JournalRepo,
  type MemoryRepo,
  type PendingMessage,
  type SettingsRepo,
  type SuggestionsRepo,
  type WidgetSettings,
} from '@ai-door/db';
import type { KnowledgeRepo } from '@ai-door/knowledge';
import { downloadAttachment, isAudio, type SttProvider } from '@ai-door/media';
import type { PricingRepo } from '@ai-door/pricing';
import {
  AmoCrm,
  PHASE2_TOOLS,
  pricingCodesHint,
  type AgentTool,
  type HandoffReason,
  type ToolContext,
} from '@ai-door/tools';
import { LlmUnavailableError, type LlmClient } from './llm.ts';
import type { HistoryMessage, Orchestrator, TurnResult } from './orchestrator.ts';
import { formatCalculation, summarizeDialog } from './summary.ts';

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
  pricing: PricingRepo;
  memory: MemoryRepo;
  suggestions: SuggestionsRepo;
  orchestrator: Orchestrator;
  /** Для резюме диалога. */
  llm: LlmClient;
  amo(accountId: number): Promise<AmoAccess>;
  /** Ответ в чат через Salesbot (continue). Пустой список — просто продолжить бота. */
  send(access: AmoAccess, returnUrl: string, messages: string[]): Promise<void>;
  /** Провайдер распознавания речи по настройкам; null — выключено или нет ключа. */
  stt?(provider: WidgetSettings['stt']['provider']): SttProvider | null;
  download?: typeof downloadAttachment;
  /** Почта: ответы письмом и признак ответа менеджера. */
  email?: {
    reply(accountId: number, leadId: number, meta: Record<string, unknown>, text: string): Promise<unknown>;
    managerRepliedSince(accountId: number, addresses: string[], since: Date): Promise<boolean>;
  };
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export type PipelineOutcome =
  | { status: 'empty' }
  | { status: 'skipped'; reason: string }
  | { status: 'replied'; text: string }
  | { status: 'drafted'; id: number }
  | { status: 'hinted'; id: number }
  | { status: 'handoff'; reason: HandoffReason };

export const REASON_TEXT: Record<HandoffReason, string> = {
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

/** Куда идёт ответ AI: клиенту, в черновик на одобрение или подсказкой менеджеру. */
type Delivery = 'send' | 'draft' | 'hint';

/** В режиме подсказок AI ничего не меняет в CRM — только читает. */
const READ_ONLY = new Set(['catalog_search', 'catalog_get_product', 'knowledge_search', 'crm_get_context', 'price_calculate']);

/** Сколько смотреть назад, если AI ещё не отвечал в сделке. */
const MANAGER_LOOKBACK_MS = 7 * 24 * 3600_000;

interface Turn {
  accountId: number;
  leadId: number;
  settings: WidgetSettings;
  access: AmoAccess;
  pending: PendingMessage[];
  texts: string[];
  sendErrors: string[];
}

export class DialogPipeline {
  constructor(private readonly d: PipelineDeps) {}

  /** Обрабатывает накопившуюся серию сообщений клиента по сделке. */
  async processLead(accountId: number, leadId: number): Promise<PipelineOutcome> {
    const pending = await this.d.dialog.takePending(accountId, leadId);
    if (!pending.length) return { status: 'empty' };
    const { settings } = await this.d.settings.get(accountId);
    const access = await this.d.amo(accountId);
    const t: Turn = { accountId, leadId, settings, access, pending, texts: [], sendErrors: [] };
    try {
      t.texts = await this.incomingTexts(t);
      for (const text of t.texts) await this.d.dialog.addMessage(accountId, leadId, 'client', text);
      return await this.process(t);
    } finally {
      if (t.sendErrors.length) {
        await this.journal(t, { kind: 'error', summary: 'Не удалось отправить ответ клиенту', details: { errors: t.sendErrors } });
      }
    }
  }

  private async process(t: Turn): Promise<PipelineOutcome> {
    const { settings, access, accountId, leadId } = t;
    if (!settings.enabled || settings.mode === 'off') return this.skip(t, 'disabled', 'AI выключен');

    const lead = await access.api.getLead(leadId);
    if (!lead) return this.skip(t, 'no_lead', 'Сделка не найдена');
    if (settings.where.pipelineIds && !settings.where.pipelineIds.includes(lead.pipeline_id)) {
      return this.skip(t, 'pipeline', 'Воронка не входит в список работы AI');
    }
    if (settings.where.disabledStatusIds.includes(lead.status_id)) {
      await this.d.dialog.pause(accountId, leadId, 'status_without_ai');
      return this.skip(t, 'status', 'Этап сделки — «без AI»');
    }

    let state = await this.d.dialog.state(accountId, leadId);
    const now = this.d.now?.() ?? new Date();
    const emails = t.pending.filter((m) => m.channel === 'email');
    const chats = t.pending.filter((m) => m.channel !== 'email');
    if (!state.paused) {
      // Менеджер уже пишет клиенту — AI замолкает (раздел 6 ТЗ): в чате — события amo, в почте — «Отправленные».
      const since = state.lastAiAt ?? new Date(now.getTime() - MANAGER_LOOKBACK_MS);
      const chatManager = chats.length ? (await access.api.getOutgoingChatEvents(leadId, since)).some((e) => e.created_by > 0) : false;
      const addresses = emails.map((m) => String(m.meta.from ?? '')).filter(Boolean);
      const mailManager = addresses.length && this.d.email ? await this.d.email.managerRepliedSince(accountId, addresses, since) : false;
      if (chatManager || mailManager) {
        await this.d.dialog.pause(accountId, leadId, 'manager_message');
        await this.journal(t, { kind: 'pause', summary: 'Менеджер написал клиенту — AI на паузе' });
        state = await this.d.dialog.state(accountId, leadId);
      }
    }

    let delivery: Delivery = settings.mode === 'auto' ? 'send' : settings.mode === 'semi' ? 'draft' : 'hint';
    if (state.paused) {
      if (!settings.hints.whenPaused) {
        return this.skip(t, state.pauseReason === 'manager_message' ? 'manager' : 'paused', `AI на паузе: ${state.pauseReason ?? ''}`);
      }
      delivery = 'hint';
    }

    if (settings.limits.dailyRub !== null) {
      const spent = await this.d.journal.spentTodayRub(accountId);
      if (spent >= settings.limits.dailyRub) {
        const note = `Дневной лимит ${settings.limits.dailyRub} ₽ исчерпан (${spent.toFixed(2)} ₽)`;
        if (settings.limits.onExceed === 'stop' || delivery === 'hint') return this.skip(t, 'limit', note);
        if (settings.limits.onExceed === 'handoff') return this.handoff(t, 'other', note);
        delivery = 'hint';
      }
    }
    if (delivery !== 'hint' && settings.limits.maxAiMessagesPerLead !== null) {
      const count = await this.d.dialog.aiMessagesCount(accountId, leadId);
      if (count >= settings.limits.maxAiMessagesPerLead) {
        return this.handoff(t, 'other', `Достигнут лимит ответов AI в сделке (${count}).`);
      }
    }

    // Контекст: память клиента по основному контакту, правила цен.
    const contactRef = lead._embedded?.contacts?.find((c) => c.is_main) ?? lead._embedded?.contacts?.[0];
    const subject = memorySubject(contactRef?.id ?? null, leadId);
    const [mem, { rules }] = await Promise.all([this.d.memory.get(accountId, subject), this.d.pricing.get(accountId)]);
    const memoryText = memoryToText(mem.data, mem.summary);
    const clientFacts = [
      mem.data.budget_rub ? String(mem.data.budget_rub) : '',
      ...mem.data.openings.map((o) => `${o.width_mm ?? ''} ${o.height_mm ?? ''} ${o.wall_mm ?? ''} ${o.qty ?? ''}`),
    ].filter((x) => x.trim());
    const tools: readonly AgentTool[] = delivery === 'hint' ? PHASE2_TOOLS.filter((x) => READ_ONLY.has(x.name)) : PHASE2_TOOLS;
    const ctx: ToolContext = {
      accountId,
      catalog: this.d.catalog,
      knowledge: this.d.knowledge,
      crm: new AmoCrm(access.api, leadId),
      pricing: rules,
      tasks: settings.tasks,
      memory: {
        get: async () => (await this.d.memory.get(accountId, subject)).data,
        update: (patch) => this.d.memory.update(accountId, subject, patch),
      },
    };

    const history = (await this.d.dialog.history(accountId, leadId, 40)).map((m) => ({ role: m.role, text: m.text }));
    // Новые сообщения уже в истории — отдаём историю без них и их отдельно.
    const past = history.slice(0, history.length - t.texts.length);

    let result: TurnResult;
    try {
      result = await this.d.orchestrator.runTurn({
        settings,
        history: past,
        incoming: t.texts,
        ctx,
        tools,
        now,
        dynamic: { memory: memoryText, pricing: pricingCodesHint(rules), channel: emails.length && !chats.length ? 'email' : 'chat' },
        clientFacts,
      });
    } catch (err) {
      const unavailable = err instanceof LlmUnavailableError;
      await this.journal(t, {
        kind: 'error',
        summary: unavailable ? 'LLM недоступна (основная и резервная модели)' : `Ошибка AI: ${(err as Error).message}`,
      });
      if (delivery === 'hint') return this.skip(t, 'error', 'Подсказка не подготовлена: ошибка AI');
      return this.handoff(t, 'no_answer', 'AI временно недоступен. Клиент ждёт ответа.');
    }

    const cost = {
      inputTokens: result.cost.inputTokens,
      outputTokens: result.cost.outputTokens,
      costUsd: result.cost.usd,
      costRub: result.cost.usd * settings.billing.usdRubRate,
    };
    const lastEmail = emails.at(-1);
    const details = {
      model: result.model,
      delivery,
      channel: lastEmail && !chats.length ? 'email' : 'chat',
      ...(lastEmail ? { emailMeta: lastEmail.meta } : {}),
      toolCalls: result.toolCalls,
      sources: result.sources,
      rejections: result.rejections,
      incoming: t.texts,
      ...(result.calculation ? { calculation: result.calculation } : {}),
    };

    if (result.calculation && delivery !== 'hint') {
      await this.d.memory.update(accountId, subject, {
        last_calculation: { total_rub: result.calculation.total, complete: result.calculation.complete, at: now.toISOString() },
      });
      await access.api.addLeadNote(leadId, formatCalculation(result.calculation)).catch(() => undefined);
    }

    if (result.kind === 'handoff') {
      if (delivery === 'hint') {
        const id = await this.d.suggestions.add(accountId, leadId, 'hint', `AI рекомендует передать диалог менеджеру: ${REASON_TEXT[result.handoff.reason]}. ${result.handoff.summary}`, details);
        await this.journal(t, { kind: 'hint', summary: `Подсказка: ${REASON_TEXT[result.handoff.reason]}`, details, ...cost });
        await this.release(t, []);
        return { status: 'hinted', id };
      }
      await this.journal(t, { kind: 'handoff', summary: REASON_TEXT[result.handoff.reason], details, ...cost });
      return this.handoff(t, result.handoff.reason, result.handoff.summary, [], { history: [...past, ...t.texts.map((x) => ({ role: 'client' as const, text: x }))], memoryText, subject });
    }
    if (result.kind === 'blocked') {
      await this.journal(t, { kind: 'blocked', summary: `Ответ не отправлен: ${result.reason}`, details, ...cost });
      if (delivery !== 'send') {
        await this.release(t, []);
        return { status: 'skipped', reason: 'blocked' };
      }
      return this.handoff(t, 'no_answer', `AI не смог дать проверенный ответ (${result.reason}).`);
    }

    if (delivery === 'hint' || delivery === 'draft') {
      const id = await this.d.suggestions.add(accountId, leadId, delivery, result.text, details);
      await this.journal(t, { kind: delivery, summary: result.text, details, ...cost });
      if (delivery === 'draft') await this.d.dialog.registerTurn(accountId, leadId, result.missed);
      await this.release(t, []);
      return delivery === 'draft' ? { status: 'drafted', id } : { status: 'hinted', id };
    }

    const misses = await this.d.dialog.registerTurn(accountId, leadId, result.missed);
    if (settings.where.typingDelay && chats.length) await (this.d.sleep ?? defaultSleep)(Math.min(1500 + result.text.length * 25, 8000));
    await this.journal(t, { kind: 'reply', summary: result.text, details, ...cost });
    if (misses >= 2) {
      await this.d.dialog.addMessage(accountId, leadId, 'ai', result.text);
      return this.handoff(t, 'no_answer', 'AI дважды подряд не нашёл ответа.', [result.text]);
    }
    await this.release(t, [result.text]);
    await this.d.dialog.addMessage(accountId, leadId, 'ai', result.text);
    return { status: 'replied', text: result.text };
  }

  /** Тексты входящих: голосовые расшифровываются, прочие вложения помечаются (раздел 5, шаг 4). */
  private async incomingTexts(t: Turn): Promise<string[]> {
    const out: string[] = [];
    for (const m of t.pending) {
      if (!m.attachmentUrl) {
        out.push(m.text);
        continue;
      }
      if (!isAudio(m.attachmentType)) {
        out.push([m.text, '(клиент отправил файл или фото — разбор вложений появится позже, попросите описать словами)'].filter(Boolean).join('\n'));
        continue;
      }
      const stt = this.d.stt?.(t.settings.stt.provider) ?? null;
      if (!stt) {
        out.push([m.text, '(клиент отправил голосовое сообщение; расшифровка выключена — попросите написать текстом)'].filter(Boolean).join('\n'));
        continue;
      }
      try {
        const file = await (this.d.download ?? downloadAttachment)(m.attachmentUrl);
        const text = await stt.transcribe(file.bytes, file.mime);
        out.push(text ? `[Голосовое сообщение] ${text}` : '(голосовое сообщение без распознанной речи)');
        await this.journal(t, { kind: 'note', summary: `Голосовое расшифровано (${stt.name})`, details: { text } });
      } catch (err) {
        out.push('(клиент отправил голосовое сообщение, расшифровать не удалось — попросите написать текстом)');
        await this.journal(t, { kind: 'error', summary: `Расшифровка голосового: ${(err as Error).message}` });
      }
    }
    return out;
  }

  private async skip(t: Turn, reason: string, summary: string): Promise<PipelineOutcome> {
    await this.release(t, []);
    await this.journal(t, { kind: 'skipped', summary, details: { reason } });
    return { status: 'skipped', reason };
  }

  /** Передача менеджеру: пауза, задача, резюме (раздел 10), этап (опционально), фраза клиенту. */
  private async handoff(
    t: Turn,
    reason: HandoffReason,
    summary: string,
    before: string[] = [],
    ctx?: { history: HistoryMessage[]; memoryText: string | null; subject: string },
  ): Promise<PipelineOutcome> {
    const { accountId, leadId, settings, access } = t;
    await this.d.dialog.pause(accountId, leadId, `handoff:${reason}`);
    const h = settings.handoff;
    const now = this.d.now?.() ?? new Date();

    let note = `[AI] Передано менеджеру: ${REASON_TEXT[reason]}\n${summary}`;
    if (ctx) {
      try {
        const s = await summarizeDialog(this.d.llm, settings, { history: ctx.history, memoryText: ctx.memoryText });
        note = `[AI] Передано менеджеру: ${REASON_TEXT[reason]}\n\n${s.text}`;
        await this.d.memory.setSummary(accountId, ctx.subject, s.text);
        await this.journal(t, { kind: 'summary', summary: s.text, costUsd: s.cost.usd, costRub: s.cost.usd * settings.billing.usdRubRate, inputTokens: s.cost.inputTokens, outputTokens: s.cost.outputTokens });
      } catch {
        // Резюме не критично: остаётся краткое от агента.
      }
    }
    const steps = await Promise.allSettled([
      access.api.createTask({
        text: `AI: ${REASON_TEXT[reason]}. ${summary}`.slice(0, 1000),
        completeTill: new Date(now.getTime() + h.taskDeadlineMin * 60_000),
        leadId,
        taskTypeId: h.taskTypeId,
        ...(h.responsibleUserId ? { responsibleUserId: h.responsibleUserId } : {}),
      }),
      access.api.addLeadNote(leadId, note),
      h.statusId ? access.api.setLeadStatus(leadId, h.statusId) : Promise.resolve(),
    ]);
    const failed = steps.filter((s) => s.status === 'rejected').map((s) => String((s as PromiseRejectedResult).reason));
    // В «Полуавто» клиенту ничего не уходит без одобрения — фраза передачи тоже.
    const phrase = settings.mode === 'auto' ? [settings.behavior.handoffPhrase] : [];
    await this.release(t, [...before, ...phrase]);
    if (phrase.length) await this.d.dialog.addMessage(accountId, leadId, 'ai', phrase[0] as string);
    await this.journal(t, { kind: 'handoff', summary: `Передано менеджеру: ${REASON_TEXT[reason]}`, details: { reason, summary, errors: failed } });
    return { status: 'handoff', reason };
  }

  /** Отвечает последнему боту пачки (остальные просто продолжает) или письмом на последнее письмо клиента. */
  private async release(t: Turn, messages: string[]): Promise<void> {
    const emails = t.pending.filter((m) => m.channel === 'email');
    const chatsWithUrl = t.pending.filter((m) => m.channel !== 'email' && m.returnUrl);
    // Ответ письмом, если клиент писал только по почте (в смешанной пачке отвечаем в чат).
    const lastEmail = emails.at(-1);
    if (lastEmail && !lastEmail.meta.answered && !chatsWithUrl.length && messages.length) {
      if (!this.d.email) t.sendErrors.push('Почта не подключена');
      else {
        try {
          await this.d.email.reply(t.accountId, t.leadId, lastEmail.meta, messages.join('\n\n'));
        } catch (err) {
          t.sendErrors.push((err as Error).message);
        }
      }
      for (const m of emails) m.meta = { ...m.meta, answered: true };
    }
    const withUrl = chatsWithUrl;
    for (const [i, m] of withUrl.entries()) {
      try {
        await this.d.send(t.access, m.returnUrl as string, i === withUrl.length - 1 ? messages : []);
      } catch (err) {
        t.sendErrors.push((err as Error).message);
      }
    }
    // Повторно не отвечаем тем же ботам.
    for (const m of withUrl) m.returnUrl = null;
  }

  private journal(t: Turn, e: Omit<JournalEntry, 'accountId' | 'leadId'>) {
    return this.d.journal.add({ accountId: t.accountId, leadId: t.leadId, ...e });
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
