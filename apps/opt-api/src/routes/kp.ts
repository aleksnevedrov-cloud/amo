import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { WidgetPrincipal } from '@core/amo';
import { sizeOf } from '@opt/kb';
import { buildKp, composeKpMail, DEFAULT_CACHE_DAYS, DEFAULT_MAX_POSITIONS_PER_RUN, DEFAULT_MAX_SEARCH_CALLS, DEFAULT_PRICE_NOTE, DEFAULT_WEB_SEARCH_DAILY_USD, findCertificates, renderMailTemplate, researchablePositions, sendBlockers, templateData, type KpConstants, type KpDraft, type KpLine, type KpPayload } from '@opt/kp';
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
        priceSource: z.enum(['research', 'analog', 'manager', 'kb']).optional(),
        market: z.object({ median: z.number(), min: z.number(), max: z.number(), count: z.number().int(), unit: z.literal('piece'), researchId: z.number().int(), researchedAt: z.string() }).nullable().optional(),
        coefficient: z.number().optional(),
        priceLabel: z.string().max(200).nullable().optional(),
        priceStale: z.boolean().optional(),
        kbPriceId: z.number().int().nullable().optional(),
      }),
    )
    .max(200),
});

/** Кнопка «Найти цены»: все позиции без цены или явный список; force — «искать заново» мимо кэша. */
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
export function kpRoutes(api: FastifyInstance, deps: Deps, principal: Principal, requireAdmin: RequireAdmin) {
  const repo = deps.kp;
  const templatePath = (accountId: number) => join(deps.filesRoot, 'kp', String(accountId), 'template.docx');

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
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    const md5 = createHash('md5').update(bytes).digest('hex');
    await repo.setTemplate(accountId, { path, name: b.data.filename, md5 });
    return { ok: true, md5, size: bytes.length };
  });

  api.get('/kp/template', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const s = await repo.getSettings(principal(req).accountId);
    if (!s.templatePath) return reply.code(404).send({ error: 'no_template' });
    const bytes = await readFile(s.templatePath).catch(() => null);
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
    return { draft: d ? view(d) : null, job };
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
    const requestItems = (d.payload as unknown as Partial<KpPayload>).request_items ?? [];
    const manual: KpLine[] = [];
    const items = (b.data.items as KpLine[]).map((l) => {
      const prev = before.find((x) => x.request_index === l.request_index);
      const changed = l.price !== (prev?.price ?? null);
      if (changed && l.price !== null) {
        manual.push(l);
        return { ...prev, ...l, priceSource: 'manager', priceLabel: 'изменено менеджером', priceStale: false, kbPriceId: null } as KpLine;
      }
      return { ...prev, ...l, priceSource: l.priceSource ?? prev?.priceSource } as KpLine;
    });
    await repo.setPayload(id, { ...(d.payload as unknown as KpPayload), items } as unknown as Record<string, unknown>);
    // Правка менеджера — в базу знаний с доверием 90 (RFD-AI-AGENT-OPT-KB): следующая заявка с этой моделью возьмёт её без поиска.
    for (const l of manual) {
      if (l.kind === 'service' || l.price === null) continue;
      const ri = requestItems[l.request_index];
      const size = ri?.width_mm && ri?.height_mm ? { widthMm: Math.min(ri.width_mm, ri.height_mm), heightMm: Math.max(ri.width_mm, ri.height_mm) } : sizeOf(`${l.size} ${l.name}`);
      await deps.kb.prices
        .upsert({ accountId: p.accountId, model: l.name, widthMm: size?.widthMm ?? null, heightMm: size?.heightMm ?? null, price: l.price, origin: 'manager', createdBy: p.userId, note: `черновик ${id}, сделка ${d.leadId}` })
        .catch((err: Error) => req.log.warn({ err: err.message }, 'kb: цена менеджера не записана'));
    }
    const fresh = await repo.byId(p.accountId, id);
    return { draft: fresh ? view(fresh) : null };
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
    if (!(await deps.ai(p.accountId))) return reply.code(409).send({ error: 'no_llm' });
    const { constants } = await repo.getSettings(p.accountId);
    const positions = researchablePositions(draft.payload as unknown as Partial<KpPayload>, b.data.requestIndexes, constants.maxPositionsPerRun ?? DEFAULT_MAX_POSITIONS_PER_RUN);
    if (!positions.length) return reply.code(202).send({ queued: [], reason: b.data.requestIndexes === 'all' ? 'у всех позиций уже есть цена' : 'позиции не найдены' });
    await deps.researchQueue.enqueue(positions.map((requestIndex) => ({ accountId: p.accountId, draftId: draft.id, requestIndex, userId: p.userId, force: b.data.force, replace: b.data.requestIndexes !== 'all' })));
    return reply.code(202).send({ queued: positions });
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

  /** Документ строится из строк, которые менеджер подтвердил: цены и количества берутся из черновика. Автосборки нет. */
  api.post('/kp/build', async (req, reply) => {
    const p = principal(req);
    const b = draftBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body' });
    const draft = await repo.byId(p.accountId, b.data.draftId);
    if (!draft) return reply.code(404).send({ error: 'not_found' });
    if (draft.status === 'sent') return reply.code(409).send({ error: 'already_sent' });
    const s = await repo.getSettings(p.accountId);
    if (!s.templatePath) return reply.code(409).send({ error: 'no_template' });
    const payload = draft.payload as unknown as KpPayload;
    const lines = (payload.items ?? []).filter((l) => l.price !== null);
    if (!lines.length) return reply.code(409).send({ error: 'no_priced_lines' });
    try {
      const r = await buildDocument(deps, p, draft, lines, s.templatePath, s.constants, s.certsDir);
      const fresh = await repo.byId(p.accountId, draft.id);
      return { draft: fresh ? view(fresh) : null, pdf: r.pdf, attached: r.attached };
    } catch (err) {
      await deps.journal.add({ accountId: p.accountId, leadId: draft.leadId, kind: 'kp_error', summary: `КП не собрано: ${(err as Error).message}`, details: { draftId: draft.id } });
      return reply.code(502).send({ error: 'build_failed', message: (err as Error).message });
    }
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
    const file = draft.pdfPath ?? draft.docxPath;
    const fileBytes = file ? await stat(file).then((s) => s.size).catch(() => null) : null;
    const vars = { kpNo: draft.kpNo ?? '', clientName: payload.client?.org || payload.client?.fio || '' };
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
    const file = draft.pdfPath ?? draft.docxPath;
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
    try {
      await deps.mailer.send({ host: m.smtpHost, port: m.smtpPort, secure: m.smtpSecure, username: m.username, password }, mail);
    } catch (err) {
      // Статус не меняем, ошибку сервера показываем как есть (6.6).
      await deps.journal.add({ accountId: p.accountId, leadId: draft.leadId, kind: 'kp_error', summary: `КП ${kpNo} не отправлено: ${(err as Error).message}`, details: { draftId: draft.id, to: mail.to, userId: p.userId } });
      return reply.code(502).send({ error: 'send_failed', message: (err as Error).message });
    }
    await repo.setStatus(draft.id, 'sent');
    await deps.journal.add({ accountId: p.accountId, leadId: draft.leadId, kind: 'kp_sent', summary: `КП ${kpNo} отправлено на ${mail.to}`, details: { draftId: draft.id, to: mail.to, cc: mail.cc ?? null, kpNo, userId: p.userId, attachment: basename(file) } });
    await deps
      .amoFor(p.accountId)
      .then((amo) => amo.addLeadNote(draft.leadId, `[Агент опт] КП${kpNo ? ` ${kpNo}` : ''} отправлено на ${mail.to}.`))
      .catch((err: Error) => req.log.warn({ err: err.message }, 'kp: примечание в сделку не записано'));
    const fresh = await repo.byId(p.accountId, draft.id);
    return { draft: fresh ? view(fresh) : null, to: mail.to };
  });
}

