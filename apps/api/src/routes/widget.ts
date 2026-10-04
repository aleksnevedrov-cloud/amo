import { detectFormat, extract } from '@ai-door/docs';
import { resolveRoute, type Orchestrator, type TurnResult } from '@ai-door/agent';
import { InMemoryMemory, PHASE2_TOOLS, pricingCodesHint, SandboxCrm, type Source } from '@ai-door/tools';
import { widgetDocsRoutes } from './widget-docs.ts';
import { widgetEmailRoutes } from './widget-email.ts';
import { widgetWazzupRoutes } from './widget-wazzup.ts';
import { widgetLlmRoutes } from './widget-llm.ts';
import { widgetPhase4Routes } from './widget-phase4.ts';
import { widgetPhase2Routes } from './widget-phase2.ts';
import { AmoApiClient, disposableTokenAudience, verifyDisposableToken, type WidgetPrincipal } from '@ai-door/amo';
import { feedUrlsOf, llmModelRefSchema, widgetSettingsSchema, type JournalRow, type WidgetSettings, formatWazzupHistory, normalizePhone } from '@ai-door/db';
import { PROVIDERS, type ChatRoute } from '@ai-door/llm';
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

/** Файл для базы знаний: содержимое в base64, как у документов сделки. */
const knowledgeFileBody = z.object({
  name: z.string().min(1).max(200),
  mime: z.string().max(120).default('application/octet-stream'),
  file: z.string().min(1),
});
const KNOWLEDGE_FILE_FORMATS = new Set(['pdf', 'docx', 'xlsx', 'text']);

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
  /** Провайдер и модель для этого прогона (иначе — из настроек). */
  model: llmModelRefSchema.optional(),
  /** Телефон клиента — подтянуть переписку из Wazzup как в боевом контексте (RFD-AI-AGENT-WAZZUP-HISTORY). */
  phone: z.string().max(32).optional(),
});

