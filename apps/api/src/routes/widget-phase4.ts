import { verifyAnthropicKey } from '@ai-door/agent';
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

  // Ключ Anthropic аккаунта (Маркетплейс: каждая компания со своим ключом). Хранится зашифрованным, не отдаётся.
  api.get('/llm/status', async (req) => {
    const accountId = principal(req).accountId;
    const [hasOwnKey, ai] = await Promise.all([deps.secrets.has(accountId, 'anthropic'), deps.ai(accountId)]);
    return { hasOwnKey, configured: ai !== null, source: ai?.source ?? null };
  });

  api.put('/llm/key', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = z.object({ key: z.string().trim().min(20).max(500) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_key' });
    const p = principal(req);
    await deps.secrets.set(p.accountId, 'anthropic', b.data.key, p.userId);
    await deps.journal.add({ accountId: p.accountId, kind: 'note', summary: 'Ключ Anthropic аккаунта обновлён', details: { userId: p.userId } });
    return { ok: true };
  });

  api.delete('/llm/key', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const p = principal(req);
    await deps.secrets.remove(p.accountId, 'anthropic');
    await deps.journal.add({ accountId: p.accountId, kind: 'note', summary: 'Ключ Anthropic аккаунта удалён', details: { userId: p.userId } });
    return { ok: true };
  });

  // Проверка ключа без расходов (список моделей). Ключ из тела — до сохранения, иначе сохранённый.
  api.post('/llm/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = z.object({ key: z.string().trim().min(20).max(500).optional() }).safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'bad_key' });
    const key = b.data.key ?? (await deps.secrets.get(principal(req).accountId, 'anthropic'));
    if (!key) return reply.code(400).send({ error: 'no_key' });
    return verifyAnthropicKey(key, deps.fetch);
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
