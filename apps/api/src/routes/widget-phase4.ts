import type { WidgetPrincipal } from '@ai-door/amo';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.ts';

const idParams = z.object({ id: z.coerce.number().int().positive() });
const analyticsQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

/** Эндпоинты фазы 4: аналитика, учёт расходов, версии настроек, удаление данных аккаунта. */
export function widgetPhase4Routes(
  api: FastifyInstance,
  deps: Deps,
  principal: (req: FastifyRequest) => WidgetPrincipal,
  requireAdmin: (req: FastifyRequest, reply: FastifyReply) => boolean,
) {
  // Аналитика за период: диалоги, передачи, конверсия, стоимость, по дням.
  api.get('/analytics', async (req) => {
    const { days } = analyticsQuery.parse(req.query);
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    return deps.analytics.summary(principal(req).accountId, from, to);
  });

  // Расход по месяцам (учёт для биллинга).
  api.get('/billing', async (req) => ({ months: await deps.analytics.billing(principal(req).accountId, 6) }));

  // Версии настроек: история, снимок, откат.
  api.get('/settings/history', async (req) => ({ items: await deps.settings.history(principal(req).accountId) }));

  api.get('/settings/history/:id', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const v = await deps.settings.version(principal(req).accountId, id);
    return v ?? reply.code(404).send({ error: 'not_found' });
  });

  api.post('/settings/history/:id/restore', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = idParams.parse(req.params);
    const p = principal(req);
    const r = await deps.settings.restore(p.accountId, p.userId, id);
    if (!r) return reply.code(404).send({ error: 'not_found' });
    await deps.journal.add({ accountId: p.accountId, kind: 'note', summary: `Настройки откачены к версии #${id}`, details: { userId: p.userId, versionId: id } });
    return { version: r.version };
  });

  // Удаление всех данных аккаунта по запросу (чек-лист Маркетплейса). Необратимо; виджет придётся установить заново.
  api.post('/account/purge', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = z.object({ confirm: z.literal('УДАЛИТЬ') }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'confirm_required' });
    const p = principal(req);
    const ok = await deps.accounts.purge(p.accountId);
    if (!ok) return reply.code(404).send({ error: 'not_installed' });
    await deps.alerter.alert(`Аккаунт ${p.accountId}: все данные удалены по запросу пользователя ${p.userId}`).catch(() => undefined);
    return { ok: true };
  });
}
