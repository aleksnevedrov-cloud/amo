import type { WidgetPrincipal } from '@core/amo';
import { ALIASES_PAGE, MANUAL_ALIASES, exportCandidatesXlsx, exportSitesXlsx, exportPricesXlsx, isPriceBook, readSitesXlsx, KbLimitError, parsePriceBook, previewPriceList, pricesExportFilename, readKbSheetRows, type ColumnMapping, priceListTitleOf } from '@opt/kb';
import { answerFromKb, resolveOptRoute } from '@opt/kp';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.ts';

/** Файл до 50 МБ приходит base64 внутри JSON (как шаблон КП): лимит тела — с запасом на кодирование. */
const FILE_BODY_LIMIT = 72 * 1024 * 1024;

const textBody = z.object({ title: z.string().trim().max(300).default(''), content: z.string().min(1).max(2_000_000) });
const fileBody = z.object({ filename: z.string().trim().min(1).max(200), mime: z.string().max(200).optional(), contentBase64: z.string().min(1) });
/** Ссылка: период обновления в днях (по умолчанию 30, 0 — не обновлять), crawl — обойти раздел до 50 страниц. */
/** Сайт: комментарий (до 2000 знаков, пусто — снять) и «фабрика». */
const siteBody = z.object({ comment: z.string().max(2000).nullable().optional(), isFactory: z.boolean().optional() });
/** KB-MARKUP: наценка прайса, % — от −50 до 300, шаг 0,1; пусто (null) — 0. */
const markupBody = z.object({ markupPct: z.number().min(-50).max(300).nullable() }).refine((b) => b.markupPct === null || Math.abs(b.markupPct * 10 - Math.round(b.markupPct * 10)) < 1e-6);
const pctText = (n: number) => `${n.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} %`;

