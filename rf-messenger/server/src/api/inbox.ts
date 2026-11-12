import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AmoRestError } from '../amo/rest.ts';
import { KIND_TEXT } from '../channels.ts';
import { normalizePhone } from '../connectors/types.ts';
import type { ChatRouteDeps } from './chat.ts';
import { chatView } from './chat.ts';

/**
 * Раздел «Rf Messenger» в левом меню amoCRM: все переписки всех менеджеров (как у Wazzup).
 * Все сотрудники видят все чаты аккаунта (п. 26); сообщения и отправка — через /chat/v1 (доступ к чату
 * выдаётся при показе его в списке). Авторизация — X-Auth-Token amoCRM на каждом запросе.
 */
export const INBOX_PAGE = 50;

const aclKey = (accountId: number, userId: number, chatId: number) => `rfm:chat:acl:${accountId}:${userId}:${chatId}`;

export async function inboxRoutes(app: FastifyInstance, deps: ChatRouteDeps): Promise<void> {
  const { store, redis, auth, who } = deps;
  /** Кэш amojo-ссылки сотрудника (для фильтра «Мои»). */
  const refCache = new Map<string, { ref: string | null; at: number }>();
  const userRef = async (accountId: number, userId: number): Promise<string | null> => {
    const key = `${accountId}:${userId}`;
    const c = refCache.get(key);
    if (c && Date.now() - c.at < 600_000) return c.ref;
    const ref = deps.rest ? await deps.rest.userAmojoId(accountId, userId).catch(() => null) : null;
    refCache.set(key, { ref, at: Date.now() });
    return ref;
  };

  await app.register(
    async (w) => {
      w.addHook('preHandler', auth);

      w.get<{ Querystring: { filter?: string; channelId?: string; q?: string; before?: string; limit?: string } }>('/chats', { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (req, reply) => {
        const p = who(req);
        const filter = req.query.filter === 'unanswered' || req.query.filter === 'mine' ? req.query.filter : 'all';
        const channelId = Number(req.query.channelId ?? 0) || null;
        const q = String(req.query.q ?? '').slice(0, 100);
        const before = Number(req.query.before ?? 0) || null;
        const limit = Math.min(Math.max(Number(req.query.limit ?? INBOX_PAGE) || INBOX_PAGE, 1), INBOX_PAGE);
        if (q && q.trim().length < 2) return reply.code(400).send({ error: 'Введите хотя бы 2 символа' });
        const chats = await store.inboxChats(p.accountId, { filter, channelId, q, beforeChatId: before, limit: limit + 1, userId: p.userId, userRef: filter === 'mine' ? await userRef(p.accountId, p.userId) : null });
        const page = chats.slice(0, limit);
        const channels = await store.listChannels(p.accountId);
        const summaries = await store.chatSummaries(page.map((c) => c.id));
        // Раздел открыт для всех сотрудников: доступ к показанным чатам на час (сообщения, отправка, SSE).
        if (!p.isAdmin && page.length) {
          const pipe = redis.pipeline();
          for (const c of page) pipe.set(aclKey(p.accountId, p.userId, c.id), '1', 'EX', 3600);
          await pipe.exec();
        }
        return {
          me: { userId: p.userId, isAdmin: p.isAdmin },
          chats: page.map((c) => chatView(c, channels.find((x) => x.id === c.channelId), summaries.get(c.id))),
          hasMore: chats.length > limit,
          unansweredChats: await store.unansweredChats(p.accountId),
        };
      });

      w.get('/counters', { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (req) => {
        const p = who(req);
        return { unansweredChats: await store.unansweredChats(p.accountId) };
      });

      w.get('/channels', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
        const p = who(req);
        return { channels: (await store.listChannels(p.accountId)).map((c) => ({ id: c.id, kind: c.kind, kindText: KIND_TEXT[c.kind], title: c.title, connected: c.status === 'connected' })) };
      });

      w.post<{ Params: { id: string } }>('/chats/:id/no-reply', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
        const p = who(req);
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'Некорректный id' });
        const r = await deps.bridge.noReply(p.accountId, id, p.userId);
        if (!r) return reply.code(404).send({ error: 'Чат не найден' });
        return { ok: true, answered: r.answered, unansweredChats: await store.unansweredChats(p.accountId) };
      });

      w.post<{ Params: { id: string } }>('/chats/:id/pin', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
        const p = who(req);
        const id = Number(req.params.id);
        const body = z.object({ pinned: z.boolean() }).safeParse(req.body);
        if (!Number.isInteger(id) || id <= 0 || !body.success) return reply.code(400).send({ error: 'Некорректные данные' });
        if (!(await store.setPinned(p.accountId, id, body.data.pinned))) return reply.code(404).send({ error: 'Чат не найден' });
        return { ok: true };
      });

      // ---------- Контакт и сделка из чата ----------
      w.get<{ Querystring: { q?: string } }>('/contacts/search', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
        const p = who(req);
        const q = String(req.query.q ?? '').trim();
        if (q.length < 2) return reply.code(400).send({ error: 'Введите хотя бы 2 символа' });
        if (!deps.rest) return reply.code(503).send({ error: 'Интеграция не авторизована в amoCRM' });
        try {
          return { contacts: await deps.rest.searchContacts(p.accountId, q) };
        } catch (err) {
          if (err instanceof AmoRestError) return reply.code(502).send({ error: err.message });
          throw err;
        }
      });

      /** Чат в amo (createChat, если его ещё нет) + привязка к контакту. */
      const ensureLinked = async (accountId: number, chatId: number, contactId: number) => {
        const chat = await store.chatOfAccount(accountId, chatId);
        if (!chat) return null;
        if (!deps.rest || !deps.amojo) throw new AmoRestError('Интеграция не авторизована в amoCRM', 0);
        const conn = await store.getConnection(accountId);
        if (!conn) throw new AmoRestError('Канал чатов amoCRM не подключён к аккаунту', 0);
        let amojoChatId = chat.amojoChatId;
        if (!amojoChatId) {
          const user = { id: `${chat.conversationId}-c`, name: chat.title.slice(0, 100), ...(chat.contact.phone ? { profile: { phone: chat.contact.phone } } : {}) };
          amojoChatId = (await deps.amojo.createChat(conn.scopeId, chat.conversationId, user)).chatId;
          await store.setAmojoChatId(chat.id, amojoChatId);
        }
        await deps.rest.linkChat(accountId, amojoChatId, contactId);
        return chat;
      };

      w.post<{ Params: { id: string } }>('/chats/:id/link-contact', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
        const p = who(req);
        const id = Number(req.params.id);
        const body = z.object({ contactId: z.number().int().positive() }).safeParse(req.body);
        if (!Number.isInteger(id) || id <= 0 || !body.success) return reply.code(400).send({ error: 'Некорректные данные' });
        try {
          const chat = await ensureLinked(p.accountId, id, body.data.contactId);
          if (!chat) return reply.code(404).send({ error: 'Чат не найден' });
          req.log.info({ chatId: id, contactId: body.data.contactId, userId: p.userId }, 'чат привязан к контакту вручную');
          return { ok: true, contactId: body.data.contactId };
        } catch (err) {
          if (err instanceof AmoRestError) return reply.code(err.status === 409 ? 409 : 502).send({ error: err.message });
          throw err;
        }
      });

      /** «Создать сделку»: контакт с номером создаётся автоматически, если чат ещё не привязан. */
      w.post<{ Params: { id: string } }>('/chats/:id/lead', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
        const p = who(req);
        const id = Number(req.params.id);
        const body = z.object({ contactId: z.number().int().positive().optional(), name: z.string().trim().max(200).optional() }).safeParse(req.body ?? {});
        if (!Number.isInteger(id) || id <= 0 || !body.success) return reply.code(400).send({ error: 'Некорректные данные' });
        if (!deps.rest) return reply.code(503).send({ error: 'Интеграция не авторизована в amoCRM' });
        const chat = await store.chatOfAccount(p.accountId, id);
        if (!chat) return reply.code(404).send({ error: 'Чат не найден' });
        try {
          let contactId = body.data.contactId ?? null;
          if (!contactId && chat.amojoChatId) contactId = (await deps.rest.chatContacts(p.accountId, chat.amojoChatId).catch(() => []))[0] ?? null;
          if (!contactId) contactId = await deps.rest.createContact(p.accountId, chat.title, chat.contact.phone ? normalizePhone(chat.contact.phone) : null);
          await ensureLinked(p.accountId, id, contactId);
          const leadId = await deps.rest.createLead(p.accountId, body.data.name || `Сделка · ${chat.title}`, contactId);
          req.log.info({ chatId: id, contactId, leadId, userId: p.userId }, 'сделка создана из чата');
          return { ok: true, contactId, leadId };
        } catch (err) {
          if (err instanceof AmoRestError) return reply.code(502).send({ error: err.message });
          throw err;
        }
      });
    },
    { prefix: '/inbox/v1' },
  );
}
