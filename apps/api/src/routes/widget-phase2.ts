import { formatCalculation, summarizeDialog } from '@ai-door/agent';
import { AmoApiClient, type WidgetPrincipal } from '@ai-door/amo';
import { memorySubject, memoryToText } from '@ai-door/db';
import { calculate, exportRulesXlsx, importRulesXlsx, pricingRulesSchema, RulesImportError, type CalcInput } from '@ai-door/pricing';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.ts';

const leadParams = z.object({ leadId: z.coerce.number().int().positive() });
const idParams = z.object({ id: z.coerce.number().int().positive() });

const testBody = z.object({
  doors: z
    .array(z.object({ product_id: z.string(), width_mm: z.number().int().optional(), height_mm: z.number().int().optional(), qty: z.number().int().min(1) }))
    .max(50),
  kit: z.boolean().optional(),
  extras: z.array(z.object({ code: z.string(), qty: z.number().int().min(1) })).optional(),
  products: z.array(z.object({ product_id: z.string(), qty: z.number().int().min(1) })).optional(),
  services: z.array(z.object({ code: z.string(), km: z.number().optional(), floor: z.number().int().optional() })).optional(),
  /** Проверить черновик правил до сохранения. */
  rules: z.unknown().optional(),
});

/** Эндпоинты фазы 2. Регистрируются внутри плагина /widget/v1 (авторизация уже проверена). */
export function widgetPhase2Routes(
  api: FastifyInstance,
  deps: Deps,
  principal: (req: FastifyRequest) => WidgetPrincipal,
  requireAdmin: (req: FastifyRequest, reply: FastifyReply) => boolean,
) {
  const amoClient = async (accountId: number) => {
    const account = await deps.accounts.get(accountId);
    if (!account || account.uninstalledAt) return null;
    return new AmoApiClient(account.accountDomain, () => deps.tokenService.getAccessToken(accountId), deps.fetch);
  };

  // Правила цен.
  api.get('/pricing', async (req) => deps.pricing.get(principal(req).accountId));

  api.put('/pricing', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const p = principal(req);
    const parsed = pricingRulesSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_rules', issues: parsed.error.issues });
    return { rules: parsed.data, ...(await deps.pricing.save(p.accountId, p.userId, parsed.data)) };
  });

  // Импорт XLSX: файл base64 в JSON — так его передаёт виджет через $authorizedAjax.
  api.post('/pricing/import', { bodyLimit: 15 * 1024 * 1024 }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const p = principal(req);
    const b = z.object({ file: z.string().min(1), save: z.boolean().default(false) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'no_file' });
    try {
      const rules = await importRulesXlsx(Buffer.from(b.data.file, 'base64'));
      if (b.data.save) await deps.pricing.save(p.accountId, p.userId, rules);
      return { rules, saved: b.data.save };
    } catch (err) {
      if (err instanceof RulesImportError) return reply.code(422).send({ error: 'import_failed', problems: err.problems });
      throw err;
    }
  });

  api.get('/pricing/export', async (req) => {
    const { rules } = await deps.pricing.get(principal(req).accountId);
    return { file: Buffer.from(await exportRulesXlsx(rules)).toString('base64'), name: 'pravila-cen.xlsx' };
  });

  // «Тест расчёта» в настройках.
  api.post('/pricing/test', async (req, reply) => {
    const accountId = principal(req).accountId;
    const b = testBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid', issues: b.error.issues });
    let rules = (await deps.pricing.get(accountId)).rules;
    if (b.data.rules !== undefined) {
      const draft = pricingRulesSchema.safeParse(b.data.rules);
      if (!draft.success) return reply.code(400).send({ error: 'invalid_rules', issues: draft.error.issues });
      rules = draft.data;
    }
    const doors: CalcInput['doors'] = [];
    for (const d of b.data.doors) {
      const pr = await deps.catalog.get(accountId, d.product_id);
      if (!pr) return reply.code(404).send({ error: 'product_not_found', id: d.product_id });
      doors.push({ productId: pr.id, name: pr.name, category: pr.category, price: pr.price, widthMm: d.width_mm, heightMm: d.height_mm, qty: d.qty });
    }
    const products: CalcInput['products'] = [];
    for (const x of b.data.products ?? []) {
      const pr = await deps.catalog.get(accountId, x.product_id);
      if (!pr) return reply.code(404).send({ error: 'product_not_found', id: x.product_id });
      products.push({ productId: pr.id, name: pr.name, price: pr.price, qty: x.qty });
    }
    const result = calculate(rules, { doors, kit: b.data.kit ?? true, extras: b.data.extras ?? [], products, services: b.data.services ?? [] });
    return { result, text: formatCalculation(result) };
  });

  // Черновики и подсказки.
  api.get('/suggestions', async (req) => {
    const q = z.object({ leadId: z.coerce.number().int().positive().optional() }).parse(req.query);
    const accountId = principal(req).accountId;
    return { items: q.leadId ? await deps.suggestions.listForLead(accountId, q.leadId) : await deps.suggestions.pendingDrafts(accountId) };
  });

  api.post('/suggestions/:id/approve', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const p = principal(req);
    const b = z.object({ text: z.string().min(1).max(4000).optional() }).parse(req.body ?? {});
    const s = await deps.suggestions.get(p.accountId, id);
    if (!s || s.kind !== 'draft') return reply.code(404).send({ error: 'not_found' });
    const { settings } = await deps.settings.get(p.accountId);
    if (!settings.salesbot.senderBotId) return reply.code(409).send({ error: 'no_sender_bot' });
    const decided = await deps.suggestions.decide(p.accountId, id, 'approved', p.userId, b.text);
    if (!decided) return reply.code(409).send({ error: 'already_decided' });
    const client = await amoClient(p.accountId);
    if (!client) return reply.code(409).send({ error: 'not_installed' });
    try {
      // Бот-отправщик вызовет /salesbot/v1/hook с kind=send и заберёт черновик.
      await client.runSalesbot(settings.salesbot.senderBotId, decided.leadId);
    } catch (err) {
      await deps.journal.add({ accountId: p.accountId, leadId: decided.leadId, kind: 'error', summary: `Запуск бота-отправщика: ${(err as Error).message}` });
      return reply.code(502).send({ error: 'salesbot_failed' });
    }
    await deps.journal.add({ accountId: p.accountId, leadId: decided.leadId, kind: 'draft', summary: 'Черновик одобрен менеджером', details: { id, userId: p.userId, edited: Boolean(b.text) } });
    return { ok: true };
  });

  for (const [action, status] of [
    ['reject', 'rejected'],
    ['used', 'used'],
  ] as const) {
    api.post(`/suggestions/:id/${action}`, async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const p = principal(req);
      const s = await deps.suggestions.decide(p.accountId, id, status, p.userId);
      return s ? { ok: true } : reply.code(409).send({ error: 'already_decided' });
    });
  }

  // Резюме диалога по кнопке (раздел 10 ТЗ).
  api.post('/leads/:leadId/summary', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!deps.llm) return reply.code(503).send({ error: 'llm_not_configured' });
    const { leadId } = leadParams.parse(req.params);
    const p = principal(req);
    const client = await amoClient(p.accountId);
    if (!client) return reply.code(409).send({ error: 'not_installed' });
    const lead = await client.getLead(leadId);
    const contact = lead?._embedded?.contacts?.find((c) => c.is_main) ?? lead?._embedded?.contacts?.[0];
    const subject = memorySubject(contact?.id ?? null, leadId);
    const [{ settings }, history, mem] = await Promise.all([
      deps.settings.get(p.accountId),
      deps.dialog.history(p.accountId, leadId, 80),
      deps.memory.get(p.accountId, subject),
    ]);
    const s = await summarizeDialog(deps.llm, settings, {
      history: history.map((m) => ({ role: m.role, text: m.text })),
      memoryText: memoryToText(mem.data, null),
    });
    await client.addLeadNote(leadId, `[AI] Резюме диалога\n\n${s.text}`);
    await deps.memory.setSummary(p.accountId, subject, s.text);
    const costRub = s.cost.usd * settings.billing.usdRubRate;
    await deps.journal.add({ accountId: p.accountId, leadId, kind: 'summary', summary: s.text, costUsd: s.cost.usd, costRub, inputTokens: s.cost.inputTokens, outputTokens: s.cost.outputTokens });
    return { text: s.text, costRub };
  });
}
