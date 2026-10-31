import type { AmoApiClient, AmoLead } from '@core/amo';
import { canCreateTask, taskScope } from '@core/amo';
import type { JournalRepo, ReactivationRepo, SettingsRepo, SuggestionsRepo, WidgetSettings } from '@core/db';

/**
 * Реактивация отказных сделок (RFD-AI-AGENT-REAKTIVATSIYA).
 *
 * Агент сам догоняет клиента после отказа: два касания за неделю, затем молчит навсегда.
 * Переход в «Отказ» уже ловит анализ отказов (`refusal_analyses`), поэтому своего опроса
 * событий здесь нет — догон берёт разобранные отказы и помнит исход в `reactivation_leads`.
 *
 * Правила заданы владельцем аккаунта 30.10.2026:
 *  • только воронка «Двери», этап «Закрыто и не реализовано», отказ не старше 14 дней;
 *  • только сделки с бюджетом не ниже 30 000 ₽;
 *  • два касания (2-й и 5-й день), после второго — не писать никогда;
 *  • клиент ответил — агент замолкает: дальше либо менеджер, либо шаблон «Отказ»;
 *  • причина отказа «купил у конкурента» — не продаём: одно сообщение шаблоном «Отказ»;
 *  • интерес или названный срок — сделку на этап «Заказ» (менеджеры отказы не видят) и задачу;
 *  • повторный отказ — шаблон «Отказ» (опрос отдела качества), ответ на него агент не комментирует.
 */

export const REACTIVATION_JOB = 'reactivation-poll';
export const REACTIVATION_EVERY_MS = 10 * 60_000;

const DAY_MS = 24 * 3600_000;

export type ReasonCode = 'price' | 'stock' | 'competitor' | 'changedMind' | 'universal';

/**
 * Причина отказа у агента — свободный текст модели (`refusalReason`), не перечисление,
 * поэтому набор текстов выбирается по ключевым словам. Порядок важен: «купил дешевле
 * у другого» — про конкурента, а не про цену.
 */
const REASON_RULES: readonly (readonly [ReasonCode, RegExp])[] = [
  ['competitor', /конкурент|друг(?:ой|ого|ом)\s+поставщ|в друг(?:ой|ом)\s+(?:компан|магазин|фирм)|уже\s+(?:купил|заказал|приобрел|приобрёл|постав)|взял(?:и)?\s+в\s|нашл(?:и|ё|е)л?\s+дешевл/iu],
  ['price', /дорог|цен(?:а|у|ы|е)|бюджет|дешевл|не\s+по\s+карман|скидк|стоимост/iu],
  ['stock', /налич|нет\s+на\s+склад|не\s+было\s+в\s+наличии|срок(?:и|а)?\s+поставк|долго\s+ждать|под\s+заказ/iu],
  ['changedMind', /передумал|отложи|не\s+актуальн|перенес|отмени|ремонт\s+(?:отложен|перенес)|пока\s+не\s+готов/iu],
];

/** Какой набор текстов подходит причине отказа. */
export function reasonCode(reason: string | null | undefined): ReasonCode {
  const t = (reason ?? '').trim();
  if (!t) return 'universal';
  for (const [code, re] of REASON_RULES) if (re.test(t)) return code;
  return 'universal';
}

type Texts = WidgetSettings['reactivation']['texts'];

/**
 * Текст касания: `n` — номер касания (1 или 2); напоминание пользуется текстом второго.
 * У причины «купил у конкурента» своего набора нет — она идёт отдельным сценарием
 * (одно сообщение шаблоном «Отказ»), поэтому здесь отдаётся запасной набор.
 */
export function touchText(texts: Texts, code: ReasonCode, n: 1 | 2): string {
  const set = code in texts ? texts[code as keyof Texts] : texts.universal;
  return n === 1 ? set.first : set.second;
}

/**
 * Клиент уже купил двери у другого поставщика: продавать ему нечего.
 * Такому отправляется одно сообщение — шаблон «Отказ» (опрос отдела качества), и всё.
 */
