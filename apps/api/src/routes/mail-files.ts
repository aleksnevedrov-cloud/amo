import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { MailAttachmentsRepo } from '@core/db';
import { checkDownloadSignature } from '@retail/mail';
import type { Deps } from '../deps.ts';

/**
 * Запасной путь для вложений письма: amo не принял файл — отдаём его
 * по подписанной ссылке из примечания. Ссылка живёт 7 суток, подпись
 * проверяется по MAIL_FILES_SECRET (по умолчанию — ключ шифрования токенов).
 */
export function mailFilesRoutes(app: FastifyInstance, deps: Deps) {
  const repo = new MailAttachmentsRepo(deps.db);
  const secret = process.env.MAIL_FILES_SECRET ?? process.env.TOKEN_ENCRYPTION_KEY ?? '';

  app.get('/files/mail/:id', async (req, reply) => {
    const fileId = Number((req.params as { id: string }).id);
    const q = req.query as { exp?: string; sig?: string };
    if (!secret || !Number.isFinite(fileId)) return reply.code(404).send('not found');
    if (!checkDownloadSignature(fileId, Number(q.exp), String(q.sig ?? ''), secret)) {
      return reply.code(403).send('link expired');
    }
    const row = await repo.byId(fileId);
    if (!row?.storagePath) return reply.code(404).send('not found');
    try {
      await stat(row.storagePath);
    } catch {
      return reply.code(410).send('file removed');
    }
    return reply
      .type(row.mime || 'application/octet-stream')
      .header(
        'content-disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      )
      .send(createReadStream(row.storagePath));
  });
}