const compareBody = sandboxBody.omit({ model: true }).extend({
  /** Две модели для сравнения рядом (раздел 7 ТЗ 1.1.0). */
  models: z.array(llmModelRefSchema).min(1).max(2),
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
        const ai = await deps.ai(p.accountId);
        // Здоровье интеграции LLM (раздел 4 ТЗ): модель пропала из списка провайдера, ответы через резервную, ошибки.
        const cache = ai ? await deps.modelsCache.get<{ id: string }>(p.accountId, settings.model.provider).catch(() => null) : null;
        const missing = cache?.models.length && !cache.models.some((m) => m.id === settings.model.model) ? [settings.model.model] : [];
        const recentErrors = await deps.journal.list(p.accountId, { kind: 'error', limit: 5 });
        return {
          accountId: p.accountId,
          isAdmin: p.isAdmin,
          connected,
          tokenExpiresAt: token?.expiresAt ?? null,
          tokenError: token?.lastError ?? null,
          enabled: settings.enabled,
          mode: settings.mode,
          llmConfigured: ai !== null && ai.providers.includes(settings.model.provider),
          llm: {
            provider: settings.model.provider,
            model: settings.model.model,
            fallback: resolveRoute(settings).fallback,
            providers: ai?.providers ?? [],
            missingModels: missing,
            lastError: recentErrors.find((e) => (e.details as { modelMissing?: boolean; provider?: string }).modelMissing || (e.details as { attempts?: unknown }).attempts) ?? null,
          },
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
        // Смена провайдера без сохранённого ключа не применяется (раздел 3 ТЗ 1.1.0).
        const prev = (await deps.settings.get(p.accountId)).settings;
        const next = parsed.data;
        if (next.model.provider !== prev.model.provider) {
          const ai = await deps.ai(p.accountId);
          if (!ai?.providers.includes(next.model.provider)) return reply.code(409).send({ error: 'no_key', provider: next.model.provider, message: `Введите ключ ${PROVIDERS[next.model.provider].label.split(' ')[0]}` });
        }
        const { version } = await deps.settings.save(p.accountId, p.userId, next);
        if (next.model.provider !== prev.model.provider || next.model.model !== prev.model.model || next.model.fallbackModel !== prev.model.fallbackModel || next.model.fallbackProvider !== prev.model.fallbackProvider) {
          await deps.journal.add({
            accountId: p.accountId,
            kind: 'note',
            summary: `Модель по умолчанию: ${PROVIDERS[next.model.provider].short} · ${next.model.model}${next.model.fallbackModel ? ` (резерв: ${next.model.fallbackModel})` : ''}`,
            details: { userId: p.userId, audit: 'llm.model', provider: next.model.provider, model: next.model.model, before: prev.model, after: next.model },
          });
        }
        return { settings: next, version };
      });

      api.get('/journal', async (req, reply) => {
        const q = journalQuery.safeParse(req.query);
        if (!q.success) return reply.code(400).send({ error: 'bad_query' });
        return { items: await deps.journal.list(principal(req).accountId, q.data) };
      });

      // Панель в карточке сделки (раздел 11 ТЗ 1.1.0): статус, модель, черновики, товары, расчёт, файлы, задачи, резюме, журнал.
      api.get('/leads/:leadId/panel', async (req) => {
        const { leadId } = leadParams.parse(req.params);
        const accountId = principal(req).accountId;
        const [{ settings }, state, log, suggestions, attachments, documents, ai] = await Promise.all([
          deps.settings.get(accountId),
          deps.dialog.state(accountId, leadId),
          deps.journal.list(accountId, { leadId, limit: 40 }),
          deps.suggestions.listForLead(accountId, leadId, 10),
          deps.dialog.attachments(accountId, leadId, 20).catch(() => []),
          deps.documents.listForLead(accountId, leadId, 20).catch(() => []),
          deps.ai(accountId),
        ]);
        const lastCalc = log.find((e) => (e.details as { calculation?: unknown }).calculation);
        const lastReply = log.find((e) => e.kind === 'reply' || e.kind === 'handoff' || e.kind === 'draft' || e.kind === 'hint');
        const sources = ((lastReply?.details as { sources?: Source[] } | undefined)?.sources ?? []).filter((x) => x.type === 'product');
        const products = await Promise.all(
          sources.slice(0, 10).map(async (src) => {
            const pr = await deps.catalog.get(accountId, src.id).catch(() => null);
            return { ...src, title: pr?.name ?? src.title, url: pr?.url ?? src.url ?? null, price: pr?.price ?? null, available: pr?.available ?? null, picture: pr?.picture ?? null, category: pr?.category ?? null };
          }),
        );
        const route = resolveRoute(settings, { lead: state.llm });
        const daily = settings.limits.dailyRub !== null ? await deps.journal.spentTodayRub(accountId) : 0;
        const lastSummary = log.find((e) => e.kind === 'summary');
        const lastErrorEntry = log.find((e) => e.kind === 'error');
        return {
          leadId,
          // Права текущего пользователя: смену модели показываем только администратору.
          isAdmin: principal(req).isAdmin,
          ai: { enabled: settings.enabled, mode: settings.mode, paused: state.paused, pauseReason: state.pauseReason, pausedAt: state.pausedAt },
          llm: {
            provider: route.primary.provider,
            model: route.primary.model,
            fallback: route.fallback,
            override: state.llm,
            providers: ai?.providers ?? [],
            configured: ai !== null && ai.providers.includes(route.primary.provider),
          },
          health: {
            llmConfigured: ai !== null && ai.providers.includes(route.primary.provider),
            dailyLimitExhausted: settings.limits.dailyRub !== null && daily >= settings.limits.dailyRub,
            lastError: lastErrorEntry ? { summary: lastErrorEntry.summary, createdAt: lastErrorEntry.createdAt } : null,
          },
          hints: suggestions.filter((x) => x.status === 'pending'),
          products,
          calculations: lastCalc ? [(lastCalc.details as { calculation: unknown }).calculation] : [],
          files: filesOf(attachments, documents, log),
          tasks: tasksOf(log),
          summary: lastSummary ? { text: lastSummary.summary, createdAt: lastSummary.createdAt } : null,
          log: log.map((e) => ({ id: e.id, kind: e.kind, summary: e.summary, costRub: e.costRub, createdAt: e.createdAt, ...modelOf(e) })),
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
        const [pipelines, taskTypes, users] = await Promise.all([client.getPipelines(), client.getTaskTypes(), client.listUsers().catch(() => [])]);
        return { pipelines, taskTypes, users };
      });

      // Каталог.
      api.get('/catalog', async (req) => deps.catalog.stats(principal(req).accountId));

      api.post('/catalog/import', async (req, reply) => {
        if (!requireAdmin(req, reply)) return;
        const accountId = principal(req).accountId;
        const { settings } = await deps.settings.get(accountId);
        const feedUrls = feedUrlsOf(settings);
        if (!feedUrls.length) return reply.code(400).send({ error: 'no_feed_url' });
        // Импорт может идти долго — выполняем в фоне, статус виден в GET /catalog.
        void deps.importer
          .importFromUrls(accountId, feedUrls)
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

      // Файл в базу знаний: PDF, DOCX, XLSX, TXT. Текст извлекает packages/docs, индексирует knowledge.
  api.post('/knowledge/file', { bodyLimit: 30 * 1024 * 1024 }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const p = principal(req);
    const b = knowledgeFileBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid', issues: b.error.issues });
    const bytes = new Uint8Array(Buffer.from(b.data.file, 'base64'));
    if (!bytes.byteLength) return reply.code(400).send({ error: 'bad_file' });
    const format = detectFormat(b.data.mime, b.data.name);
    if (!KNOWLEDGE_FILE_FORMATS.has(format)) {
      return reply.code(422).send({ error: 'cannot_add', message: 'Поддерживаются PDF, DOCX, XLSX и TXT' });
    }
    try {
      const ex = await extract(bytes, b.data.mime, b.data.name);
      if (ex.needsOcr) return reply.code(422).send({ error: 'cannot_add', message: 'В файле нет текстового слоя — это скан. Загрузите текстовую версию.' });
      const id = await deps.knowledge.addFile(p.accountId, b.data.name, ex.text, p.userId);
      return { id, chars: ex.text.length, pages: ex.pages };
    } catch (err) {
      return reply.code(422).send({ error: 'cannot_add', message: (err as Error).message });
    }
  });

  // Перечитать статью по ссылке — когда на сайте поменялся текст.
  api.post('/knowledge/:id/refresh', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const p = principal(req);
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    try {
      return { id: await deps.knowledge.refreshUrl(p.accountId, id, p.userId) };
    } catch (err) {
      return reply.code(422).send({ error: 'cannot_refresh', message: (err as Error).message });
    }
  });

  // Песочница: реальный каталог и база знаний, CRM — тестовая сделка, клиенту ничего не уходит.
      api.post('/sandbox', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
        const p = principal(req);
        const ai = await deps.ai(p.accountId);
        if (!ai) return reply.code(503).send({ error: 'llm_not_configured' });
        const b = sandboxBody.safeParse(req.body);
        if (!b.success) return reply.code(400).send({ error: 'invalid', issues: b.error.issues });
        const last = b.data.messages.at(-1);
        if (last?.role !== 'client') return reply.code(400).send({ error: 'last_must_be_client' });
        const settings = await sandboxSettings(deps, p.accountId, b.data.settings, reply);
        if (!settings) return;
        const route = b.data.model ? { primary: b.data.model, fallback: resolveRoute(settings).fallback } : resolveRoute(settings);
        const { rules } = await deps.pricing.get(p.accountId);
        const messenger = await sandboxMessenger(deps, p.accountId, b.data.phone, b.data.messages);
      return runSandbox(deps, p, ai.orchestrator, settings, rules, b.data.messages, route, false, messenger);
      });

      // Сравнение двух моделей на одном диалоге: ответы, инструменты, токены, стоимость и время рядом (раздел 7 ТЗ 1.1.0).
      api.post('/sandbox/compare', { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } }, async (req, reply) => {
        const p = principal(req);
        const ai = await deps.ai(p.accountId);
        if (!ai) return reply.code(503).send({ error: 'llm_not_configured' });
        const b = compareBody.safeParse(req.body);
        if (!b.success) return reply.code(400).send({ error: 'invalid', issues: b.error.issues });
        const last = b.data.messages.at(-1);
        if (last?.role !== 'client') return reply.code(400).send({ error: 'last_must_be_client' });
        const settings = await sandboxSettings(deps, p.accountId, b.data.settings, reply);
        if (!settings) return;
        const { rules } = await deps.pricing.get(p.accountId);
        const results = await Promise.all(
          b.data.models.map(async (model) => {
            if (!ai.providers.includes(model.provider)) return { model, error: `Нет ключа ${PROVIDERS[model.provider].label}` };
            try {
              const r = await runSandbox(deps, p, ai.orchestrator, settings, rules, b.data.messages, { primary: model, fallback: null }, true);
              return { ...r, model };
            } catch (err) {
              return { model, error: (err as Error).message };
            }
          }),
        );
        return { results };
      });

      widgetLlmRoutes(api, deps, principal, requireAdmin);
      widgetPhase2Routes(api, deps, principal, requireAdmin);
      widgetEmailRoutes(api, deps, principal, requireAdmin);
      widgetWazzupRoutes(api, deps, principal, requireAdmin);
      widgetDocsRoutes(api, deps, principal);
      widgetPhase4Routes(api, deps, principal, requireAdmin);
    },
    { prefix: '/widget/v1' },
  );
}