export const BOUGHT_ELSEWHERE: ReasonCode = 'competitor';

export type ReplyKind = 'interest' | 'refusal' | 'think';

export interface ReplyVerdict {
  kind: ReplyKind;
  /** Срок, который назвал клиент («через месяц», «после ремонта»); null — срока нет. */
  deadline: string | null;
}

const REFUSAL_RE =
  /не\s+интересн|не\s+нужн|уже\s+(?:купил|куплен|заказал|постав|решил)|не\s+актуальн|ничего\s+не\s+нужно|не\s+беспоко|не\s+пишите|не\s+звоните|отстан|спам|удалите\s+мой|нет,?\s+спасибо|спасибо,?\s+нет|отказ(?:ываюсь|ались)?\b/iu;
const THINK_RE = /подума|не\s+знаю\s+пока|пока\s+не\s+решил|позже|потом\s+напиш|созвон|посмотрю|надо\s+обсуд|посоветуюсь/iu;

const DEADLINE_RES: readonly RegExp[] = [
  // Число не обязательно: «через месяц» — такой же срок, как «через 2 недели».
  /через\s+(?:\d+|пару|несколько|полтора)?\s*(?:день|дня|дней|недел\p{L}*|месяц\p{L}*|год\p{L}*|полгода|полугод\p{L}*)/iu,
  /(?:в|к)\s+(?:январ|феврал|март|апрел|ма[ейя]|июн|июл|август|сентябр|октябр|ноябр|декабр)\p{L}*/iu,
  /(?:весной|летом|осенью|зимой|к\s+весне|к\s+лету|к\s+осени|к\s+зиме)/iu,
  /после\s+(?:нового\s+года|праздник\p{L}*|отпуск\p{L}*|ремонт\p{L}*|зарплат\p{L}*)/iu,
  /\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?/u,
];

/** Срок из ответа клиента в том виде, в котором он его назвал. */
export function findDeadline(text: string): string | null {
  for (const re of DEADLINE_RES) {
    const m = re.exec(text);
    if (m) return m[0].trim();
  }
  return null;
}

/**
 * Что ответил клиент. Чёткий отказ и «подумаю» разбираются по словам; всё остальное —
 * интерес, то есть сделка уходит менеджеру. Агент сам ответ не придумывает:
 * любое неоднозначное сообщение читает человек.
 */
export function classifyReply(text: string): ReplyVerdict {
  const t = text.trim();
  const deadline = findDeadline(t);
  if (REFUSAL_RE.test(t)) return { kind: 'refusal', deadline: null };
  if (deadline) return { kind: 'think', deadline };
  if (THINK_RE.test(t)) return { kind: 'think', deadline: null };
  return { kind: 'interest', deadline: null };
}

export interface ReactivationDeps {
  settings: SettingsRepo;
  journal: JournalRepo;
  reactivation: ReactivationRepo;
  suggestions: SuggestionsRepo;
  /** Разобранные отказы за период — исходный список для догона. */
  analyzedRefusals(
    accountId: number,
    since: Date,
    statusId: number,
    pipelineIds: number[],
    limit: number,
  ): Promise<{ leadId: number; eventId: string; changedAt: Date; analysis: { refusalReason: string } | null }[]>;
  amo(accountId: number): Promise<{ api: AmoApiClient }>;
  /** Отправка сообщения клиенту ботом-отправщиком; false — канал недоступен. */
  send(accountId: number, leadId: number, text: string, details: Record<string, unknown>): Promise<boolean>;
  /** Дубль касания письмом; отсутствует или false — почта не ушла. */
  email?(accountId: number, leadId: number, text: string): Promise<boolean>;
  now?(): Date;
}

const now = (d: ReactivationDeps): Date => d.now?.() ?? new Date();

export interface PlanResult {
  planned: number;
  skipped: number;
}

