import { isSafeReturnUrl, verifyBotToken } from '@ai-door/amo';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.ts';

const bodySchema = z.object({
  token: z.string().min(1),
  data: z.record(z.unknown()).default({}),
  return_url: z.string().url(),
});

/**
 * Данные шага виджета в Salesbot. Их формирует виджет (onSalesbotDesignerSave)
 * из плейсхолдеров Salesbot: {{lead.id}}, {{message_text}}.
 */
const dataSchema = z.object({
  lead_id: z.coerce.number().int().positive(),
  message: z.string().max(8000).optional().default(''),
});

/** Приём сообщений клиента из Salesbot (`widget_request`). Отвечаем сразу, обработка — в очереди. */
export function salesbotRoutes(app: FastifyInstance, deps: Deps) {
  app.post(
    '/salesbot/v1/hook',
    { bodyLimit: 256 * 1024, config: { rateLimit: { max: 3000, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = bodySchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'bad_request' });

      let accountId: number;
      try {
        ({ accountId } = await verifyBotToken(body.data.token, { clientSecret: deps.env.AMO_CLIENT_SECRET }));
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, 'salesbot: невалидный токен');
        return reply.code(401).send({ error: 'invalid_token' });
      }
      const account = await deps.accounts.get(accountId);
      if (!account || account.uninstalledAt) return reply.code(404).send({ error: 'not_installed' });
      // На return_url уйдёт access-токен аккаунта — только домен этого аккаунта.
      if (!isSafeReturnUrl(body.data.return_url, account.accountDomain)) {
        return reply.code(400).send({ error: 'bad_return_url' });
      }
      const data = dataSchema.safeParse(body.data.data);
      if (!data.success) return reply.code(400).send({ error: 'bad_data' });

      const text = data.data.message.trim() || '(клиент отправил сообщение без текста — вложение или стикер)';
      await deps.dialog.enqueue(accountId, data.data.lead_id, text, body.data.return_url);
      const { settings } = await deps.settings.get(accountId);
      await deps.schedule({ accountId, leadId: data.data.lead_id }, settings.where.batchWindowSec * 1000);
      return reply.code(200).send({ ok: true });
    },
  );
}
