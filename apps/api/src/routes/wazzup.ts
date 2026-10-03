import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isGroupChatType, normalizePhone, type WazzupMessage } from '@ai-door/db';
import type { Deps } from '../deps.ts';
import { replyInGroup } from '../group-reply.ts';

/** Системные тексты Wazzup (канал недоступен, не доставлено) — храним, но в контекст агента не даём. */
export const WAZZUP_SYSTEM_TEXT_RE = /===\s*SYSTEM\s+WZ\s*===|^\s*Сообщение не отправлено/iu;

const messageSchema = z.object({
  messageId: z.string().min(1),
  channelId: z.string().nullish(),
  chatType: z.string().nullish(),
  chatId: z.string().min(1),
  dateTime: z.string().nullish(),
  type: z.string().nullish(),
  isEcho: z.boolean().nullish(),
  text: z.string().nullish(),
  status: z.string().nullish(),
  authorName: z.string().nullish(),
  contentUri: z.string().nullish(),
  contact: z.object({ name: z.string().nullish(), phone: z.string().nullish(), username: z.string().nullish() }).nullish(),
}).passthrough();

const statusSchema = z.object({ messageId: z.string().min(1), status: z.string().min(1) }).passthrough();

const bodySchema = z.object({
  test: z.boolean().optional(),
  messages: z.array(messageSchema).optional(),
  statuses: z.array(statusSchema).optional(),
}).passthrough();

/** Перевод сообщения вебхука в строку таблицы. Экспортируется для тестов. */
export function toWazzupMessage(m: z.infer<typeof messageSchema>): WazzupMessage {
  const text = (m.text ?? '').trim();
  const direction: 'in' | 'out' = m.isEcho ? 'out' : 'in';
  // Телефон: из contact.phone, иначе из chatId (для WhatsApp chatId = номер).
  const phone = normalizePhone(m.contact?.phone) ?? (m.chatType === 'whatsapp' || m.chatType === 'whatsgroup' ? normalizePhone(m.chatId) : null);
  const typeNote = m.type && m.type !== 'text' && !text ? `[${m.type}]` : '';
  return {
    messageId: m.messageId,
    channelId: m.channelId ?? null,
    chatId: m.chatId,
    chatType: m.chatType ?? null,
    phone,
    direction,
    author: direction === 'in' ? 'client' : 'manager',
    text: text || typeNote,
    status: m.status ?? null,
    isSystem: WAZZUP_SYSTEM_TEXT_RE.test(text),
    sentAt: m.dateTime ? new Date(m.dateTime) : new Date(),
    source: 'webhook',
    raw: m,
    contentUri: m.contentUri ?? null,
    contentType: m.type ?? null,
  };
}

/** Приёмник вебхуков Wazzup API v3 (messagesAndStatuses). Адрес содержит id аккаунта, доступ — Bearer crmKey (секрет wazzup_crm). */
/** Ответ в групповом чате в фоне: вебхук Wazzup должен ответить 200 сразу. */
async function handleGroupMessage(
  deps: Deps,
  accountId: number,
  row: WazzupMessage,
  log: { error: (o: unknown, m: string) => void },
): Promise<void> {
  try {
    const outcome = await replyInGroup(deps, {
      accountId,
      chatId: row.chatId,
      chatType: row.chatType ?? 'whatsgroup',
      channelId: row.channelId,
      author: row.author,
      text: row.text,
    });
    if (outcome.status === 'sent') {
      await deps.journal.add({
        accountId,
        kind: 'reply',
        summary: `Групповой чат ${row.chatId}: ${outcome.text.slice(0, 120)}`,
        details: { chatId: row.chatId, chatType: row.chatType },
      });
    } else if (outcome.status === 'error') {
      await deps.journal.add({
        accountId,
        kind: 'error',
        summary: `Групповой чат ${row.chatId}: ошибка ответа — ${outcome.error}`,
        details: { chatId: row.chatId },
      });
    }
  } catch (err) {
    log.error({ err: (err as Error).message, chatId: row.chatId }, 'wazzup: ошибка ответа в группе');
  }
}

export function wazzupRoutes(app: FastifyInstance, deps: Deps): void {
  app.post('/wazzup/v1/webhook/:accountId/:token?', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } }, bodyLimit: 2_000_000 }, async (req, reply) => {
    const accountId = Number((req.params as { accountId: string }).accountId);
    if (!Number.isInteger(accountId) || accountId <= 0) return reply.code(404).send({ error: 'not_found' });
    const expected = await deps.secrets.get(accountId, 'wazzup_crm');
    const auth = String(req.headers.authorization ?? '');
    const token = String((req.params as { token?: string }).token ?? '');
    // Wazzup не передаёт Authorization в вебхуках — секрет (crmKey) идёт в адресе подписки.
    if (!expected || (auth !== `Bearer ${expected}` && token !== expected)) {
      req.log.warn({ accountId }, 'wazzup: вебхук с неверным ключом');
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      await deps.wazzup.markError(accountId, `неразобранный вебхук: ${parsed.error.issues[0]?.message ?? 'bad body'}`);
      // 200 — чтобы Wazzup не снял подписку из-за нашей ошибки разбора.
      return reply.code(200).send({ ok: false, error: 'bad_body' });
    }
    const b = parsed.data;
    if (b.test) return reply.code(200).send({ ok: true, test: true });
    let inserted = 0;
    try {
      for (const m of b.messages ?? []) {
        const row = toWazzupMessage(m);
        if (await deps.wazzup.upsert(accountId, row)) inserted += 1;
        // Групповые чаты: у них нет сделки, Salesbot их не запускает — отвечаем отсюда.
        if (row.direction === 'in' && !row.isSystem && isGroupChatType(row.chatType) && row.text.trim()) {
          void handleGroupMessage(deps, accountId, row, req.log);
        }
      }
      for (const s of b.statuses ?? []) await deps.wazzup.setStatus(accountId, s.messageId, s.status);
      await deps.wazzup.markEvent(accountId, inserted);
    } catch (err) {
      req.log.error({ err: (err as Error).message, accountId }, 'wazzup: ошибка записи вебхука');
      await deps.wazzup.markError(accountId, (err as Error).message).catch(() => undefined);
      await deps.journal.add({ accountId, kind: 'error', summary: `Wazzup: ошибка записи вебхука: ${(err as Error).message}` }).catch(() => undefined);
    }
    return reply.code(200).send({ ok: true, inserted });
  });
}
