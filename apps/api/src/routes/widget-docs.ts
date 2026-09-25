import { AmoApiClient, type WidgetPrincipal } from '@ai-door/amo';
import { memorySubject } from '@ai-door/db';
import { DocumentError } from '@ai-door/docs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.ts';

const leadParams = z.object({ leadId: z.coerce.number().int().positive() });

/** Файл до 20 МБ (base64 ≈ 27 МБ). */
const uploadBody = z.object({
  name: z.string().min(1).max(300),
  mime: z.string().max(200).default(''),
  file: z.string().min(1).max(28 * 1024 * 1024),
  hint: z.enum(['measurement', 'request', 'photo']).optional(),
});

/** Разбор файлов из карточки сделки (фаза 3): кнопка «Разобрать файл», список разобранных. */
export function widgetDocsRoutes(api: FastifyInstance, deps: Deps, principal: (req: FastifyRequest) => WidgetPrincipal) {
  api.get('/leads/:leadId/documents', async (req) => {
    const { leadId } = leadParams.parse(req.params);
    const items = await deps.documents.listForLead(principal(req).accountId, leadId);
    return { items: items.map(publicDoc) };
  });

  api.post('/leads/:leadId/documents', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } }, bodyLimit: 30 * 1024 * 1024 }, async (req, reply) => {
    if (!deps.llm) return reply.code(503).send({ error: 'llm_not_configured' });
    const { leadId } = leadParams.parse(req.params);
    const b = uploadBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_file' });
    const p = principal(req);
    const bytes = new Uint8Array(Buffer.from(b.data.file, 'base64'));
    if (!bytes.byteLength) return reply.code(400).send({ error: 'bad_file' });
    const { settings } = await deps.settings.get(p.accountId);
    let r;
    try {
      r = await deps.docs.analyze({
        accountId: p.accountId,
        leadId,
        source: 'widget',
        filename: b.data.name,
        mime: b.data.mime,
        bytes,
        settings,
        createdBy: p.userId,
        ...(b.data.hint ? { hint: b.data.hint } : {}),
      });
    } catch (err) {
      const message = (err as Error).message;
      await deps.journal.add({ accountId: p.accountId, leadId, kind: 'error', summary: `Разбор файла «${b.data.name}»: ${message}`, details: { userId: p.userId } });
      if (err instanceof DocumentError) return reply.code(422).send({ error: 'document', message });
      throw err;
    }
    await deps.journal.add({
      accountId: p.accountId,
      leadId,
      kind: 'document',
      summary: `Разобран файл «${b.data.name}» (${r.kind})`,
      details: { documentId: r.id, userId: p.userId, model: r.model, text: r.text },
      costUsd: r.costUsd,
      costRub: r.costUsd * settings.billing.usdRubRate,
    });

    // Проёмы из замера — в память клиента; примечание — в сделку (по настройке).
    const account = await deps.accounts.get(p.accountId);
    let noted = false;
    if (account && !account.uninstalledAt) {
      const client = new AmoApiClient(account.accountDomain, () => deps.tokenService.getAccessToken(p.accountId), deps.fetch);
      if (r.memoryOpenings.length) {
        const lead = await client.getLead(leadId).catch(() => null);
        const contact = lead?._embedded?.contacts?.find((c) => c.is_main) ?? lead?._embedded?.contacts?.[0];
        await deps.memory.update(p.accountId, memorySubject(contact?.id ?? null, leadId), { openings: r.memoryOpenings });
      }
      if (settings.vision.noteInLead) noted = await client.addLeadNote(leadId, r.note).then(() => true, () => false);
    }
    return { id: r.id, kind: r.kind, data: r.data, matches: r.matches, kit: r.kit, note: r.note, noted, ocr: r.ocr, piiRemoved: r.piiRemoved, costRub: r.costUsd * settings.billing.usdRubRate };
  });
}

function publicDoc(d: { id: number; filename: string | null; kind: string; source: string; data: Record<string, unknown>; createdAt: Date; costUsd: number }) {
  const data = d.data as { title?: string; summary?: string; openings?: unknown[]; positions?: unknown[] };
  return {
    id: d.id,
    filename: d.filename,
    kind: d.kind,
    source: d.source,
    title: data.title ?? '',
    summary: data.summary ?? '',
    openings: data.openings?.length ?? 0,
    positions: data.positions?.length ?? 0,
    createdAt: d.createdAt,
  };
}
