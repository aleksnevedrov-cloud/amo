import type { WidgetPrincipal } from '@core/amo';
import { draftsToPrices, KbLimitError, previewPriceList, readKbSheetRows, extractPrices, type ColumnMapping } from '@opt/kb';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.ts';

/** Файл до 50 МБ приходит base64 внутри JSON (как шаблон КП): лимит тела — с запасом на кодирование. */
const FILE_BODY_LIMIT = 72 * 1024 * 1024;

const textBody = z.object({ title: z.string().trim().max(300).default(''), content: z.string().min(1).max(2_000_000) });
const fileBody = z.object({ filename: z.string().trim().min(1).max(200), mime: z.string().max(200).optional(), contentBase64: z.string().min(1) });
/** Ссылка: период обновления в днях (по умолчанию 30, 0 — не обновлять), crawl — обойти раздел до 50 страниц. */
const urlBody = z.object({ url: z.string().trim().min(8).max(2000), refreshDays: z.number().int().min(0).max(365).optional(), crawl: z.boolean().optional() });
const searchQuery = z.object({ q: z.string().trim().min(1).max(500), limit: z.coerce.number().int().min(1).max(50).optional() });
const chunksQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).optional(), offset: z.coerce.number().int().min(0).optional() });

const mappingSchema = z.object({
  sheet: z.string().max(200).nullable().optional(),
  model: z.number().int().min(0).optional(),
  price: z.number().int().min(0).optional(),
  size: z.number().int().min(0).nullable().optional(),
  width: z.number().int().min(0).nullable().optional(),
  height: z.number().int().min(0).nullable().optional(),
  factory: z.number().int().min(0).nullable().optional(),
  unit: z.number().int().min(0).nullable().optional(),
  headerRow: z.number().int().min(0).nullable().optional(),
});
const nonstandardSchema = z.object({ heightPct: z.number().min(0).max(300).optional(), heightOverMm: z.number().int().optional(), widthPct: z.number().min(0).max(300).optional(), widthOverMm: z.number().int().optional(), thicknessPct: z.number().min(0).max(300).optional(), thicknessOverMm: z.number().int().optional(), doubleLeafPct: z.number().min(0).max(300).optional(), areaScale: z.boolean().optional() }).strict();
const vatSchema = z.enum(['included', 'no_vat', 'unknown']);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).transform((s) => new Date(`${s}T00:00:00Z`));
/** Импорт прайса: сопоставление колонок после предпросмотра, фабрика и дата актуальности по умолчанию, НДС, правила нестандарта. */
const importBody = z.object({ mapping: mappingSchema, factory: z.string().trim().max(200).optional(), validAt: dateSchema.optional(), vat: vatSchema.optional(), nonstandard: nonstandardSchema.optional(), confidence: z.number().int().min(0).max(100).optional() });
const priceBody = z.object({
  model: z.string().trim().min(1).max(300),
  factory: z.string().trim().max(200).nullable().optional(),
  unit: z.string().trim().max(20).optional(),
  widthMm: z.number().int().min(100).max(10_000).nullable().optional(),
  heightMm: z.number().int().min(100).max(10_000).nullable().optional(),
  price: z.number().min(0).max(100_000_000),
  vat: vatSchema.optional(),
  validAt: dateSchema.optional(),
  confidence: z.number().int().min(0).max(100).optional(),
  origin: z.enum(['price_list', 'web', 'manager', 'purchase']).optional(),
  nonstandard: nonstandardSchema.optional(),
  url: z.string().trim().max(2000).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});
