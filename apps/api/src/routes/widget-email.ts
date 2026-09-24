import type { WidgetPrincipal } from '@ai-door/amo';
import { serverConfig } from '@ai-door/mail';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.ts';

/** Почта: пароль (только запись), проверка подключения, статус опроса. */
export function widgetEmailRoutes(
  api: FastifyInstance,
  deps: Deps,
  principal: (req: FastifyRequest) => WidgetPrincipal,
  requireAdmin: (req: FastifyRequest, reply: FastifyReply) => boolean,
) {
  api.get('/email/status', async (req) => {
    const accountId = principal(req).accountId;
    const [{ settings }, hasPassword, folders] = await Promise.all([
      deps.settings.get(accountId),
      deps.mail.hasPassword(accountId),
      deps.mail.status(accountId),
    ]);
    return { enabled: settings.email.enabled, hasPassword, folders };
  });

  // Пароль приложения почтового ящика. Хранится зашифрованным и обратно не отдаётся.
  api.put('/email/password', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = z.object({ password: z.string().min(1).max(500) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'no_password' });
    const p = principal(req);
    await deps.mail.setPassword(p.accountId, b.data.password, p.userId);
    await deps.journal.add({ accountId: p.accountId, kind: 'note', summary: 'Пароль почтового ящика обновлён', details: { userId: p.userId } });
    return { ok: true };
  });

  // Проверка IMAP и SMTP с сохранёнными настройками и паролем.
  api.post('/email/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const accountId = principal(req).accountId;
    const { settings } = await deps.settings.get(accountId);
    const password = await deps.mail.getPassword(accountId);
    if (!settings.email.imapHost || !settings.email.smtpHost || !settings.email.username) return reply.code(400).send({ error: 'not_configured' });
    if (!password) return reply.code(400).send({ error: 'no_password' });
    const cfg = serverConfig(settings.email, password);
    const result: { imap: string; smtp: string; sentFolder: string | null } = { imap: 'ok', smtp: 'ok', sentFolder: null };
    try {
      const box = await deps.mailConnect(cfg);
      try {
        await box.folderState(settings.email.inboxFolder);
        result.sentFolder = settings.email.sentFolder || (await box.findSentFolder());
      } finally {
        await box.close();
      }
    } catch (err) {
      result.imap = (err as Error).message || 'ошибка подключения';
    }
    try {
      await deps.mailSender(cfg).verify();
    } catch (err) {
      result.smtp = (err as Error).message || 'ошибка подключения';
    }
    return result;
  });
}
