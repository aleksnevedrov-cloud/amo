import type { WidgetPrincipal } from '@core/amo';
import { llmProviderSchema } from '@core/db';
import { maskKey, pricePublic, PROVIDER_IDS, PROVIDERS, tariffModels, verifyKey, type ModelInfo, type ProviderId } from '@core/llm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.ts';

const keyBody = z.object({ key: z.string().trim().min(20).max(500), provider: llmProviderSchema.default('openai') });
const providerQuery = z.object({ provider: llmProviderSchema.default('openai'), refresh: z.coerce.boolean().optional() });

/** Список моделей считается свежим сутки. */
export const MODELS_CACHE_MS = 24 * 3600_000;

/** Ключи провайдеров и список моделей для вкладки «Модель» опта. Копия розничных маршрутов без eval и переопределений по сделкам. */
export function llmRoutes(
  api: FastifyInstance,
  deps: Deps,
  principal: (req: FastifyRequest) => WidgetPrincipal,
  requireAdmin: (req: FastifyRequest, reply: FastifyReply) => boolean,
) {
  const label = (p: ProviderId) => PROVIDERS[p].label.split(' ')[0] ?? p;

  // Ключи обоих провайдеров: только маска и откуда ключ.
  api.get('/llm/keys', async (req) => {
    const accountId = principal(req).accountId;
    const [{ settings }, ai] = await Promise.all([deps.settings.get(accountId), deps.ai(accountId)]);
    const keys: Record<string, { saved: boolean; mask: string | null; source: 'account' | 'server' | null }> = {};
    for (const id of PROVIDER_IDS) {
      const own = await deps.secrets.get(accountId, id);
      keys[id] = { saved: Boolean(own), mask: own ? maskKey(own) : null, source: ai?.keySources[id] ?? null };
    }
    return { provider: settings.model.provider, fallbackProvider: settings.model.fallbackProvider ?? settings.model.provider, keys, providers: ai?.providers ?? [] };
  });

  // Сохранение ключа: сначала проверка у провайдера, невалидный ключ не сохраняется.
  api.put('/llm/key', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = keyBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_key' });
    const p = principal(req);
    const check = await verifyKey(b.data.provider, b.data.key, { fetch: deps.fetch });
    if (!check.ok) return reply.code(422).send({ error: 'key_invalid', message: check.error });
    await deps.secrets.set(p.accountId, b.data.provider, b.data.key, p.userId);
    await deps.modelsCache.clear(p.accountId, b.data.provider).catch(() => undefined);
    await deps.journal.add({ accountId: p.accountId, kind: 'note', summary: `Ключ ${label(b.data.provider)} обновлён (${maskKey(b.data.key)})`, details: { userId: p.userId, provider: b.data.provider, audit: 'llm.key' } });
    return { ok: true };
  });

  api.delete('/llm/key', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const q = z.object({ provider: llmProviderSchema.default('openai') }).safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: 'bad_provider' });
    const p = principal(req);
    await deps.secrets.remove(p.accountId, q.data.provider);
    await deps.modelsCache.clear(p.accountId, q.data.provider).catch(() => undefined);
    await deps.journal.add({ accountId: p.accountId, kind: 'note', summary: `Ключ ${label(q.data.provider)} удалён`, details: { userId: p.userId, provider: q.data.provider, audit: 'llm.key' } });
    return { ok: true };
  });

  // Проверка ключа без расходов (список моделей). Ключ из тела — до сохранения, иначе сохранённый или серверный.
  api.post('/llm/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = z.object({ key: z.string().trim().min(20).max(500).optional(), provider: llmProviderSchema.default('openai') }).safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'bad_key' });
    const accountId = principal(req).accountId;
    const serverKeys: Partial<Record<ProviderId, string | undefined>> = { anthropic: deps.env.ANTHROPIC_API_KEY, openai: deps.env.OPENAI_API_KEY };
    const key = b.data.key ?? (await deps.secrets.get(accountId, b.data.provider)) ?? serverKeys[b.data.provider];
    if (!key) return reply.code(400).send({ error: 'no_key' });
    return verifyKey(b.data.provider, key, { fetch: deps.fetch });
  });

  // Модели провайдера по сохранённому ключу с ценой из таблицы тарифов; кэш 24 ч, refresh=1 — заново.
  api.get('/llm/models', async (req, reply) => {
    const q = providerQuery.safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: 'bad_provider' });
    const accountId = principal(req).accountId;
    const { provider } = q.data;
    const [{ settings }, ai] = await Promise.all([deps.settings.get(accountId), deps.ai(accountId)]);
    const adapter = await ai?.llm.provider(provider);
    const withPrices = (models: ModelInfo[]) => models.map((m) => ({ ...m, price: pricePublic(provider, m.id, settings.billing.pricing) }));
    if (!adapter) return { provider, models: withPrices(tariffModels(provider)), fetchedAt: null, fromCache: false, source: 'tariff' as const, noKey: true };
    const cached = q.data.refresh ? null : await deps.modelsCache.get<ModelInfo>(accountId, provider);
    if (cached && cached.models.length && Date.now() - cached.fetchedAt.getTime() < MODELS_CACHE_MS) {
      return { provider, models: withPrices(cached.models), fetchedAt: cached.fetchedAt, fromCache: true, source: 'api' as const, noKey: false };
    }
    try {
      const models = await adapter.listModels();
      await deps.modelsCache.set(accountId, provider, models);
      return { provider, models: withPrices(models), fetchedAt: new Date(), fromCache: false, source: 'api' as const, noKey: false };
    } catch (err) {
      const message = (err as Error).message;
      if (cached?.models.length) return { provider, models: withPrices(cached.models), fetchedAt: cached.fetchedAt, fromCache: true, source: 'api' as const, noKey: false, error: message };
      return reply.code(502).send({ error: 'provider_error', message, provider, models: withPrices(tariffModels(provider)), source: 'tariff' });
    }
  });
}
