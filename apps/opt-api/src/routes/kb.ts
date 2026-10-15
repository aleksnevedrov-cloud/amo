import type { WidgetPrincipal } from '@core/amo';
import { KbLimitError } from '@opt/kb';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.ts';

/** Файл до 50 МБ приходит base64 внутри JSON (как шаблон КП): лимит тела — с запасом на кодирование. */
const FILE_BODY_LIMIT = 72 * 1024 * 1024;

const textBody = z.object({ title: z.string().trim().max(300).default(''), content: z.string().min(1).max(2_000_000) });
const fileBody = z.object({ filename: z.string().trim().min(1).max(200), mime: z.string().max(200).optional(), contentBase64: z.string().min(1) });
const searchQuery = z.object({ q: z.string().trim().min(1).max(500), limit: z.coerce.number().int().min(1).max(50).optional() });
const chunksQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).optional(), offset: z.coerce.number().int().min(0).optional() });

type Principal = (req: FastifyRequest) => WidgetPrincipal;
type RequireAdmin = (req: FastifyRequest, reply: FastifyReply) => boolean;

/** Вкладка «База знаний» опта (RFD-AI-AGENT-OPT-KB, этап 1): источники, индексация через очередь kb-index, фрагменты, поиск. */
export function kbRoutes(api: FastifyInstance, deps: Deps, principal: Principal, requireAdmin: RequireAdmin) {
  const kb = deps.kb;
  const idOf = (req: FastifyRequest): number | null => {
    const id = Number((req.params as { id?: string }).id);
    return Number.isInteger(id) && id > 0 ? id : null;
  };

  /** Список источников с состоянием задания очереди и занятым объёмом. */
  api.get('/kb/sources', async (req) => {
    const accountId = principal(req).accountId;
    const [sources, usage] = await Promise.all([kb.repo.list(accountId), kb.repo.usage(accountId)]);
    const jobs = await deps.kbQueue.states(accountId, sources.filter((s) => s.status === 'new').map((s) => s.id));
    return { sources: sources.map((s) => ({ ...view(s), job: jobs[s.id] ?? null })), usage };
  });

  api.post('/kb/sources/text', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = textBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body' });
    const p = principal(req);
    try {
      const id = await kb.addText(p.accountId, { title: b.data.title, content: b.data.content, userId: p.userId });
      await deps.kbQueue.enqueue({ accountId: p.accountId, sourceId: id, userId: p.userId });
      await deps.journal.add({ accountId: p.accountId, kind: 'note', summary: `База знаний: добавлен текст «${(await kb.repo.get(p.accountId, id))?.title ?? ''}»`, details: { sourceId: id, kind: 'text', userId: p.userId, audit: 'kb' } });
      return reply.code(202).send({ source: view(await kb.repo.get(p.accountId, id)) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  api.post('/kb/sources/file', { bodyLimit: FILE_BODY_LIMIT }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = fileBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body' });
    const p = principal(req);
    const bytes = new Uint8Array(Buffer.from(b.data.contentBase64, 'base64'));
    try {
      const id = await kb.addFile(p.accountId, { filename: b.data.filename, mime: b.data.mime ?? null, bytes, userId: p.userId });
      await deps.kbQueue.enqueue({ accountId: p.accountId, sourceId: id, userId: p.userId });
      await deps.journal.add({ accountId: p.accountId, kind: 'note', summary: `База знаний: загружен файл «${b.data.filename}» (${Math.round(bytes.byteLength / 1024)} КБ)`, details: { sourceId: id, kind: 'file', userId: p.userId, audit: 'kb' } });
      return reply.code(202).send({ source: view(await kb.repo.get(p.accountId, id)) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** Переиндексация: статус new и задание в очередь; старые фрагменты живут до успешного завершения. */
  api.post('/kb/sources/:id/reindex', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = idOf(req);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const p = principal(req);
    if (!(await kb.repo.get(p.accountId, id))) return reply.code(404).send({ error: 'not_found' });
    await kb.reindex(p.accountId, id);
    await deps.kbQueue.enqueue({ accountId: p.accountId, sourceId: id, userId: p.userId });
    return reply.code(202).send({ source: view(await kb.repo.get(p.accountId, id)) });
  });

  api.delete('/kb/sources/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = idOf(req);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const p = principal(req);
    const removed = await kb.remove(p.accountId, id);
    if (!removed) return reply.code(404).send({ error: 'not_found' });
    await deps.journal.add({ accountId: p.accountId, kind: 'note', summary: `База знаний: удалён источник «${removed.title}» (фрагментов ${removed.chunks})`, details: { sourceId: id, kind: removed.kind, userId: p.userId, audit: 'kb' } });
    return { ok: true };
  });

  api.get('/kb/sources/:id/chunks', async (req, reply) => {
    const id = idOf(req);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const q = chunksQuery.safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: 'bad_query' });
    const accountId = principal(req).accountId;
    const source = await kb.repo.get(accountId, id);
    if (!source) return reply.code(404).send({ error: 'not_found' });
    return { source: view(source), chunks: await kb.repo.listChunks(accountId, id, q.data) };
  });

  /** Семантический поиск по фрагментам (top-5 по умолчанию) — для проверки базы менеджером и для ответов агента. */
  api.get('/kb/search', async (req, reply) => {
    const q = searchQuery.safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: 'bad_query' });
    const p = principal(req);
    const r = await kb.search(p.accountId, q.data.q, { limit: q.data.limit ?? 5, userId: p.userId });
    return { query: q.data.q, hits: r.hits, model: r.model, tokens: r.tokens, costUsd: r.usd, ms: r.ms };
  });
}

function fail(reply: FastifyReply, err: unknown) {
  const message = (err as Error).message;
  if (err instanceof KbLimitError) return reply.code(409).send({ error: 'limit', message });
  return reply.code(400).send({ error: 'rejected', message });
}

function view(s: Awaited<ReturnType<Deps['kb']['repo']['get']>>) {
  if (!s) return null;
  return {
    id: s.id,
    kind: s.kind,
    title: s.title,
    original: s.original,
    mime: s.mime,
    status: s.status,
    sizeBytes: s.sizeBytes,
    chunks: s.chunks,
    embeddedChunks: s.embeddedChunks,
    refreshDays: s.refreshDays,
    nextRefreshAt: s.nextRefreshAt,
    error: s.error,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    indexedAt: s.indexedAt,
  };
}
