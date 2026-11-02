import { disposableTokenAudience, verifyDisposableToken, type WidgetPrincipal } from '@core/amo';
import { amoRedirectUri } from '@core/shared';
import { imapConfigFor, optSettingsSchema, resolveOptRoute } from '@opt/kp';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.ts';
import { kbPriceRoutes, kbRoutes } from './kb.ts';
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

/**
 * Утверждения JWT без проверки подписи — только для диагностики 401 (RFD-AI-AGENT-OPT-WIDGET-401):
 * по client_uuid видно, ключом какой интеграции amo подписал токен (опта или розницы), по aud — для какого
 * адреса. Сам токен, подпись и секрет наружу не отдаются.
 */
export function decodeTokenClaims(token: string): { client_uuid?: string; aud?: unknown; iss?: string; exp?: number; jti?: string } | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const raw = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
    return {
      client_uuid: typeof raw.client_uuid === 'string' ? raw.client_uuid : undefined,
      aud: raw.aud,
      iss: typeof raw.iss === 'string' ? raw.iss : undefined,
      exp: typeof raw.exp === 'number' ? raw.exp : undefined,
      jti: typeof raw.jti === 'string' ? raw.jti : undefined,
    };
  } catch {
    return null;
  }
}

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
          // Диагностика без секретов: чей client_uuid в токене и совпадает ли он с AMO_CLIENT_ID опта.
          const c = decodeTokenClaims(token);
          req.log.warn(
            {
              err: (err as Error).message,
              clientUuid: c?.client_uuid ?? null,
              sameClientId: c?.client_uuid === deps.env.AMO_CLIENT_ID,
              aud: c?.aud ?? null,
              expectedAud: audience,
              iss: c?.iss ?? null,
              exp: c?.exp ? new Date(c.exp * 1000).toISOString() : null,
              jti: c?.jti ?? null,
              secretLength: deps.env.AMO_CLIENT_SECRET.length,
            },
            'widget: невалидный токен',
          );
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

      /**
       * KP-SENT-COPY: «Проверить IMAP» — вход в ящик отправки КП (IMAP по домену SMTP, логин и пароль SMTP) и папка
       * отправленных: заданная (sentFolder из тела или настроек) или найденная по признаку \Sent / имени.
       */
      api.post('/settings/imap-test', async (req, reply) => {
        if (!requireAdmin(req, reply)) return;
        const b = z.object({ sentFolder: z.string().max(200).optional() }).safeParse(req.body ?? {});
        if (!b.success) return reply.code(400).send({ error: 'bad_body' });
        const p = principal(req);
        const m = (await deps.settings.get(p.accountId)).settings.mail;
        const password = await deps.secrets.get(p.accountId, 'smtp');
        if (!m.smtpHost || !m.username || !password) return reply.code(409).send({ error: 'mail_off', message: 'Заполните SMTP-сервер, логин и пароль и сохраните' });
        const cfg = imapConfigFor(m, password);
        const want = (b.data.sentFolder ?? m.sentFolder ?? '').trim() || null;
        try {
          const r = await deps.sentCopier.probe(cfg, want);
          const exists = r.folder !== null && r.folders.some((f) => f.toLowerCase() === r.folder?.toLowerCase());
          return { ok: Boolean(r.folder) && exists, host: `${cfg.host}:${cfg.port}`, username: cfg.username, folder: r.folder, how: r.how, exists, folders: r.folders };
        } catch (err) {
          return { ok: false, host: `${cfg.host}:${cfg.port}`, username: cfg.username, error: (err as Error).message };
        }
      });

      llmRoutes(api, deps, principal, requireAdmin);
      kpRoutes(api, deps, principal, requireAdmin);
      kbRoutes(api, deps, principal, requireAdmin);
      kbPriceRoutes(api, deps, principal, requireAdmin);
    },
    { prefix: '/widget/v1' },
  );
}
