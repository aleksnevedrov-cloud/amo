import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AmoRestError } from '../amo/rest.ts';
import type { Principal } from '../auth.ts';
import type { WindowSendInput } from '../bridge.ts';
import { CHAT_START_KINDS, KIND_TEXT, PHONE_START_KINDS } from '../channels.ts';
import { normalizePhone } from '../connectors/types.ts';
import type { ChatEvent } from '../events.ts';
import type { Channel, Chat, Message, Template } from '../store.ts';
import type { ApiDeps } from './app.ts';

/**
 * API окна переписки в карточке сделки: чаты контакта, сообщения с пагинацией, отправка, файлы,
 * прочитанность, история, шаблоны, живые события (SSE).
 *
 * Авторизация: X-Auth-Token amoCRM на каждом запросе (как у остального API виджета). Исключения —
 * SSE и загрузка файлов: браузер не умеет ставить заголовки EventSource и слать FormData через
 * $authorizedAjax, поэтому для них выдаётся сеанс (POST /session по токену amo): случайная строка
 * в Redis на 1 час, привязанная к аккаунту и сотруднику.
 *
 * Права: администратор — все чаты аккаунта; менеджер — чаты сделок и контактов, где он ответственный.
 * Доступ выдаётся при открытии карточки (GET /chats) и запоминается на час (ACL в Redis).
 */

export interface ChatRouteDeps extends ApiDeps {
  auth: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  who: (req: FastifyRequest) => Principal;
}

export const PAGE_SIZE = 50;
const SESSION_TTL_SEC = 3600;
const ACL_TTL_SEC = 3600;

const sessionKey = (t: string) => `rfm:chat:session:${t}`;
const aclKey = (accountId: number, userId: number, chatId: number) => `rfm:chat:acl:${accountId}:${userId}:${chatId}`;

export interface MessageView {
  id: number;
  direction: 'in' | 'out';
  source: Message['source'];
  kind: Message['kind'];
  text: string;
  at: string;
  status: Message['status'];
  error: string | null;
  senderName: string | null;
  author: Message['author'];
  fromHistory: boolean;
  file: { id: string; name: string; mime: string; size: number; url: string } | null;
  replyTo: { id: number; text: string; kind: Message['kind']; direction: 'in' | 'out'; senderName: string | null } | null;
}

/** Сообщения → вид для окна: с файлами (подписанные ссылки) и цитатами. */
export async function messageViews(deps: Pick<ApiDeps, 'store' | 'files'>, chatId: number, list: Message[]): Promise<MessageView[]> {
  const quotedIds = [...new Set(list.map((m) => m.replyToMessageId).filter((x): x is number => x !== null && !list.some((m) => m.id === x)))];
  const quoted = new Map<number, Message>();
  for (const m of [...list, ...(await deps.store.messagesByIds(chatId, quotedIds))]) quoted.set(m.id, m);
  const out: MessageView[] = [];
  for (const m of list) {
    const file = m.fileId ? await deps.store.fileById(m.fileId) : null;
    const q = m.replyToMessageId ? quoted.get(m.replyToMessageId) : undefined;
    out.push({
      id: m.id,
      direction: m.direction,
      source: m.source,
      kind: m.kind,
      text: m.text,
      at: m.createdAt.toISOString(),
      status: m.status,
      error: m.error,
      senderName: m.senderName,
      author: m.author,
      fromHistory: m.fromHistory,
      file: file ? { id: file.id, name: file.name, mime: file.mime, size: file.size, url: deps.files.signedUrl(file) } : null,
      replyTo: q ? { id: q.id, text: q.text, kind: q.kind, direction: q.direction, senderName: q.senderName } : null,
    });
  }
  return out;
}

const templateSchema = z.object({
  title: z.string().trim().min(1, 'Введите название шаблона').max(120),
  text: z.string().min(1, 'Введите текст шаблона').max(4000),
  folder: z.string().trim().max(60).optional().default(''),
  attachments: z
    .array(z.object({ fileId: z.string().uuid(), name: z.string().max(200), mime: z.string().max(100), size: z.number().int().nonnegative() }))
    .max(5)
    .optional()
    .default([]),
  /** Общий шаблон аккаунта (только администратор); иначе личный. */
  shared: z.boolean().optional().default(false),
});

const sendSchema = z.object({
  text: z.string().max(4000).optional().default(''),
  replyToMessageId: z.number().int().positive().optional().nullable(),
  fileIds: z.array(z.string().uuid()).max(10).optional().default([]),
});

