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
    // kb_db — отдельная БД базы знаний (контейнер opt-kb-db, RFD-AI-AGENT-OPT-KB).
    const [db, redis, kbDb] = await Promise.all([probe(() => deps.db.query('SELECT 1')), probe(() => deps.redis.ping()), probe(() => deps.kb.db.query('SELECT 1'))]);
    const ok = db === 'ok' && redis === 'ok' && kbDb === 'ok';
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', checks: { db, redis, kb_db: kbDb } });
  });
}
