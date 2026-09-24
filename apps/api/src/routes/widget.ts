import { disposableTokenAudience, verifyDisposableToken, type WidgetPrincipal } from '@ai-door/amo';
import { widgetSettingsSchema } from '@ai-door/db';
import { amoRedirectUri } from '@ai-door/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
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

/** API для фронтенда виджета. Авторизация — одноразовый токен amo в X-Auth-Token. */
export function widgetRoutes(app: FastifyInstance, deps: Deps) {
  const audience = disposableTokenAudience(amoRedirectUri(deps.env));

  app.register(async (api) => {
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
      const [account, token, { settings }] = await Promise.all([
        deps.accounts.get(p.accountId),
        deps.tokens.status(p.accountId),
        deps.settings.get(p.accountId),
      ]);
      const connected = Boolean(account && !account.uninstalledAt && token && !token.lastError);
      return {
        accountId: p.accountId,
        connected,
        tokenExpiresAt: token?.expiresAt ?? null,
        tokenError: token?.lastError ?? null,
        enabled: settings.enabled,
        mode: settings.mode,
      };
    });

    api.get('/settings', async (req) => {
      const { settings, version } = await deps.settings.get(principal(req).accountId);
      return { settings, version };
    });

    api.put('/settings', async (req, reply) => {
      const p = principal(req);
      if (!p.isAdmin) return reply.code(403).send({ error: 'admin_only' });
      const parsed = widgetSettingsSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_settings', issues: parsed.error.issues });
      if (!(await deps.accounts.get(p.accountId))) return reply.code(409).send({ error: 'not_installed' });
      const { version } = await deps.settings.save(p.accountId, p.userId, parsed.data);
      return { settings: parsed.data, version };
    });

    api.get('/leads/:leadId/panel', async (req) => {
      const { leadId } = z.object({ leadId: z.coerce.number().int().positive() }).parse(req.params);
      const { settings } = await deps.settings.get(principal(req).accountId);
      // Фаза 0: панель-заглушка. Подсказки, товары, расчёты и журнал — в фазах 1–3.
      return { leadId, ai: { mode: settings.mode, paused: false }, hints: [], products: [], calculations: [], log: [] };
    });
  }, { prefix: '/widget/v1' });
}
