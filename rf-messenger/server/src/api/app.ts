import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import QRCode from 'qrcode';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { AmoRestError, type AmoRest } from '../amo/rest.ts';
import type { AmojoClient } from '../amojo/client.ts';
import { verifyAmojoHook } from '../amojo/signature.ts';
import { isAmoOrigin, tokenAudience, verifyWidgetToken, type Principal } from '../auth.ts';
import type { Bridge, StartChatInput, WindowSendInput } from '../bridge.ts';
import type { ChatEvent } from '../events.ts';
import type { JobQueue } from '../queue.ts';
import { chatRoutes } from './chat.ts';
import { CHAT_START_KINDS, ChannelValidationError, createChannelSchema, KIND_TEXT, PHONE_START_KINDS, STATUS_TEXT, validateChannel } from '../channels.ts';
import { safeEqualHex } from '../crypto.ts';
import type { Env } from '../config.ts';
import type { SecretBox } from '../crypto.ts';
import { safeFileName, type FileStore } from '../files.ts';
import type { Store } from '../store.ts';
import { PROXY_STATUS_KEY, readProxyStatus } from '../proxy-monitor.ts';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody: Buffer | null;
    principal: Principal | null;
  }
}

export interface ApiDeps {
  env: Env;
  store: Store;
  files: FileStore;
  bridge: Bridge;
  amojo: AmojoClient | null;
  box: SecretBox;
  redis: Redis;
  /** fetch для проверки ключей каналов (в тестах — заглушка). */
  fetch?: typeof fetch;
  /** REST API amoCRM (OAuth интеграции). */
  rest?: AmoRest | null;
  /** «Написать первым»: выполняется в процессе коннекторов, api ждёт результат. */
  startChat?: (input: StartChatInput) => Promise<{ chatId: number; messageId: number }>;
  /** Вебхуки мессенджеров (Авито): очередь в процесс коннекторов. */
  webhooks?: { add(channelId: number, body: unknown): Promise<void> };
  /** Окно переписки: отправка (в процессе коннекторов), очередь задач (история), события (SSE). */
  windowSend?: (input: WindowSendInput) => Promise<{ messageIds: number[] }>;
  queue?: JobQueue;
  events?: { subscribe(accountId: number, fn: (ev: ChatEvent) => void): () => void };
}

/** Ключи Redis: QR для входа (WhatsApp, Telegram личный) и пароль 2FA Telegram. */
export const qrKey = (kind: string, id: number) => (kind === 'telegram_user' ? `rfm:tg:qr:${id}` : `rfm:wa:qr:${id}`);
export const tgPasswordKey = (id: number) => `rfm:tg:pwd:${id}`;

const startChatSchema = z
  .object({
    channelId: z.number().int().positive(),
    contactId: z.number().int().positive(),
    phone: z.string().trim().min(5).max(32).optional(),
    chatId: z.number().int().positive().optional(),
    text: z.string().trim().min(1, 'Введите текст первого сообщения').max(4000, 'Сообщение длиннее 4000 символов'),
  })
  .refine((v) => Boolean(v.phone) !== Boolean(v.chatId), 'Нужен номер клиента или существующий чат');

