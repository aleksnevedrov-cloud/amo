import type { WidgetPrincipal } from '@core/amo';
import { mailboxConfig, mailboxesOf, serverConfig } from '@retail/mail';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.ts';

/** Почта: пароли ящиков (только запись), проверка подключения, статус опроса по ящикам. */
export function widgetEmailRoutes(
  api: FastifyInstance,
  deps: Deps,
  principal: (req: FastifyRequest) => WidgetPrincipal,
  requireAdmin: (req: FastifyRequest, reply: FastifyReply) => boolean,
) {
  const mailboxId = z.string().min(1).max(40).regex(/^[a-z0-9_-]+$/i).default('main');

  // Состояние: по каждому ящику (RFD-AI-AGENT-FIX-PACK-2410, ч. 2) — пароль сохранён, папки, ошибки опроса.
  api.get('/email/status', async (req) => {
    const accountId = principal(req).accountId;
    const [{ settings }, withPassword, folders] = await Promise.all([deps.settings.get(accountId), deps.mail.mailboxesWithPassword(accountId), deps.mail.status(accountId)]);
    const mailboxes = mailboxesOf(settings.email).map((mb) => ({ id: mb.id, address: mb.address || mb.username, mode: mb.mode, hasPassword: withPassword.has(mb.id), folders: folders.filter((f) => f.mailboxId === mb.id).map(({ folder, lastOkAt, lastError }) => ({ folder, lastOkAt, lastError })) }));
    return { enabled: settings.email.enabled, hasPassword: withPassword.has('main'), folders: folders.filter((f) => f.mailboxId === 'main').map(({ folder, lastOkAt, lastError }) => ({ folder, lastOkAt, lastError })), mailboxes };
  });

  // Пароль приложения почтового ящика (на каждый ящик). Хранится зашифрованным и обратно не отдаётся.
  api.put('/email/password', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = z.object({ password: z.string().min(1).max(500), mailboxId }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'no_password' });
    const p = principal(req);
    await deps.mail.setPassword(p.accountId, b.data.mailboxId, b.data.password, p.userId);
    await deps.journal.add({ accountId: p.accountId, kind: 'note', summary: `Пароль почтового ящика обновлён (${b.data.mailboxId})`, details: { userId: p.userId, mailboxId: b.data.mailboxId } });
    return { ok: true };
  });

  api.delete('/email/password/:mailboxId', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = mailboxId.safeParse((req.params as { mailboxId: string }).mailboxId);
    if (!id.success) return reply.code(400).send({ error: 'bad_mailbox' });
    const p = principal(req);
    await deps.mail.deletePassword(p.accountId, id.data);
    return { ok: true };
  });

  // Проверка IMAP (ящика) и SMTP (только для ящика reply — ответы уходят из него) с сохранёнными настройками и паролем.
  api.post('/email/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const accountId = principal(req).accountId;
    const b = z.object({ mailboxId }).safeParse(req.body ?? {});
    const id = b.success ? b.data.mailboxId : 'main';
    const { settings } = await deps.settings.get(accountId);
    const mb = mailboxesOf(settings.email).find((m) => m.id === id);
    if (!mb || !mb.imapHost || !mb.username) return reply.code(400).send({ error: 'not_configured' });
    const password = await deps.mail.getPassword(accountId, mb.id);
    if (!password) return reply.code(400).send({ error: 'no_password' });
    const cfg = mailboxConfig(settings.email, mb, password);
    const result: { imap: string; smtp: string; sentFolder: string | null } = { imap: 'ok', smtp: mb.mode === 'reply' ? 'ok' : 'не используется (ящик только для чтения)', sentFolder: null };
    try {
      const box = await deps.mailConnect(cfg);
      try {
        await box.folderState(mb.inboxFolder);
        result.sentFolder = mb.sentFolder || (await box.findSentFolder());
      } finally {
        await box.close();
      }
    } catch (err) {
      result.imap = (err as Error).message || 'ошибка подключения';
    }
    if (mb.mode === 'reply') {
      if (!settings.email.smtpHost) result.smtp = 'SMTP не настроен';
      else {
        try {
          await deps.mailSender(serverConfig(settings.email, password)).verify();
        } catch (err) {
          result.smtp = (err as Error).message || 'ошибка подключения';
        }
      }
    }
    return result;
  });
}
