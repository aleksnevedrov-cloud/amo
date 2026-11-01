import { AmoApiClient, type WidgetPrincipal } from '@core/amo';
import { normalizePhone, type JournalRow, type WazzupChatItem } from '@core/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.ts';
import { sendWazzupMessage } from '../wazzup-send.ts';

/**
 * Большое окно виджета «Агент розница» (RETAIL-WIDGET-WINDOW):
 *  - GET  /leads/:leadId/dialog — лента переписки по сделке: сообщения клиента (WhatsApp / Telegram / почта / чат amo),
 *    ответы агента (модель, время), ответы менеджера, подсказки и черновики, не отправленные клиенту; системные сообщения
 *    Wazzup скрыты. Источники — переписка Wazzup (чаты сделки и телефоны её контактов), диалог агента, журнал, подсказки.
 *  - POST /leads/:leadId/send — ответ менеджера клиенту по кнопке: в тот же чат Wazzup, откуда клиент писал последним
 *    (WhatsApp / Telegram — сообщение появляется и в чате amo через интеграцию Wazzup). Запись в журнал — каждое сообщение.
 *  - PUT  /settings/mode — режим агента из окна (только администратор, как во вкладке настроек).
 *  - POST /client-errors — сбой загрузки в виджете (после автоповторов) в журнал API.
 */

const leadParams = z.object({ leadId: z.coerce.number().int().positive() });
const sendBody = z.object({ text: z.string().trim().min(1).max(4000) });
const modeBody = z.object({ mode: z.enum(['auto', 'semi', 'hints', 'off']) });
const clientErrorBody = z.object({
  method: z.string().max(10),
  path: z.string().max(300),
  reason: z.string().max(40),
  status: z.number().int().min(0).max(999).nullable(),
  attempts: z.number().int().min(1).max(10),
  recovered: z.boolean(),
  message: z.string().max(500).optional(),
  leadId: z.number().int().positive().nullable().optional(),
});

/** Каналы Wazzup, в которые виджет отвечает клиенту напрямую. */
const SENDABLE = new Set(['whatsapp', 'wapi', 'telegram', 'tgapi', 'instagram', 'vk', 'avito', 'viber']);
const CHANNEL_LABEL: Record<string, string> = { whatsapp: 'WhatsApp', wapi: 'WhatsApp', telegram: 'Telegram', tgapi: 'Telegram', instagram: 'Instagram', vk: 'ВКонтакте', avito: 'Авито', viber: 'Viber', email: 'почта', chat: 'чат amo' };

export interface DialogItem {
  id: string;
  at: string;
  who: 'client' | 'agent' | 'manager' | 'hint' | 'system';
  /** whatsapp / telegram / email / chat (чат amo через Salesbot) / null. */
  channel: string | null;
  channelLabel: string | null;
  text: string;
  provider?: string | null;
  model?: string | null;
  managerName?: string | null;
  /** Подсказка / черновик агента, не отправленные клиенту. */
  notSent?: boolean;
  suggestionId?: number;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 200).toLowerCase();
const DAY = 86_400_000;

/** Имена пользователей amo — кэш на процесс (10 мин): имя менеджера в ленте и в журнале. */
const userNames = new Map<number, { at: number; names: Map<number, string> }>();
async function userName(deps: Deps, accountId: number, userId: number): Promise<string | null> {
  const cached = userNames.get(accountId);
  if (cached && Date.now() - cached.at < 600_000) return cached.names.get(userId) ?? null;
  try {
    const client = await amoClient(deps, accountId);
    if (!client) return null;
    const names = new Map((await client.listUsers()).map((u) => [u.id, u.name] as [number, string]));
    userNames.set(accountId, { at: Date.now(), names });
    return names.get(userId) ?? null;
  } catch {
    return null;
  }
}

async function amoClient(deps: Deps, accountId: number): Promise<AmoApiClient | null> {
  const account = await deps.accounts.get(accountId);
  if (!account || account.uninstalledAt) return null;
  return new AmoApiClient(account.accountDomain, () => deps.tokenService.getAccessToken(accountId), deps.fetch);
}