/** Отбор сделок в догон: возраст отказа, бюджет, воронка и этап. */
export async function planReactivations(d: ReactivationDeps, accountId: number): Promise<PlanResult> {
  const { settings } = await d.settings.get(accountId);
  const r = settings.reactivation;
  if (!settings.enabled || !r.enabled) return { planned: 0, skipped: 0 };

  const t = now(d);
  const since = new Date(t.getTime() - r.maxAgeDays * DAY_MS);
  const rows = await d.analyzedRefusals(accountId, since, r.statusId, r.pipelineIds, 200);
  if (!rows.length) return { planned: 0, skipped: 0 };

  const { api } = await d.amo(accountId);
  let planned = 0;
  let skipped = 0;
  for (const row of rows) {
    if (await d.reactivation.byLead(accountId, row.leadId)) continue;
    let lead: AmoLead | null;
    try {
      lead = await api.getLead(row.leadId);
    } catch {
      // Сбой amo: решение не принято, вернёмся к сделке следующим проходом.
      skipped += 1;
      continue;
    }
    const code = reasonCode(row.analysis?.refusalReason);
    const base = { leadId: row.leadId, eventId: row.eventId, refusedAt: row.changedAt, budget: lead?.price ?? 0, reason: row.analysis?.refusalReason ?? null, reasonCode: code };
    // Сделку уже увели с «Отказа» — ею занимается менеджер, догон не нужен.
    if (!lead || lead.status_id !== r.statusId) {
      skipped += 1;
      await d.reactivation.skip(accountId, base, lead ? 'moved' : 'no_lead');
      continue;
    }
    const budget = lead.price ?? 0;
    if (budget < r.minBudget) {
      skipped += 1;
      await d.reactivation.skip(accountId, base, 'low_budget');
      continue;
    }
    const first = new Date(row.changedAt.getTime() + r.firstTouchDay * DAY_MS);
    const id = await d.reactivation.plan(accountId, {
      leadId: row.leadId,
      eventId: row.eventId,
      refusedAt: row.changedAt,
      budget,
      reason: row.analysis?.refusalReason ?? null,
      reasonCode: code,
      nextTouchAt: first,
    });
    if (id === null) continue;
    planned += 1;
    await d.journal.add({
      accountId,
      leadId: row.leadId,
      kind: 'skipped',
      summary: `Догон после отказа запланирован: касание ${first.toISOString().slice(0, 10)}, бюджет ${budget} ₽`,
      details: { reactivationId: id, reasonCode: code, reason: row.analysis?.refusalReason ?? null, budget, refusedAt: row.changedAt.toISOString() },
    });
  }
  return { planned, skipped };
}

export interface TouchResult {
  sent: number;
  stopped: number;
  errors: number;
}

/** Писал ли сотрудник клиенту после `since` — тогда догон прекращается. */
async function managerWrote(api: AmoApiClient, leadId: number, since: Date): Promise<boolean> {
  try {
    const events = await api.getOutgoingChatEvents(leadId, since);
    return events.some((e) => e.created_by > 0);
  } catch {
    // Проверку провалить нельзя: сбой amo не должен превращаться в сообщение поверх менеджера.
    return true;
  }
}