async function sandboxSettings(deps: Deps, accountId: number, draft: unknown, reply: FastifyReply): Promise<WidgetSettings | null> {
  let settings: WidgetSettings = (await deps.settings.get(accountId)).settings;
  if (draft !== undefined) {
    const parsed = widgetSettingsSchema.safeParse(draft);
    if (!parsed.success) {
      void reply.code(400).send({ error: 'invalid_settings', issues: parsed.error.issues });
      return null;
    }
    settings = parsed.data;
  }
  return settings;
}

/** Песочница: история Wazzup по телефону — тот же блок, что в боевом контексте (без собственных реплик AI из диалога). */
async function sandboxMessenger(
  deps: Deps,
  accountId: number,
  phoneRaw: string | undefined,
  messages: { role: 'client' | 'ai'; text: string }[],
): Promise<{ text: string | null; count: number } | null> {
  const phone = normalizePhone(phoneRaw);
  if (!phone) return null;
  const items = await deps.wazzup.historyByPhone(accountId, phone, 40);
  const own = new Set(messages.filter((m) => m.role === 'ai').map((m) => m.text.trim()));
  return formatWazzupHistory(items, own);
}

async function runSandbox(
  deps: Deps,
  p: WidgetPrincipal,
  orchestrator: Orchestrator,
  settings: WidgetSettings,
  rules: Awaited<ReturnType<Deps['pricing']['get']>>['rules'],
  messages: { role: 'client' | 'ai'; text: string }[],
  route: ChatRoute,
  compare = false,
  messenger: { text: string | null; count: number } | null = null,
) {
  const crm = new SandboxCrm();
  const memory = new InMemoryMemory();
  const last = messages.at(-1) as { text: string };
  const started = Date.now();
  const result: TurnResult = await orchestrator.runTurn({
    settings,
    history: messages.slice(0, -1),
    incoming: [last.text],
    ctx: { accountId: p.accountId, catalog: deps.catalog, knowledge: deps.knowledge, crm, memory, pricing: rules, tasks: settings.tasks },
    tools: PHASE2_TOOLS,
    dynamic: { pricing: pricingCodesHint(rules), messenger: messenger?.text ?? null },
    route,
  });
  const costRub = result.cost.usd * settings.billing.usdRubRate;
  await deps.journal.add({
    accountId: p.accountId,
    kind: 'sandbox',
    summary: result.kind === 'reply' ? result.text : `Песочница: ${result.kind}`,
    details: { wazzupMessages: messenger?.count ?? 0, toolCalls: result.toolCalls, sources: result.sources, rejections: result.rejections, userId: p.userId, provider: result.provider, model: result.model, requestedModel: result.requestedModel, fallbackUsed: result.fallbackUsed, latencyMs: result.latencyMs, ...(compare ? { compare: true } : {}) },
    inputTokens: result.cost.inputTokens,
    outputTokens: result.cost.outputTokens,
    costUsd: result.cost.usd,
    costRub,
  });
  return {
    kind: result.kind,
    text: result.kind === 'reply' ? result.text : result.kind === 'handoff' ? settings.behavior.handoffPhrase : null,
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
    provider: result.provider,
    requestedModel: result.requestedModel,
    fallbackUsed: result.fallbackUsed,
    latencyMs: result.latencyMs,
    totalMs: Date.now() - started,
    cost: { usd: result.cost.usd, rub: costRub, inputTokens: result.cost.inputTokens, outputTokens: result.cost.outputTokens },
  };
}

