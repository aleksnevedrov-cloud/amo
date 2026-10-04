import { AmoApiClient, continueBot, isSafeReturnUrl, verifyBotToken } from '@ai-door/amo';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hasMention } from '@ai-door/shared';
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
  /** reply — входящее сообщение клиента; send — бот-отправщик забирает одобренный черновик. */
  kind: z.enum(['reply', 'send']).optional().default('reply'),
  attachment_url: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  attachment_type: z.string().max(50).optional(),
});

/** Приём сообщений клиента из Salesbot (`widget_request`). Отвечаем сразу, обработка — в очереди. */
const WAZZUP_SYSTEM_RE = /===\s*SYSTEM\s+WZ\s*===|^\s*Сообщение не отправлено/iu;

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

      const leadId = data.data.lead_id;
      const returnUrl = body.data.return_url;

      if (data.data.kind === 'send') {
        // Бот-отправщик: отвечаем одобренным черновиком (режим «Полуавто»). Отвечаем в фоне.
        void (async () => {
          const draft = await deps.suggestions.takeApproved(accountId, leadId);
          try {
            const token = await deps.tokenService.getAccessToken(accountId);
            // Нажатие «Отправить» — явная передача агенту, поэтому сам факт участия менеджера
            // отправку не запрещает. Запрещает только сообщение менеджера ПОСЛЕ одобрения:
            // пока черновик ждал, менеджер мог ответить клиенту сам.
            if (draft) {
              const api = new AmoApiClient(account.accountDomain, () => deps.tokenService.getAccessToken(accountId), deps.fetch);
              const since = draft.decidedAt ?? draft.createdAt;
              const events = await api.getOutgoingChatEvents(leadId, since).catch(() => []);
              const manager = events.find((e) => e.created_by > 0);
              if (manager) {
                await deps.suggestions.markApprovedAgain(accountId, draft.id);
                await deps.journal.add({
                  accountId,
                  leadId,
                  kind: 'blocked',
                  summary: 'Черновик не отправлен: менеджер ответил клиенту сам',
                  details: { draftId: draft.id, approvedBy: draft.decidedBy, createdBy: manager.created_by, text: draft.text },
                });
                await deps.dialog.pause(accountId, leadId, 'manager_message');
                await continueBot(returnUrl, token, [], deps.fetch);
                return;
              }
            }
            await continueBot(returnUrl, token, draft ? [draft.text] : [], deps.fetch);
            if (draft) {
              await deps.dialog.addMessage(accountId, leadId, 'ai', draft.text);
              await deps.dialog.registerTurn(accountId, leadId, false);
              await deps.journal.add({ accountId, leadId, kind: 'reply', summary: draft.text, details: { draftId: draft.id, approvedBy: draft.decidedBy } });
            }
          } catch (err) {
            if (draft) await deps.suggestions.markApprovedAgain(accountId, draft.id);
            await deps.journal.add({ accountId, leadId, kind: 'error', summary: `Отправка черновика: ${(err as Error).message}` });
          }
        })().catch((err: Error) => req.log.error({ err }, 'salesbot send'));
        return reply.code(200).send({ ok: true });
      }

      const attachment = data.data.attachment_url ? { url: data.data.attachment_url, type: data.data.attachment_type ?? null } : null;
      const text = data.data.message.trim() || (attachment ? '' : '(клиент отправил сообщение без текста — вложение или стикер)');
      // Системные уведомления Wazzup (канал недоступен, сообщение не доставлено) приходят в бота как «сообщения клиента»
      // и зацикливают диалог (RFD-AI-AGENT-DEPLOY-112): не обрабатываем и бота не продолжаем.
      if (WAZZUP_SYSTEM_RE.test(text)) {
        await deps.journal.add({ accountId, leadId, kind: 'skipped', summary: `Системное сообщение Wazzup пропущено: ${text.slice(0, 120)}` });
        return reply.code(200).send({ ok: true, skipped: 'wazzup_system' });
      }
      const { settings } = await deps.settings.get(accountId);
      // Групповые чаты: агент отвечает только в разрешённых (RFD-AI-AGENT-GRUPPOVYE-CHATY).
      const chat = await deps.wazzup.resolveChatKind(accountId, leadId, text);
      const groups = settings.where.groups;
      const groupBlocked =
        chat.kind === 'group' &&
        (groups.mode === 'block_all' ||
          (groups.mode === 'allowlist' && !groups.allowedChatIds.includes(chat.chatId ?? '')));
      if (groupBlocked) {
        await deps.journal.add({
          accountId,
          leadId,
          kind: 'skipped',
          summary: `Групповой чат без разрешения: ${chat.chatName ?? chat.chatId ?? 'без названия'}`,
          details: { chatId: chat.chatId, chatName: chat.chatName, chatType: chat.chatType, mode: groups.mode },
        });
        return reply.code(200).send({ ok: true, skipped: 'group_chat' });
      }
      // Пункт 8: в разрешённой группе агент отвечает только на обращение по имени.
      if (chat.kind === 'group' && groups.mentionOnly && !hasMention(text, groups.mention)) {
        await deps.journal.add({
          accountId,
          leadId,
          kind: 'skipped',
          summary: 'Группа: нет обращения к агенту',
          details: { chatId: chat.chatId, chatName: chat.chatName, mention: groups.mention },
        });
        return reply.code(200).send({ ok: true, skipped: 'group_no_mention' });
      }
      await deps.dialog.enqueue(accountId, leadId, text, returnUrl, attachment);
      await deps.schedule({ accountId, leadId }, settings.where.batchWindowSec * 1000);
      return reply.code(200).send({ ok: true });
    },
  );
}