// KP-AGENT-V2, п. 4а: комментарий сайта и «фабрика» — сразу с ссылкой (как в PUT /kb/sources/:id/site).
const urlBody = z.object({ url: z.string().trim().min(8).max(2000), refreshDays: z.number().int().min(0).max(365).optional(), crawl: z.boolean().optional(), comment: z.string().max(2000).nullable().optional(), isFactory: z.boolean().optional() });
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
  abbr: z.number().int().min(0).nullable().optional(),
  description: z.number().int().min(0).nullable().optional(),
  headerRow: z.number().int().min(0).nullable().optional(),
});
const nonstandardSchema = z.object({ heightPct: z.number().min(0).max(300).optional(), heightOverMm: z.number().int().optional(), widthPct: z.number().min(0).max(300).optional(), widthOverMm: z.number().int().optional(), thicknessPct: z.number().min(0).max(300).optional(), thicknessOverMm: z.number().int().optional(), doubleLeafPct: z.number().min(0).max(300).optional(), areaScale: z.boolean().optional() }).strict();
const vatSchema = z.enum(['included', 'no_vat', 'unknown']);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).transform((s) => new Date(`${s}T00:00:00Z`));
/** Импорт прайса: сопоставление колонок после предпросмотра, фабрика и дата актуальности по умолчанию, НДС, правила нестандарта. */
const importBody = z.object({ mapping: mappingSchema.default({}), factory: z.string().trim().max(200).optional(), validAt: dateSchema.optional(), vat: vatSchema.optional(), nonstandard: nonstandardSchema.optional(), confidence: z.number().int().min(0).max(100).optional() });
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
const aliasQuery = z.object({
  source_id: z.coerce.number().int().min(0).optional(),
  q: z.string().max(200).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  limit: z.coerce.number().int().min(0).max(1000).default(ALIASES_PAGE),
});
/** Строка синонима для виджета: синоним, модель (каноническое) и ID товара, источник. */
const aliasView = (a: { id: number; alias: string; canonical: string; productId: string | null; sourceId: number | null }) => ({ id: a.id, alias: a.alias, canonical: a.canonical, productId: a.productId, sourceId: a.sourceId });
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
    const [sources, usage, priceCounts, bookCounts] = await Promise.all([kb.repo.list(accountId), kb.repo.usage(accountId), kb.prices.countBySource(accountId), kb.prices.bookCountsBySource(accountId)]);
    const jobs = await deps.kbQueue.states(accountId, sources.filter((s) => s.status === 'new').map((s) => s.id));
    // KB-PRICE-SHEETS: счётчики файла — цены дверей / комплектующих / фурнитуры / размеров / синонимов / комментариев.
    return { sources: sources.map((s) => ({ ...view(s), job: jobs[s.id] ?? null, prices: priceCounts.get(s.id) ?? 0, counts: bookCounts.get(s.id) ?? null })), usage };
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
      // Если xlsx распознан как прайс, цены импортирует задание индексации (в тестах — тут же); виджет видит их число.
      const prices = (await kb.prices.countBySource(p.accountId)).get(id) ?? 0;
      const counts = (await kb.prices.bookCountsBySource(p.accountId)).get(id) ?? null;
      return reply.code(202).send({ source: { ...view(await kb.repo.get(p.accountId, id)), prices, counts } });
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** Ссылка на страницу или файл по url (этап 2): скачивание и разбор — в задании очереди; тот же адрес повторно — переиндексация. */
  api.post('/kb/sources/url', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = urlBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body', message: b.error.issues.some((i) => i.path[0] === 'comment') ? 'комментарий — не длиннее 2000 знаков' : undefined });
    const p = principal(req);
    try {
      const { id, existed } = await kb.addUrl(p.accountId, { url: b.data.url, refreshDays: b.data.refreshDays === 0 ? null : b.data.refreshDays, crawl: b.data.crawl, userId: p.userId });
      if (b.data.comment !== undefined || b.data.isFactory !== undefined) await kb.repo.setSiteMeta(p.accountId, id, { ...(b.data.comment !== undefined ? { comment: b.data.comment } : {}), ...(b.data.isFactory !== undefined ? { isFactory: b.data.isFactory } : {}) });
      await deps.kbQueue.enqueue({ accountId: p.accountId, sourceId: id, userId: p.userId });
      if (!existed) await deps.journal.add({ accountId: p.accountId, kind: 'note', summary: `База знаний: добавлена ссылка ${b.data.url}${b.data.crawl ? ' (обход раздела)' : ''}${b.data.isFactory ? ', фабрика' : ''}${b.data.comment?.trim() ? `, комментарий: «${b.data.comment.trim().slice(0, 100)}»` : ''}`, details: { sourceId: id, kind: 'url', crawl: Boolean(b.data.crawl), refreshDays: b.data.refreshDays ?? 30, userId: p.userId, audit: 'kb' } });
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

  /**
   * Ответ на вопрос покупателя из базы (этап 4): top-5 фрагментов → модель отвечает только по ним со ссылками [n].
   * Нужна настроенная LLM; без фрагментов ответа нет, модель не вызывается.
   */
  api.post('/kb/answer', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ question: z.string().trim().min(2).max(500), leadId: z.coerce.number().int().positive().optional() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body' });
    const p = principal(req);
    const ai = await deps.ai(p.accountId);
    if (!ai) return reply.code(409).send({ error: 'no_llm' });
    const { settings } = await deps.settings.get(p.accountId);
    return answerFromKb(deps, { accountId: p.accountId, question: b.data.question, route: resolveOptRoute(settings), llm: ai.llm, pricing: settings.billing.pricing, userId: p.userId, leadId: b.data.leadId ?? null });
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
    // KB-PRICE-SHEETS-FIX, п. 3: многолистовой прайс — не ручная разметка колонок, а разбор всех вкладок: счётчики, ошибки
    // (лист, строка, колонка), пропущенное; виджет показывает это вместо панели «Импортировать N цен».
    const rows = await readKbSheetRows(x.bytes);
    if (isPriceBook(rows)) {
      const book = parsePriceBook(rows);
      return {
        sheets: [...new Set(rows.map((r) => r.sheet))],
        columns: [],
        mapping: { sheet: null, model: 0, price: 0, size: null, width: null, height: null, factory: null, unit: null, abbr: null, description: null, headerRow: null },
        headerFound: true,
        sample: [],
        total: book.products.length,
        skipped: book.skipped.length,
        vatHint: 'unknown',
        isPriceList: false,
        isPriceBook: true,
        book: {
          doors: book.products.length,
          estimates: book.products.filter((p) => p.estimate).length,
          components: book.products.reduce((n, p) => n + Object.values(p.components).filter((c) => c.status === 'priced' && c.price).length, 0),
          hardware: book.hardware.length,
          hardwareUnpriced: book.hardware.filter((h) => h.price === null).length,
          sizes: book.sizes.length,
          aliases: book.products.reduce((n, p) => n + p.aliases.length + (p.abbr ? 1 : 0), 0) + book.hardware.reduce((n, h) => n + h.aliases.length, 0),
          comments: book.products.filter((p) => p.card.comment).length,
          dictionary: book.dictionary.length,
          errors: book.errors.map((e) => `${e.sheet}${e.row ? `, строка ${e.row}` : ''}${e.column ? `, колонка «${e.column}»` : ''}: ${e.message}`),
          skipped: book.skipped.map((e) => `${e.sheet}${e.row ? `, строка ${e.row}` : ''}${e.column ? `, колонка «${e.column}»` : ''}: ${e.message}`),
        },
        priceImport: x.source.priceImport ?? null,
      };
    }
    return previewPriceList(x.bytes, given);
  });

  /** Переимпорт после проверки или с другой разметкой: прайс — единый источник цен, прежний прайс аккаунта заменяется целиком (KB-PRICELIST, а). */
  api.post('/kb/sources/:id/prices/import', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = idOf(req);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const b = importBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body', issues: b.error.issues });
    const p = principal(req);
    const r = await kb.importPriceList(p.accountId, id, { mapping: b.data.mapping as Partial<ColumnMapping>, factory: b.data.factory ?? null, validAt: b.data.validAt, vat: b.data.vat, nonstandard: b.data.nonstandard, confidence: b.data.confidence, userId: p.userId });
    if (!r) return reply.code(404).send({ error: 'not_xlsx' });
    // Многолистовой прайс: ошибка вкладки — текстом (лист, строка, колонка), прежние данные прайса сохранены.
    if (r.error) return reply.code(422).send({ error: 'book_error', message: `${r.error}; прежние данные прайса сохранены` });
    if (!r.imported) return reply.code(422).send({ error: 'no_prices', message: 'По выбранным колонкам цен не найдено' });
    return { imported: r.imported, skipped: r.skipped, replaced: r.replaced, ...(r.book ? { book: r.book, counts: (await kb.prices.bookCountsBySource(p.accountId)).get(id) ?? null } : {}) };
  });

  api.get('/kb/prices', async (req, reply) => {
    const q = pricesQuery.safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: 'bad_query' });
    return kb.prices.list(principal(req).accountId, q.data);
  });

  /** Выгрузка всех цен аккаунта в xlsx (этап 4): файл base64 внутри JSON — виджет скачивает его сам. */
  api.get('/kb/prices/export', async (req) => {
    const rows = await kb.prices.all(principal(req).accountId);
    const bytes = await exportPricesXlsx(rows);
    return { filename: pricesExportFilename(), rows: rows.length, contentBase64: Buffer.from(bytes).toString('base64') };
  });

  /** KP-AGENT-V2, п. 4а: комментарий к сайту («какие двери есть на сайте», до 2000 знаков) и чекбокс «фабрика». */
  api.put('/kb/sources/:id/site', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = idOf(req);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const b = siteBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body', message: 'комментарий — не длиннее 2000 знаков' });
    const p = principal(req);
    const s = await kb.repo.setSiteMeta(p.accountId, id, b.data);
    if (!s) return reply.code(404).send({ error: 'not_found', message: 'сайт не найден' });
    await deps.journal.add({ accountId: p.accountId, kind: 'note', summary: `База знаний: сайт ${s.original ?? s.title} — ${s.isFactory ? 'фабрика, ' : ''}комментарий ${s.comment ? `«${s.comment.slice(0, 80)}${s.comment.length > 80 ? '…' : ''}»` : 'пуст'}`, details: { sourceId: id, userId: p.userId, audit: 'kb' } });
    return { source: view(s) };
  });

  /**
   * KB-MARKUP: наценка прайса-источника. Цены kb_prices не меняются — наценка применяется при расчёте КП (новые черновики и
   * «Пересчитать»). В журнал — кто, когда, источник, было → стало.
   */
  api.put('/kb/sources/:id/markup', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = idOf(req);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const b = markupBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body', message: 'наценка — число от −50 до 300 с шагом 0,1' });
    const p = principal(req);
    const cur = await kb.repo.get(p.accountId, id);
    if (!cur) return reply.code(404).send({ error: 'not_found', message: 'источник не найден' });
    if (!cur.priceKey) return reply.code(409).send({ error: 'not_price', message: 'наценка задаётся только у прайса' });
    const pct = Math.round((b.data.markupPct ?? 0) * 10) / 10;
    const r = await kb.repo.setMarkup(p.accountId, id, pct);
    if (!r) return reply.code(404).send({ error: 'not_found', message: 'источник не найден' });
    if (r.before !== pct) {
      await deps.journal.add({ accountId: p.accountId, kind: 'note', summary: `База знаний: наценка прайса «${cur.title}»: ${pctText(r.before)} → ${pctText(pct)} (новые черновики и «Пересчитать»)`, details: { sourceId: id, title: cur.title, priceKey: cur.priceKey, before: r.before, after: pct, userId: p.userId, audit: 'kb_markup' } });
    }
    return { source: view(r.source) };
  });

  /** Сайты в xlsx (адрес, название, фабрика, комментарий) и обратно: новые адреса добавляются ссылками, у известных — комментарий и флаг. */
  api.get('/kb/sites/export', async (req) => {
    const sites = await kb.repo.sites(principal(req).accountId);
    return { filename: `kb-sites-${new Date().toISOString().slice(0, 10)}.xlsx`, rows: sites.length, contentBase64: Buffer.from(await exportSitesXlsx(sites)).toString('base64') };
  });

  api.post('/kb/sites/import', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = z.object({ contentBase64: z.string().min(1).max(10_000_000) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body' });
    const p = principal(req);
    let rows: Awaited<ReturnType<typeof readSitesXlsx>>;
    try {
      rows = await readSitesXlsx(new Uint8Array(Buffer.from(b.data.contentBase64, 'base64')));
    } catch (err) {
      return reply.code(422).send({ error: 'bad_file', message: `файл не читается: ${(err as Error).message}` });
    }
    let added = 0;
    let updated = 0;
    for (const r of rows) {
      try {
        const { id, existed } = await kb.addUrl(p.accountId, { url: r.url, refreshDays: 30, crawl: false, userId: p.userId });
        if (!existed) await deps.kbQueue.enqueue({ accountId: p.accountId, sourceId: id, userId: p.userId });
        await kb.repo.setSiteMeta(p.accountId, id, { comment: r.comment, isFactory: r.isFactory });
        if (existed) updated += 1;
        else added += 1;
      } catch (err) {
        req.log.warn({ err: (err as Error).message, url: r.url }, 'kb: сайт из xlsx не добавлен');
      }
    }
    await deps.journal.add({ accountId: p.accountId, kind: 'note', summary: `База знаний: сайты из xlsx — добавлено ${added}, обновлено ${updated}`, details: { added, updated, rows: rows.length, userId: p.userId, audit: 'kb' } });
    return { added, updated, rows: rows.length };
  });

  /** П. 4.4: кандидаты в прайс — цены, подтверждённые менеджером в КП; в подбор не идут. */
  api.get('/kb/candidates', async (req) => ({ items: (await kb.candidates.list(principal(req).accountId)).map((c) => ({ ...c, createdAt: c.createdAt.toISOString() })) }));
  api.get('/kb/candidates/export', async (req) => {
    const rows = await kb.candidates.list(principal(req).accountId);
    return { filename: `kb-candidates-${new Date().toISOString().slice(0, 10)}.xlsx`, rows: rows.length, contentBase64: Buffer.from(await exportCandidatesXlsx(rows)).toString('base64') };
  });
  api.delete('/kb/candidates/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = idOf(req);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    return (await kb.candidates.remove(principal(req).accountId, id)) ? { ok: true } : reply.code(404).send({ error: 'not_found' });
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

  /**
   * KB-ALIASES-UI: синонимы постранично — source_id (0 — добавлены вручную), q (синоним, модель или ID; без регистра и ё/е),
   * offset, limit (не больше 50); groups — счётчики по источникам с тем же поиском, all — всего синонимов у аккаунта.
   */
  api.get('/kb/aliases', async (req, reply) => {
    const q = aliasQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_query' });
    const { accountId } = principal(req);
    const [page, groups] = await Promise.all([kb.aliases.page(accountId, { sourceId: q.data.source_id ?? null, q: q.data.q, offset: q.data.offset, limit: q.data.limit }), kb.aliases.groups(accountId, q.data.q)]);
    const all = q.data.q?.trim() ? (await kb.aliases.groups(accountId)).reduce((n, g) => n + g.count, 0) : groups.reduce((n, g) => n + g.count, 0);
    return { aliases: page.items.map(aliasView), total: page.total, offset: q.data.offset, limit: Math.min(q.data.limit, ALIASES_PAGE), groups, all };
  });

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
      // Добавленные вручную — первая страница своей группы (импортированных из прайсов бывают тысячи).
      return { added: n, aliases: (await kb.aliases.page(p.accountId, { sourceId: MANUAL_ALIASES })).items.map(aliasView) };
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
    // KB-MULTIPRICE: ключ прайса, короткое название и итог последнего импорта (обновлён: было/стало/удалено/добавлено).
    priceKey: s.priceKey,
    priceTitle: s.priceKey ? priceListTitleOf(s.priceKey) : null,
    priceImport: s.priceImport,
    // KP-AGENT-V2, п. 4а: комментарий к сайту и флаг «фабрика».
    comment: s.comment,
    isFactory: s.isFactory,
    // KB-MARKUP: наценка прайса, %.
    markupPct: s.markupPct,
  };
}