/** Отправка касаний, которым пришёл срок. */
export async function runTouches(d: ReactivationDeps, accountId: number): Promise<TouchResult> {
  const { settings } = await d.settings.get(accountId);
  const r = settings.reactivation;
  const out: TouchResult = { sent: 0, stopped: 0, errors: 0 };
  if (!settings.enabled || !r.enabled) return out;

  const t = now(d);
  const due = await d.reactivation.due(accountId, t, r.maxPerRun);
  if (!due.length) return out;
  const { api } = await d.amo(accountId);

  for (const row of due) {
    try {
      const lead = await api.getLead(row.leadId);
      if (!lead || lead.status_id !== r.statusId) {
        await d.reactivation.stop(accountId, row.id, 'moved');
        await d.journal.add({ accountId, leadId: row.leadId, kind: 'skipped', summary: 'Догон прекращён: сделку увели с «Отказа»', details: { statusId: lead?.status_id ?? null } });
        out.stopped += 1;
        continue;
      }
      if (row.clientReplyAt) {
        await d.reactivation.stop(accountId, row.id, 'client_replied');
        out.stopped += 1;
        continue;
      }
      if (await managerWrote(api, row.leadId, row.refusedAt)) {
        await d.reactivation.stop(accountId, row.id, 'manager_active');
        await d.journal.add({ accountId, leadId: row.leadId, kind: 'skipped', summary: 'Догон прекращён: менеджер пишет клиенту сам' });
        out.stopped += 1;
        continue;
      }

      const reminder = row.state === 'reminder';
      // Клиент купил у конкурента — не продаём, а один раз спрашиваем причину и поставщика.
      const bought = row.reasonCode === BOUGHT_ELSEWHERE;
      const n: 1 | 2 = reminder || row.touches >= 1 ? 2 : 1;
      const text = bought ? r.finalTemplate : touchText(r.texts, row.reasonCode as ReasonCode, n);
      const details = { reactivationId: row.id, touch: bought ? 'final' : reminder ? 'reminder' : n, reasonCode: row.reasonCode };
      const ok = await d.send(accountId, row.leadId, text, details);
      if (!ok) {
        out.errors += 1;
        await d.journal.add({ accountId, leadId: row.leadId, kind: 'error', summary: 'Касание после отказа не отправлено: канал недоступен', details });
        continue;
      }
      if (r.email && d.email) await d.email(accountId, row.leadId, text).catch(() => false);

      // После второго касания, после напоминания и после шаблона «Отказ» расписания нет:
      // молчим навсегда. Ответ на шаблон сохраняется примечанием, агент его не комментирует.
      const last = bought || reminder || n === 2;
      const next = last ? null : new Date(row.refusedAt.getTime() + r.secondTouchDay * DAY_MS);
      await d.reactivation.markTouched(accountId, row.id, t, next, last ? (bought ? 'done' : 'stopped') : 'touched');
      if (bought) await d.reactivation.resolve(accountId, row.id, 'done', { stopReason: 'bought_elsewhere', finalSent: true });
      else if (last) await d.reactivation.stop(accountId, row.id, reminder ? 'reminder_sent' : 'two_touches');
      out.sent += 1;
      await d.journal.add({
        accountId,
        leadId: row.leadId,
        kind: 'reply',
        summary: bought
          ? `Клиент купил у конкурента: отправлен шаблон «Отказ», догон закрыт`
          : `Касание после отказа (${reminder ? 'напоминание' : `${n} из 2`}): ${text.slice(0, 160)}`,
        details: { ...details, email: Boolean(r.email && d.email), next: next?.toISOString() ?? null },
      });
    } catch (err) {
      out.errors += 1;
      await d.journal.add({ accountId, leadId: row.leadId, kind: 'error', summary: `Касание после отказа: ${(err as Error).message}`, details: { reactivationId: row.id } });
    }
  }
  return out;
}

export interface ReplyOutcome {
  handled: boolean;
  kind?: ReplyKind | 'feedback';
  /** Что сделали: задача, перевод на этап заказа, шаблон «Отказ», сохранение обратной связи. */
  action?: string;
}

export interface ReplyDeps extends ReactivationDeps {
  /** Ответственный по задаче; null — ответственный сделки. */
  assignee?(accountId: number, lead: AmoLead): Promise<number | null>;
}

/**
 * Ответ клиента на касание. Агент сам клиенту не отвечает: он либо возвращает сделку
 * менеджеру, либо отправляет шаблон «Отказ» и замолкает.
 * Возвращает `handled: false`, если сделка к догону не относится.
 */
