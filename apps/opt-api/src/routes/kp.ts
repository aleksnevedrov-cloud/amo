import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { WidgetPrincipal } from '@core/amo';
import { buildKp, composeKpMail, findCertificates, renderMailTemplate, sendBlockers, templateData, type KpDraft, type KpLine, type KpPayload } from '@opt/kp';
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
        qty: z.number().int().min(1).max(10_000),
        price: z.number().min(0).max(100_000_000).nullable(),
        lead_time: z.string().max(100),
        discount: z.number().min(0).max(100),
      }),
    )
    .max(200),
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
      constants: s.constants,
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
    await repo.setPayload(id, { ...(d.payload as unknown as KpPayload), items: b.data.items as KpLine[] } as unknown as Record<string, unknown>);
    const fresh = await repo.byId(p.accountId, id);
    return { draft: fresh ? view(fresh) : null };
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
      const r = await buildDocument(deps, p, draft, lines, s.templatePath, s.constants.vatRate ?? 0, s.certsDir);
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
async function buildDocument(deps: Deps, p: WidgetPrincipal, draft: KpDraft, lines: KpLine[], template: string, vatRate: number, certsDir: string | null) {
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
    vatRate,
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
    summary: `КП ${kpNo} собрано: позиций ${lines.length}` + (built.pdfPath ? '' : ', PDF не собран') + (attached.length ? `, в сделку ${attached.length}` : ''),
    details: { draftId: draft.id, certificates: certs.length, attached, pdfError: built.pdfError, userId: p.userId },
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