/** Телефоны контактов сделки (до 5 контактов, все номера), нормализованные под chatId Wazzup. */
async function leadPhones(deps: Deps, accountId: number, leadId: number): Promise<string[]> {
  try {
    const client = await amoClient(deps, accountId);
    if (!client) return [];
    const lead = await client.getLead(leadId);
    const phones: string[] = [];
    for (const ref of (lead?._embedded?.contacts ?? []).slice(0, 5)) {
      const contact = await client.getContact(ref.id);
      for (const v of contact?.custom_fields_values?.find((f) => f.field_code === 'PHONE')?.values ?? []) {
        const p = normalizePhone(typeof v.value === 'string' ? v.value : null);
        if (p) phones.push(p);
      }
    }
    return [...new Set(phones)];
  } catch {
    return [];
  }
}

/** Чат, в который отвечать: последний входящий клиента в личном чате Wazzup поддерживаемого канала. */
export function replyTarget(chat: WazzupChatItem[]): { channelId: string; chatId: string; chatType: string } | null {
  for (let i = chat.length - 1; i >= 0; i -= 1) {
    const m = chat[i] as WazzupChatItem;
    if (m.direction === 'in' && m.channelId && m.chatType && SENDABLE.has(m.chatType.toLowerCase())) return { channelId: m.channelId, chatId: m.chatId, chatType: m.chatType };
  }
  return null;
}

/**
 * Лента: переписка Wazzup — основа (точное время и канал); сообщения диалога агента, которых нет в Wazzup (почта, чат amo),
 * добавляются; исходящие совпадают с ответами агента по тексту — «агент» с моделью из журнала, с отправками менеджера из
 * окна — «менеджер» с именем; прочие исходящие — менеджер из мессенджера. Подсказки и черновики, не отправленные, — жёлтым.
 */
