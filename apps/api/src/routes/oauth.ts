import { createHmac, timingSafeEqual } from 'node:crypto';
import { AmoApiClient, normalizeAccountDomain } from '@ai-door/amo';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.ts';
import { createState, verifyState } from '../oauth-state.ts';

const callbackQuery = z.object({
  code: z.string().min(1).optional(),
  referer: z.string().min(1).optional(),
  state: z.string().optional(),
  client_id: z.string().optional(),
  from_widget: z.string().optional(),
  error: z.string().optional(),
});

const disconnectQuery = z.object({
  account_id: z.coerce.number().int().positive(),
  client_uuid: z.string(),
  signature: z.string(),
});

function page(reply: FastifyReply, status: number, title: string, text: string) {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return reply
    .code(status)
    .type('text/html; charset=utf-8')
    .send(
      `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>` +
        `<body style="font-family:sans-serif;padding:32px"><h2>${esc(title)}</h2><p>${esc(text)}</p></body>`,
    );
}

export function oauthRoutes(app: FastifyInstance, deps: Deps) {
  const { env } = deps;

  /** Ручной запуск авторизации (если интеграцию подключают не из карточки виджета). */
  app.get('/oauth/amo/start', async (_req, reply) => {
    const url = new URL('https://www.amocrm.ru/oauth');
    url.searchParams.set('client_id', env.AMO_CLIENT_ID);
    url.searchParams.set('state', createState(env.AMO_CLIENT_SECRET));
    url.searchParams.set('mode', 'popup');
    return reply.redirect(url.toString());
  });

  /** Redirect URI интеграции: amo передаёт сюда code и referer (домен аккаунта). */
  app.get('/oauth/amo/callback', async (req, reply) => {
    const q = callbackQuery.safeParse(req.query);
    if (!q.success) return page(reply, 400, 'Ошибка подключения', 'Некорректные параметры запроса.');
    const { code, referer, state, client_id: clientId, from_widget: fromWidget, error } = q.data;

    if (error) return page(reply, 400, 'Доступ не предоставлен', 'Авторизация в amoCRM была отменена.');
    if (!code || !referer) return page(reply, 400, 'Ошибка подключения', 'Не переданы code или referer.');
    if (clientId && clientId !== env.AMO_CLIENT_ID) {
      return page(reply, 400, 'Ошибка подключения', 'Код выдан для другой интеграции.');
    }
    // При установке из виджета amo не передаёт наш state. Code в этом случае
    // обменивается только вместе с client_secret, поэтому подделать его нельзя.
    if (!fromWidget && !(state && verifyState(env.AMO_CLIENT_SECRET, state))) {
      return page(reply, 400, 'Ошибка подключения', 'Неверный или просроченный параметр state.');
    }
    const accountDomain = normalizeAccountDomain(referer, env.AMO_ALLOWED_DOMAINS);
    if (!accountDomain) {
      req.log.warn({ referer }, 'oauth callback: недопустимый referer');
      return page(reply, 400, 'Ошибка подключения', 'Недопустимый домен аккаунта.');
    }

    try {
      const pair = await deps.oauth.exchangeCode(accountDomain, code);
      const account = await new AmoApiClient(accountDomain, async () => pair.accessToken, deps.fetch).getAccount();
      await deps.accounts.upsertInstalled({
        id: account.id,
        subdomain: account.subdomain,
        accountDomain,
        name: account.name,
      });
      await deps.tokens.put(account.id, pair);
      req.log.info({ accountId: account.id, accountDomain }, 'amo: интеграция подключена');
      return page(reply, 200, 'Интеграция подключена', `Аккаунт ${account.subdomain} подключён к AI-агенту.`);
    } catch (err) {
      req.log.error({ err, accountDomain }, 'amo: ошибка обмена кода');
      await deps.alerter.alert(`amo ${accountDomain}: не удалось подключить интеграцию`).catch(() => undefined);
      return page(reply, 502, 'Ошибка подключения', 'amoCRM не принял код авторизации. Попробуйте ещё раз.');
    }
  });

  /**
   * Хук отключения интеграции. Формат (account_id, client_uuid, signature =
   * HMAC-SHA256(client_uuid|account_id, client_secret)) нужно сверить с актуальной
   * документацией amo при установке: сайт документации недоступен из среды разработки.
   */
  app.get('/oauth/amo/disconnect', async (req, reply) => {
    const q = disconnectQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_request' });
    const { account_id: accountId, client_uuid: clientUuid, signature } = q.data;
    const expected = createHmac('sha256', env.AMO_CLIENT_SECRET).update(`${clientUuid}|${accountId}`).digest('hex');
    const valid =
      clientUuid === env.AMO_CLIENT_ID &&
      signature.length === expected.length &&
      timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    if (!valid) return reply.code(401).send({ error: 'invalid_signature' });
    await deps.accounts.markUninstalled(accountId);
    req.log.info({ accountId }, 'amo: интеграция отключена');
    return reply.code(200).send({ ok: true });
  });
}