const templateView = (t: Template) => ({ id: t.id, title: t.title, text: t.text, folder: t.folder, attachments: t.attachments, shared: t.ownerUserId === null, useCount: t.useCount });

/** Чат для списков окна и раздела: канал, последнее сообщение, счётчики «неотвеченных». */
export function chatView(c: Chat, ch: Channel | undefined, s: { last: Message | null; unread: number } | undefined) {
  return {
    id: c.id,
    channelId: c.channelId,
    kind: ch?.kind ?? 'unknown',
    kindText: ch ? KIND_TEXT[ch.kind] : '',
    channelTitle: ch?.title ?? '',
    channelConnected: ch?.status === 'connected',
    title: c.title,
    isGroup: c.isGroup,
    contact: c.contact,
    unread: c.unanswered,
    unanswered: c.unanswered,
    answered: c.answered,
    pinned: c.pinned,
    lastAt: (s?.last?.createdAt ?? c.lastMessageAt).toISOString(),
    last: s?.last ? { text: s.last.text, kind: s.last.kind, direction: s.last.direction, fileName: s.last.fileId ? s.last.kind : null } : null,
    historyAvailable: ch?.kind === 'whatsapp' || ch?.kind === 'telegram_user',
  };
}

export async function chatRoutes(app: FastifyInstance, deps: ChatRouteDeps): Promise<void> {
  const { store, redis, auth, who } = deps;

  /** Сеанс для SSE и загрузки файлов. */
  const principalFromSession = async (token: string | undefined): Promise<Principal | null> => {
    if (!token || !/^[0-9a-f]{48}$/.test(token)) return null;
    const raw = await redis.get(sessionKey(token));
    if (!raw) return null;
    await redis.expire(sessionKey(token), SESSION_TTL_SEC);
    return JSON.parse(raw) as Principal;
  };

  const grant = async (p: Principal, chatIds: number[]): Promise<void> => {
    if (p.isAdmin || !chatIds.length) return;
    const pipe = redis.pipeline();
    for (const id of chatIds) pipe.set(aclKey(p.accountId, p.userId, id), '1', 'EX', ACL_TTL_SEC);
    await pipe.exec();
  };

  const canAccess = async (p: Principal, chat: Chat | null): Promise<boolean> => {
    if (!chat || chat.accountId !== p.accountId) return false;
    if (p.isAdmin) return true;
    return (await redis.get(aclKey(p.accountId, p.userId, chat.id))) === '1';
  };

  /** Чат по id с проверкой доступа; 404 без различия «нет» и «чужой». */
  const chatFor = async (p: Principal, rawId: string, reply: FastifyReply): Promise<Chat | null> => {
    const id = Number(rawId);
    const chat = Number.isInteger(id) && id > 0 ? await store.chatOfAccount(p.accountId, id) : null;
    if (!(await canAccess(p, chat))) {
      await reply.code(404).send({ error: 'Чат не найден' });
      return null;
    }
    return chat;
  };

  const restOr503 = (reply: FastifyReply) => {
    if (!deps.rest) void reply.code(503).send({ error: 'Интеграция не авторизована в amoCRM: администратору нужно нажать «Авторизовать» в настройках виджета' });
    return deps.rest ?? null;
  };

  await app.register(
    async (w) => {
      w.addHook('preHandler', auth);

      w.post('/session', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
        const p = who(req);
        const token = randomBytes(24).toString('hex');
        await redis.set(sessionKey(token), JSON.stringify(p), 'EX', SESSION_TTL_SEC);
        return { token, expiresIn: SESSION_TTL_SEC, userId: p.userId, isAdmin: p.isAdmin };
      });

      // ---------- Чаты карточки ----------
      w.get<{ Querystring: { leadId?: string; contactId?: string; chatId?: string } }>('/chats', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
        const p = who(req);
        const leadId = Number(req.query.leadId ?? 0);
        const contactId = Number(req.query.contactId ?? 0);
        const directChatId = Number(req.query.chatId ?? 0);
        if (!(Number.isInteger(leadId) && leadId >= 0 && Number.isInteger(contactId) && contactId >= 0 && Number.isInteger(directChatId) && directChatId >= 0) || (!leadId && !contactId && !directChatId))
          return reply.code(400).send({ error: 'Нужен id сделки, контакта или чата' });
        const rest = restOr503(reply);
        if (!rest) return;
        let contactIds: number[] = [];
        let lead: Awaited<ReturnType<typeof rest.lead>> | null = null;
        try {
          if (directChatId) {
            // Раздел «Rf Messenger»: чат открыт из общего списка — все сотрудники видят все чаты (п. 26).
            const chat = await store.chatOfAccount(p.accountId, directChatId);
            if (!chat) return reply.code(404).send({ error: 'Чат не найден' });
            await grant(p, [chat.id]);
            contactIds = chat.amojoChatId ? (await rest.chatContacts(p.accountId, chat.amojoChatId).catch(() => [])).slice(0, 3) : [];
            const contacts = [];
            for (const id of contactIds) contacts.push(await rest.contact(p.accountId, id).catch(() => null));
            const channels = await store.listChannels(p.accountId);
            const summaries = await store.chatSummaries([chat.id]);
            return {
              me: { userId: p.userId, isAdmin: p.isAdmin },
              lead: null,
              contacts: contacts.filter((c): c is NonNullable<typeof c> => Boolean(c)),
              chats: [chatView(chat, channels.find((x) => x.id === chat.channelId), summaries.get(chat.id))],
              startChannels: [],
            };
          }
          if (leadId) {
            lead = await rest.lead(p.accountId, leadId);
            if (!p.isAdmin && lead.responsibleUserId !== p.userId) return reply.code(403).send({ error: 'Переписка доступна ответственному по сделке и администратору' });
            contactIds = lead.contactIds.slice(0, 5);
          } else {
            const c = await rest.contact(p.accountId, contactId);
            if (!p.isAdmin && c.responsibleUserId && c.responsibleUserId !== p.userId) return reply.code(403).send({ error: 'Переписка доступна ответственному по контакту и администратору' });
            contactIds = [c.id];
          }
          const contacts = [];
          for (const id of contactIds) contacts.push(await rest.contact(p.accountId, id));
          const links = await rest.contactChats(p.accountId, contactIds).catch(() => []);
          const phones = contacts.flatMap((c) => c.phones.map((ph) => normalizePhone(ph)).filter((x): x is string => Boolean(x)));
          const chats = await store.chatsForContacts(p.accountId, links.map((l) => l.chatId), phones);
          const summaries = await store.chatSummaries(chats.map((c) => c.id));
          const channels = await store.listChannels(p.accountId);
          await grant(p, chats.map((c) => c.id));
          const startChannels = await Promise.all(
            channels
              .filter((c) => PHONE_START_KINDS.has(c.kind) || CHAT_START_KINDS.has(c.kind))
              .map(async (c) => ({
                id: c.id,
                kind: c.kind,
                kindText: KIND_TEXT[c.kind],
                title: c.title,
                connected: c.status === 'connected',
                ...(CHAT_START_KINDS.has(c.kind) ? { byChat: true, chats: (await store.recentChats(p.accountId, c.id)).map((ch) => ({ id: ch.id, title: ch.title })) } : {}),
              })),
          );
          return {
            me: { userId: p.userId, isAdmin: p.isAdmin },
            lead: lead ? { id: lead.id, name: lead.name, price: lead.price } : null,
            contacts,
            chats: chats.map((c) => chatView(c, channels.find((x) => x.id === c.channelId), summaries.get(c.id))),
            startChannels,
          };
        } catch (err) {
          if (err instanceof AmoRestError) return reply.code(err.status === 0 ? 503 : 502).send({ error: err.message });
          throw err;
        }
      });

      w.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>('/chats/:id/messages', { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (req, reply) => {
        const p = who(req);
        const chat = await chatFor(p, req.params.id, reply);
        if (!chat) return;
        const before = Number(req.query.before ?? 0) || null;
        const limit = Math.min(Math.max(Number(req.query.limit ?? PAGE_SIZE) || PAGE_SIZE, 1), PAGE_SIZE);
        const page = await store.messagesPage(chat.id, before, limit);
        return { messages: await messageViews(deps, chat.id, page.messages), hasMore: page.hasMore };
      });

      w.get<{ Params: { id: string }; Querystring: { q?: string } }>('/chats/:id/search', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
        const p = who(req);
        const chat = await chatFor(p, req.params.id, reply);
        if (!chat) return;
        const q = String(req.query.q ?? '').trim().slice(0, 100);
        if (q.length < 2) return reply.code(400).send({ error: 'Введите хотя бы 2 символа' });
        return { messages: await messageViews(deps, chat.id, await store.searchMessages(chat.id, q)) };
      });

      w.post<{ Params: { id: string } }>('/chats/:id/messages', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
        const p = who(req);
        const chat = await chatFor(p, req.params.id, reply);
        if (!chat) return;
        const body = sendSchema.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'Некорректные данные' });
        if (!body.data.text.trim() && !body.data.fileIds.length) return reply.code(400).send({ error: 'Введите сообщение или добавьте файл' });
        if (!deps.windowSend) return reply.code(503).send({ error: 'Сервис отправки недоступен' });
        const input: WindowSendInput = { accountId: p.accountId, userId: p.userId, chatId: chat.id, text: body.data.text, replyToMessageId: body.data.replyToMessageId ?? null, fileIds: body.data.fileIds };
        try {
          const r = await deps.windowSend(input);
          return { messages: await messageViews(deps, chat.id, await store.messagesByIds(chat.id, r.messageIds)) };
        } catch (err) {
          req.log.warn({ chatId: chat.id, err: (err as Error).message }, 'отправка из окна: ошибка');
          return reply.code(422).send({ error: (err as Error).message || 'Не удалось отправить' });
        }
      });

      w.post<{ Params: { id: string } }>('/chats/:id/read', { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (req, reply) => {
        const p = who(req);
        const chat = await chatFor(p, req.params.id, reply);
        if (!chat) return;
        await store.markChatRead(chat.id);
        return { ok: true };
      });

      w.post<{ Params: { id: string } }>('/chats/:id/history', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
        const p = who(req);
        const chat = await chatFor(p, req.params.id, reply);
        if (!chat) return;
        if (!deps.queue) return reply.code(503).send({ error: 'Очередь недоступна' });
        await deps.queue.add('history', { messageId: 0, chatId: chat.id }, { jobId: `history-${chat.id}-${Date.now()}` });
        return { queued: true };
      });

      w.post<{ Params: { id: string } }>('/messages/:id/retry', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
        const p = who(req);
        const id = Number(req.params.id);
        const msg = Number.isInteger(id) && id > 0 ? await store.messageById(id) : null;
        const chat = msg ? await store.chatOfAccount(p.accountId, msg.chatId) : null;
        if (!msg || !chat || !(await canAccess(p, chat))) return reply.code(404).send({ error: 'Сообщение не найдено' });
        if (!(await deps.bridge.retryMessage(p.accountId, msg.id))) return reply.code(409).send({ error: 'Повторить можно только недоставленное сообщение из amoCRM' });
        return { queued: true };
      });

      w.get<{ Params: { id: string } }>('/contacts/:id/leads', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
        const p = who(req);
        const rest = restOr503(reply);
        if (!rest) return;
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'Некорректный id' });
        try {
          return { leads: await rest.contactLeads(p.accountId, id) };
        } catch (err) {
          if (err instanceof AmoRestError) return reply.code(502).send({ error: err.message });
          throw err;
        }
      });

      // ---------- Шаблоны ----------
      w.get('/templates', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
        const p = who(req);
        return { templates: (await store.listTemplates(p.accountId, p.userId)).map(templateView) };
      });

      w.get<{ Querystring: { leadId?: string; contactId?: string } }>('/templates/context', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
        const p = who(req);
        const rest = restOr503(reply);
        if (!rest) return;
        const leadId = Number(req.query.leadId ?? 0) || 0;
        const contactId = Number(req.query.contactId ?? 0) || 0;
        try {
          const manager = await rest.userName(p.accountId, p.userId).catch(() => '');
          const lead = leadId ? await rest.lead(p.accountId, leadId) : null;
          const cid = lead?.contactIds[0] ?? contactId;
          const contact = cid ? await rest.contact(p.accountId, cid).catch(() => null) : null;
          return { client: contact?.name ?? '', manager, leadId: lead?.id ?? null, leadName: lead?.name ?? '', budget: lead?.price ?? null, fields: lead?.fields ?? {} };
        } catch (err) {
          if (err instanceof AmoRestError) return reply.code(502).send({ error: err.message });
          throw err;
        }
      });

      w.post('/templates', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
        const p = who(req);
        const body = templateSchema.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'Некорректные данные' });
        if (body.data.shared && !p.isAdmin) return reply.code(403).send({ error: 'Общие шаблоны создаёт администратор' });
        for (const a of body.data.attachments) {
          const f = await store.fileById(a.fileId);
          if (!f || f.accountId !== p.accountId) return reply.code(400).send({ error: 'Файл вложения не найден' });
        }
        const t = await store.createTemplate({ accountId: p.accountId, ownerUserId: body.data.shared ? null : p.userId, title: body.data.title, text: body.data.text, folder: body.data.folder, attachments: body.data.attachments });
        return reply.code(201).send(templateView(t));
      });

      const editable = async (p: Principal, rawId: string): Promise<Template | null> => {
        const id = Number(rawId);
        const t = Number.isInteger(id) && id > 0 ? await store.templateById(p.accountId, id) : null;
        if (!t) return null;
        if (t.ownerUserId === null ? !p.isAdmin : t.ownerUserId !== p.userId) return null;
        return t;
      };

      w.put<{ Params: { id: string } }>('/templates/:id', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
        const p = who(req);
        const t = await editable(p, req.params.id);
        if (!t) return reply.code(404).send({ error: 'Шаблон не найден или нет прав на его правку' });
        const body = templateSchema.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'Некорректные данные' });
        const u = await store.updateTemplate(p.accountId, t.id, { title: body.data.title, text: body.data.text, folder: body.data.folder, attachments: body.data.attachments });
        return u ? templateView(u) : reply.code(404).send({ error: 'Шаблон не найден' });
      });

      w.delete<{ Params: { id: string } }>('/templates/:id', async (req, reply) => {
        const p = who(req);
        const t = await editable(p, req.params.id);
        if (!t) return reply.code(404).send({ error: 'Шаблон не найден или нет прав на его удаление' });
        await store.deleteTemplate(p.accountId, t.id);
        return { deleted: true };
      });

      w.post<{ Params: { id: string } }>('/templates/:id/used', async (req, reply) => {
        const p = who(req);
        const id = Number(req.params.id);
        const t = Number.isInteger(id) && id > 0 ? await store.templateById(p.accountId, id) : null;
        if (!t || (t.ownerUserId !== null && t.ownerUserId !== p.userId)) return reply.code(404).send({ error: 'Шаблон не найден' });
        await store.bumpTemplate(p.accountId, t.id);
        return { ok: true };
      });
    },
    { prefix: '/chat/v1' },
  );

  // ---------- По сеансу: файлы и живые события ----------
  app.post('/chat/v1/files', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = await principalFromSession(req.headers['x-rfm-session'] as string | undefined);
    if (!p) return reply.code(401).send({ error: 'Сеанс окна истёк — обновите страницу' });
    const part = await req.file({ limits: { fileSize: deps.files.maxBytes, files: 1 } }).catch(() => null);
    if (!part) return reply.code(400).send({ error: 'Нет файла' });
    const data = await part.toBuffer().catch(() => null);
    if (!data || part.file.truncated) return reply.code(413).send({ error: `Файл больше ${Math.round(deps.files.maxBytes / 1024 / 1024)} МБ` });
    const file = await deps.files.save({ accountId: p.accountId, channelId: null, data, name: part.filename || 'file', mime: part.mimetype || 'application/octet-stream' });
    return { id: file.id, name: file.name, mime: file.mime, size: file.size, url: deps.files.signedUrl(file) };
  });

  app.get<{ Querystring: { session?: string; chats?: string; scope?: string } }>('/chat/v1/events', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = await principalFromSession(req.query.session);
    if (!p) return reply.code(401).send({ error: 'Сеанс окна истёк — обновите страницу' });
    if (!deps.events) return reply.code(503).send({ error: 'События недоступны' });
    const wanted = String(req.query.chats ?? '')
      .split(',')
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 50);
    const allowed = new Set<number>();
    for (const id of wanted) if (await canAccess(p, await store.chatOfAccount(p.accountId, id))) allowed.add(id);
    // Раздел «Rf Messenger»: все сотрудники видят все чаты аккаунта (п. 26) — события по всем чатам.
    const all = p.isAdmin || req.query.scope === 'inbox';
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': (req.headers.origin as string | undefined) ?? '*',
    });
    raw.write(`event: ready\ndata: ${JSON.stringify({ chats: [...allowed] })}\n\n`);
    const send = (ev: ChatEvent) => {
      if (all || allowed.has(ev.chatId)) raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    const unsubscribe = deps.events.subscribe(p.accountId, send);
    const heartbeat = setInterval(() => raw.write(': ping\n\n'), 25_000);
    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
      raw.end();
    };
    req.raw.on('close', close);
    req.raw.on('error', close);
  });
}
