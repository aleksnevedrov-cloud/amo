import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { WidgetPrincipal } from '@core/amo';
import { categoryOf } from '@opt/kb';
import { asciiFilename, buildDraftDocument, describeFsError, composeKpMail, DEFAULT_CACHE_DAYS, DEFAULT_MAX_POSITIONS_PER_RUN, DEFAULT_MAX_SEARCH_CALLS, DEFAULT_PRICE_NOTE, DEFAULT_VAT_RATE, DEFAULT_WEB_SEARCH_DAILY_USD, KpBuildError, lineCategory, RESEARCH_BATCH, kpFileOf, kpTemplateRel, renderMailTemplate, addProjectItem, applyAnswer, buildQuestions, draftCounters, isPriceFile, ownNote, recalcDraftMarkup, researchablePositions, resolveKpPath, sendBlockers, imapConfigFor, kpLeadDirRel, type KpDraft, type KpLine, type KpPayload, type SendResult, type SentMailRecord } from '@opt/kp';
import type { JournalKind } from '@core/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.ts';

/** Шаблон КП — обычный DOCX, то есть zip: первые байты PK. */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const MAX_TEMPLATE_BYTES = 5 * 1024 * 1024;

const constantsSchema = z.object({
  sellerName: z.string().max(300).optional(),
  sellerRequisites: z.string().max(3000).optional(),
  vatRate: z.number().min(0).max(100).optional(),
  paymentTerms: z.string().max(1000).optional(),
  warranty: z.string().max(1000).optional(),
  delivery: z.string().max(1000).optional(),
  validDays: z.number().int().min(1).max(365).optional(),
  coverLetter: z.string().max(3000).optional(),
  signature: z.string().max(500).optional(),
  priceNote: z.string().max(500).optional(),
  priceValidity: z.string().max(200).optional(),
  /** Допуск цены аналога: заказчик — не более ±10 %. */
  analogPriceTolerancePct: z.number().min(0).max(10).optional(),
  /** Домены производителей, без схемы и пути; пусто по умолчанию. */
  manufacturerDomains: z.array(z.string().trim().min(1).max(100)).max(200).optional(),
  // Поиск рыночных цен (RFD-AI-AGENT-OPT-PRICE, этап 5): коэффициенты, режим запуска, кэш, лимиты.
  priceCoefficient: z.number().min(0.1).max(10).optional(),
  manufacturerCoefficients: z.record(z.string().trim().min(1).max(100), z.number().min(0.1).max(10)).optional(),
  autoResearch: z.boolean().optional(),
  researchCacheDays: z.number().int().min(0).max(365).optional(),
  maxPositionsPerRun: z.number().int().min(1).max(200).optional(),
  searchContext: z.enum(['low', 'medium', 'high']).optional(),
  maxSearchCalls: z.number().int().min(1).max(20).optional(),
  // База знаний (RFD-AI-AGENT-OPT-KB): дневной лимит веб-поиска в $ и выключатель приоритета базы.
  webSearchDailyUsd: z.number().min(0).max(1000).optional(),
  skipKnowledgeBase: z.boolean().optional(),
});

const settingsSchema = z.object({
  constants: constantsSchema.optional(),
  certsDir: z.string().max(300).nullable().optional(),
  numbering: z.object({ prefix: z.string().min(1).max(20).optional(), counter: z.number().int().min(0).optional() }).optional(),
});

const templateSchema = z.object({ filename: z.string().min(1).max(200), contentBase64: z.string().min(1) });
const leadBody = z.object({ leadId: z.coerce.number().int().positive() });
const draftBody = z.object({ draftId: z.coerce.number().int().positive() });

/** Правки менеджера: только то, что он вправе менять руками. */
const linesSchema = z.object({
  items: z
    .array(
      z.object({
        request_index: z.number().int().min(-1),
        page_id: z.string().max(100).nullable(),
        name: z.string().max(300),
        size: z.string().max(100),
        // Дробное количество допустимо («24,5» наличников из заявки клиента, XLSX-2).
        qty: z.number().positive().max(10_000),
        price: z.number().min(0).max(100_000_000).nullable(),
        lead_time: z.string().max(100),
        discount: z.number().min(0).max(100),
        // Поля автозаполнения цен идут сквозь правки менеджера без изменений (сервер решает, что цена стала ручной).
        priceSource: z.enum(['research', 'analog', 'manager', 'kb', 'price_file', 'web_confirmed']).optional(),
        market: z.object({ median: z.number(), min: z.number(), max: z.number(), count: z.number().int(), unit: z.literal('piece'), researchId: z.number().int(), researchedAt: z.string() }).nullable().optional(),
        coefficient: z.number().optional(),
        priceLabel: z.string().max(200).nullable().optional(),
        priceStale: z.boolean().optional(),
        kbPriceId: z.number().int().nullable().optional(),
      }),
    )
    .max(200),
});

/** Ответ опросника: вариант, своя цена, поля (неполная позиция, доставка, срок действия цены). */
const answerBody = z.object({
  key: z.string().min(1).max(600),
  option: z.string().max(200).nullable().optional(),
  price: z.number().positive().max(100_000_000).nullable().optional(),
  fields: z.record(z.string().max(60), z.string().max(500)).optional(),
});

/** Кнопка «Найти цены»: все позиции без цены или явный список; force — прежний флаг веб-поиска, не используется (KB-WEB-ROWS). */
const researchBody = z.object({
  draftId: z.coerce.number().int().positive(),
  requestIndexes: z.union([z.literal('all'), z.array(z.number().int().min(0)).max(200)]).default('all'),
  force: z.boolean().optional(),
});

/** Окно предпросмотра (ТЗ 6.6): менеджер правит получателя, копию, тему и текст; вложение — нет. */
const sendBody = z.object({
  draftId: z.coerce.number().int().positive(),
  to: z.string().trim().max(200),
  cc: z.string().trim().max(200).optional(),
  subject: z.string().trim().min(1).max(300),
  text: z.string().max(8000),
  resendConfirmed: z.boolean().optional(),
});

type Principal = (req: FastifyRequest) => WidgetPrincipal;
type RequireAdmin = (req: FastifyRequest, reply: FastifyReply) => boolean;

/** Настройки КП, шаблон, черновики, сборка документа и отправка — весь путь менеджера от кнопки до письма. */

