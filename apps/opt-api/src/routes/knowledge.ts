import type { WidgetPrincipal } from '@core/amo';
import { isKnowledgeKind, KINDS, KNOWLEDGE_KINDS, loadKnowledge, templateText } from '@opt/kp-knowledge';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.ts';

const MAX_FILE_CHARS = 2_000_000;
const uploadBody = z.object({ filename: z.string().min(1).max(200), content: z.string().min(1).max(MAX_FILE_CHARS) });

/** База знаний опта: список справочников, шаблон, загрузка с проверкой, удаление. Файл приходит текстом (UTF-8). */
export function knowledgeRoutes(api: FastifyInstance, deps: Deps, principal: (req: FastifyRequest) => WidgetPrincipal, requireAdmin: (req: FastifyRequest, reply: FastifyReply) => boolean) {
  const kindOf = (req: FastifyRequest, reply: FastifyReply) => {
    const kind = (req.params as { kind?: string }).kind;
    if (isKnowledgeKind(kind)) return kind;
    void reply.code(404).send({ error: 'unknown_kind' });
    return null;
  };

  api.get('/kp/knowledge', async (req) => {
    const loaded = await deps.knowledge.list(principal(req).accountId);
    return {
      items: KNOWLEDGE_KINDS.map((kind) => {
        const it = loaded.find((l) => l.kind === kind);
        return { ...KINDS[kind], loaded: it ? { filename: it.filename, rows: it.rows, updatedAt: it.updatedAt, usage: it.usage } : null };
      }),
    };
  });

  // Шаблон и загруженный файл отдаются JSON-ом: ссылки из виджета не несут токен amo, скачивание делает сам виджет.
  api.get('/kp/knowledge/:kind/template', async (req, reply) => {
    const kind = kindOf(req, reply);
    if (!kind) return;
    return { filename: KINDS[kind].template, content: await templateText(kind) };
  });

  api.get('/kp/knowledge/:kind/file', async (req, reply) => {
    const kind = kindOf(req, reply);
    if (!kind) return;
    const r = await deps.db.query<{ filename: string; content: string }>('SELECT filename, content FROM kp_knowledge_items WHERE account_id = $1 AND kind = $2', [principal(req).accountId, kind]);
    const row = r.rows[0];
    if (!row) return reply.code(404).send({ error: 'not_loaded' });
    return { filename: row.filename, content: row.content };
  });

  /** Загрузка: файл проверяется целиком, при ошибках ничего не сохраняется, в ответе — строки и причины. */
  api.put('/kp/knowledge/:kind', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const kind = kindOf(req, reply);
    if (!kind) return;
    const b = uploadBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body' });
    const r = loadKnowledge(kind, b.data.content);
    if (!r.ok) return reply.code(422).send({ error: 'invalid_file', errors: r.errors });
    const p = principal(req);
    await deps.knowledge.save(p.accountId, kind, { filename: b.data.filename, content: b.data.content, data: r.data, rows: r.rows, userId: p.userId });
    await deps.journal.add({ accountId: p.accountId, kind: 'note', summary: `Справочник «${KINDS[kind].title}» загружен: ${r.rows} строк (${b.data.filename})`, details: { userId: p.userId, audit: 'knowledge', kind: kind } });
    return { ok: true, rows: r.rows };
  });

  api.delete('/kp/knowledge/:kind', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const kind = kindOf(req, reply);
    if (!kind) return;
    const p = principal(req);
    const removed = await deps.knowledge.remove(p.accountId, kind);
    if (removed) await deps.journal.add({ accountId: p.accountId, kind: 'note', summary: `Справочник «${KINDS[kind].title}» удалён`, details: { userId: p.userId, audit: 'knowledge', kind: kind } });
    return { ok: true, removed };
  });
}
