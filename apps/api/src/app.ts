import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { normalizeAccountDomain } from '@ai-door/amo';
import Fastify, { type FastifyError, type FastifyServerOptions } from 'fastify';
import type { Deps } from './deps.ts';
import { healthRoutes } from './routes/health.ts';
import { oauthRoutes } from './routes/oauth.ts';
import { salesbotRoutes } from './routes/salesbot.ts';
import { widgetRoutes } from './routes/widget.ts';

export async function buildApp(deps: Deps, opts: FastifyServerOptions = {}) {
  const app = Fastify({
    trustProxy: true,
    logger: {
      level: deps.env.LOG_LEVEL,
      redact: ['req.headers["x-auth-token"]', 'req.headers.authorization', 'req.query.code'],
    },
    ...opts,
  });

  // Виджет работает на домене аккаунта amo: разрешаем только такие origin.
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, false);
      cb(null, normalizeAccountDomain(origin, deps.env.AMO_ALLOWED_DOMAINS) !== null);
    },
    allowedHeaders: ['content-type', 'x-auth-token'],
    methods: ['GET', 'PUT', 'POST', 'DELETE'],
  });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    return reply.code(status).send({ error: status >= 500 ? 'internal_error' : err.message });
  });

  healthRoutes(app, deps);
  oauthRoutes(app, deps);
  widgetRoutes(app, deps);
  salesbotRoutes(app, deps);
  return app;
}
