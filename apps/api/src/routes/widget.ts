import { InMemoryMemory, PHASE2_TOOLS, pricingCodesHint, SandboxCrm } from '@ai-door/tools';
import { widgetEmailRoutes } from './widget-email.ts';
import { widgetPhase2Routes } from './widget-phase2.ts';
import { AmoApiClient, disposableTokenAudience, verifyDisposableToken, type WidgetPrincipal } from '@ai-door/amo';
import { widgetSettingsSchema, type WidgetSettings } from '@ai-door/db';
import { amoRedirectUri } from '@ai-door/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.ts';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: WidgetPrincipal;
  }
}

function principal(req: FastifyRequest): WidgetPrincipal {
  if (!req.principal) throw new Error('principal не установлен');
  return req.principal;
}

function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (principal(req).isAdmin) return true;
  void reply.code(403).send({ error: 'admin_only' });
  return false;
}

const leadParams = z.object({ leadId: z.coerce.number().int().positive() });

const journalQuery = z.object({
  leadId: z.coerce.number().int().positive().optional(),
  kind: z.string().max(20).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const knowledgeBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('faq'), question: z.string().min(3).max(1000), answer: z.string().min(1).max(8000) }),
  z.object({ kind: z.literal('text'), title: z.string().min(1).max(500), content: z.string().min(20).max(200_000) }),
  z.object({ kind: z.literal('url'), url: z.string().url() }),
]);

const sandboxBody = z.object({
  messages: z
    .array(z.object({ role: z.enum(['client', 'ai']), text: z.string().min(1).max(8000) }))
    .min(1)
    .max(60),
  /** Черновик настроек — проверить поведение до сохранения. */
  settings: z.unknown().optional(),
});

