import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { KpRepo } from '@ai-door/db';
import type { WidgetPrincipal } from '@ai-door/amo';
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

/** Вкладка «КП» в настройках виджета: константы, нумерация, файл-шаблон. */
export function widgetKpRoutes(
  api: FastifyInstance,
  deps: Deps,
  principal: (req: FastifyRequest) => WidgetPrincipal,
  requireAdmin: (req: FastifyRequest, reply: FastifyReply) => boolean,
) {
  const repo = new KpRepo(deps.db);
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
}
