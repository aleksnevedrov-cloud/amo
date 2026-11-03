import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { AmojoClient } from '../amojo/client.ts';
import { verifyAmojoHook } from '../amojo/signature.ts';
import { isAmoOrigin, tokenAudience, verifyWidgetToken, type Principal } from '../auth.ts';
import type { Bridge } from '../bridge.ts';
import { ChannelValidationError, createChannelSchema, KIND_TEXT, STATUS_TEXT, validateChannel } from '../channels.ts';
import type { Env } from '../config.ts';
import type { SecretBox } from '../crypto.ts';
import { safeFileName, type FileStore } from '../files.ts';
import type { Store } from '../store.ts';

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
}

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

  // Сырое тело нужно для проверки подписи вебхука amo.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
    req.rawBody = body;
    if (!body.length) return done(null, {});
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch {
      done(Object.assign(new Error('Некорректный JSON'), { statusCode: 400 }), undefined);
    }
  });

  await app.register(cors, {
    origin: (origin, cb) => cb(null, Boolean(origin && isAmoOrigin(origin, env.AMO_ALLOWED_DOMAINS))),
    allowedHeaders: ['content-type', 'x-auth-token'],
    methods: ['GET', 'POST', 'DELETE'],
  });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    return reply.code(status).send({ error: status >= 500 ? 'internal_error' : err.message });
  });

  app.get('/health', async (_req, reply) => {
    const db = await store.db.query('SELECT 1').then(() => true, () => false);
    const redis = await deps.redis.ping().then(() => true, () => false);
    return reply.code(db && redis ? 200 : 503).send({ ok: db && redis, db, redis, amojo: Boolean(deps.amojo) });
  });

  // ---------- Вебхук amoCRM: исходящие сообщения ----------
  app.post<{ Params: { scopeId: string } }>(
    '/amojo/v1/hook/:scopeId',
    { config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const secret = env.AMOJO_CHANNEL_SECRET;
      const sig = req.headers['x-signature'];
      if (!secret || !req.rawBody || !verifyAmojoHook(secret, req.rawBody, typeof sig === 'string' ? sig : undefined)) {
        return reply.code(401).send({ error: 'bad_signature' });
      }
      const conn = await store.getConnectionByScope(req.params.scopeId);
      if (!conn) return reply.code(404).send({ error: 'unknown_scope' });
      const result = await deps.bridge.onAmoHook(conn.accountId, req.body);
      if (result !== 'queued' && result !== 'duplicate') req.log.warn({ result }, 'вебхук amo не обработан');
      return reply.send({ ok: true });
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

  // ---------- API виджета (только администратор аккаунта) ----------
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
    // Токен одноразовый: повтор того же jti отклоняем.
    const fresh = await deps.redis.set(`rfm:jti:${p.tokenId}`, '1', 'EX', 900, 'NX');
    if (fresh !== 'OK') return reply.code(401).send({ error: 'Токен уже использован' });
    if (env.AMO_ACCOUNT_IDS.length && !env.AMO_ACCOUNT_IDS.includes(p.accountId)) return reply.code(403).send({ error: 'Аккаунт не подключён к сервису' });
    if (!p.isAdmin) return reply.code(403).send({ error: 'Настройки мессенджеров доступны только администратору' });
    req.principal = p;
  };
  const who = (req: FastifyRequest): Principal => {
    if (!req.principal) throw Object.assign(new Error('Нет токена виджета'), { statusCode: 401 });
    return req.principal;
  };

  await app.register(
    async (w) => {
      w.addHook('preHandler', auth);

      w.get('/status', async (req) => {
        const { accountId } = who(req);
        const [conn, channels] = await Promise.all([store.getConnection(accountId), store.listChannels(accountId)]);
        return {
          amojo: { configured: Boolean(deps.amojo), connected: Boolean(conn) },
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

  return app;
}
