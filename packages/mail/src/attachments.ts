import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import type { AmoApiClient } from '@ai-door/amo';
import type { MailAttachmentsRepo } from '@ai-door/db';

/** Лимиты на одно письмо — защита диска и amo от мусорных рассылок. */
export const MAX_FILES_PER_LETTER = 10;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
/** Inline-картинки мельче этого — подписи и логотипы из подвала письма, не вложения. */
export const MIN_INLINE_BYTES = 20 * 1024;
/** Срок жизни ссылки на скачивание, когда amo файл не принял. */
export const LINK_TTL_MS = 7 * 24 * 3600_000;

export interface IncomingAttachment {
  filename: string | null;
  contentType: string;
  size: number;
  content: Buffer;
  inline?: boolean;
}

export interface SaveAttachmentsDeps {
  attachments: MailAttachmentsRepo;
  journal: {
    add(e: {
      accountId: number;
      leadId: number | null;
      kind: 'mail_attachment';
      summary: string;
      details?: Record<string, unknown>;
    }): Promise<unknown>;
  };
  /** Корень хранилища внутри контейнера. */
  root: string;
  publicUrl?: string;
  linkSecret?: string;
  now?(): Date;
}

export interface SaveAttachmentsResult {
  saved: number;
  duplicates: number;
  skipped: number;
  uploaded: number;
  failed: number;
}

/** Имя файла из письма доверять нельзя: режем пути и управляющие символы. */
export function safeFilename(name: string | null, contentType: string): string {
  const raw = (name ?? '').replace(/[\\/\u0000-\u001f]/g, '').trim();
  if (raw) return raw.slice(0, 200);
  const ext = (contentType.split('/')[1] ?? 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8);
  return `attachment.${ext || 'bin'}`;
}

/** /data/mail/<account>/<yyyy-mm>/<uuid><ext> — месяц в пути упрощает чистку. */
export function storagePathFor(root: string, accountId: number, filename: string, now: Date): string {
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const ext = extname(filename).slice(0, 12);
  return join(root, 'mail', String(accountId), month, `${randomUUID()}${ext}`);
}

export function signDownload(id: number, expiresAt: number, secret: string): string {
  return createHmac('sha256', secret).update(`${id}.${expiresAt}`).digest('hex').slice(0, 32);
}

export function checkDownloadSignature(
  id: number,
  expiresAt: number,
  signature: string,
  secret: string,
  now = Date.now(),
): boolean {
  if (!Number.isFinite(expiresAt) || expiresAt < now) return false;
  const expected = Buffer.from(signDownload(id, expiresAt, secret));
  const got = Buffer.from(String(signature));
  return expected.length === got.length && timingSafeEqual(expected, got);
}

/** Какие части письма вообще считаем вложениями. */
export function pickAttachments(files: IncomingAttachment[]): {
  take: IncomingAttachment[];
  skipped: number;
} {
  let skipped = 0;
  const take: IncomingAttachment[] = [];
  let total = 0;
  for (const f of files) {
    const size = f.size || f.content.byteLength;
    if (f.inline && size < MIN_INLINE_BYTES) {
      skipped += 1;
      continue;
    }
    if (size > MAX_FILE_BYTES || take.length >= MAX_FILES_PER_LETTER || total + size > MAX_TOTAL_BYTES) {
      skipped += 1;
      continue;
    }
    total += size;
    take.push(f);
  }
  return { take, skipped };
}

/**
 * Кладёт вложения письма на диск, пишет строки в mail_attachments и грузит файлы
 * в карточку сделки. Повторный опрос того же письма ничего не дублирует.
 */
export async function saveMailAttachments(
  args: {
    accountId: number;
    leadId: number;
    messageId: string;
    messageUid: number | null;
    files: IncomingAttachment[];
    api: AmoApiClient;
    /** Текст вложений, уже извлечённый при разборе письма: имя файла → результат. */
    extracts?: Map<string, { text?: string; error?: string }>;
  },
  d: SaveAttachmentsDeps,
): Promise<SaveAttachmentsResult> {
  const now = d.now?.() ?? new Date();
  const res: SaveAttachmentsResult = { saved: 0, duplicates: 0, skipped: 0, uploaded: 0, failed: 0 };
  const { take, skipped } = pickAttachments(args.files);
  res.skipped = skipped;
  const linkless: string[] = [];

  for (const f of take) {
    const filename = safeFilename(f.filename, f.contentType);
    const sizeBytes = f.size || f.content.byteLength;
    const path = storagePathFor(d.root, args.accountId, filename, now);
    let row: { id: number; created: boolean };
    try {
      row = await d.attachments.insert({
        accountId: args.accountId,
        leadId: args.leadId,
        messageUid: args.messageUid,
        messageId: args.messageId,
        filename,
        mime: f.contentType || 'application/octet-stream',
        sizeBytes,
        storagePath: path,
      });
    } catch (err) {
      res.failed += 1;
      await d.journal.add({
        accountId: args.accountId,
        leadId: args.leadId,
        kind: 'mail_attachment',
        summary: `Вложение «${filename}» не записано: ${(err as Error).message}`,
      });
      continue;
    }
    if (!row.created) {
      res.duplicates += 1;
      continue;
    }

    const extract = args.extracts?.get(filename) ?? args.extracts?.get(f.filename ?? '');
    if (extract) {
      await d.attachments
        .setExtract(row.id, { text: extract.text ?? null, error: extract.error ?? null })
        .catch(() => undefined);
    }

    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, f.content);
      res.saved += 1;
    } catch (err) {
      res.failed += 1;
      await d.attachments.markUploadError(row.id, `disk: ${(err as Error).message}`);
      continue;
    }

    try {
      const uuid = await args.api.uploadFileToLead(args.leadId, {
        filename,
        mime: f.contentType || 'application/octet-stream',
        bytes: new Uint8Array(f.content),
      });
      if (uuid) {
        await d.attachments.markUploaded(row.id, uuid);
        res.uploaded += 1;
      } else {
        await d.attachments.markUploadError(row.id, 'amo: файл не принят');
        linkless.push(downloadLine(row.id, filename, now, d));
      }
    } catch (err) {
      res.failed += 1;
      await d.attachments.markUploadError(row.id, (err as Error).message);
      linkless.push(downloadLine(row.id, filename, now, d));
    }
  }

  if (linkless.length) {
    await d.journal.add({
      accountId: args.accountId,
      leadId: args.leadId,
      kind: 'mail_attachment',
      summary: 'Файлы не попали в карточку, ссылки на скачивание',
      details: { links: linkless },
    });
  }
  if (res.saved || res.skipped || res.duplicates) {
    await d.journal.add({
      accountId: args.accountId,
      leadId: args.leadId,
      kind: 'mail_attachment',
      summary: `Вложения письма: сохранено ${res.saved}, в карточку ${res.uploaded}, пропущено ${res.skipped}, повторов ${res.duplicates}`,
    });
  }
  return res;
}

function downloadLine(id: number, filename: string, now: Date, d: SaveAttachmentsDeps): string {
  if (!d.publicUrl || !d.linkSecret) return filename;
  const exp = now.getTime() + LINK_TTL_MS;
  const sig = signDownload(id, exp, d.linkSecret);
  return `${filename}: ${d.publicUrl.replace(/\/$/, '')}/files/mail/${id}?exp=${exp}&sig=${sig}`;
}
