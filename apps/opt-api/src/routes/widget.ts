import { disposableTokenAudience, verifyDisposableToken, type WidgetPrincipal } from '@core/amo';
import { amoRedirectUri } from '@core/shared';
import { optSettingsSchema, resolveOptRoute } from '@opt/kp';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.ts';
import { knowledgeRoutes } from './knowledge.ts';
import { kpRoutes } from './kp.ts';
import { llmRoutes } from './llm.ts';

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

const journalQuery = z.object({
  leadId: z.coerce.number().int().positive().optional(),
  kind: z.string().max(20).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** API виджета «Агент опт». Авторизация — одноразовый токен amo в X-Auth-Token, подписанный ключами интеграции опта. */
export function widgetRoutes(app: FastifyInstance, deps: Deps) {
  const audience = disposableTokenAudience(amoRedirectUri(deps.env));

  app.register(
    async (api) => {
      api.addHook('preHandler', async (req, reply) => {
        const token = req.headers['x-auth-token'];
        if (typeof token !== 'string' || !token) return reply.code(401).send({ error: 'no_token' });
        try {
          req.principal = await verifyDisposableToken(token, { clientSecret: deps.env.AMO_CLIENT_SECRET, clientId: deps.env.AMO_CLIENT_ID, audience });
        } catch (err) {
          req.log.warn({ err: (err as Error).message }, 'widget: невалидный токен');
          return reply.code(401).send({ error: 'invalid_token' });
        }
      });

      api.get('/status', async (req) => {
        const p = principal(req);
        const [account, token, { settings }, spend, kp, ai] = await Promise.all([
          deps.accounts.get(p.accountId),
          deps.tokens.status(p.accountId),
          deps.settings.get(p.accountId),
          deps.journal.spentSummary(p.accountId),
          deps.kp.getSettings(p.accountId),
          deps.ai(p.accountId),
        ]);
        const route = resolveOptRoute(settings);
        return {
          accountId: p.accountId,
          isAdmin: p.isAdmin,
          connected: Boolean(account && !account.uninstalledAt && token && !token.lastError),
          tokenExpiresAt: token?.expiresAt ?? null,
          tokenError: token?.lastError ?? null,
          llmConfigured: ai !== null,
          llm: { provider: route.primary.provider, model: route.primary.model, fallback: route.fallback, providers: ai?.providers ?? [] },
          mailConfigured: Boolean(settings.mail.smtpHost && settings.mail.username && (await deps.secrets.has(p.accountId, 'smtp'))),
          templateLoaded: Boolean(kp.templatePath),
          spend,
        };
      });

      api.get('/journal', async (req, reply) => {
        const q = journalQuery.safeParse(req.query);
        if (!q.success) return reply.code(400).send({ error: 'bad_query' });
        return { items: await deps.journal.list(principal(req).accountId, q.data) };
      });

      api.get('/settings', async (req) => deps.settings.get(principal(req).accountId));

      // Схема strict: неизвестный ключ — 400, а не молчаливая потеря (порядок деплоя: код, потом настройки).
      api.put('/settings', async (req, reply) => {
        if (!requireAdmin(req, reply)) return;
        const b = optSettingsSchema.safeParse(req.body);
        if (!b.success) return reply.code(400).send({ error: 'invalid_settings', issues: b.error.issues });
        const p = principal(req);
        const { version } = await deps.settings.save(p.accountId, p.userId, b.data);
        await deps.journal.add({ accountId: p.accountId, kind: 'note', summary: `Настройки опта сохранены (версия ${version})`, details: { userId: p.userId, audit: 'settings' } });
        return { settings: b.data, version };
      });

      // Пароль SMTP ящика для отправки КП (ТЗ 6.6): в account_secrets (kind = smtp), обратно не отдаётся.
      api.put('/settings/smtp-password', async (req, reply) => {
        if (!requireAdmin(req, reply)) return;
        const b = z.object({ password: z.string().min(1).max(500) }).safeParse(req.body);
        if (!b.success) return reply.code(400).send({ error: 'bad_body' });
        const p = principal(req);
        await deps.secrets.set(p.accountId, 'smtp', b.data.password, p.userId);
        await deps.journal.add({ accountId: p.accountId, kind: 'note', summary: 'Пароль SMTP для отправки КП обновлён', details: { userId: p.userId, audit: 'smtp' } });
        return { ok: true };
      });

      llmRoutes(api, deps, principal, requireAdmin);
      kpRoutes(api, deps, principal, requireAdmin);
      knowledgeRoutes(api, deps, principal, requireAdmin);
    },
    { prefix: '/widget/v1' },
  );
}
