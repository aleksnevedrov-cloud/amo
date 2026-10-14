import { convertLegacyOffice } from './convert.ts';
import { DEFAULT_MAX_POSITIONS_PER_RUN, researchablePositions, type ResearchJob } from './research-job.ts';
import type { OptCore } from './deps.ts';
import { buildKpDraft, type KpDraftDeps } from './draft.ts';
import { resolveOptRoute, toWidgetSettings } from './settings.ts';

/** Очередь опта в Redis (база 1): задание «собрать черновик» по кнопке менеджера; плановых задач нет (ТЗ 6.5). */
export const KP_QUEUE = 'kp';
export const DRAFT_JOB = 'draft';

export interface DraftJob {
  accountId: number;
  leadId: number;
  userId: number | null;
}

/** Один черновик на сделку в очереди: повторное нажатие не плодит задания. */
export const draftJobId = (accountId: number, leadId: number) => `draft-${accountId}-${leadId}`;

/**
 * Черновик КП из карточки сделки: письма и файлы читаются через API amoCRM, спецификации
 * разбираются @core/docs, позиции кладутся в kp_drafts без цен. Любая ошибка — в журнал (kp_error)
 * и наверх: задание помечается упавшим, виджет показывает текст.
 */
/**
 * Хуки задания: onProgress — строки хода чтения ящика (в debug-лог воркера); enqueueResearch — постановка
 * заданий поиска цен (очередь kp-research) при включённой настройке «искать автоматически при сборке».
 */
export interface DraftJobHooks {
  onProgress?: (line: string) => void;
  enqueueResearch?: (jobs: ResearchJob[]) => Promise<void>;
}

export async function runDraftJob(core: OptCore, job: DraftJob, hooks: DraftJobHooks = {}): Promise<{ draftId: number }> {
  const { accountId, leadId } = job;
  try {
    const ai = await core.ai(accountId);
    if (!ai) throw new Error('LLM не настроена: задайте ключ провайдера в настройках «Модель»');
    const { settings } = await core.settings.get(accountId);
    const route = resolveOptRoute(settings);
    const amo = await core.amoFor(accountId);
    const widgetSettings = toWidgetSettings(settings);
    const analyze: KpDraftDeps['analyze'] =
      settings.vision.provider === 'off'
        ? null
        : async (orig) => {
            // Старый Word/Excel (.doc, .xls, .rtf…) → DOCX/XLSX через LibreOffice, затем обычный разбор.
            const file = await convertLegacyOffice(orig);
            const r = await core.docs.analyze({ accountId, leadId, source: 'widget', filename: file.filename, mime: file.mime, bytes: file.bytes, settings: widgetSettings, createdBy: job.userId, hint: 'request', route });
            return { id: r.id, filename: orig.filename, kind: r.kind, positions: r.data.positions, questions: r.data.questions, requirements: r.data.requirements };
          };
    // Ящик, подключённый к amoCRM, читается по IMAP только на чтение и только здесь — по кнопке (вариант А).
    const m = settings.mail;
    const mailPassword = m.username && m.imapHost ? await core.secrets.get(accountId, 'smtp') : null;
    const mail: KpDraftDeps['mail'] = mailPassword
      ? (search) => core.mailRead({ host: m.imapHost, port: m.imapPort, secure: m.imapSecure, username: m.username, password: mailPassword }, search, { onProgress: hooks.onProgress })
      : null;
    // Каталога у опта нет — подбор аналогов (analogs) не подключён, пока заказчик не выберет источник.
    const r = await buildKpDraft(ai.llm, { accountId, leadId, route, pricing: settings.billing.pricing }, { amo, analyze, mail });
    const ms = r.payload.source.mail;
    if (ms) {
      await core.journal.add({
        accountId,
        leadId,
        kind: ms.status === 'error' ? 'kp_error' : 'mail_fetch',
        summary:
          ms.status === 'found'
            ? `Письмо из ящика найдено (${ms.matchedBy === 'domain' ? `по домену ${ms.diag?.criteria.domain ?? ''}, не по адресу ` : 'от '}${ms.searchedFrom}${ms.folder ? `, папка ${ms.folder}` : ''}${ms.date ? `, ${new Date(ms.date).toLocaleDateString('ru-RU')}` : ''}): вложений ${ms.attachments}, взято ${ms.taken.length}, загружено в сделку ${ms.uploaded.length}` + (ms.skipped.length ? `, пропущено ${ms.skipped.length}` : '')
            : ms.status === 'not_found'
              ? `Письмо в ящике не найдено (искали от ${ms.searchedFrom}${ms.diag ? `, папок просмотрено ${ms.diag.folders.length}, писем в окне дат ${ms.diag.folders.reduce((n, f) => n + f.inWindow, 0)}, от отправителя ${ms.diag.folders.reduce((n, f) => n + f.bySender + f.bySenderWithoutDate, 0)}` : ''}${ms.error ? `: ${ms.error}` : ''})`
              : `Ящик не прочитан: ${ms.error}`,
        details: { userId: job.userId, status: ms.status, messageId: ms.messageId, folder: ms.folder, matchedBy: ms.matchedBy, taken: ms.taken, uploaded: ms.uploaded, skipped: ms.skipped, retryAt: ms.retryAt, diag: ms.diag },
      });
    }
    const draftId = await core.kp.createDraft(accountId, leadId, r.payload as unknown as Record<string, unknown>, job.userId);
    // Поиск цен при сборке — только если включено в настройках КП (по умолчанию выключено: поиск по кнопке «Найти цены»).
    const { constants } = await core.kp.getSettings(accountId);
    if (constants.autoResearch && hooks.enqueueResearch) {
      const idx = researchablePositions(r.payload, 'all', constants.maxPositionsPerRun ?? DEFAULT_MAX_POSITIONS_PER_RUN);
      if (idx.length) await hooks.enqueueResearch(idx.map((requestIndex) => ({ accountId, draftId, requestIndex, userId: job.userId })));
    }
    await core.journal.add({
      accountId,
      leadId,
      kind: 'kp_draft',
      summary: `Черновик КП: позиций ${r.payload.items.length}, документов ${r.payload.source.documents.length}` + (r.payload.source.skipped.length ? `, пропущено файлов ${r.payload.source.skipped.length}` : ''),
      details: { draftId, model: r.model, provider: r.provider, userId: job.userId, skipped: r.payload.source.skipped },
      inputTokens: r.cost.inputTokens,
      outputTokens: r.cost.outputTokens,
      costUsd: r.cost.usd,
      costRub: r.cost.usd * settings.billing.usdRubRate,
    });
    return { draftId };
  } catch (err) {
    await core.journal.add({ accountId, leadId, kind: 'kp_error', summary: `Черновик КП не собран: ${(err as Error).message}`, details: { userId: job.userId } }).catch(() => undefined);
    throw err;
  }
}