/** DOCX по шаблону и PDF через LibreOffice, сертификаты по фабрикам, файлы — в карточку сделки. */
async function buildDocument(deps: Deps, p: WidgetPrincipal, draft: KpDraft, lines: KpLine[], template: string, constants: KpConstants, certsDir: string | null) {
  const payload = draft.payload as unknown as KpPayload;
  const kpNo = draft.kpNo ?? (await deps.kp.nextNumber(p.accountId));
  const letterAt = payload.source?.letterAt ? new Date(payload.source.letterAt) : null;
  const data = templateData({
    kpNo,
    date: new Date(),
    basis: letterAt ? `запрос от ${letterAt.toLocaleDateString('ru-RU')}` : 'запрос клиента',
    clientName: payload.client?.org || payload.client?.fio || '',
    clientPhone: payload.client?.phone || '',
    lines: lines.map((l) => ({ name: l.name, size: l.size, qty: l.qty, price: l.price, discount: l.discount })),
    vatRate: constants.vatRate ?? 0,
    priceNote: constants.priceNote ?? DEFAULT_PRICE_NOTE,
  });
  const outDir = join(deps.filesRoot, 'kp', String(p.accountId), String(draft.leadId));
  const built = await buildKp(template, data, outDir, `KP-${kpNo.replace(/[^0-9A-Za-zА-Яа-я._-]+/g, '_')}`);
  // Фабрики у опта берутся из названий позиций: каталога нет, сертификат подбирается по вхождению имени фабрики в файл.
  const certs = await findCertificates(certsDir, lines.map((l) => l.name));
  const attached = await attachToLead(deps, p.accountId, draft.leadId, [built.pdfPath ?? built.docxPath, ...certs]);
  await deps.kp.setBuilt(draft.id, { docxPath: built.docxPath, pdfPath: built.pdfPath, kpNo });
  await deps.journal.add({
    accountId: p.accountId,
    leadId: draft.leadId,
    kind: 'kp_build',
    summary:
      `КП ${kpNo} собрано: позиций ${lines.length}` +
      (built.pdfPath ? '' : ', PDF не собран') +
      (attached.length ? `, в сделку ${attached.length}` : '') +
      (built.priceNoteFallback ? '; в шаблоне нет {{price_note}} — фраза о ценах добавлена под строку НДС' : ''),
    details: { draftId: draft.id, certificates: certs.length, attached, pdfError: built.pdfError, priceNoteFallback: built.priceNoteFallback, userId: p.userId },
  });
  return { pdf: Boolean(built.pdfPath), attached };
}

/** Файлы — в карточку сделки: менеджер открывает их там же, где письмо. Сбой загрузки не ломает сборку. */
async function attachToLead(deps: Deps, accountId: number, leadId: number, files: string[]): Promise<string[]> {
  const amo = await deps.amoFor(accountId).catch(() => null);
  if (!amo) return [];
  const attached: string[] = [];
  for (const f of files) {
    const bytes = await readFile(f).catch(() => null);
    if (!bytes) continue;
    const mime = f.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    await amo
      .uploadFileToLead(leadId, { filename: basename(f), mime, bytes })
      .then(() => attached.push(basename(f)))
      .catch(() => undefined);
  }
  return attached;
}

function view(d: KpDraft) {
  const p = d.payload as unknown as Partial<KpPayload>;
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
  };
}
