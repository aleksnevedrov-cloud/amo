import { resolveRoute } from '@ai-door/agent';
import { AmoApiClient, type WidgetPrincipal } from '@ai-door/amo';
import { llmModelRefSchema, llmProviderSchema, type LlmModelRef } from '@ai-door/db';
import { isProviderId, maskKey, pricePublic, PROVIDER_IDS, PROVIDERS, tariffModels, verifyKey, type ModelInfo, type ProviderId } from '@ai-door/llm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.ts';
import { EVAL_DIALOGS, runEvalSet } from '../evals.ts';

const leadParams = z.object({ leadId: z.coerce.number().int().positive() });
const idParams = z.object({ id: z.coerce.number().int().positive() });
const keyBody = z.object({ key: z.string().trim().min(20).max(500), provider: llmProviderSchema.default('anthropic') });
const providerQuery = z.object({ provider: llmProviderSchema.default('anthropic'), refresh: z.coerce.boolean().optional() });

/** Список моделей считается свежим сутки (раздел 4 ТЗ). */
export const MODELS_CACHE_MS = 24 * 3600_000;

/** Эндпоинты 1.1.0: ключи двух провайдеров, список моделей, переопределение модели для сделки, прогон eval. */
export function widgetLlmRoutes(
  api: FastifyInstance,
  deps: Deps,
  principal: (req: FastifyRequest) => WidgetPrincipal,
  requireAdmin: (req: FastifyRequest, reply: FastifyReply) => boolean,
) {
  const label = (p: ProviderId) => PROVIDERS[p].label.split(' ')[0] ?? p;

  // Совместимость 1.0.x: есть ли ключ Anthropic у аккаунта и настроена ли LLM вообще.
  api.get('/llm/status', async (req) => {
    const accountId = principal(req).accountId;
    const [hasOwnKey, ai] = await Promise.all([deps.secrets.has(accountId, 'anthropic'), deps.ai(accountId)]);
    return { hasOwnKey, configured: ai !== null, source: ai?.source ?? null };
  });

  // Ключи обоих провайдеров: только маска (раздел 5 ТЗ) и откуда ключ.
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

  // Сохранение ключа: сначала проверка у провайдера, невалидный ключ не сохраняется (раздел 3 ТЗ).
  api.put('/llm/key', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = keyBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_key' });
    const p = principal(req);
    const check = await verifyKey(b.data.provider, b.data.key, { fetch: deps.fetch });
    if (!check.ok) return reply.code(422).send({ error: 'key_invalid', message: check.error });
    await deps.secrets.set(p.accountId, b.data.provider, b.data.key, p.userId);
    await deps.modelsCache.set(p.accountId, b.data.provider, []).catch(() => undefined);
    await deps.modelsCache.clear(p.accountId, b.data.provider).catch(() => undefined);
    await deps.journal.add({ accountId: p.accountId, kind: 'note', summary: `Ключ ${label(b.data.provider)} аккаунта обновлён (${maskKey(b.data.key)})`, details: { userId: p.userId, provider: b.data.provider, audit: 'llm.key' } });
    return { ok: true };
  });

  api.delete('/llm/key', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const q = z.object({ provider: llmProviderSchema.default('anthropic') }).safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: 'bad_provider' });
    const p = principal(req);
    await deps.secrets.remove(p.accountId, q.data.provider);
    await deps.modelsCache.clear(p.accountId, q.data.provider).catch(() => undefined);
    await deps.journal.add({ accountId: p.accountId, kind: 'note', summary: `Ключ ${label(q.data.provider)} аккаунта удалён`, details: { userId: p.userId, provider: q.data.provider, audit: 'llm.key' } });
    return { ok: true };
  });

  // Проверка ключа без расходов (список моделей). Ключ из тела — до сохранения, иначе сохранённый.
  api.post('/llm/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = z.object({ key: z.string().trim().min(20).max(500).optional(), provider: llmProviderSchema.default('anthropic') }).safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'bad_key' });
    const accountId = principal(req).accountId;
    const key = b.data.key ?? (await deps.secrets.get(accountId, b.data.provider)) ?? deps.serverKeys[b.data.provider];
    if (!key) return reply.code(400).send({ error: 'no_key' });
    return verifyKey(b.data.provider, key, { fetch: deps.fetch });
  });

  /**
   * Список моделей провайдера из его API по сохранённому ключу (раздел 4 ТЗ): только чат-модели с инструментами,
   * с ценой из таблицы тарифов (с учётом переопределений аккаунта) и меткой изображений. Кэш 24 ч, refresh=1 — заново.
   */
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

  // Провайдер и модель только для этой сделки (панель карточки, раздел 3 ТЗ); null — снять.
  api.put('/leads/:leadId/llm', async (req, reply) => {
    const { leadId } = leadParams.parse(req.params);
    const p = principal(req);
    const b = z.object({ model: llmModelRefSchema.nullable() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_model', issues: b.error.issues });
    const ref = b.data.model;
    if (ref) {
      const ai = await deps.ai(p.accountId);
      if (!ai?.providers.includes(ref.provider)) return reply.code(409).send({ error: 'no_key', provider: ref.provider });
    }
    await deps.dialog.setLlmOverride(p.accountId, leadId, ref);
    await deps.journal.add({
      accountId: p.accountId,
      leadId,
      kind: 'note',
      summary: ref ? `Модель для сделки: ${PROVIDERS[ref.provider].short} · ${ref.model}` : 'Модель для сделки: по настройкам',
      details: { userId: p.userId, audit: 'llm.lead', ...(ref ? { provider: ref.provider, model: ref.model } : {}) },
    });
    const { settings } = await deps.settings.get(p.accountId);
    return { ok: true, route: resolveRoute(settings, { lead: ref }) };
  });

  // «В примечание» из панели сделки (расчёт, резюме): примечание в amo от имени пользователя виджета.
  api.post('/leads/:leadId/notes', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { leadId } = leadParams.parse(req.params);
    const p = principal(req);
    const b = z.object({ text: z.string().trim().min(1).max(8000) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_text' });
    const account = await deps.accounts.get(p.accountId);
    if (!account || account.uninstalledAt) return reply.code(409).send({ error: 'not_installed' });
    const client = new AmoApiClient(account.accountDomain, () => deps.tokenService.getAccessToken(p.accountId), deps.fetch);
    await client.addLeadNote(leadId, b.data.text);
    await deps.journal.add({ accountId: p.accountId, leadId, kind: 'note', summary: `Примечание из панели: ${b.data.text.slice(0, 120)}`, details: { userId: p.userId } });
    return { ok: true };
  });

  // Eval-набор на выбранных моделях (раздел 7 ТЗ): запуск в фоне, прогресс и итог — в eval_runs.
  api.get('/evals/dialogs', async () => ({ items: EVAL_DIALOGS.map((d) => ({ id: d.id, topic: d.topic, turns: d.turns.length })) }));

  api.post('/evals/run', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = z
      .object({ models: z.array(llmModelRefSchema).min(1).max(2), ids: z.array(z.string().max(100)).max(200).optional(), limit: z.number().int().min(1).max(200).optional() })
      .safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid', issues: b.error.issues });
    const p = principal(req);
    const ai = await deps.ai(p.accountId);
    if (!ai) return reply.code(503).send({ error: 'llm_not_configured' });
    const missing = b.data.models.find((m) => !ai.providers.includes(m.provider));
    if (missing) return reply.code(409).send({ error: 'no_key', provider: missing.provider });
    if (await deps.evalRuns.running(p.accountId)) return reply.code(409).send({ error: 'already_running' });
    const known = new Set(EVAL_DIALOGS.map((d) => d.id));
    let ids = (b.data.ids ?? []).filter((id) => known.has(id));
    if (!ids.length && b.data.limit) ids = EVAL_DIALOGS.slice(0, b.data.limit).map((d) => d.id);
    const models: LlmModelRef[] = b.data.models;
    const id = await deps.evalRuns.start(p.accountId, models, ids, p.userId);
    const { settings } = await deps.settings.get(p.accountId);
    void runEvalSet({ evalRuns: deps.evalRuns, fixtures: deps.evalFixtures, ai, settings, log: req.log }, p.accountId, id, models, ids).catch((err: Error) => req.log.error({ err }, 'eval run'));
    await deps.journal.add({ accountId: p.accountId, kind: 'note', summary: `Запущен прогон eval на ${models.map((m) => `${m.provider}/${m.model}`).join(' и ')}`, details: { userId: p.userId, evalRunId: id } });
    return reply.code(202).send({ id });
  });

  api.get('/evals/runs', async (req) => {
    const runs = await deps.evalRuns.list(principal(req).accountId);
    return { items: runs.map((r) => ({ ...r, results: undefined, progress: progressOf(r.results, r.dialogIds.length || EVAL_DIALOGS.length) })) };
  });

  api.get('/evals/runs/:id', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const r = await deps.evalRuns.get(principal(req).accountId, id);
    return r ? { ...r, progress: progressOf(r.results, r.dialogIds.length || EVAL_DIALOGS.length) } : reply.code(404).send({ error: 'not_found' });
  });
}

function progressOf(results: unknown[], total: number): { done: number; total: number } {
  const first = results[0] as { reports?: unknown[] } | undefined;
  return { done: first?.reports?.length ?? 0, total };
}

/** Провайдер из произвольной строки (query, настройки старых версий). */
export const providerOf = (v: unknown): ProviderId => (isProviderId(v) ? v : 'anthropic');
