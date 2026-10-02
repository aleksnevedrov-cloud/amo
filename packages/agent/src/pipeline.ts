import { resolveTaskAssignee, type AmoApiClient, type TaskAssignee } from '@ai-door/amo';
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
  formatWazzupHistory,
  normalizePhone,
  type WazzupContentItem,
  type WazzupHistoryItem,
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
import { PROVIDER_LABELS, type ChatRoute, type LlmGateway } from '@ai-door/llm';
import { asGateway, LlmUnavailableError, type LlmClient } from './llm.ts';
import type { AccountAi, AiProvider } from './provider.ts';
import type { HistoryMessage, Orchestrator, TurnResult } from './orchestrator.ts';
import { resolveRoute } from './route.ts';
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
  /** Переписка из Wazzup по телефону контакта (RFD-AI-AGENT-WAZZUP-HISTORY); нет — блок не добавляется. */
  wazzup?: {
    historyByPhone(accountId: number, phone: string, limit?: number): Promise<WazzupHistoryItem[]>;
    incomingContent?(accountId: number, phones: string[], from: Date, to: Date): Promise<WazzupContentItem[]>;
    markConsumed?(accountId: number, ids: number[]): Promise<void>;
  };
  suggestions: SuggestionsRepo;
  /** Общие LLM и оркестратор (серверный ключ); null — только ключи аккаунтов через `ai`. */
  orchestrator: Orchestrator | null;
  /** Для резюме диалога (сырой клиент Anthropic или единый шлюз). */
  llm: LlmClient | LlmGateway | null;
  /** LLM по аккаунту (свой ключ или серверный) — приоритетнее общих. */
  ai?: AiProvider;
  amo(accountId: number): Promise<AmoAccess>;
  /** Ответ в чат через Salesbot (continue). Пустой список — просто продолжить бота. */
  send(access: AmoAccess, returnUrl: string, messages: string[]): Promise<void>;
  /** Провайдер распознавания речи по настройкам; null — выключено или нет ключа. */
  stt?(provider: WidgetSettings['stt']['provider']): SttProvider | null;
  download?: typeof downloadAttachment;
  /** Пауза перед повторным поиском вложения в Wazzup (мс); в тестах 0. */
  wazzupRetryMs?: number;
  /** Почта: ответы письмом и признак ответа менеджера. */
  email?: {
    reply(accountId: number, leadId: number, meta: Record<string, unknown>, text: string): Promise<unknown>;
    managerRepliedSince(accountId: number, addresses: string[], since: Date): Promise<boolean>;
  };
  /** Разбор вложений (фаза 3): фото, сканы, PDF/XLSX/DOCX → факты для агента и примечание менеджеру. */
  documents?: DocumentAnalyzer;
  /** Аналитика (фаза 4): стартовый этап сделки при первом контакте AI. */
  outcomes?: { start(accountId: number, leadId: number, pipelineId: number, statusId: number): Promise<void> };
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface DocumentAnalyzer {
  analyze(input: {
    accountId: number;
    leadId: number;
    source: 'chat';
    filename: string;
    mime: string;
    bytes: Uint8Array;
    settings: WidgetSettings;
  }): Promise<{ id: number; kind: string; text: string; note: string; memoryOpenings: MemoryOpening[]; costUsd: number; model: string }>;
}

type MemoryOpening = { room?: string; width_mm?: number; height_mm?: number; wall_mm?: number; qty?: number };

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

/** Заглушка hook'а Salesbot для сообщения без текста (вложение, стикер) — повод искать вложение в Wazzup. */
const isEmptyPlaceholder = (text: string): boolean => {
  const v = text.trim();
  return !v || v.startsWith('(клиент отправил сообщение без текста');
};
const WAZZUP_ATTACH_WINDOW_MS = 3 * 60_000;
const WAZZUP_ATTACH_RETRY_MS = 5_000;
/** Тип вложения Wazzup → MIME для существующих веток разбора (vision/документы/STT). */
const wazzupMime = (type: string | null): string =>
  type === 'image' ? 'image/jpeg' : type === 'audio' ? 'audio/ogg' : type === 'video' ? 'video/mp4' : 'application/octet-stream';

