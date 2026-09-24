import type { FastifyInstance } from 'fastify';
import type { Deps } from '../deps.ts';

async function probe(fn: () => Promise<unknown>): Promise<'ok' | 'fail'> {
  try {
    await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))]);
    return 'ok';
  } catch {
    return 'fail';
  }
}

export function healthRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/health', { config: { rateLimit: false } }, async (_req, reply) => {
    const [db, redis] = await Promise.all([probe(() => deps.db.query('SELECT 1')), probe(() => deps.redis.ping())]);
    const ok = db === 'ok' && redis === 'ok';
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', checks: { db, redis } });
  });
}