/** API для фронтенда виджета. Авторизация — одноразовый токен amo в X-Auth-Token. */
export function widgetRoutes(app: FastifyInstance, deps: Deps) {
  const audience = disposableTokenAudience(amoRedirectUri(deps.env));

  app.register(
    async (api) => {
      api.addHook('preHandler', async (req, reply) => {
        const token = req.headers['x-auth-token'];
        if (typeof token !== 'string' || !token) return reply.code(401).send({ error: 'no_token' });
        try {
          req.principal = await verifyDisposableToken(token, {
            clientSecret: deps.env.AMO_CLIENT_SECRET,
            clientId: deps.env.AMO_CLIENT_ID,
            audience,
          });
        } catch (err) {
          req.log.warn({ err: (err as Error).message }, 'widget: невалидный токен');
          return reply.code(401).send({ error: 'invalid_token' });
        }
      });

      api.get('/status', async (req) => {
        const p = principal(req);
        const [account, token, { settings }, spend, catalog] = await Promise.all([
          deps.accounts.get(p.accountId),
          deps.tokens.status(p.accountId),
          deps.settings.get(p.accountId),
          deps.journal.spentSummary(p.accountId),
          deps.catalog.stats(p.accountId),
        ]);
        const connected = Boolean(account && !account.uninstalledAt && token && !token.lastError);
        return {
          accountId: p.accountId,
          isAdmin: p.isAdmin,
          connected,
          tokenExpiresAt: token?.expiresAt ?? null,
          tokenError: token?.lastError ?? null,
          enabled: settings.enabled,
          mode: settings.mode,
          llmConfigured: deps.orchestrator !== null,
          spend,
          dailyLimitRub: settings.limits.dailyRub,
          catalog,
        };
      });

      api.get('/settings', async (req) => deps.settings.get(principal(req).accountId));

      api.put('/settings', async (req, reply) => {
        if (!requireAdmin(req, reply)) return;
        const p = principal(req);
        const parsed = widgetSettingsSchema.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'invalid_settings', issues: parsed.error.issues });
        if (!(await deps.accounts.get(p.accountId))) return reply.code(409).send({ error: 'not_installed' });
        const { version } = await deps.settings.save(p.accountId, p.userId, parsed.data);
        return { settings: parsed.data, version };
      });

      api.get('/journal', async (req, reply) => {
        const q = journalQuery.safeParse(req.query);
        if (!q.success) return reply.code(400).send({ error: 'bad_query' });
        return { items: await deps.journal.list(principal(req).accountId, q.data) };
      });

      // Панель в карточке сделки.
      api.get('/leads/:leadId/panel', async (req) => {
        const { leadId } = leadParams.parse(req.params);
        const accountId = principal(req).accountId;
        const [{ settings }, state, log, suggestions] = await Promise.all([
          deps.settings.get(accountId),
          deps.dialog.state(accountId, leadId),
          deps.journal.list(accountId, { leadId, limit: 30 }),
          deps.suggestions.listForLead(accountId, leadId, 10),
        ]);
        const lastCalc = log.find((e) => (e.details as { calculation?: unknown }).calculation);
        const lastReply = log.find((e) => e.kind === 'reply' || e.kind === 'handoff');
        const sources = ((lastReply?.details as { sources?: { type: string }[] } | undefined)?.sources ?? []);
        return {
          leadId,
          ai: {
            enabled: settings.enabled,
            mode: settings.mode,
            paused: state.paused,
            pauseReason: state.pauseReason,
            pausedAt: state.pausedAt,
          },
          hints: suggestions.filter((x) => x.status === 'pending'),
          products: sources.filter((s) => s.type === 'product'),
          calculations: lastCalc ? [(lastCalc.details as { calculation: unknown }).calculation] : [],
          log: log.map((e) => ({ id: e.id, kind: e.kind, summary: e.summary, costRub: e.costRub, createdAt: e.createdAt })),
          costRub: log.reduce((sum, e) => sum + e.costRub, 0),
        };
      });

      api.post('/leads/:leadId/pause', async (req) => {
        const { leadId } = leadParams.parse(req.params);
        const p = principal(req);
        await deps.dialog.pause(p.accountId, leadId, `manual:${p.userId}`);
        await deps.journal.add({ accountId: p.accountId, leadId, kind: 'pause', summary: 'AI поставлен на паузу вручную', details: { userId: p.userId } });
        return { ok: true };
      });

      api.post('/leads/:leadId/resume', async (req) => {
        const { leadId } = leadParams.parse(req.params);
        const p = principal(req);
        await deps.dialog.resume(p.accountId, leadId);
        await deps.journal.add({ accountId: p.accountId, leadId, kind: 'resume', summary: 'AI возвращён в диалог', details: { userId: p.userId } });
        return { ok: true };
      });

      // Справочники amo для настроек: воронки, этапы, типы задач.
      api.get('/amo/dictionaries', async (req, reply) => {
        const accountId = principal(req).accountId;
        const account = await deps.accounts.get(accountId);
        if (!account || account.uninstalledAt) return reply.code(409).send({ error: 'not_installed' });
        const client = new AmoApiClient(account.accountDomain, () => deps.tokenService.getAccessToken(accountId), deps.fetch);
        const [pipelines, taskTypes] = await Promise.all([client.getPipelines(), client.getTaskTypes()]);
        return { pipelines, taskTypes };
      });

      // Каталог.
      api.get('/catalog', async (req) => deps.catalog.stats(principal(req).accountId));

      api.post('/catalog/import', async (req, reply) => {
        if (!requireAdmin(req, reply)) return;
        const accountId = principal(req).accountId;
        const { settings } = await deps.settings.get(accountId);
        if (!settings.catalog.feedUrl) return reply.code(400).send({ error: 'no_feed_url' });
        // Импорт может идти долго — выполняем в фоне, статус виден в GET /catalog.
        void deps.importer
          .importFromUrl(accountId, settings.catalog.feedUrl)
          .then((r) => deps.journal.add({ accountId, kind: 'import', summary: `Каталог обновлён: ${r.products} товаров` }))
          .catch((err: Error) =>
            deps.journal.add({ accountId, kind: 'error', summary: `Импорт каталога: ${err.message}` }).catch(() => undefined),
          );
        return reply.code(202).send({ started: true });
      });

      // База знаний.
      api.get('/knowledge', async (req) => ({ items: await deps.knowledge.list(principal(req).accountId) }));

      api.post('/knowledge', async (req, reply) => {
        if (!requireAdmin(req, reply)) return;
        const p = principal(req);
        const b = knowledgeBody.safeParse(req.body);
        if (!b.success) return reply.code(400).send({ error: 'invalid', issues: b.error.issues });
        try {
          const id =
            b.data.kind === 'faq'
              ? await deps.knowledge.addFaq(p.accountId, b.data.question, b.data.answer, p.userId)
              : b.data.kind === 'text'
                ? await deps.knowledge.addText(p.accountId, b.data.title, b.data.content, null, p.userId)
                : await deps.knowledge.addUrl(p.accountId, b.data.url, p.userId);
          return { id };
        } catch (err) {
          return reply.code(422).send({ error: 'cannot_add', message: (err as Error).message });
        }
      });

      api.delete('/knowledge/:id', async (req, reply) => {
        if (!requireAdmin(req, reply)) return;
        const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
        const ok = await deps.knowledge.remove(principal(req).accountId, id);
        return ok ? { ok } : reply.code(404).send({ error: 'not_found' });
      });

      // Песочница: реальный каталог и база знаний, CRM — тестовая сделка, клиенту ничего не уходит.
      api.post('/sandbox', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
        if (!deps.orchestrator) return reply.code(503).send({ error: 'llm_not_configured' });
        const p = principal(req);
        const b = sandboxBody.safeParse(req.body);
        if (!b.success) return reply.code(400).send({ error: 'invalid', issues: b.error.issues });
        const last = b.data.messages.at(-1);
        if (last?.role !== 'client') return reply.code(400).send({ error: 'last_must_be_client' });

        let settings: WidgetSettings = (await deps.settings.get(p.accountId)).settings;
        if (b.data.settings !== undefined) {
          const draft = widgetSettingsSchema.safeParse(b.data.settings);
          if (!draft.success) return reply.code(400).send({ error: 'invalid_settings', issues: draft.error.issues });
          settings = draft.data;
        }
        const crm = new SandboxCrm();
        const memory = new InMemoryMemory();
        const { rules } = await deps.pricing.get(p.accountId);
        const result = await deps.orchestrator.runTurn({
          settings,
          history: b.data.messages.slice(0, -1),
          incoming: [last.text],
          ctx: { accountId: p.accountId, catalog: deps.catalog, knowledge: deps.knowledge, crm, memory, pricing: rules, tasks: settings.tasks },
          tools: PHASE2_TOOLS,
          dynamic: { pricing: pricingCodesHint(rules) },
        });
        const costRub = result.cost.usd * settings.billing.usdRubRate;
        await deps.journal.add({
          accountId: p.accountId,
          kind: 'sandbox',
          summary: result.kind === 'reply' ? result.text : `Песочница: ${result.kind}`,
          details: { toolCalls: result.toolCalls, sources: result.sources, rejections: result.rejections, userId: p.userId },
          inputTokens: result.cost.inputTokens,
          outputTokens: result.cost.outputTokens,
          costUsd: result.cost.usd,
          costRub,
        });
        return {
          kind: result.kind,
          text:
            result.kind === 'reply'
              ? result.text
              : result.kind === 'handoff'
                ? settings.behavior.handoffPhrase
                : null,
          handoff: result.kind === 'handoff' ? result.handoff : null,
          blockedReason: result.kind === 'blocked' ? result.reason : null,
          toolCalls: result.toolCalls,
          sources: result.sources,
          rejections: result.rejections,
          notes: crm.notes,
          tasks: crm.tasks,
          memory: await memory.get(),
          calculation: result.calculation ?? null,
          model: result.model,
          cost: { usd: result.cost.usd, rub: costRub, inputTokens: result.cost.inputTokens, outputTokens: result.cost.outputTokens },
        };
      });

      widgetPhase2Routes(api, deps, principal, requireAdmin);
      widgetEmailRoutes(api, deps, principal, requireAdmin);
    },
    { prefix: '/widget/v1' },
  );
}