export async function handleReactivationReply(d: ReplyDeps, accountId: number, lead: AmoLead, text: string): Promise<ReplyOutcome> {
  const row = await d.reactivation.byLead(accountId, lead.id);
  if (!row) return { handled: false };
  const { settings } = await d.settings.get(accountId);
  const r = settings.reactivation;
  const t = now(d);

  // Шаблон «Отказ» уже отправлен: обратная связь ложится в сделку, агент её не комментирует.
  if (row.state === 'done' || row.finalSent) {
    await addNote(d, accountId, lead.id, `Обратная связь клиента после отказа (агент не отвечает):\n${text.trim()}`);
    await d.journal.add({ accountId, leadId: lead.id, kind: 'skipped', summary: 'Обратная связь на шаблон «Отказ» сохранена, агент не отвечает', details: { reactivationId: row.id } });
    return { handled: true, kind: 'feedback', action: 'note' };
  }
  // Касаний не было (или догон уже закрыт не по ответу) — обычный диалог.
  if (row.touches === 0 || row.state === 'interested' || row.state === 'postponed') return { handled: false };

  const verdict = classifyReply(text);
  const { api } = await d.amo(accountId);

  if (verdict.kind === 'refusal') {
    const sent = await d.send(accountId, lead.id, r.finalTemplate, { reactivationId: row.id, touch: 'final' });
    if (sent && r.email && d.email) await d.email(accountId, lead.id, r.finalTemplate).catch(() => false);
    await d.reactivation.resolve(accountId, row.id, 'done', { clientReplyAt: t, stopReason: 'client_refused', finalSent: sent });
    await d.journal.add({
      accountId,
      leadId: lead.id,
      kind: sent ? 'reply' : 'error',
      summary: sent ? 'Клиент отказал: отправлен шаблон «Отказ», догон закрыт' : 'Клиент отказал: шаблон «Отказ» не отправлен (канал недоступен)',
      details: { reactivationId: row.id },
    });
    return { handled: true, kind: 'refusal', action: sent ? 'final_template' : 'final_failed' };
  }

  if (verdict.kind === 'think' && !verdict.deadline) {
    // Срока нет — агент напомнит сам один раз, это последнее касание.
    const next = new Date(t.getTime() + r.remindDays * DAY_MS);
    await d.reactivation.resolve(accountId, row.id, 'reminder', { clientReplyAt: t, nextTouchAt: next });
    await d.journal.add({
      accountId,
      leadId: lead.id,
      kind: 'skipped',
      summary: `Клиент думает, срок не назвал: напоминание ${next.toISOString().slice(0, 10)}`,
      details: { reactivationId: row.id },
    });
    return { handled: true, kind: 'think', action: 'reminder_scheduled' };
  }

  // Интерес или названный срок: сделка возвращается менеджеру на этап заказа с задачей.
  const moved = await moveToOrder(d, accountId, api, lead, r.targetStatusId);
  const taskText = verdict.deadline
    ? `AI: клиент после отказа просит вернуться к вопросу — срок «${verdict.deadline}». Ответ клиента: ${text.trim().slice(0, 400)}`
    : `AI: клиент после отказа ответил на сообщение агента — нужен менеджер. Ответ клиента: ${text.trim().slice(0, 400)}`;
  const taskId = await createTask(d, accountId, api, settings, lead, taskText, verdict.deadline ? 3 : 1, moved);
  const state = verdict.deadline ? 'postponed' : 'interested';
  await d.reactivation.resolve(accountId, row.id, state, { clientReplyAt: t, taskId, movedAt: moved ? t : null, stopReason: 'to_manager' });
  await d.journal.add({
    accountId,
    leadId: lead.id,
    kind: 'handoff',
    summary: verdict.deadline
      ? `Клиент назвал срок «${verdict.deadline}»: сделка на этап заказа, задача менеджеру`
      : 'Клиент ответил после отказа: сделка на этап заказа, задача менеджеру',
    details: { reactivationId: row.id, taskId, moved, deadline: verdict.deadline },
  });
  return { handled: true, kind: verdict.kind, action: taskId ? 'task' : 'moved' };
}

async function addNote(d: ReplyDeps, accountId: number, leadId: number, text: string): Promise<void> {
  try {
    const { api } = await d.amo(accountId);
    await api.addLeadNote(leadId, text);
  } catch (err) {
    await d.journal.add({ accountId, leadId, kind: 'error', summary: `Примечание не добавлено: ${(err as Error).message}` });
  }
}