/** Провайдер и модель записи журнала (ответы, черновики, подсказки, резюме, песочница). */
function modelOf(e: JournalRow): { provider?: string; model?: string; fallbackUsed?: boolean } {
  const d = e.details as { provider?: string; model?: string; fallbackUsed?: boolean; fallback?: boolean };
  if (!d.model) return {};
  return { provider: d.provider ?? 'anthropic', model: d.model, ...(d.fallbackUsed || d.fallback ? { fallbackUsed: true } : {}) };
}

type Attachment = { id: number; url: string; type: string | null; text: string; receivedAt: Date; processed: boolean };
type Doc = { id: number; filename: string | null; kind: string; data: Record<string, unknown>; createdAt: Date };

/** Файлы клиента из чата сделки со статусом разбора (блок 8 раздела 11 ТЗ). */
function filesOf(attachments: Attachment[], documents: Doc[], log: JournalRow[]) {
  const nameOf = (url: string) => decodeURIComponent(new URL(url, 'https://x').pathname.split('/').pop() ?? '') || 'файл';
  const items = attachments.map((a) => {
    const name = nameOf(a.url);
    const doc = documents.find((d) => d.filename === name && d.createdAt >= a.receivedAt) ?? documents.find((d) => d.filename === name);
    const failed = !doc && log.find((e) => e.kind === 'error' && e.summary.startsWith(`Разбор файла «${name}»`) && e.createdAt >= a.receivedAt);
    const data = (doc?.data ?? {}) as { summary?: string; openings?: unknown[]; positions?: unknown[] };
    return {
      id: a.id,
      name,
      type: a.type,
      url: a.url,
      receivedAt: a.receivedAt,
      status: doc ? ('parsed' as const) : failed ? ('error' as const) : a.processed ? ('unparsed' as const) : ('pending' as const),
      documentId: doc?.id ?? null,
      kind: doc?.kind ?? null,
      summary: doc ? (data.summary ?? '') : failed ? failed.summary.replace(/^Разбор файла «[^»]*»: /, '') : '',
      openings: data.openings?.length ?? 0,
      positions: data.positions?.length ?? 0,
    };
  });
  // Файлы, загруженные вручную из карточки (нет в чате).
  for (const d of documents) {
    if (items.some((i) => i.documentId === d.id)) continue;
    const data = d.data as { summary?: string; openings?: unknown[]; positions?: unknown[] };
    items.push({ id: -d.id, name: d.filename ?? 'файл', type: null, url: '', receivedAt: d.createdAt, status: 'parsed', documentId: d.id, kind: d.kind, summary: data.summary ?? '', openings: data.openings?.length ?? 0, positions: data.positions?.length ?? 0 });
  }
  return items.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime()).slice(0, 20);
}

