import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { dirname, join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { buildKp, buildKpDraft, findCertificates, templateData, type KpLine, type KpPayload } from '@ai-door/agent';
import { buildKpMail, ourAddress, replySubject, serverConfig, type Mailbox } from '@ai-door/mail';
import { KpRepo, MailAttachmentsRepo, type KpDraft } from '@ai-door/db';
import { AmoApiClient, type WidgetPrincipal } from '@ai-door/amo';
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
  numbering: z
    .object({
      prefix: z.string().min(1).max(20).optional(),
      counter: z.number().int().min(0).optional(),
    })
    .optional(),
});

const templateSchema = z.object({
  filename: z.string().min(1).max(200),
  contentBase64: z.string().min(1),
});

const leadBody = z.object({ leadId: z.coerce.number().int().positive() });

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

/** Вкладка «КП» в настройках виджета и черновик КП в карточке сделки. */
export function widgetKpRoutes(
  api: FastifyInstance,
  deps: Deps,
  principal: (req: FastifyRequest) => WidgetPrincipal,
  requireAdmin: (req: FastifyRequest, reply: FastifyReply) => boolean,
) {
  const repo = new KpRepo(deps.db);
  const attachments = new MailAttachmentsRepo(deps.db);
  /** Клиент amoCRM аккаунта: письма сделки читаем прямо из карточки. */
  const amoFor = async (accountId: number) => {
    const a = await deps.accounts.get(accountId);
    if (!a) return undefined;
    return new AmoApiClient(a.accountDomain, () => deps.tokenService.getAccessToken(accountId), deps.fetch);
  };
  const root = process.env.KP_FILES_ROOT ?? process.env.MAIL_FILES_ROOT ?? '/data';
  const templatePath = (accountId: number) => join(root, 'kp', String(accountId), 'template.docx');

  api.get('/kp/settings', async (req) => {
    const s = await repo.getSettings(principal(req).accountId);
    return {
      constants: s.constants,
      certsDir: s.certsDir,
      numbering: s.numbering,
      template: {
        exists: Boolean(s.templatePath),
        name: s.templateName,
        md5: s.templateMd5,
        updatedAt: s.templateUpdatedAt,
      },
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
    if (!bytes.length || bytes.length > MAX_TEMPLATE_BYTES) {
      return reply.code(400).send({ error: 'bad_size' });
    }
    if (!bytes.subarray(0, 4).equals(ZIP_MAGIC)) {
      return reply.code(400).send({ error: 'not_docx' });
    }

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
      .header(
        'content-disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(s.templateName ?? 'kp.docx')}`,
      )
      .send(bytes);
  });

  api.get('/kp/draft', async (req, reply) => {
    const q = leadBody.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_query' });
    const d = await repo.latestByLead(principal(req).accountId, q.data.leadId);
    return { draft: d ? view(d) : null };
  });

  /**
   * Кнопка «Подготовить КП». Единственный шаг темы, который тратит токены.
   * Документ здесь не собирается: сборка — отдельная кнопка после правок менеджера.
   */
  api.post('/kp/draft', async (req, reply) => {
    const p = principal(req);
    const b = leadBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body' });
    const leadId = b.data.leadId;
    const ai = await deps.ai(p.accountId);
    if (!ai?.llm) return reply.code(409).send({ error: 'no_llm' });
    const { settings } = await deps.settings.get(p.accountId);
    try {
      const r = await buildKpDraft(
        ai.llm,
        settings,
        { accountId: p.accountId, leadId },
        {
          catalog: deps.catalog,
          dialog: deps.dialog,
          mail: await amoFor(p.accountId).catch(() => undefined),
          attachments,
          components: deps.doorComponents,
        },
      );
      const id = await repo.createDraft(p.accountId, leadId, r.payload as unknown as Record<string, unknown>, p.userId);
      await deps.journal.add({
        accountId: p.accountId,
        leadId,
        kind: 'kp_draft',
        summary:
          `Черновик КП: позиций ${r.payload.request_items.length}` +
          (r.payload.needs_manager.length ? `, нужен менеджер по ${r.payload.needs_manager.length}` : ''),
        details: { draftId: id, model: r.model, provider: r.provider },
        inputTokens: r.cost.inputTokens,
        outputTokens: r.cost.outputTokens,
        costUsd: r.cost.usd,
        costRub: r.cost.usd * settings.billing.usdRubRate,
      });
      const d = await repo.byId(p.accountId, id);
      return { draft: d ? view(d) : null };
    } catch (err) {
      await deps.journal.add({
        accountId: p.accountId,
        leadId,
        kind: 'kp_error',
        summary: `Черновик КП не собран: ${(err as Error).message}`,
      });
      return reply.code(502).send({ error: 'draft_failed', message: (err as Error).message });
    }
  });


  /**
   * Кнопка «Собрать КП». Документ строится из строк, которые менеджер подтвердил:
   * цены и количества берутся из черновика, а не из каталога. Автосборки нет.
   */
  api.post('/kp/build', async (req, reply) => {
    const p = principal(req);
    const b = z.object({ draftId: z.coerce.number().int().positive() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body' });
    const draft = await repo.byId(p.accountId, b.data.draftId);
    if (!draft) return reply.code(404).send({ error: 'not_found' });
    if (draft.status === 'sent') return reply.code(409).send({ error: 'already_sent' });

    const s = await repo.getSettings(p.accountId);
    if (!s.templatePath) return reply.code(409).send({ error: 'no_template' });
    const payload = draft.payload as unknown as KpPayload;
    const lines = (payload.items ?? []).filter((l) => l.price !== null);
    if (!lines.length) return reply.code(409).send({ error: 'no_priced_lines' });

    const kpNo = draft.kpNo ?? (await repo.nextNumber(p.accountId));
    const letterAt = payload.source?.letterAt ? new Date(payload.source.letterAt) : null;
    const data = templateData({
      kpNo,
      date: new Date(),
      basis: letterAt ? `запрос от ${letterAt.toLocaleDateString('ru-RU')}` : 'запрос клиента',
      clientName: payload.client?.org || payload.client?.fio || '',
      clientPhone: payload.client?.phone || '',
      lines: lines.map((l) => ({ name: l.name, size: l.size, qty: l.qty, price: l.price, discount: l.discount })),
      vatRate: s.constants.vatRate ?? 0,
    });

    const outDir = join(root, 'kp', String(p.accountId), String(draft.leadId));
    const baseName = `KP-${kpNo.replace(/[^0-9A-Za-zА-Яа-я._-]+/g, '_')}`;
    try {
      const built = await buildKp(s.templatePath, data, outDir, baseName);
      const ids = new Set(lines.map((l) => l.page_id).filter(Boolean));
      const factories = (payload.candidates ?? [])
        .filter((c) => ids.has(c.page_id))
        .map((c) => c.factory)
        .filter(Boolean);
      const certs = await findCertificates(s.certsDir, [...new Set(factories)]);

      // Файлы — в карточку сделки: менеджер открывает их там же, где письмо.
      const amo = await amoFor(p.accountId).catch(() => undefined);
      const attached: string[] = [];
      if (amo) {
        const files = [built.pdfPath ?? built.docxPath, ...certs];
        for (const f of files) {
          const bytes = await readFile(f).catch(() => null);
          if (!bytes) continue;
          const mime = f.endsWith('.pdf')
            ? 'application/pdf'
            : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
          await amo
            .uploadFileToLead(draft.leadId, { filename: basename(f), mime, bytes })
            .then(() => attached.push(basename(f)))
            .catch(() => undefined);
        }
      }

      await repo.setBuilt(draft.id, { docxPath: built.docxPath, pdfPath: built.pdfPath, kpNo });
      await deps.journal.add({
        accountId: p.accountId,
        leadId: draft.leadId,
        kind: 'kp_build',
        summary: `КП ${kpNo} собрано: позиций ${lines.length}` +
          (built.pdfPath ? '' : ', PDF не собран') +
          (attached.length ? `, в сделку ${attached.length}` : ''),
        details: { draftId: draft.id, certificates: certs.length, attached, pdfError: built.pdfError },
      });
      const fresh = await repo.byId(p.accountId, draft.id);
      return { draft: fresh ? view(fresh) : null, pdf: Boolean(built.pdfPath), attached };
    } catch (err) {
      await deps.journal.add({
        accountId: p.accountId,
        leadId: draft.leadId,
        kind: 'kp_error',
        summary: `КП не собрано: ${(err as Error).message}`,
        details: { draftId: draft.id },
      });
      return reply.code(502).send({ error: 'build_failed', message: (err as Error).message });
    }
  });


  /**
   * Кнопка «Отправить». Письмо уходит в ту же цепочку, что и запрос клиента,
   * с PDF коммерческого предложения и сертификатами. Автоотправки нет: только по кнопке.
   */
  api.post('/kp/send', async (req, reply) => {
    const p = principal(req);
    const b = z.object({ draftId: z.coerce.number().int().positive() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_body' });
    const draft = await repo.byId(p.accountId, b.data.draftId);
    if (!draft) return reply.code(404).send({ error: 'not_found' });
    if (draft.status === 'sent') return reply.code(409).send({ error: 'already_sent' });
    if (draft.status !== 'built' || !draft.docxPath) return reply.code(409).send({ error: 'not_built' });

    const { settings } = await deps.settings.get(p.accountId);
    const e = settings.email;
    if (!e.enabled || !e.smtpHost || !e.username) return reply.code(409).send({ error: 'mail_off' });
    const password = await deps.mail.getPassword(p.accountId);
    if (!password) return reply.code(409).send({ error: 'no_password' });

    const s = await repo.getSettings(p.accountId);
    const c = s.constants;
    const payload = draft.payload as unknown as KpPayload;
    const thread = await deps.mail.lastThread(p.accountId, draft.leadId);
    const to = (payload.source?.from || thread?.from || '').trim();
    if (!to.includes('@')) return reply.code(409).send({ error: 'no_recipient' });

    const kpNo = draft.kpNo ?? '';
    const docPath = draft.pdfPath ?? draft.docxPath;
    const lines = (payload.items ?? []).filter((l) => l.price !== null);
    const ids = new Set(lines.map((l) => l.page_id).filter(Boolean));
    const factories = (payload.candidates ?? [])
      .filter((x) => ids.has(x.page_id))
      .map((x) => x.factory)
      .filter(Boolean);
    const certs = await findCertificates(s.certsDir, [...new Set(factories)]);

    const files: { filename: string; content: Buffer }[] = [];
    for (const f of [docPath, ...certs]) {
      const bytes = await readFile(f).catch(() => null);
      if (bytes) files.push({ filename: basename(f), content: bytes });
    }
    if (!files.length) return reply.code(409).send({ error: 'no_files' });

    const body = [
      (c.coverLetter || 'Здравствуйте!\n\nНаправляем коммерческое предложение по вашему запросу — документ во вложении.').trim(),
      kpNo ? `Номер предложения: ${kpNo}.` : '',
      c.validDays ? `Предложение действительно ${c.validDays} дн.` : '',
      c.paymentTerms ? `Оплата: ${c.paymentTerms}` : '',
      c.delivery ? `Доставка: ${c.delivery}` : '',
      c.warranty ? `Гарантия: ${c.warranty}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const subject = thread?.subject
      ? replySubject(thread.subject)
      : `Коммерческое предложение${kpNo ? ` ${kpNo}` : ''}`;
    const mail = buildKpMail(
      { name: e.fromName, address: ourAddress(e) },
      {
        to,
        toName: thread?.fromName ?? payload.client?.fio ?? '',
        subject,
        inReplyTo: thread?.messageId ?? null,
        references: thread?.references ?? [],
      },
      body,
      c.signature || e.signature,
      files,
    );

    const cfg = serverConfig(e, password);
    let raw: Buffer;
    try {
      raw = await deps.mailSender(cfg).send(mail);
    } catch (err) {
      await deps.journal.add({
        accountId: p.accountId,
        leadId: draft.leadId,
        kind: 'kp_error',
        summary: `КП ${kpNo} не отправлено: ${(err as Error).message}`,
        details: { draftId: draft.id, to },
      });
      return reply.code(502).send({ error: 'send_failed', message: (err as Error).message });
    }

    // Копия в «Отправленные»: письмо должно быть видно в почте и в карточке amo.
    if (e.saveToSent) {
      let box: Mailbox | null = null;
      try {
        box = await deps.mailConnect(cfg);
        const sent = e.sentFolder || (await box.findSentFolder());
        if (sent) await box.append(sent, raw);
      } catch {
        // не критично: письмо уже ушло
      } finally {
        await box?.close().catch(() => undefined);
      }
    }

    await repo.setStatus(draft.id, 'sent');

    const amo = await amoFor(p.accountId).catch(() => undefined);
    let taskAt: Date | null = null;
    if (amo) {
      const lead = (await amo.getLeadsByIds([draft.leadId]).catch(() => []))[0];
      taskAt = addWorkdays(new Date(), 2);
      await amo
        .createTask({
          text: `Контроль ответа по КП${kpNo ? ` ${kpNo}` : ''}: клиент ${to}`,
          completeTill: taskAt,
          leadId: draft.leadId,
          taskTypeId: settings.taskSweep.taskTypeId,
          responsibleUserId: lead?.responsible_user_id || undefined,
        })
        .catch(() => undefined);
      await amo
        .addLeadNote(draft.leadId, `[AI] КП${kpNo ? ` ${kpNo}` : ''} отправлено на ${to}. Вложений: ${files.length}.`)
        .catch(() => undefined);
    }

    await deps.journal.add({
      accountId: p.accountId,
      leadId: draft.leadId,
      kind: 'kp_sent',
      summary: `КП ${kpNo} отправлено на ${to}, вложений ${files.length}`,
      details: { draftId: draft.id, to, attachments: files.map((f) => f.filename), taskAt },
    });

    const fresh = await repo.byId(p.accountId, draft.id);
    return { draft: fresh ? view(fresh) : null, to, attachments: files.map((f) => f.filename) };
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
    const payload = { ...(d.payload as unknown as KpPayload), items: b.data.items as KpLine[] };
    await repo.setPayload(id, payload as unknown as Record<string, unknown>);
    const fresh = await repo.byId(p.accountId, id);
    return { draft: fresh ? view(fresh) : null };
  });
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
    candidates: p.candidates ?? [],
    items: p.items ?? [],
    components: p.components ?? [],
    requiredBlocks: p.required_blocks ?? [],
    questions: p.questions ?? [],
    needsManager: p.needs_manager ?? [],
  };
}

/** Срок контроля: +N рабочих дней, суббота и воскресенье пропускаются. */
function addWorkdays(from: Date, days: number): Date {
  const d = new Date(from);
  let left = days;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) left -= 1;
  }
  return d;
}