/** Перевод сделки на этап «Заказ»: менеджеры отказы не видят, для них сделка закрыта. */
async function moveToOrder(d: ReplyDeps, accountId: number, api: AmoApiClient, lead: AmoLead, targetStatusId: number | null): Promise<boolean> {
  if (!targetStatusId) return false;
  try {
    await api.setLeadStatus(lead.id, targetStatusId);
    lead.status_id = targetStatusId;
    return true;
  } catch (err) {
    await d.journal.add({ accountId, leadId: lead.id, kind: 'error', summary: `Этап не изменён: ${(err as Error).message}` });
    return false;
  }
}

/**
 * Задача менеджеру. Запрет задач в закрытых сделках остаётся в силе: сделку сначала
 * переводят на этап заказа, и только тогда guard пропускает её по флагу `reactivated`
 * (в amo остаётся заполненным `closed_at` от прежнего закрытия).
 */
async function createTask(
  d: ReplyDeps,
  accountId: number,
  api: AmoApiClient,
  settings: WidgetSettings,
  lead: AmoLead,
  text: string,
  dueDays: number,
  reactivated: boolean,
): Promise<number | null> {
  const gate = await canCreateTask(api, lead, taskScope(settings), { reactivated });
  if (!gate.allowed) return null;
  try {
    const assignee = (await d.assignee?.(accountId, lead)) ?? lead.responsible_user_id ?? null;
    const complete = new Date(now(d).getTime() + dueDays * DAY_MS);
    return await api.createTask({
      leadId: lead.id,
      text,
      completeTill: complete,
      responsibleUserId: assignee ?? undefined,
      taskTypeId: settings.taskSweep.taskTypeId,
    });
  } catch {
    return null;
  }
}

/**
 * Канал исходящих для касаний: одобренный черновик плюс запуск бота-отправщика —
 * тем же путём, которым уходят одобренные черновики в режиме «Полуавто». Своего
 * второго пути отправки нет, поэтому проверка «менеджер ответил сам» в боте-отправщике
 * работает и для касаний.
 */
export function senderBotSend(deps: {
  settings: SettingsRepo;
  suggestions: SuggestionsRepo;
  journal: JournalRepo;
  dialog?: { addMessage(accountId: number, leadId: number, role: 'ai', text: string): Promise<unknown> };
  amo(accountId: number): Promise<{ api: AmoApiClient }>;
}): ReactivationDeps['send'] {
  return async (accountId, leadId, text, details) => {
    const { settings } = await deps.settings.get(accountId);
    const botId = settings.salesbot.senderBotId;
    if (!botId) {
      await deps.journal.add({ accountId, leadId, kind: 'error', summary: 'Касание не отправлено: бот-отправщик не выбран в настройках', details });
      return false;
    }
    const draftId = await deps.suggestions.addApproved(accountId, leadId, text, { ...details, source: 'reactivation' });
    try {
      const { api } = await deps.amo(accountId);
      await api.runSalesbot(botId, leadId);
      await deps.dialog?.addMessage(accountId, leadId, 'ai', text);
      return true;
    } catch (err) {
      // Черновик остаётся одобренным: уйдёт, когда бот запустится следующим ходом.
      await deps.journal.add({ accountId, leadId, kind: 'error', summary: `Бот-отправщик не запущен: ${(err as Error).message}`, details: { ...details, draftId } });
      return false;
    }
  };
}

export interface ReactivationRunResult {
  accountId: number;
  planned: number;
  skipped: number;
  sent: number;
  stopped: number;
  errors: number;
}

/** Один проход по всем аккаунтам: отбор новых отказов и отправка назревших касаний. */
export async function runReactivationAll(d: ReactivationDeps & { accountIds(): Promise<number[]> }): Promise<ReactivationRunResult[]> {
  const out: ReactivationRunResult[] = [];
  for (const accountId of await d.accountIds()) {
    try {
      const plan = await planReactivations(d, accountId);
      const touch = await runTouches(d, accountId);
      out.push({ accountId, ...plan, ...touch });
    } catch {
      out.push({ accountId, planned: 0, skipped: 0, sent: 0, stopped: 0, errors: 1 });
    }
  }
  return out;
}