/**
 * Категории позиций старого черновика (до KB-COMPONENTS / KB-PRICE-SHEETS в payload их нет): дверь / комплектующее / фурнитура /
 * работы по названию и строке заявки; ID двери, которого в базе уже нет (прайс перезалит), снимается. Возвращает число
 * изменённых позиций; payload сохраняется, только если что-то поменялось.
 */
async function refreshDraftCategories(deps: Deps, accountId: number, draft: KpDraft): Promise<{ payload: Partial<KpPayload>; changed: number }> {
  const payload = draft.payload as unknown as Partial<KpPayload>;
  const items = payload.items ?? [];
  const requestItems = payload.request_items ?? [];
  let changed = 0;
  const next: KpLine[] = [];
  for (const l of items) {
    const line = { ...l };
    const item = requestItems[l.request_index];
    if (!line.category) {
      line.category = line.kind === 'service' || item?.kind === 'service' ? 'service' : categoryOf(`${item?.name ?? line.name} | ${item?.raw ?? ''}`);
      changed += 1;
    }
    if (line.kbPriceId && line.productId && !(await deps.kb.prices.byId(accountId, line.kbPriceId))) {
      line.productId = null;
      changed += 1;
    }
    next.push(line);
  }
  if (!changed) return { payload, changed: 0 };
  const fresh = { ...payload, items: next, request_items: requestItems.map((it, i) => (it.category || !items.some((l) => l.request_index === i) ? it : { ...it, category: next.find((l) => l.request_index === i)?.category })) };
  await deps.kp.setPayload(draft.id, fresh as unknown as Record<string, unknown>);
  return { payload: fresh, changed };
}

/**
 * KB-WEB-ROWS: цена позиции не из прайса — из интернета (по рынку / по аналогу) или из строки базы знаний, которая не строка
 * прайса (веб-поиск, правка менеджера, закупка), — снимается: «уточнить у менеджера», без цены, в итог не идёт. Ручная цена
 * менеджера в этом черновике (priceSource = manager) остаётся. Строки базы не удаляются.
 */
export async function dropNonPriceListPrices(deps: Deps, accountId: number, draft: KpDraft): Promise<number> {
  const payload = draft.payload as unknown as Partial<KpPayload>;
  const items = payload.items ?? [];
  const foreign = new Set<number>();
  for (const l of items) {
    if (l.price === null && l.priceOutcome !== 'included') continue;
    if (l.priceSource === 'research' || l.priceSource === 'analog') foreign.add(l.request_index);
    else if (isPriceFile(l.priceSource) && l.kbPriceId) {
      const row = await deps.kb.prices.byId(accountId, l.kbPriceId);
      if (row && row.origin !== 'price_list') foreign.add(l.request_index);
    }
  }
  if (!foreign.size) return 0;
  const next = items.map((l): KpLine => {
    if (!foreign.has(l.request_index)) return l;
    const rest: KpLine = { ...l };
    delete rest.coefficient;
    return { ...rest, price: null, priceSource: 'price_file', priceLabel: 'цена не из прайса', priceOutcome: 'not_priced', priceStale: false, kbPriceId: null, productId: null, priceModel: null, equipment: null, priceAbbr: null, market: null, includedIn: null };
  });
  const needs = (payload.needs_manager ?? []).filter((n) => !(foreign.has(n.request_index) && ownNote(n.reason)));
  for (const l of items.filter((x) => foreign.has(x.request_index))) {
    needs.push({ request_index: l.request_index, reason: `уточнить у менеджера: цена «${l.name}» была взята не из прайса (${l.priceLabel ?? 'из интернета'}) — в КП не идёт; в прайсе позиции нет — введите цену вручную` });
  }
  await deps.kp.setPayload(draft.id, { ...payload, items: next, needs_manager: needs } as unknown as Record<string, unknown>);
  await deps.journal.add({ accountId, leadId: draft.leadId, kind: 'note', summary: `Цены не из прайса сняты: ${foreign.size} поз. (из интернета или из базы не по прайсу) — «уточнить у менеджера»`, details: { draftId: draft.id, requestIndexes: [...foreign] } });
  return foreign.size;
}