const okPage = (title: string, text: string) =>
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${title}</title></head><body style="font:15px/1.5 sans-serif;padding:32px;color:#2e3640"><h2 style="font-weight:500">${title}</h2><p>${text}</p></body></html>`;

/** Типы, которые безопасно показывать в браузере; остальное (html, svg, js…) — только скачиванием. */
export function inlineMime(mime: string): boolean {
  const m = mime.toLowerCase();
  if (m === 'image/svg+xml') return false;
  return /^(image|audio|video)\//.test(m) || m === 'application/pdf';
}

/** Канал Redis: процесс коннекторов перечитывает список каналов. */
export const CHANNELS_CHANGED = 'rfm:channels-changed';

export async function buildApp(deps: ApiDeps, opts: FastifyServerOptions = {}) {
  const { env, store } = deps;
  const app = Fastify({
    // Ровно один прокси перед сервисом — nginx на хосте; X-Forwarded-For от клиента не доверяем.
    trustProxy: (_addr: string, hop: number) => hop === 0,
    bodyLimit: 1024 * 1024,
    logger: { level: env.LOG_LEVEL, redact: ['req.headers["x-auth-token"]', 'req.headers["x-signature"]'] },
    ...opts,
  });
  app.decorateRequest('rawBody', null);
  app.decorateRequest('principal', null);

  // Сырое тело нужно для проверки подписи вебхука amo. amoCRM может прислать JSON
  // с Content-Type, отличным от application/json, поэтому тело принимаем любого типа.
  const parseBody = (req: FastifyRequest, body: Buffer, done: (err: Error | null, body?: unknown) => void) => {
    req.rawBody = body;
    if (!body.length) return done(null, {});
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch {
      done(Object.assign(new Error('Некорректный JSON'), { statusCode: 400 }), undefined);
    }
  };
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, parseBody);

  await app.register(cors, {
    origin: (origin, cb) => cb(null, Boolean(origin && isAmoOrigin(origin, env.AMO_ALLOWED_DOMAINS))),
    allowedHeaders: ['content-type', 'x-auth-token', 'x-rfm-session'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  });
  // Загрузка файлов из окна переписки (multipart); размер — MAX_FILE_MB.
  await app.register(multipart, { limits: { fileSize: deps.files.maxBytes, files: 1, fields: 5 } });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    return reply.code(status).send({ error: status >= 500 ? 'internal_error' : err.message });
  });

  app.get('/health', async (_req, reply) => {
    const db = await store.db.query('SELECT 1').then(() => true, () => false);
    const redis = await deps.redis.ping().then(() => true, () => false);
    const proxy = readProxyStatus(redis ? await deps.redis.get(PROXY_STATUS_KEY).catch(() => null) : null);
    return reply.code(db && redis ? 200 : 503).send({ ok: db && redis, db, redis, amojo: Boolean(deps.amojo), ...proxy });
  });

  // ---------- Вебхук amoCRM: исходящие сообщения ----------
  app.post<{ Params: { scopeId: string } }>(
    '/amojo/v1/hook/:scopeId',
    { config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const secret = env.AMOJO_CHANNEL_SECRET;
      const sig = req.headers['x-signature'];
      if (!secret || !req.rawBody || !verifyAmojoHook(secret, req.rawBody, typeof sig === 'string' ? sig : undefined)) {
        req.log.warn(
          {
            contentType: req.headers['content-type'] ?? null,
            bodyBytes: req.rawBody?.length ?? null,
            hasSignature: typeof sig === 'string',
          },
          'вебхук amo: подпись не прошла проверку',
        );
        return reply.code(401).send({ error: 'bad_signature' });
      }
      const conn = await store.getConnectionByScope(req.params.scopeId);
      if (!conn) return reply.code(404).send({ error: 'unknown_scope' });
      const result = await deps.bridge.onAmoHook(conn.accountId, req.body);
      if (result !== 'queued' && result !== 'duplicate') req.log.warn({ result }, 'вебхук amo не обработан');
      return reply.send({ ok: true });
    },
  );

  // ---------- OAuth интеграции: amo перенаправляет на адрес интеграции (корень сайта) с кодом ----------
  app.get<{ Querystring: { code?: string; referer?: string; error?: string } }>(
    '/',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { code, referer } = req.query;
      if (!code || !referer) return reply.code(404).send({ error: 'not_found' });
      if (!deps.rest) return reply.code(503).send({ error: 'OAuth не настроен' });
      try {
        await deps.rest.exchangeCode(referer, code, (id) => !env.AMO_ACCOUNT_IDS.length || env.AMO_ACCOUNT_IDS.includes(id));
      } catch (err) {
        const status = err instanceof AmoRestError && err.status >= 400 && err.status < 500 ? err.status : 502;
        req.log.warn({ err: (err as Error).message }, 'OAuth amoCRM не выполнен');
        return reply.code(status).type('text/html; charset=utf-8').send(okPage('Не удалось авторизовать', (err as Error).message.replace(/[<>&]/g, '')));
      }
      return reply.type('text/html; charset=utf-8').send(okPage('РФ-Мессенджер авторизован в amoCRM', 'Окно можно закрыть.'));
    },
  );

  // ---------- Файлы переписки по подписанной ссылке ----------
  app.get<{ Params: { id: string; name: string }; Querystring: { e?: string; s?: string } }>('/f/:id/:name', async (req, reply) => {
    const check = deps.files.verify(req.params.id, req.query.e, req.query.s);
    if (check === 'bad') return reply.code(403).send({ error: 'bad_link' });
    if (check === 'expired') return reply.code(410).send({ error: 'Срок действия ссылки истёк, запросите файл у менеджера' });
    const file = await store.fileById(req.params.id);
    if (!file) return reply.code(404).send({ error: 'not_found' });
    const data = await deps.files.read(file.id).catch(() => null);
    if (!data) return reply.code(404).send({ error: 'not_found' });
    return reply
      .header('content-type', file.mime)
      .header('content-disposition', `${inlineMime(file.mime) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(safeFileName(file.name))}`)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'private, max-age=86400')
      .send(data);
  });

  // ---------- Вебхук Авито: секрет в адресе, тело — в очередь процессу коннекторов ----------
  app.post<{ Params: { channelId: string; secret: string } }>(
    '/hooks/avito/:channelId/:secret',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const id = Number(req.params.channelId);
      const given = req.params.secret;
      if (!Number.isInteger(id) || id <= 0 || !/^[0-9a-f]{32,64}$/.test(given)) return reply.code(404).send({ error: 'not_found' });
      const channel = await store.channelById(id);
      if (!channel || channel.kind !== 'avito') return reply.code(404).send({ error: 'not_found' });
      let secret = '';
      try {
        secret = String((JSON.parse(deps.box.decrypt(channel.credentials)) as { webhookSecret?: string }).webhookSecret ?? '');
      } catch {
        secret = '';
      }
      if (!secret || !safeEqualHex(secret, given)) return reply.code(401).send({ error: 'bad_secret' });
      if (!deps.webhooks) return reply.code(503).send({ error: 'unavailable' });
      await deps.webhooks.add(id, req.body ?? {});
      return reply.send({ ok: true });
    },
  );

  // ---------- API виджета ----------
  const audience = tokenAudience(env.PUBLIC_URL);
  const auth = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.headers['x-auth-token'];
    if (typeof token !== 'string' || !token) return reply.code(401).send({ error: 'Нет токена виджета' });
    let p: Principal;
    try {
      p = await verifyWidgetToken(token, { clientSecret: env.AMO_CLIENT_SECRET, clientId: env.AMO_CLIENT_ID, audience });
    } catch {
      return reply.code(401).send({ error: 'Недействительный токен виджета' });
    }
    // amoCRM переиспользует один X-Auth-Token для нескольких запросов в пределах его срока жизни,
    // поэтому повтор jti не отклоняем; защита — подпись client_secret, aud и обязательный exp.
    if (env.AMO_ACCOUNT_IDS.length && !env.AMO_ACCOUNT_IDS.includes(p.accountId)) return reply.code(403).send({ error: 'Аккаунт не подключён к сервису' });
    req.principal = p;
  };
  const adminOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.principal?.isAdmin) return reply.code(403).send({ error: 'Настройки мессенджеров доступны только администратору' });
  };
  const who = (req: FastifyRequest): Principal => {
    if (!req.principal) throw Object.assign(new Error('Нет токена виджета'), { statusCode: 401 });
    return req.principal;
  };

  await app.register(
    async (w) => {
      w.addHook('preHandler', auth);
      w.addHook('preHandler', adminOnly);

      w.get('/status', async (req) => {
        const { accountId } = who(req);
        const [conn, channels, oauth] = await Promise.all([
          store.getConnection(accountId),
          store.listChannels(accountId),
          deps.rest ? deps.rest.connected(accountId) : false,
        ]);
        return {
          amojo: { configured: Boolean(deps.amojo), connected: Boolean(conn) },
          oauth: {
            configured: Boolean(deps.rest),
            connected: oauth,
            url: `https://www.amocrm.ru/oauth?client_id=${encodeURIComponent(env.AMO_CLIENT_ID)}&state=rfm&mode=popup`,
          },
          channels: channels.map((c) => ({
            id: c.id,
            kind: c.kind,
            kindText: KIND_TEXT[c.kind],
            title: c.title,
            status: c.status,
            statusText: STATUS_TEXT[c.status],
            statusDetail: c.statusDetail,
            createdAt: c.createdAt.toISOString(),
          })),
        };
      });

      w.post('/amojo/connect', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
        const { accountId } = who(req);
        const body = z.object({ amojoAccountId: z.string().uuid() }).safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'Нужен amojo_id аккаунта' });
        if (!deps.amojo) return reply.code(409).send({ error: 'Канал чатов ещё не зарегистрирован в amoCRM: нет AMOJO_CHANNEL_ID и секрета' });
        const { scopeId } = await deps.amojo.connect(body.data.amojoAccountId, env.AMOJO_CHANNEL_TITLE);
        await store.saveConnection(accountId, body.data.amojoAccountId, scopeId);
        return { connected: true };
      });

      w.post('/channels', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
        const { accountId } = who(req);
        const input = createChannelSchema.safeParse(req.body);
        if (!input.success) return reply.code(400).send({ error: input.error.issues[0]?.message ?? 'Некорректные данные' });
        if (input.data.kind === 'telegram_user' && !env.TELEGRAM_API_ID)
          return reply.code(409).send({ error: 'Telegram личный не настроен на сервере: нет TELEGRAM_API_ID и TELEGRAM_API_HASH' });
        let v;
        try {
          v = await validateChannel(input.data, deps.fetch ? { fetch: deps.fetch } : {});
        } catch (err) {
          if (err instanceof ChannelValidationError) return reply.code(422).send({ error: err.message });
          throw err;
        }
        const channel = await store.createChannel({
          accountId,
          kind: v.kind,
          title: v.title,
          externalId: v.externalId,
          credentials: deps.box.encrypt(JSON.stringify(v.credentials)),
        });
        if (!channel) return reply.code(409).send({ error: 'Этот канал уже подключён' });
        await deps.redis.publish(CHANNELS_CHANGED, String(channel.id));
        // Ключи в ответ не возвращаются (раздел 5 ТЗ).
        return reply.code(201).send({ id: channel.id, title: channel.title, status: channel.status });
      });

      // WhatsApp и Telegram личный: текущий QR для сканирования (процесс коннекторов обновляет его сам).
      w.get<{ Params: { id: string } }>('/channels/:id/qr', async (req, reply) => {
        const { accountId } = who(req);
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'Некорректный id' });
        const channel = await store.channelOfAccount(accountId, id);
        if (!channel || (channel.kind !== 'whatsapp' && channel.kind !== 'telegram_user')) return reply.code(404).send({ error: 'Канал не найден' });
        const qr = await deps.redis.get(qrKey(channel.kind, id));
        return {
          status: channel.status,
          needPassword: channel.kind === 'telegram_user' && /пароль/i.test(channel.statusDetail ?? ''),
          statusText: STATUS_TEXT[channel.status],
          statusDetail: channel.statusDetail,
          title: channel.title,
          svg: qr ? await QRCode.toString(qr, { type: 'svg', margin: 1, width: 264 }) : null,
        };
      });

      // Telegram личный: пароль двухэтапной проверки для входа. Хранится 5 минут, зашифрованным; коннектор забирает и удаляет.
      w.post<{ Params: { id: string } }>('/channels/:id/password', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
        const { accountId } = who(req);
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'Некорректный id' });
        const body = z.object({ password: z.string().min(1).max(256) }).safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'Введите пароль' });
        const channel = await store.channelOfAccount(accountId, id);
        if (!channel || channel.kind !== 'telegram_user') return reply.code(404).send({ error: 'Канал не найден' });
        await deps.redis.set(tgPasswordKey(id), deps.box.encrypt(body.data.password), 'EX', 300);
        return { accepted: true };
      });

      // «Новый QR»: перезапуск сессии канала в процессе коннекторов.
      w.post<{ Params: { id: string } }>('/channels/:id/restart', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
        const { accountId } = who(req);
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'Некорректный id' });
        const channel = await store.channelOfAccount(accountId, id);
        if (!channel) return reply.code(404).send({ error: 'Канал не найден' });
        await store.setChannelStatus(id, 'starting', 'Запуск…');
        await deps.redis.publish(CHANNELS_CHANGED, `restart:${id}`);
        return { restarted: true };
      });

      w.delete<{ Params: { id: string } }>('/channels/:id', async (req, reply) => {
        const { accountId } = who(req);
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'Некорректный id' });
        if (!(await store.deleteChannel(accountId, id))) return reply.code(404).send({ error: 'Канал не найден' });
        await deps.redis.publish(CHANNELS_CHANGED, String(id));
        return { deleted: true };
      });
    },
    { prefix: '/widget/v1' },
  );

  // ---------- Окно переписки в карточке (чаты, сообщения, файлы, шаблоны, SSE) ----------
  await chatRoutes(app, { ...deps, auth, who });

  // ---------- API виджета для менеджеров: «Написать первым» в карточке ----------
  await app.register(
    async (w) => {
      w.addHook('preHandler', auth);

      // Каналы, через которые можно написать первым, и контакты карточки с телефонами.
      w.get<{ Querystring: { leadId?: string; contactId?: string } }>('/compose', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
        const { accountId } = who(req);
        const leadId = Number(req.query.leadId ?? 0);
        const contactId = Number(req.query.contactId ?? 0);
        if (!(Number.isInteger(leadId) && leadId >= 0 && Number.isInteger(contactId) && contactId >= 0) || (!leadId && !contactId))
          return reply.code(400).send({ error: 'Нужен id сделки или контакта' });
        const all = await store.listChannels(accountId);
        const channels = await Promise.all(
          all
            .filter((c) => PHONE_START_KINDS.has(c.kind) || CHAT_START_KINDS.has(c.kind))
            .map(async (c) => ({
              id: c.id,
              kind: c.kind,
              kindText: KIND_TEXT[c.kind],
              title: c.title,
              connected: c.status === 'connected',
              // VK и MAX: по номеру написать нельзя — только тем, кто уже писал (выбор из чатов канала).
              ...(CHAT_START_KINDS.has(c.kind)
                ? { byChat: true, chats: (await store.recentChats(accountId, c.id)).map((ch) => ({ id: ch.id, title: ch.title })) }
                : {}),
            })),
        );
        if (!deps.rest || !(await deps.rest.connected(accountId)))
          return { channels, contacts: [], error: 'Интеграция не авторизована в amoCRM: администратору нужно нажать «Авторизовать» в настройках виджета' };
        try {
          const contacts = leadId ? await deps.rest.leadContacts(accountId, leadId) : [await deps.rest.contact(accountId, contactId)];
          return { channels, contacts };
        } catch (err) {
          req.log.warn({ err: (err as Error).message }, 'контакты карточки не получены');
          return { channels, contacts: [], error: err instanceof AmoRestError ? err.message : 'amoCRM не ответил' };
        }
      });

      w.post('/chats/start', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
        const { accountId, userId } = who(req);
        const body = startChatSchema.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'Некорректные данные' });
        if (!deps.startChat) return reply.code(503).send({ error: 'Сервис отправки недоступен' });
        try {
          return await deps.startChat({ accountId, userId, ...body.data });
        } catch (err) {
          req.log.warn({ err: (err as Error).message }, 'написать первым: ошибка');
          return reply.code(422).send({ error: (err as Error).message || 'Не удалось отправить' });
        }
      });
    },
    { prefix: '/widget/v1' },
  );

  return app;
}