const pricesQuery = z.object({ q: z.string().trim().max(200).optional(), sourceId: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(1000).optional(), offset: z.coerce.number().int().min(0).optional() });
const aliasBody = z.object({ alias: z.string().trim().min(1).max(300).optional(), canonical: z.string().trim().min(1).max(300).optional(), lines: z.string().max(20_000).optional() });

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

  /** Ссылка на страницу или файл по url (этап 2): скачивание и разбор — в задании очереди; тот же адрес повторно — переиндексация. */
  api.post('/kb/sources/url', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = urlBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body' });
    const p = principal(req);
    try {
      const { id, existed } = await kb.addUrl(p.accountId, { url: b.data.url, refreshDays: b.data.refreshDays === 0 ? null : b.data.refreshDays, crawl: b.data.crawl, userId: p.userId });
      await deps.kbQueue.enqueue({ accountId: p.accountId, sourceId: id, userId: p.userId });
      if (!existed) await deps.journal.add({ accountId: p.accountId, kind: 'note', summary: `База знаний: добавлена ссылка ${b.data.url}${b.data.crawl ? ' (обход раздела)' : ''}`, details: { sourceId: id, kind: 'url', crawl: Boolean(b.data.crawl), refreshDays: b.data.refreshDays ?? 30, userId: p.userId, audit: 'kb' } });
      return reply.code(202).send({ source: view(await kb.repo.get(p.accountId, id)), existed });
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

/** Цены (kb_prices) и синонимы (kb_aliases) — этап 3: предпросмотр и импорт прайса из xlsx-источника, список, правка, удаление. */
export function kbPriceRoutes(api: FastifyInstance, deps: Deps, principal: Principal, requireAdmin: RequireAdmin) {
  const kb = deps.kb;
  const idOf = (req: FastifyRequest): number | null => {
    const id = Number((req.params as { id?: string }).id);
    return Number.isInteger(id) && id > 0 ? id : null;
  };
  const xlsxSource = async (accountId: number, id: number) => {
    const s = await kb.repo.get(accountId, id);
    if (!s || !s.filePath) return null;
    if (!/\.(xlsx|xlsm)$/i.test(s.original ?? s.title) && !/spreadsheetml/i.test(s.mime ?? '')) return null;
    return { source: s, bytes: new Uint8Array(await readFile(s.filePath)) };
  };

  /** Предпросмотр: авто-сопоставление колонок (или переданное менеджером в query как JSON), первые 20 позиций, итог. */
  api.get('/kb/sources/:id/prices/preview', async (req, reply) => {
    const id = idOf(req);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const q = z.object({ mapping: z.string().max(2000).optional() }).safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: 'bad_query' });
    let given: Partial<ColumnMapping> = {};
    if (q.data.mapping) {
      const m = mappingSchema.safeParse(JSON.parse(q.data.mapping));
      if (!m.success) return reply.code(400).send({ error: 'bad_mapping' });
      given = m.data as Partial<ColumnMapping>;
    }
    const x = await xlsxSource(principal(req).accountId, id);
    if (!x) return reply.code(404).send({ error: 'not_xlsx', message: 'Цены извлекаются только из xlsx-источников' });
    return previewPriceList(x.bytes, given);
  });

  /** Импорт после подтверждения: прежние цены этого источника заменяются. */
  api.post('/kb/sources/:id/prices/import', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = idOf(req);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const b = importBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body', issues: b.error.issues });
    const p = principal(req);
    const x = await xlsxSource(p.accountId, id);
    if (!x) return reply.code(404).send({ error: 'not_xlsx' });
    const rows = await readKbSheetRows(x.bytes);
    const preview = await previewPriceList(x.bytes, b.data.mapping as Partial<ColumnMapping>);
    const { drafts, skipped } = extractPrices(rows, preview.mapping);
    if (!drafts.length) return reply.code(422).send({ error: 'no_prices', message: 'По выбранным колонкам цен не найдено' });
    const n = await kb.prices.replaceForSource(p.accountId, id, draftsToPrices(drafts, { factory: b.data.factory ?? null, validAt: b.data.validAt, vat: b.data.vat, nonstandard: b.data.nonstandard, confidence: b.data.confidence }).map((r) => ({ ...r, createdBy: p.userId })));
    await deps.journal.add({ accountId: p.accountId, kind: 'note', summary: `База знаний: из прайса «${x.source.title}» импортировано цен ${n}${skipped ? `, пропущено строк ${skipped}` : ''}`, details: { sourceId: id, imported: n, skipped, factory: b.data.factory ?? null, validAt: b.data.validAt ?? null, userId: p.userId, audit: 'kb_prices' } });
    return { imported: n, skipped };
  });

  api.get('/kb/prices', async (req, reply) => {
    const q = pricesQuery.safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: 'bad_query' });
    return kb.prices.list(principal(req).accountId, q.data);
  });

  /** Ручная запись цены (менеджер): по умолчанию origin manager, доверие 90. */
  api.post('/kb/prices', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = priceBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body', issues: b.error.issues });
    const p = principal(req);
    const id = await kb.prices.upsert({ accountId: p.accountId, ...b.data, origin: b.data.origin ?? 'manager', createdBy: p.userId });
    return { price: await kb.prices.byId(p.accountId, id) };
  });

  api.put('/kb/prices/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = idOf(req);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const b = priceBody.partial().safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body', issues: b.error.issues });
    // Происхождение записи при правке не меняется.
    const patch = { ...b.data };
    delete patch.origin;
    const price = await kb.prices.update(principal(req).accountId, id, patch);
    if (!price) return reply.code(404).send({ error: 'not_found' });
    return { price };
  });

  api.delete('/kb/prices/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = idOf(req);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    if (!(await kb.prices.remove(principal(req).accountId, id))) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  api.get('/kb/aliases', async (req) => ({ aliases: await kb.aliases.list(principal(req).accountId) }));

  /** Синоним: пара alias → canonical или строки «каноническое = синоним = синоним». */
  api.post('/kb/aliases', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = aliasBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body' });
    const p = principal(req);
    try {
      let n = 0;
      if (b.data.lines) for (const line of b.data.lines.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) n += await kb.aliases.addLine(p.accountId, line, { createdBy: p.userId });
      else if (b.data.alias && b.data.canonical) n += (await kb.aliases.add(p.accountId, b.data.alias, b.data.canonical, { createdBy: p.userId })) ? 1 : 0;
      else return reply.code(400).send({ error: 'bad_body' });
      return { added: n, aliases: await kb.aliases.list(p.accountId) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  api.delete('/kb/aliases/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = idOf(req);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    if (!(await kb.aliases.remove(principal(req).accountId, id))) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
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
    crawl: s.crawl,
    parentId: s.parentId,
    httpStatus: s.httpStatus,
  };
}