const TASK_LABEL: Record<string, string> = { callback: 'Перезвонить клиенту', send_offer: 'Отправить КП', check_availability: 'Проверить наличие', measure: 'Согласовать замер', other: 'Задача' };

/** Задачи, поставленные AI: из вызовов crm_create_task в журнале и передач менеджеру (блок 9 раздела 11 ТЗ). */
function tasksOf(log: JournalRow[]) {
  const out: { id: string; kind: string; text: string; createdAt: Date; source: 'tool' | 'handoff' }[] = [];
  for (const e of log) {
    const calls = ((e.details as { toolCalls?: { name: string; ok: boolean; input?: { type?: string; text?: string } }[] }).toolCalls ?? []).filter((c) => c.name === 'crm_create_task' && c.ok);
    for (const [i, c] of calls.entries()) {
      const type = c.input?.type ?? 'other';
      out.push({ id: `${e.id}-${i}`, kind: TASK_LABEL[type] ?? type, text: c.input?.text ?? '', createdAt: e.createdAt, source: 'tool' });
    }
    if (e.kind === 'handoff' && (e.details as { reason?: string }).reason) {
      out.push({ id: `${e.id}-h`, kind: 'Передача менеджеру', text: e.summary, createdAt: e.createdAt, source: 'handoff' });
    }
  }
  return out.slice(0, 10);
}