export function buildDialog(input: {
  chat: WazzupChatItem[];
  history: { role: 'client' | 'ai' | 'manager'; text: string; createdAt: Date }[];
  journal: JournalRow[];
  suggestions: { id: number; kind: string; status: string; text: string; createdAt: Date }[];
}): DialogItem[] {
  const out: DialogItem[] = [];
  const replies = input.journal.filter((e) => e.kind === 'reply');
  const managerSends = input.journal.filter((e) => e.kind === 'manager_send');
  const replyOf = (text: string) => replies.find((e) => norm(e.summary) === norm(text));
  const sendOf = (text: string) => managerSends.find((e) => norm(e.summary) === norm(text));
  const modelOf = (e: JournalRow | undefined) => {
    const d = (e?.details ?? {}) as { provider?: string; model?: string };
    return d.model ? { provider: d.provider ?? 'anthropic', model: d.model } : {};
  };
  for (const m of input.chat) {
    const channel = m.chatType?.toLowerCase() ?? null;
    const base = { id: `w-${m.messageId}`, at: new Date(m.sentAt).toISOString(), channel, channelLabel: channel ? CHANNEL_LABEL[channel] ?? channel : null, text: m.text };
    if (m.direction === 'in') {
      out.push({ ...base, who: 'client' });
      continue;
    }
    const send = sendOf(m.text);
    const reply = replyOf(m.text);
    const ai = m.author === 'agent' || input.history.some((h) => h.role === 'ai' && norm(h.text) === norm(m.text));
    if (send) out.push({ ...base, who: 'manager', managerName: ((send.details ?? {}) as { userName?: string }).userName ?? null });
    else if (ai || reply) out.push({ ...base, who: 'agent', ...modelOf(reply) });
    else out.push({ ...base, who: 'manager', managerName: null });
  }
  // Сообщения диалога агента, которых нет в Wazzup (почта, чат amo через Salesbot).
  for (const [i, h] of input.history.entries()) {
    const dir = h.role === 'client' ? 'in' : 'out';
    const at = new Date(h.createdAt).getTime();
    const dup = input.chat.some((m) => m.direction === dir && norm(m.text) === norm(h.text) && Math.abs(new Date(m.sentAt).getTime() - at) < 2 * DAY);
    if (dup) continue;
    const reply = h.role === 'ai' ? replyOf(h.text) : undefined;
    const ch = (reply?.details as { channel?: string } | undefined)?.channel ?? (h.role === 'client' ? channelOfIncoming(input.journal, h.text) : null) ?? 'chat';
    const send = h.role === 'manager' ? sendOf(h.text) : undefined;
    out.push({
      id: `d-${i}-${at}`,
      at: new Date(h.createdAt).toISOString(),
      who: h.role === 'client' ? 'client' : h.role === 'ai' ? 'agent' : 'manager',
      channel: ch,
      channelLabel: CHANNEL_LABEL[ch] ?? ch,
      text: h.text,
      ...(h.role === 'ai' ? modelOf(reply) : {}),
      ...(h.role === 'manager' ? { managerName: ((send?.details ?? {}) as { userName?: string }).userName ?? null } : {}),
    });
  }
  // Подсказки и черновики, которые клиенту не ушли и не скрыты менеджером (ждут решения).
  for (const s of input.suggestions) {
    if (s.status !== 'pending') continue;
    out.push({ id: `s-${s.id}`, at: new Date(s.createdAt).toISOString(), who: 'hint', channel: null, channelLabel: null, text: s.text, notSent: true, suggestionId: s.id });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** Канал входящего из журнала хода (details.incoming и details.channel ответа). */
function channelOfIncoming(journal: JournalRow[], text: string): string | null {
  for (const e of journal) {
    const d = (e.details ?? {}) as { incoming?: string[]; channel?: string };
    if (d.channel && d.incoming?.some((t) => norm(t) === norm(text))) return d.channel;
  }
  return null;
}

/** Повторная отправка того же текста в ту же сделку в течение 20 с и параллельная отправка — отклоняются. */
const inFlight = new Set<string>();
const lastSent = new Map<string, { text: string; at: number }>();

export function widgetDialogRoutes(api: FastifyInstance, deps: Deps, principal: (req: FastifyRequest) => WidgetPrincipal, requireAdmin: (req: FastifyRequest, reply: FastifyReply) => boolean) {
  /** Переписка сделки и куда можно ответить. */
  const load = async (accountId: number, leadId: number) => {
    const phones = await leadPhones(deps, accountId, leadId);
    const [chat, history, journal, suggestions, key] = await Promise.all([
      deps.wazzup.chatForLead(accountId, leadId, phones, 200).catch(() => []),
      deps.dialog.history(accountId, leadId, 200),
      deps.journal.list(accountId, { leadId, limit: 200 }),
      deps.suggestions.listForLead(accountId, leadId, 30),
      deps.secrets.get(accountId, 'wazzup').catch(() => null),
    ]);
    return { phones, chat, history, journal, suggestions, hasKey: Boolean(key) };
  };

  api.get('/leads/:leadId/dialog', async (req) => {
    const { leadId } = leadParams.parse(req.params);
    const { accountId } = principal(req);
    const d = await load(accountId, leadId);
    const target = replyTarget(d.chat);
    const items = buildDialog({ chat: d.chat, history: d.history, journal: d.journal, suggestions: d.suggestions });
    // Ответить из окна можно в чат Wazzup (WhatsApp, Telegram…); почта и чат amo без Wazzup — «Скопировать» / «Открыть чат».
    const send = !d.hasKey
      ? { available: false, reason: 'Wazzup не подключён — ответ из окна недоступен; скопируйте текст и отправьте в чате amo' }
      : !target
        ? { available: false, reason: d.phones.length ? 'клиент не писал в мессенджер Wazzup — ответьте в чате amo или по почте' : 'у контакта нет телефона — ответьте в чате amo' }
        : { available: true, channel: target.chatType.toLowerCase(), channelLabel: CHANNEL_LABEL[target.chatType.toLowerCase()] ?? target.chatType, reason: null };
    return { leadId, items, send };
  });

  api.post('/leads/:leadId/send', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { leadId } = leadParams.parse(req.params);
    const b = sendBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body', message: 'пустой текст или длиннее 4000 знаков' });
    const p = principal(req);
    const lock = `${p.accountId}:${leadId}`;
    const prev = lastSent.get(lock);
    if (inFlight.has(lock)) return reply.code(409).send({ error: 'busy', message: 'предыдущее сообщение ещё отправляется' });
    if (prev && prev.text === b.data.text && Date.now() - prev.at < 20_000) return reply.code(409).send({ error: 'duplicate', message: 'это сообщение уже отправлено' });
    inFlight.add(lock);
    try {
      const d = await load(p.accountId, leadId);
      if (!d.hasKey) return reply.code(409).send({ error: 'no_key', message: 'Wazzup не подключён' });
      const target = replyTarget(d.chat);
      if (!target) return reply.code(409).send({ error: 'no_chat', message: 'клиент не писал в мессенджер Wazzup по этой сделке' });
      const name = (await userName(deps, p.accountId, p.userId)) ?? `пользователь ${p.userId}`;
      const r = await sendWazzupMessage(deps, p.accountId, { ...target, text: b.data.text, crmUserId: String(p.userId) });
      const channel = target.chatType.toLowerCase();
      const details = { userId: p.userId, userName: name, channel, channelId: target.channelId, chatType: target.chatType, chars: b.data.text.length, status: r.status, via: 'wazzup' };
      if (!r.ok) {
        await deps.journal.add({ accountId: p.accountId, leadId, kind: 'error', summary: `Ответ менеджера не отправлен (${CHANNEL_LABEL[channel] ?? channel}): HTTP ${r.status} ${r.error ?? ''}`.trim(), details: { ...details, text: b.data.text } });
        return reply.code(502).send({ error: 'send_failed', message: `Wazzup не принял сообщение: HTTP ${r.status}${r.error ? ` — ${r.error.slice(0, 120)}` : ''}` });
      }
      // Кто, когда, канал, текст — в журнал; в диалог агента — ролью manager (агент видит, что ответил менеджер).
      await deps.journal.add({ accountId: p.accountId, leadId, kind: 'manager_send', summary: b.data.text, details });
      await deps.dialog.addMessage(p.accountId, leadId, 'manager', b.data.text);
      lastSent.set(lock, { text: b.data.text, at: Date.now() });
      return { ok: true, channel, channelLabel: CHANNEL_LABEL[channel] ?? channel, userName: name, at: new Date().toISOString() };
    } finally {
      inFlight.delete(lock);
    }
  });

  api.put('/settings/mode', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = modeBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body' });
    const p = principal(req);
    const { settings } = await deps.settings.get(p.accountId);
    if (settings.mode === b.data.mode) return { mode: settings.mode };
    const { version } = await deps.settings.save(p.accountId, p.userId, { ...settings, mode: b.data.mode });
    await deps.journal.add({ accountId: p.accountId, kind: 'note', summary: `Режим агента: ${b.data.mode} (было ${settings.mode}) — из окна виджета`, details: { userId: p.userId, audit: 'mode', before: settings.mode, after: b.data.mode } });
    return { mode: b.data.mode, version };
  });

  api.post('/client-errors', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = clientErrorBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body' });
    const p = principal(req);
    const e = b.data;
    const what = `${e.method} ${e.path.replace(/^\/widget\/v1/, '')}`;
    const summary = e.recovered ? `Виджет: ${what} — ${e.reason}, повтор помог (попытка ${e.attempts})` : `Виджет: ${what} — ${e.reason}${e.status && !e.reason.includes(String(e.status)) ? ` (HTTP ${e.status})` : ''}, попыток без ответа: ${e.attempts}`;
    req.log.warn({ widget: e, userId: p.userId }, 'widget request failed');
    await deps.journal.add({ accountId: p.accountId, ...(e.leadId ? { leadId: e.leadId } : {}), kind: e.recovered ? 'note' : 'error', summary, details: { ...e, userId: p.userId, audit: 'widget_request' } });
    return { ok: true };
  });
}