interface Turn {
  accountId: number;
  leadId: number;
  settings: WidgetSettings;
  access: AmoAccess;
  pending: PendingMessage[];
  texts: string[];
  sendErrors: string[];
  /** Проёмы из разобранных замерных листов — в память клиента. */
  openings: MemoryOpening[];
  ai: AccountAi | null;
  /** Провайдер и модель хода: сделка > этап > воронка > настройки (раздел 3 ТЗ 1.1.0). */
  route: ChatRoute;
  /** Получатель задач агента на этом ходу (считается один раз, лениво). */
  assignee?: Promise<TaskAssignee>;
}

export class DialogPipeline {
  constructor(private readonly d: PipelineDeps) {}

  /** Обрабатывает накопившуюся серию сообщений клиента по сделке. */
  async processLead(accountId: number, leadId: number): Promise<PipelineOutcome> {
    const pending = await this.d.dialog.takePending(accountId, leadId);
    if (!pending.length) return { status: 'empty' };
    const { settings } = await this.d.settings.get(accountId);
    const access = await this.d.amo(accountId);
    const ai: AccountAi | null =
      (await this.d.ai?.(accountId)) ??
      (this.d.orchestrator && this.d.llm
        ? { llm: asGateway(this.d.llm), orchestrator: this.d.orchestrator, source: 'server' as const, providers: ['anthropic'], keySources: { anthropic: 'server' } }
        : null);
    const t: Turn = { accountId, leadId, settings, access, pending, texts: [], sendErrors: [], openings: [], ai, route: resolveRoute(settings) };
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
    if (!t.ai) {
      const label = PROVIDER_LABELS[settings.model.provider]?.split(' ')[0] ?? 'Anthropic';
      await this.journal(t, { kind: 'error', summary: `Ключ ${label} не задан — ни у аккаунта, ни на сервере` });
      return this.handoff(t, 'no_answer', `AI не настроен: нет ключа ${label}. Клиент ждёт ответа.`);
    }

    const lead = await access.api.getLead(leadId);
    if (!lead) return this.skip(t, 'no_lead', 'Сделка не найдена');
    if (settings.where.pipelineIds && !settings.where.pipelineIds.includes(lead.pipeline_id)) {
      return this.skip(t, 'pipeline', 'Воронка не входит в список работы AI');
    }
    if (settings.where.disabledStatusIds.includes(lead.status_id)) {
      await this.d.dialog.pause(accountId, leadId, 'status_without_ai');
      return this.skip(t, 'status', 'Этап сделки — «без AI»');
    }
    await this.d.outcomes?.start(accountId, leadId, lead.pipeline_id, lead.status_id).catch(() => undefined);

    let state = await this.d.dialog.state(accountId, leadId);
    t.route = resolveRoute(settings, { pipelineId: lead.pipeline_id, statusId: lead.status_id, lead: state.llm });
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
    // Проёмы из вложений (чат — разобраны здесь, почта — при опросе ящика) сохраняем до ответа.
    const fromEmail = emails.flatMap((m) => (Array.isArray(m.meta.openings) ? (m.meta.openings as MemoryOpening[]) : []));
    if (t.openings.length || fromEmail.length) await this.d.memory.update(accountId, subject, { openings: [...t.openings, ...fromEmail].slice(0, 50) });
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
      crm: new AmoCrm(access.api, leadId, () => this.taskAssignee(t)),
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
    // Переписка менеджера с клиентом в мессенджере (Wazzup) — по телефону основного контакта сделки.
    this.lastMessengerCount = 0;
    const messengerText = await this.messengerHistory(accountId, access, contactRef?.id ?? null, history);

    let result: TurnResult;
    try {
      result = await t.ai.orchestrator.runTurn({
        settings,
        history: past,
        incoming: t.texts,
        ctx,
        tools,
        now,
        dynamic: { memory: memoryText, messenger: messengerText, pricing: pricingCodesHint(rules), channel: emails.length && !chats.length ? 'email' : 'chat' },
        clientFacts,
        route: t.route,
      });
    } catch (err) {
      const unavailable = err instanceof LlmUnavailableError ? err : null;
      await this.journal(t, {
        kind: 'error',
        summary: unavailable ? `LLM недоступна (основная и резервная модели): ${unavailable.message}`.slice(0, 500) : `Ошибка AI: ${(err as Error).message}`,
        details: { provider: t.route.primary.provider, model: t.route.primary.model, ...(unavailable ? { attempts: unavailable.attempts } : {}) },
      });
      const missing = unavailable?.attempts.find((a) => a.code === 'not_found');
      if (missing) await this.modelMissing(t, missing.ref);
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
    if (result.fallbackUsed && result.model !== result.requestedModel) await this.noteFallback(t, result);
    const details = {
      wazzupMessages: this.lastMessengerCount,
      provider: result.provider,
      model: result.model,
      requestedModel: result.requestedModel,
      fallbackUsed: result.fallbackUsed,
      latencyMs: result.latencyMs,
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
  /** История мессенджера для промпта: телефон контакта → последние сообщения без собственных ответов агента. */
  /** Сколько сообщений Wazzup попало в контекст последнего хода (для журнала). */
  private lastMessengerCount = 0;

  private async messengerHistory(
    accountId: number,
    access: AmoAccess,
    contactId: number | null,
    own: { role: string; text: string }[],
  ): Promise<string | null> {
    if (!this.d.wazzup || !contactId) return null;
    try {
      const contact = await access.api.getContact(contactId);
      const raw = contact?.custom_fields_values?.find((f) => f.field_code === 'PHONE')?.values?.[0]?.value;
      const phone = normalizePhone(typeof raw === 'string' ? raw : null);
      if (!phone) return null;
      const items = await this.d.wazzup.historyByPhone(accountId, phone, 40);
      if (!items.length) return null;
      // Исходящие, совпадающие с ответами агента, уже есть в истории диалога — не дублируем.
      const ownTexts = new Set(own.filter((m) => m.role !== 'client').map((m) => m.text.trim()));
      const { text, count } = formatWazzupHistory(items, ownTexts);
      this.lastMessengerCount = count;
      return text;
    } catch (err) {
      await this.d.journal.add({ accountId, kind: 'error', summary: `Wazzup: не удалось собрать историю мессенджера: ${(err as Error).message}` }).catch(() => undefined);
      return null;
    }
  }

  private async incomingTexts(t: Turn): Promise<string[]> {
    const out: string[] = [];
    for (const m of t.pending) {
      if (!m.attachmentUrl && isEmptyPlaceholder(m.text)) {
        // Salesbot не передаёт вложения: фото/файл/голос берём из вебхуков Wazzup по телефону клиента.
        const picked = await this.wazzupAttachments(t, m);
        if (picked.length) {
          for (const pm of picked) out.push(await this.pendingText(t, pm));
          continue;
        }
      }
      out.push(await this.pendingText(t, m));
    }
    return out;
  }

  /** Текст одного входящего: как есть, разбор файла/фото или расшифровка голосового. */
  private async pendingText(t: Turn, m: PendingMessage): Promise<string> {
    if (!m.attachmentUrl) return m.text;
    if (!isAudio(m.attachmentType)) return this.attachmentText(t, m);
    const stt = this.d.stt?.(t.settings.stt.provider) ?? null;
    if (!stt) return [m.text, '(клиент отправил голосовое сообщение; расшифровка выключена — попросите написать текстом)'].filter(Boolean).join('\n');
    try {
      const file = await (this.d.download ?? downloadAttachment)(m.attachmentUrl);
      const text = await stt.transcribe(file.bytes, file.mime);
      await this.journal(t, { kind: 'note', summary: `Голосовое расшифровано (${stt.name})`, details: { text } });
      return text ? `[Голосовое сообщение] ${text}` : '(голосовое сообщение без распознанной речи)';
    } catch (err) {
      await this.journal(t, { kind: 'error', summary: `Расшифровка голосового: ${(err as Error).message}` });
      return '(клиент отправил голосовое сообщение, расшифровать не удалось — попросите написать текстом)';
    }
  }

  /** Телефоны основного контакта сделки (все значения поля PHONE), нормализованные под chatId Wazzup. */
  private async leadPhones(t: Turn): Promise<string[]> {
    try {
      const lead = await t.access.api.getLead(t.leadId);
      const ref = lead?._embedded?.contacts?.find((c) => c.is_main) ?? lead?._embedded?.contacts?.[0];
      if (!ref) return [];
      const contact = await t.access.api.getContact(ref.id);
      const values = contact?.custom_fields_values?.find((f) => f.field_code === 'PHONE')?.values ?? [];
      const phones = values.map((v) => normalizePhone(typeof v.value === 'string' ? v.value : null)).filter((x): x is string => Boolean(x));
      return [...new Set(phones)];
    } catch {
      return [];
    }
  }

  /** Вложения клиента из Wazzup в окне ±3 мин от получения сообщения; пусто → одна повторная попытка через 5 с. */
  private async wazzupAttachments(t: Turn, m: PendingMessage): Promise<PendingMessage[]> {
    const wz = this.d.wazzup;
    if (!wz?.incomingContent) return [];
    const phones = await this.leadPhones(t);
    if (!phones.length) return [];
    const from = new Date(m.receivedAt.getTime() - WAZZUP_ATTACH_WINDOW_MS);
    const to = new Date(m.receivedAt.getTime() + WAZZUP_ATTACH_WINDOW_MS);
    let items = await wz.incomingContent(t.accountId, phones, from, to);
    if (!items.length) {
      await new Promise((r) => setTimeout(r, this.d.wazzupRetryMs ?? WAZZUP_ATTACH_RETRY_MS));
      items = await wz.incomingContent(t.accountId, phones, from, to);
    }
    if (!items.length) return [];
    await wz.markConsumed?.(t.accountId, items.map((i) => i.id));
    await this.journal(t, {
      kind: 'note',
      summary: `Вложение из Wazzup: ${items.map((i) => i.contentType ?? 'file').join(', ')} — ${items.length} шт.`,
      details: { items: items.map((i) => ({ id: i.id, contentUri: i.contentUri, type: i.contentType })) },
    });
    return items.map((i) => ({
      ...m,
      text: /^\[[a-z_]+\]$/i.test(i.text.trim()) ? '' : i.text,
      attachmentUrl: i.contentUri,
      attachmentType: wazzupMime(i.contentType),
    }));
  }

  /** Файл или фото из чата: разбор (фаза 3) или пометка, если разбор недоступен. */
  private async attachmentText(t: Turn, m: PendingMessage): Promise<string> {
    const url = m.attachmentUrl as string;
    const filename = decodeURIComponent(new URL(url, 'https://x').pathname.split('/').pop() ?? '') || 'файл';
    if (!this.d.documents || !t.settings.vision.autoParse) {
      return [m.text, `(клиент отправил файл «${filename}» — разбор вложений выключен, попросите описать словами)`].filter(Boolean).join('\n');
    }
    try {
      const file = await (this.d.download ?? downloadAttachment)(url);
      const r = await this.d.documents.analyze({ accountId: t.accountId, leadId: t.leadId, source: 'chat', filename, mime: file.mime, bytes: file.bytes, settings: t.settings });
      t.openings.push(...r.memoryOpenings);
      await this.journal(t, { kind: 'document', summary: `Разобран файл «${filename}» (${r.kind})`, details: { documentId: r.id, model: r.model, text: r.text }, costUsd: r.costUsd, costRub: r.costUsd * t.settings.billing.usdRubRate });
      if (t.settings.vision.noteInLead) await t.access.api.addLeadNote(t.leadId, r.note).catch(() => undefined);
      return [m.text, r.text].filter(Boolean).join('\n');
    } catch (err) {
      await this.journal(t, { kind: 'error', summary: `Разбор файла «${filename}»: ${(err as Error).message}` });
      return [m.text, `(клиент отправил файл «${filename}», разобрать не удалось — попросите описать словами или передайте менеджеру)`].filter(Boolean).join('\n');
    }
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
    if (ctx && t.ai) {
      try {
        const s = await summarizeDialog(t.ai.llm, settings, { history: ctx.history, memoryText: ctx.memoryText, route: t.route });
        note = `[AI] Передано менеджеру: ${REASON_TEXT[reason]}\n\n${s.text}`;
        await this.d.memory.setSummary(accountId, ctx.subject, s.text);
        await this.journal(t, { kind: 'summary', summary: s.text, details: { provider: s.provider, model: s.model, fallbackUsed: s.fallbackUsed }, costUsd: s.cost.usd, costRub: s.cost.usd * settings.billing.usdRubRate, inputTokens: s.cost.inputTokens, outputTokens: s.cost.outputTokens });
      } catch {
        // Резюме не критично: остаётся краткое от агента.
      }
    }
    const assignee = await this.taskAssignee(t);
    const steps = await Promise.allSettled([
      access.api.createTask({
        text: `AI: ${REASON_TEXT[reason]}. ${summary}`.slice(0, 1000),
        completeTill: new Date(now.getTime() + h.taskDeadlineMin * 60_000),
        leadId,
        taskTypeId: h.taskTypeId,
        ...(assignee.userId ? { responsibleUserId: assignee.userId } : {}),
      }),
      access.api.addLeadNote(leadId, note),
      h.statusId ? access.api.setLeadStatus(leadId, h.statusId) : Promise.resolve(),
    ]);
    const failed = steps.filter((s) => s.status === 'rejected').map((s) => String((s as PromiseRejectedResult).reason));
    // В «Полуавто» клиенту ничего не уходит без одобрения — фраза передачи тоже.
    const phrase = settings.mode === 'auto' ? [settings.behavior.handoffPhrase] : [];
    await this.release(t, [...before, ...phrase]);
    if (phrase.length) await this.d.dialog.addMessage(accountId, leadId, 'ai', phrase[0] as string);
    await this.journal(t, { kind: 'handoff', summary: `Передано менеджеру: ${REASON_TEXT[reason]}`, details: { reason, summary, errors: failed, assignee } });
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

  /** Ответ дала резервная модель — отметка «fallback» в журнале (критерий 6 приёмки 1.1.0). */
  private async noteFallback(t: Turn, r: TurnResult): Promise<void> {
    await this.journal(t, {
      kind: 'note',
      summary: `fallback: ${t.route.primary.provider}/${r.requestedModel} недоступна, ответ дала ${r.provider}/${r.model}`,
      details: { fallback: true, provider: r.provider, model: r.model, requestedModel: r.requestedModel, requestedProvider: t.route.primary.provider },
    });
  }

  /**
   * Модель пропала из API провайдера (раздел 4 ТЗ): предупреждение в журнал (видно в статусе здоровья интеграций)
   * и задача ответственному по настройке — не чаще раза в сутки на модель.
   */
  private async modelMissing(t: Turn, ref: { provider: string; model: string }): Promise<void> {
    const summary = `Модель ${ref.provider}/${ref.model} недоступна у провайдера — проверьте настройки «Модель»`;
    const recent = await this.d.journal.countRecent(t.accountId, 'error', summary, 24 * 3600_000).catch(() => 1);
    if (recent > 0) return;
    await this.journal(t, { kind: 'error', summary, details: { modelMissing: true, provider: ref.provider, model: ref.model } });
    const h = t.settings.handoff;
    const now = this.d.now?.() ?? new Date();
    const assignee = await this.taskAssignee(t);
    await t.access.api
      .createTask({
        text: `AI: ${summary}. Выберите другую модель в настройках AI-агента.`,
        completeTill: new Date(now.getTime() + h.taskDeadlineMin * 60_000),
        leadId: t.leadId,
        taskTypeId: h.taskTypeId,
        ...(assignee.userId ? { responsibleUserId: assignee.userId } : {}),
      })
      .catch(() => undefined);
  }

  /**
   * Получатель задач агента: ответственный по сделке, иначе «администратор для задач», иначе первый активный
   * администратор. Считается один раз на ход; при подмене — примечание в сделку.
   */
  private taskAssignee(t: Turn): Promise<TaskAssignee> {
    if (!t.assignee) {
      const h = t.settings.handoff;
      t.assignee = resolveTaskAssignee(t.access.api, t.leadId, { forcedUserId: h.responsibleUserId, fallbackUserId: h.fallbackUserId })
        .then(async (a) => {
          if (a.reason === 'fallback' || a.reason === 'admin') {
            await t.access.api
              .addLeadNote(t.leadId, `AI: у сделки нет активного ответственного, задача поставлена администратору ${a.name ?? a.userId}`)
              .catch(() => undefined);
          }
          if (a.reason === 'none') await this.journal(t, { kind: 'error', summary: 'Некому поставить задачу: нет активного ответственного и администратора', details: { assignee: a } });
          return a;
        })
        .catch(async (err) => {
          await this.journal(t, { kind: 'error', summary: `Получатель задачи: ${(err as Error).message}` });
          return { userId: h.responsibleUserId, name: null, reason: 'none' as const };
        });
    }
    return t.assignee;
  }

  private journal(t: Turn, e: Omit<JournalEntry, 'accountId' | 'leadId'>) {
    return this.d.journal.add({ accountId: t.accountId, leadId: t.leadId, ...e });
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