export function kpRoutes(api: FastifyInstance, deps: Deps, principal: Principal, requireAdmin: RequireAdmin) {
  const repo = deps.kp;
  // Путь шаблона в базе — относительно KP_FILES_ROOT (дефект 2а); абсолютный собирается при чтении.
  const templatePath = (accountId: number) => resolveKpPath(deps.filesRoot, kpTemplateRel(accountId));
  /** Черновик для виджета с опросником: срок действия цены — из настроек КП. */
  const viewOf = async (accountId: number, d: KpDraft) => {
    const { constants } = await repo.getSettings(accountId);
    return view(d, constants.priceValidity?.trim() || null, constants.vatRate ?? DEFAULT_VAT_RATE);
  };

  api.get('/kp/settings', async (req) => {
    const s = await repo.getSettings(principal(req).accountId);
    return {
      // Фраза о ценах есть в каждом КП: пока заказчик её не менял, показываем текст по умолчанию.
      constants: { priceNote: DEFAULT_PRICE_NOTE, analogPriceTolerancePct: 10, manufacturerDomains: [], priceCoefficient: 1, manufacturerCoefficients: {}, autoResearch: false, researchCacheDays: DEFAULT_CACHE_DAYS, maxPositionsPerRun: DEFAULT_MAX_POSITIONS_PER_RUN, maxSearchCalls: DEFAULT_MAX_SEARCH_CALLS, webSearchDailyUsd: DEFAULT_WEB_SEARCH_DAILY_USD, skipKnowledgeBase: false, ...s.constants },
      certsDir: s.certsDir,
      numbering: s.numbering,
      template: { exists: Boolean(s.templatePath), name: s.templateName, md5: s.templateMd5, updatedAt: s.templateUpdatedAt },
    };
  });

  api.put('/kp/settings', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = settingsSchema.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body' });
    await repo.saveSettings(principal(req).accountId, b.data);
    return { ok: true };
  });

  // Файл шаблона приходит base64 внутри JSON: отдельная зависимость на multipart не нужна.
  api.post('/kp/template', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = templateSchema.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body' });
    const bytes = Buffer.from(b.data.contentBase64, 'base64');
    if (!bytes.length || bytes.length > MAX_TEMPLATE_BYTES) return reply.code(400).send({ error: 'bad_size' });
    if (!bytes.subarray(0, 4).equals(ZIP_MAGIC)) return reply.code(400).send({ error: 'not_docx' });
    const accountId = principal(req).accountId;
    const path = templatePath(accountId);
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    } catch (err) {
      const message = describeFsError(err, dirname(path));
      await deps.journal.add({ accountId, kind: 'kp_error', summary: `Шаблон КП не сохранён: ${message}` });
      return reply.code(500).send({ error: 'write_failed', message });
    }
    const md5 = createHash('md5').update(bytes).digest('hex');
    await repo.setTemplate(accountId, { path: kpTemplateRel(accountId), name: b.data.filename, md5 });
    return { ok: true, md5, size: bytes.length };
  });

  api.get('/kp/template', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const s = await repo.getSettings(principal(req).accountId);
    if (!s.templatePath) return reply.code(404).send({ error: 'no_template' });
    const bytes = await readFile(resolveKpPath(deps.filesRoot, s.templatePath)).catch(() => null);
    if (!bytes) return reply.code(410).send({ error: 'file_removed' });
    return reply
      .type('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(s.templateName ?? 'kp.docx')}`)
      .send(bytes);
  });

  // Черновик и состояние задания воркера: queued / running / failed с текстом ошибки.
  api.get('/kp/draft', async (req, reply) => {
    const q = leadBody.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_query' });
    const accountId = principal(req).accountId;
    const [d, job] = await Promise.all([repo.latestByLead(accountId, q.data.leadId), deps.queue.state(accountId, q.data.leadId)]);
    return { draft: d ? await viewOf(accountId, d) : null, job };
  });

  /**
   * Кнопка «Собрать КП» — единственный вход опта (ТЗ 6.4). Чтение карточки, разбор файлов и модель
   * занимают десятки секунд, поэтому задание уходит в очередь, виджет опрашивает GET /kp/draft.
   */
  api.post('/kp/draft', async (req, reply) => {
    const p = principal(req);
    const b = leadBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body' });
    if (!(await deps.ai(p.accountId))) return reply.code(409).send({ error: 'no_llm' });
    await deps.queue.enqueue({ accountId: p.accountId, leadId: b.data.leadId, userId: p.userId });
    return reply.code(202).send({ queued: true });
  });

  /**
   * KB-COMPONENT-DOOR: ответ менеджера на вопрос «К какой двери считать …?» — дверь (строка заявки) сохраняется в черновике
   * (componentDoor, «Найти цены» её не сбрасывает), вопрос снимается, цена комплектующего пересчитывается по строке прайса этой двери.
   */
  /** KB-COMPONENT-DOOR-GROUP: дверь для группы комплектующих или для одной строки; общий ход для кнопки и опросника. */
  const componentDoor = async (p: { accountId: number; userId: number | null }, id: number, data: { groupKey: string; doorRequestIndex: number } | { requestIndex: number; doorRequestIndex: number }, reply: FastifyReply) => {
    const b = { data };
    const d = await repo.byId(p.accountId, id);
    if (!d) return reply.code(404).send({ error: 'not_found' });
    if (d.status !== 'draft') return reply.code(409).send({ error: 'locked', message: 'КП уже собрано, создайте новый черновик' });
    const payload = d.payload as unknown as KpPayload;
    const items = payload.items ?? [];
    const door = items.find((l) => l.request_index === b.data.doorRequestIndex);
    if (!door || lineCategory(door) !== 'door') return reply.code(400).send({ error: 'not_door', message: 'Выбранная позиция — не дверь этой заявки' });
    let targets: KpLine[];
    let next: KpLine[];
    let groups = payload.componentDoorGroups ?? {};
    let summary: string;
    if ('groupKey' in b.data) {
      const key = b.data.groupKey;
      // Строки группы: с вопросом этой группы и уже посчитанные по прежнему ответу группы; строки с «изменить дверь» — не трогаются.
      targets = items.filter((l) => lineCategory(l) === 'component' && l.componentDoorBy !== 'line' && ((l.priceOutcome === 'question' && l.question?.group === key) || (l.componentDoorBy === 'group' && l.componentDoorGroup === key)));
      if (!targets.length) return reply.code(400).send({ error: 'no_group', message: 'В черновике нет строк этой группы' });
      groups = { ...groups, [key]: door.request_index };
      const title = targets.find((l) => l.question?.groupTitle)?.question?.groupTitle ?? key;
      next = items.map((l) => (targets.includes(l) ? { ...l, componentDoor: door.request_index, componentDoorBy: 'group' as const, componentDoorGroup: key, question: null, priceOutcome: undefined, price: null } : l));
      summary = `Комплектующие группы «${title}» (строк ${targets.length}) отнесены менеджером к двери «${door.name}» (поз. ${door.request_index + 1})`;
    } else {
      const ri = b.data.requestIndex;
      const line = items.find((l) => l.request_index === ri);
      if (!line || lineCategory(line) !== 'component') return reply.code(400).send({ error: 'not_component', message: 'Позиция — не комплектующее' });
      targets = [line];
      next = items.map((l) => (l === line ? { ...l, componentDoor: door.request_index, componentDoorBy: 'line' as const, componentDoorGroup: null, question: null, priceOutcome: undefined, price: l.priceSource === 'manager' ? l.price : null } : l));
      summary = `Комплектующее «${line.name}» отнесено менеджером к двери «${door.name}» (поз. ${door.request_index + 1}) — только эта строка`;
    }
    await repo.setPayload(id, { ...payload, items: next, componentDoorGroups: groups } as unknown as Record<string, unknown>);
    await deps.journal.add({ accountId: p.accountId, leadId: d.leadId, kind: 'note', summary, details: { draftId: id, requestIndexes: targets.map((l) => l.request_index), doorRequestIndex: door.request_index, groupKey: 'groupKey' in b.data ? b.data.groupKey : null, userId: p.userId } });
    await deps.researchQueue.enqueue(targets.map((l) => ({ accountId: p.accountId, draftId: id, requestIndex: l.request_index, userId: p.userId, force: false, replace: true })));
    const fresh = await repo.byId(p.accountId, id);
    return { draft: fresh ? await viewOf(p.accountId, fresh) : null, applied: targets.length };
  };

  api.post('/kp/draft/:id/component-door', async (req, reply) => {
    const p = principal(req);
    const id = Number((req.params as { id?: string }).id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad_id' });
    // KB-COMPONENT-DOOR-GROUP: ответ на группу похожих строк ({ groupKey }) или дверь для одной строки ({ requestIndex } — «изменить дверь»).
    const b = z.union([z.object({ groupKey: z.string().min(1).max(300), doorRequestIndex: z.number().int().min(0) }), z.object({ requestIndex: z.number().int().min(0), doorRequestIndex: z.number().int().min(0) })]).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body' });
    return componentDoor(p, id, b.data, reply);
  });

  /**
   * KP-AGENT-V2, п. 5: ответ на вопрос опросника. Один ответ — всем одинаковым строкам (ключ вопроса); цена из интернета или своя —
   * в «кандидаты в прайс»; модель / аналог / интернет / уточнённый профиль — позиции подбираются заново. Вопрос «к какой двери» —
   * тем же ходом, что кнопка в плитке.
   */
  /**
   * KP-LETTER-SCOPE, п. 2: «добавить» из «Ещё в проекте» — строка проекта, не названная в письме, становится позицией КП
   * (цены — «Найти цену»); на «Собрать заново» добавляется снова.
   */
  api.post('/kp/draft/:id/project-item', async (req, reply) => {
    const p = principal(req);
    const id = Number((req.params as { id?: string }).id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad_id' });
    const b = z.object({ index: z.number().int().min(0) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body' });
    const d = await repo.byId(p.accountId, id);
    if (!d) return reply.code(404).send({ error: 'not_found' });
    if (d.status !== 'draft') return reply.code(409).send({ error: 'locked', message: 'КП уже собрано, создайте новый черновик' });
    const payload = d.payload as unknown as KpPayload;
    const it = payload.projectRest?.[b.data.index];
    const r = addProjectItem(payload, b.data.index);
    if (r.requestIndex === null || !it) return reply.code(404).send({ error: 'no_item', message: 'Такой строки в «Ещё в проекте» нет — обновите карточку' });
    if (!(await repo.setPayloadIfVersion(id, d.version, r.payload as unknown as Record<string, unknown>))) return reply.code(409).send({ error: 'conflict', message: 'Черновик изменился — обновите карточку' });
    await deps.journal.add({ accountId: p.accountId, leadId: d.leadId, kind: 'note', summary: `Позиция из проекта добавлена в КП: «${it.name}»${it.width_mm || it.height_mm ? `, ${it.width_mm ?? '—'}×${it.height_mm ?? '—'} мм` : ''}, ${it.qty} шт`, details: { draftId: id, requestIndex: r.requestIndex, mark: it.mark ?? null, userId: p.userId } });
    const fresh = await repo.byId(p.accountId, id);
    return { draft: fresh ? await viewOf(p.accountId, fresh) : null, requestIndex: r.requestIndex };
  });

  /**
   * KB-MARKUP: «Пересчитать» — текущая наценка прайсов к ценам из прайса этого черновика (сам черновик при смене наценки не
   * пересчитывается). Ручные цены и цены интернета не трогаются.
   */
  api.post('/kp/draft/:id/recalc-markup', async (req, reply) => {
    const p = principal(req);
    const id = Number((req.params as { id?: string }).id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad_id' });
    const d = await repo.byId(p.accountId, id);
    if (!d) return reply.code(404).send({ error: 'not_found' });
    if (d.status !== 'draft') return reply.code(409).send({ error: 'locked', message: 'КП уже собрано, создайте новый черновик' });
    const r = await recalcDraftMarkup(deps, p.accountId, id, p.userId);
    const fresh = await repo.byId(p.accountId, id);
    return { draft: fresh ? await viewOf(p.accountId, fresh) : null, changed: r.changed.length, skipped: r.skipped };
  });

  api.post('/kp/draft/:id/answer', async (req, reply) => {
    const p = principal(req);
    const id = Number((req.params as { id?: string }).id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad_id' });
    const b = answerBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body' });
    const d = await repo.byId(p.accountId, id);
    if (!d) return reply.code(404).send({ error: 'not_found' });
    if (d.status !== 'draft') return reply.code(409).send({ error: 'locked', message: 'КП уже собрано, создайте новый черновик' });
    const payload = d.payload as unknown as KpPayload;
    const priceValidity = (await repo.getSettings(p.accountId)).constants.priceValidity?.trim() || null;
    const q = buildQuestions(payload, { priceValidity }).find((x) => x.key === b.data.key);
    if (!q) return reply.code(404).send({ error: 'no_question', message: 'Такого вопроса в черновике нет — обновите карточку' });
    if (q.type === 'component_door') {
      const door = Number(b.data.option);
      if (!Number.isInteger(door)) return reply.code(400).send({ error: 'bad_option' });
      return componentDoor(p, id, { groupKey: q.key.slice('component_door:'.length), doorRequestIndex: door }, reply);
    }
    const custom = b.data.price !== undefined && b.data.price !== null;
    if (b.data.option && b.data.option !== 'custom' && !q.options.some((o) => o.id === b.data.option)) return reply.code(400).send({ error: 'bad_option', message: 'Такого варианта ответа нет' });
    if (['web_price', 'enter_price', 'nonstandard'].includes(q.type) && b.data.option !== 'no_price' && !custom && !q.options.find((o) => o.id === b.data.option)?.price) return reply.code(400).send({ error: 'no_price', message: 'Выберите вариант с ценой или введите цену' });
    if (q.type === 'delivery' && b.data.option === 'delivery' && !(Number((b.data.fields?.sum ?? '').replace(/\s/g, '').replace(',', '.')) > 0)) return reply.code(400).send({ error: 'no_sum', message: 'Введите сумму доставки' });
    const applied = applyAnswer(payload, q.key, { option: custom ? 'custom' : b.data.option ?? null, price: b.data.price ?? null, fields: b.data.fields ?? {}, at: new Date().toISOString(), by: p.userId }, q);
    await repo.setPayload(id, applied.payload as unknown as Record<string, unknown>);
    for (const c of applied.candidates) {
      await deps.kb.candidates.upsert({ accountId: p.accountId, leadId: d.leadId, draftId: id, model: c.model, size: c.size || null, price: c.price, source: c.source, url: c.url, note: `сделка ${d.leadId}, поз. ${c.requestIndex + 1}`, createdBy: p.userId }).catch((err: Error) => req.log.warn({ err: err.message }, 'kb: кандидат в прайс не записан'));
    }
    const choice = custom ? `своя цена ${b.data.price}` : q.options.find((o) => o.id === b.data.option)?.label ?? (b.data.fields ? Object.entries(b.data.fields).map(([k, v]) => `${k}: ${v}`).join(', ') : '');
    await deps.journal.add({ accountId: p.accountId, leadId: d.leadId, kind: 'note', summary: `Опросник: «${q.title}» (${q.requestIndexes.length ? `поз. ${q.requestIndexes.map((i) => i + 1).join(', ')}` : 'КП'}) — ${choice}`, details: { draftId: id, key: q.key, type: q.type, option: b.data.option ?? null, price: b.data.price ?? null, fields: b.data.fields ?? null, userId: p.userId } });
    if (applied.research.length) await deps.researchQueue.enqueue(applied.research.map((requestIndex) => ({ accountId: p.accountId, draftId: id, requestIndex, userId: p.userId, force: false, replace: true })));
    const fresh = await repo.byId(p.accountId, id);
    return { draft: fresh ? await viewOf(p.accountId, fresh) : null, research: applied.research };
  });

  /** Правки менеджера в таблице позиций. Цены и количества дальше берутся отсюда. */
  api.put('/kp/draft/:id', async (req, reply) => {
    const p = principal(req);
    const id = Number((req.params as { id?: string }).id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad_id' });
    const b = linesSchema.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body' });
    const d = await repo.byId(p.accountId, id);
    if (!d) return reply.code(404).send({ error: 'not_found' });
    if (d.status !== 'draft' && d.status !== 'built') return reply.code(409).send({ error: 'locked' });
    // Цена, которую менеджер поменял руками, становится ручной: автозаполнение её не затирает (этап 5, 9.3).
    const before = (d.payload as unknown as Partial<KpPayload>).items ?? [];
    const items = (b.data.items as KpLine[]).map((l) => {
      const prev = before.find((x) => x.request_index === l.request_index);
      const changed = l.price !== (prev?.price ?? null);
      if (changed && l.price !== null) {
        return { ...prev, ...l, priceSource: 'manager', priceLabel: 'изменено менеджером', priceStale: false, kbPriceId: null, markup: null } as KpLine;
      }
      return { ...prev, ...l, priceSource: l.priceSource ?? prev?.priceSource } as KpLine;
    });
    await repo.setPayload(id, { ...(d.payload as unknown as KpPayload), items } as unknown as Record<string, unknown>);
    // KB-WEB-ROWS: правка менеджера остаётся в этом черновике и в базу знаний не пишется — цены других КП только из прайсов.
    const fresh = await repo.byId(p.accountId, id);
    return { draft: fresh ? await viewOf(p.accountId, fresh) : null };
  });

  /**
   * Поиск рыночных цен (RFD-AI-AGENT-OPT-PRICE, этап 5). Задания уходят в очередь kp-research по одной позиции,
   * ответ сразу 202 со списком позиций; виджет опрашивает GET /kp/research, пока есть queued / running.
   * «all» — только позиции без цены; явный список — заменяет и ручную цену (кнопка «Заменить»).
   */
  api.post('/kp/research', async (req, reply) => {
    const p = principal(req);
    const b = researchBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body' });
    const draft = await repo.byId(p.accountId, b.data.draftId);
    if (!draft) return reply.code(404).send({ error: 'not_found' });
    if (draft.status !== 'draft') return reply.code(409).send({ error: 'locked', message: 'КП уже собрано, создайте новый черновик' });
    // KB-WEB-ROWS: цена только из прайса — модель и веб-поиск не нужны; цены из интернета и строк базы не из прайса снимаются.
    await dropNonPriceListPrices(deps, p.accountId, draft);
    // KB-PRICE-SHEETS-FIX, п. 6: черновик, собранный до загрузки прайса, не знает категорий и ID — перед поиском категория
    // позиций ставится по названию заново, ID двери, которого в базе больше нет, снимается (контекст подберётся по свежему прайсу).
    const refreshed = await refreshDraftCategories(deps, p.accountId, (await repo.byId(p.accountId, draft.id)) ?? draft);
    const payload = refreshed.payload;
    // KB-COMPONENTS, п. 6: «Найти цены» по всем — все позиции без цены за одно нажатие, в очередь порциями по 20 подряд
    // (лимит maxPositionsPerRun остаётся для автопоиска при сборке); работы не ставятся.
    const positions = researchablePositions(payload, b.data.requestIndexes, b.data.requestIndexes === 'all' ? Number.MAX_SAFE_INTEGER : 200);
    if (!positions.length) return reply.code(202).send({ queued: [], reason: b.data.requestIndexes === 'all' ? 'у всех позиций уже есть цена' : 'позиции не найдены' });
    const batches: number[][] = [];
    for (let i = 0; i < positions.length; i += RESEARCH_BATCH) batches.push(positions.slice(i, i + RESEARCH_BATCH));
    for (const [n, batch] of batches.entries()) {
      await deps.researchQueue.enqueue(batch.map((requestIndex) => ({ accountId: p.accountId, draftId: draft.id, requestIndex, userId: p.userId, force: false, replace: b.data.requestIndexes !== 'all', batch: n + 1, batches: batches.length })));
    }
    if (positions.length > RESEARCH_BATCH) await deps.journal.add({ accountId: p.accountId, leadId: draft.leadId, kind: 'note', summary: `Поиск цен: поставлено позиций ${positions.length} порциями по ${RESEARCH_BATCH} (${batches.length})`, details: { draftId: draft.id, positions: positions.length, batches: batches.length, userId: p.userId } });
    return reply.code(202).send({ queued: positions, total: positions.length, batches: batches.length, ...(refreshed.changed ? { categoriesRefreshed: refreshed.changed } : {}) });
  });

  /** Состояние поиска по позициям черновика: задание (queued / running / failed) и последняя запись kp_price_research. */
  api.get('/kp/research', async (req, reply) => {
    const p = principal(req);
    const q = draftBody.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_query' });
    const draft = await repo.byId(p.accountId, q.data.draftId);
    if (!draft) return reply.code(404).send({ error: 'not_found' });
    const items = (draft.payload as unknown as Partial<KpPayload>).items ?? [];
    const idx = items.map((l) => l.request_index);
    const [states, rows] = await Promise.all([deps.researchQueue.states(p.accountId, draft.id, idx), deps.research.listByDraft(p.accountId, draft.id)]);
    const positions = idx.map((requestIndex) => {
      const r = rows.find((x) => x.requestIndex === requestIndex) ?? null;
      return {
        requestIndex,
        job: states[requestIndex] ?? null,
        research: r
          ? {
              id: r.id,
              status: r.status,
              query: r.query,
              stats: r.stats,
              error: r.error,
              createdAt: r.createdAt,
              webSearchCalls: r.webSearchCalls,
              costUsd: r.costUsd,
              analog: r.analog ? { url: r.analog.url, unitPrice: r.analog.unitPrice, reason: r.analog.suggestion.reason } : null,
              offers: r.offers.map((o) => ({ url: o.offer.url, seller: o.offer.seller, title: o.offer.title, price: o.offer.price, currency: o.offer.currency, unit: o.offer.unit, vatStated: o.offer.vatStated, unitPrice: o.unitPrice, accepted: o.accepted, reason: o.reason, manufacturer: o.manufacturer, formula: o.formula, notes: o.notes, vatAssumed: o.vatAssumed ?? false, areaScaled: o.areaScaled ?? false, sourceSize: o.sourceSize ?? null, foundAt: o.offer.foundAt })),
            }
          : null,
      };
    });
    const pending = positions.some((x) => x.job && (x.job.state === 'queued' || x.job.state === 'running'));
    return { draftId: draft.id, pending, positions };
  });

  /**
   * Документ строится из строк, которые менеджер подтвердил: цены и количества берутся из черновика. Автосборки нет.
   * Сама сборка — buildDraftDocument (@opt/kp/kp-build.ts), та же, что у консольной утилиты kp-build.
   */
  api.post('/kp/build', async (req, reply) => {
    const p = principal(req);
    const b = draftBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body' });
    try {
      // KB-WEB-ROWS: в документ — только цены прайса и ручные цены менеджера.
      const before = await repo.byId(p.accountId, b.data.draftId);
      if (before && before.status === 'draft') await dropNonPriceListPrices(deps, p.accountId, before);
      const r = await buildDraftDocument(deps, { accountId: p.accountId, draftId: b.data.draftId, userId: p.userId });
      return { draft: await viewOf(p.accountId, r.draft), pdf: r.pdf, attached: r.attached, files: r.files.map((f) => ({ kind: f.kind, name: f.name, bytes: f.bytes })) };
    } catch (err) {
      if (err instanceof KpBuildError) {
        const status = err.code === 'not_found' ? 404 : err.code === 'build_failed' ? 502 : 409;
        return reply.code(status).send({ error: err.code, message: err.message, ...(err.latestDraftId ? { latestDraftId: err.latestDraftId } : {}) });
      }
      throw err;
    }
  });

  /**
   * Скачивание собранного КП в виджет (RFD-AI-AGENT-OPT-KP-DOWNLOAD, п. 1): файл уходит браузеру как вложение.
   * GET /kp/file — с токеном виджета в X-Auth-Token; для клика по ссылке из iframe amo (заголовок туда не
   * подставить) виджет сначала берёт подписанную ссылку GET /kp/file/link — она ведёт на открытый маршрут
   * GET /kp/file?…&t=<подпись> (kpPublicRoutes), живёт 10 минут и привязана к аккаунту, черновику и виду файла.
   */
  api.get('/kp/file', async (req, reply) => {
    const p = principal(req);
    const q = fileQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_query' });
    return sendKpFile(deps, reply, p.accountId, q.data.draftId, q.data.kind);
  });

  api.get('/kp/file/link', async (req, reply) => {
    const p = principal(req);
    const q = fileQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_query' });
    const draft = await repo.byId(p.accountId, q.data.draftId);
    if (!draft) return reply.code(404).send({ error: 'not_found' });
    const file = kpFileOf(deps.filesRoot, draft, q.data.kind);
    if (!file) return reply.code(404).send({ error: 'no_file', message: `у черновика ${draft.id} нет файла ${q.data.kind.toUpperCase()} — соберите документ` });
    const exp = Math.floor(Date.now() / 1000) + FILE_LINK_TTL_SEC;
    const t = signFileLink(deps.env.TOKEN_ENCRYPTION_KEY, p.accountId, draft.id, q.data.kind, exp);
    const url = new URL('/kp/file', deps.env.PUBLIC_URL);
    url.searchParams.set('draftId', String(draft.id));
    url.searchParams.set('kind', q.data.kind);
    url.searchParams.set('t', t);
    return { url: url.toString(), filename: file.name, expiresAt: new Date(exp * 1000).toISOString() };
  });

  /** Окно предпросмотра: что уйдёт клиенту и что мешает отправке. */
  api.get('/kp/send/preview', async (req, reply) => {
    const p = principal(req);
    const q = draftBody.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_query' });
    const draft = await repo.byId(p.accountId, q.data.draftId);
    if (!draft) return reply.code(404).send({ error: 'not_found' });
    const { settings } = await deps.settings.get(p.accountId);
    const payload = draft.payload as unknown as KpPayload;
    const file = resolveKpPath(deps.filesRoot, draft.pdfPath ?? draft.docxPath);
    const fileBytes = file ? await stat(file).then((s) => s.size).catch(() => null) : null;
    const vars = { kpNo: draft.kpNo ?? '', clientName: payload.client?.org || payload.client?.fio || '' };
    void file;
    const to = payload.client?.email ?? '';
    const noPrice = (payload.items ?? []).filter((l) => l.price === null).length;
    return {
      to,
      cc: settings.mail.cc,
      subject: renderMailTemplate(settings.mail.subject, vars),
      text: renderMailTemplate(settings.mail.text, vars),
      signature: settings.mail.signature,
      attachment: file ? { name: basename(file), bytes: fileBytes } : null,
      blockers: sendBlockers({ draft, fileBytes, to, resendConfirmed: false }),
      warnings: noPrice ? [`позиций без цены: ${noPrice}`] : [],
      alreadySent: draft.status === 'sent',
    };
  });

  /** Кнопка «Проверено, отправить»: только по нажатию человека, один получатель, статус sent лишь после успешной отправки. */
  api.post('/kp/send', async (req, reply) => {
    const p = principal(req);
    const b = sendBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body', issues: b.error.issues });
    const draft = await repo.byId(p.accountId, b.data.draftId);
    if (!draft) return reply.code(404).send({ error: 'not_found' });
    const { settings } = await deps.settings.get(p.accountId);
    const m = settings.mail;
    if (!m.smtpHost || !m.username) return reply.code(409).send({ error: 'mail_off' });
    const password = await deps.secrets.get(p.accountId, 'smtp');
    if (!password) return reply.code(409).send({ error: 'no_password' });
    const file = resolveKpPath(deps.filesRoot, draft.pdfPath ?? draft.docxPath);
    const fileBytes = file ? await stat(file).then((s) => s.size).catch(() => null) : null;
    const blockers = sendBlockers({ draft, fileBytes, to: b.data.to, resendConfirmed: Boolean(b.data.resendConfirmed) });
    if (blockers.length || !file) return reply.code(409).send({ error: 'blocked', reasons: blockers });

    const mail = composeKpMail({
      from: { name: m.fromName, address: m.fromAddress || m.username },
      to: b.data.to,
      ...(b.data.cc ? { cc: b.data.cc } : {}),
      subject: b.data.subject,
      text: b.data.text,
      signature: m.signature,
      attachment: { filename: basename(file), content: await readFile(file) },
    });
    const kpNo = draft.kpNo ?? '';
    let sent: SendResult;
    try {
      sent = await deps.mailer.send({ host: m.smtpHost, port: m.smtpPort, secure: m.smtpSecure, username: m.username, password }, mail);
    } catch (err) {
      // Статус не меняем, ошибку сервера показываем как есть (6.6).
      await deps.journal.add({ accountId: p.accountId, leadId: draft.leadId, kind: 'kp_error', summary: `КП ${kpNo} не отправлено: ${(err as Error).message}`, details: { draftId: draft.id, to: mail.to, userId: p.userId } });
      return reply.code(502).send({ error: 'send_failed', message: (err as Error).message });
    }
    // KP-SENT-COPY: письмо ушло. Дальше — только запись следов: .eml рядом с КП и копия в «Отправленные». Их сбой
    // отправку не отменяет и повторного письма клиенту не делает.
    const attachment = mail.attachments[0] as { filename: string; content: Buffer };
    const emlRel = `${kpLeadDirRel(p.accountId, draft.leadId)}/${basename(file).replace(/\.(pdf|docx)$/i, '')}.eml`;
    let eml: string | null = null;
    try {
      const abs = resolveKpPath(deps.filesRoot, emlRel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, sent.raw);
      eml = emlRel;
    } catch (err) {
      req.log.warn({ err: describeFsError(err, emlRel) }, 'kp: .eml письма не сохранён');
    }
    let copy: SentMailRecord['copy'];
    try {
      const r = await deps.sentCopier.append(imapConfigFor(m, password), sent.raw, m.sentFolder?.trim() || null);
      copy = { status: 'saved', folder: r.folder, error: null };
    } catch (err) {
      copy = { status: 'failed', folder: m.sentFolder?.trim() || null, error: (err as Error).message };
    }
    const record: SentMailRecord = {
      at: new Date().toISOString(),
      messageId: sent.messageId,
      from: mail.from.name ? `${mail.from.name} <${mail.from.address}>` : mail.from.address,
      to: mail.to,
      cc: mail.cc ?? null,
      subject: mail.subject,
      text: mail.text,
      attachment: { name: attachment.filename, bytes: attachment.content.length },
      smtp: { accepted: sent.accepted, rejected: sent.rejected, response: sent.response },
      eml,
      copy,
    };
    // Письмо уже у клиента: статус «отправлено» ставится, даже если запись следов в черновик не удалась.
    await setSentMail(p.accountId, draft.id, record).catch((err: Error) => req.log.warn({ err: err.message }, 'kp: запись об отправке в черновик не сохранена'));
    await repo.setStatus(draft.id, 'sent');
    // Текст письма — в черновике и .eml; в журнал не дублируется.
    const details: Partial<SentMailRecord> = { ...record };
    delete details.text;
    await deps.journal.add({ accountId: p.accountId, leadId: draft.leadId, kind: 'kp_sent', summary: `КП ${kpNo} отправлено на ${mail.to}${copy.status === 'saved' ? `, копия — в «${copy.folder}»` : ''}`, details: { draftId: draft.id, kpNo, userId: p.userId, ...details } });
    if (copy.status === 'failed') {
      await deps.journal.add({ accountId: p.accountId, leadId: draft.leadId, kind: KP_SENT_COPY_FAILED, summary: `КП ${kpNo}: копия в «Отправленные» не сохранена — ${copy.error}`, details: { draftId: draft.id, kpNo, messageId: sent.messageId, folder: copy.folder, error: copy.error, eml, userId: p.userId } });
    }
    await deps
      .amoFor(p.accountId)
      .then((amo) => amo.addLeadNote(draft.leadId, `[Агент опт] КП${kpNo ? ` ${kpNo}` : ''} отправлено на ${mail.to}.`))
      .catch((err: Error) => req.log.warn({ err: err.message }, 'kp: примечание в сделку не записано'));
    const fresh = await repo.byId(p.accountId, draft.id);
    return { draft: fresh ? await viewOf(p.accountId, fresh) : null, to: mail.to, copy };
  });

  /** Запись об отправке — в payload черновика (с повтором при параллельной правке). */
  const setSentMail = async (accountId: number, id: number, record: SentMailRecord) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const cur = await repo.byId(accountId, id);
      if (!cur) return;
      if (await repo.setPayloadIfVersion(id, cur.version, { ...(cur.payload as Record<string, unknown>), sentMail: record })) return;
    }
  };

  /**
   * KP-SENT-COPY: «Посмотреть письмо» — от кого, кому, копия, тема, дата, текст, вложение, messageId, копия в «Отправленные».
   * КП, отправленные до сохранения копий, — то, что есть в журнале kp_sent, с пометкой legacy.
   */
  api.get('/kp/draft/:id/sent-mail', async (req, reply) => {
    const p = principal(req);
    const id = Number((req.params as { id?: string }).id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad_id' });
    const d = await repo.byId(p.accountId, id);
    if (!d) return reply.code(404).send({ error: 'not_found' });
    const rec = (d.payload as unknown as Partial<KpPayload>).sentMail ?? null;
    const attachmentKind = d.pdfPath ? 'pdf' : d.docxPath ? 'docx' : null;
    if (rec) return { legacy: false, kpNo: d.kpNo, attachmentKind, ...rec };
    if (d.status !== 'sent' && !d.sentAt) return reply.code(404).send({ error: 'not_sent', message: 'КП ещё не отправлялось' });
    const entry = (await deps.journal.list(p.accountId, { leadId: d.leadId, kind: 'kp_sent', limit: 100 })).find((e) => Number((e.details as { draftId?: number }).draftId) === d.id) ?? null;
    const det = (entry?.details ?? {}) as { to?: string; cc?: string | null; attachment?: string | { name: string; bytes: number }; subject?: string; messageId?: string; from?: string };
    const sentAt = entry?.createdAt ?? d.sentAt ?? null;
    const att = typeof det.attachment === 'string' ? { name: det.attachment, bytes: null } : det.attachment ?? null;
    return {
      legacy: true,
      note: 'письмо отправлено до сохранения копий',
      kpNo: d.kpNo,
      attachmentKind,
      at: sentAt ? new Date(sentAt).toISOString() : null,
      messageId: det.messageId ?? null,
      from: det.from ?? null,
      to: det.to ?? null,
      cc: det.cc ?? null,
      subject: det.subject ?? null,
      text: null,
      attachment: att,
      smtp: null,
      eml: null,
      copy: { status: 'unknown', folder: null, error: null },
    };
  });
}

/** KP-SENT-COPY: копия письма в «Отправленные» не сохранена (письмо клиенту ушло). */
const KP_SENT_COPY_FAILED = 'kp_sent_copy_failed' as JournalKind;

/** Открытые маршруты файлов КП: ссылка с подписью из GET /widget/v1/kp/file/link. */
export function kpPublicRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/kp/file', async (req, reply) => {
    const q = fileQuery.extend({ t: z.string().min(1).max(200) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_query' });
    const accountId = verifyFileLink(deps.env.TOKEN_ENCRYPTION_KEY, q.data.t, q.data.draftId, q.data.kind);
    if (accountId === null) return reply.code(403).send({ error: 'bad_link', message: 'ссылка на файл устарела или испорчена — откройте карточку заново' });
    return sendKpFile(deps, reply, accountId, q.data.draftId, q.data.kind);
  });
}

const fileQuery = z.object({ draftId: z.coerce.number().int().positive(), kind: z.enum(['pdf', 'docx']) });
const FILE_LINK_TTL_SEC = 10 * 60;

/** Файл черновика браузеру: Content-Disposition attachment с именем в ASCII и полным в filename*. */
async function sendKpFile(deps: Deps, reply: FastifyReply, accountId: number, draftId: number, kind: 'pdf' | 'docx') {
  const draft = await deps.kp.byId(accountId, draftId);
  if (!draft) return reply.code(404).send({ error: 'not_found' });
  const file = kpFileOf(deps.filesRoot, draft, kind);
  if (!file) return reply.code(404).send({ error: 'no_file', message: `у черновика ${draft.id} нет файла ${kind.toUpperCase()} — соберите документ` });
  const bytes = await readFile(file.path).catch(() => null);
  if (!bytes) return reply.code(410).send({ error: 'file_removed', message: `файл ${file.name} не найден на диске (${file.path})` });
  return reply
    .type(file.mime)
    .header('content-disposition', `attachment; filename="${asciiFilename(file.name)}"; filename*=UTF-8''${encodeURIComponent(file.name)}`)
    .header('content-length', String(bytes.length))
    .header('cache-control', 'private, no-store')
    .send(bytes);
}

const linkPayload = (accountId: number, draftId: number, kind: string, exp: number) => `${accountId}.${draftId}.${kind}.${exp}`;

export function signFileLink(secret: string, accountId: number, draftId: number, kind: string, exp: number): string {
  const body = linkPayload(accountId, draftId, kind, exp);
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return Buffer.from(`${body}.${mac}`).toString('base64url');
}

/** Аккаунт из подписанной ссылки; null — подпись не сошлась, срок вышел или черновик/вид файла другие. */
export function verifyFileLink(secret: string, token: string, draftId: number, kind: string, now = Date.now()): number | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const m = /^(\d+)\.(\d+)\.(pdf|docx)\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(decoded);
  if (!m) return null;
  const [, acc, dId, k, expS, mac] = m as unknown as [string, string, string, string, string, string];
  if (Number(dId) !== draftId || k !== kind) return null;
  if (Number(expS) * 1000 < now) return null;
  const expected = createHmac('sha256', secret).update(linkPayload(Number(acc), Number(dId), k, Number(expS))).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return Number(acc);
}

function view(d: KpDraft, priceValidity: string | null = null, vatRate = DEFAULT_VAT_RATE) {
  const p = d.payload as unknown as Partial<KpPayload>;
  // KP-AGENT-V2, п. 5: опросник выводится из состояния черновика; ответы — в payload.answers.
  const survey = buildQuestions(p, { priceValidity });
  return {
    id: d.id,
    leadId: d.leadId,
    status: d.status,
    kpNo: d.kpNo,
    createdAt: d.createdAt,
    builtAt: d.builtAt,
    sentAt: d.sentAt,
    hasDocx: Boolean(d.docxPath),
    hasPdf: Boolean(d.pdfPath),
    client: p.client ?? { org: '', fio: '', email: '', phone: '' },
    requestItems: p.request_items ?? [],
    items: p.items ?? [],
    requiredBlocks: p.required_blocks ?? [],
    questions: p.questions ?? [],
    needsManager: p.needs_manager ?? [],
    source: p.source ?? null,
    survey,
    counters: draftCounters(p, survey),
    delivery: p.delivery ?? null,
    priceValidity: p.priceValidity || priceValidity || null,
    // Ставка НДС для итога в окне КП (цены с НДС, «в т.ч. НДС 22 %»).
    vatRate,
    requirements: p.requirements ?? [],
    photos: p.photos ?? [],
    letterText: p.letterText ?? null,
    // KP-LETTER-SCOPE: объём по письму и «Ещё в проекте».
    scope: p.scope ?? null,
    projectRest: p.projectRest ?? [],
    // KP-SENT-COPY: последнее отправленное письмо — дата и судьба копии в «Отправленные» (жёлтая пометка в окне КП).
    sentMail: p.sentMail ? { at: p.sentMail.at, to: p.sentMail.to, messageId: p.sentMail.messageId, copy: p.sentMail.copy } : null,
  };
}
