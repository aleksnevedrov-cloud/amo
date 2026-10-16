import { knownModelNames } from '@opt/kb';
import { DEFAULT_MAX_POSITIONS_PER_RUN, researchablePositions, type ResearchJob } from './research-job.ts';
import type { OptCore } from './deps.ts';
import { buildKpDraft, type KpDraftDeps, type KpPayload, type ParsedFile } from './draft.ts';
import { analyzeDraftFile } from './file-analyze.ts';
import { resolveOptRoute, toWidgetSettings } from './settings.ts';

/** Подпись способа разбора файла для журнала. */
const METHOD_LABEL: Record<NonNullable<ParsedFile['method']>, string> = { docs: 'модель одним запросом', columns: 'по колонкам, без модели', 'columns+model': 'по колонкам + модель', 'model-chunks': 'модель порциями' };

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
    // Таблицы xlsx — по колонкам и порциями (file-analyze.ts / table-parse.ts), остальное — @core/docs; старый Office — через LibreOffice.
    const analyze: KpDraftDeps['analyze'] =
      settings.vision.provider === 'off'
        ? null
        : (orig) =>
            analyzeDraftFile(
              {
                docs: core.docs,
                documents: core.documents,
                llm: ai.llm,
                settings: widgetSettings,
                route,
                pricing: settings.billing.pricing,
                accountId,
                leadId,
                userId: job.userId ?? null,
                ...(hooks.onProgress ? { onProgress: hooks.onProgress } : {}),
                // База знаний первая (RFD-AI-AGENT-OPT-KB, этап 4): известные модели — без модели.
                known: (names) => knownModelNames(core.kb.prices, core.kb.aliases, accountId, names),
              },
              orig,
            );
    // Ящик, подключённый к amoCRM, читается по IMAP только на чтение и только здесь — по кнопке (вариант А).
    const m = settings.mail;
    const mailPassword = m.username && m.imapHost ? await core.secrets.get(accountId, 'smtp') : null;
    // Прежний черновик сделки (KP-REBUILD-MAIL): его письмо читается сразу по папке и UID (п. 1), а пустая пересборка
    // его не затирает (п. 2).
    const prev = await core.kp.latestByLead(accountId, leadId);
    const prevPayload = (prev?.payload ?? {}) as unknown as Partial<KpPayload>;
    const prevMail = prevPayload.source?.mail;
    const known = prevMail && prevMail.status === 'found' && prevMail.folder && prevMail.uid ? { folder: prevMail.folder, uid: prevMail.uid, messageId: prevMail.messageId } : null;
    const mail: KpDraftDeps['mail'] = mailPassword
      ? (search) => core.mailRead({ host: m.imapHost, port: m.imapPort, secure: m.imapSecure, username: m.username, password: mailPassword }, { ...search, ...(known ? { known } : {}) }, { onProgress: hooks.onProgress })
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
            : ms.status === 'not_found' || ms.status === 'partial'
              ? `Письмо в ящике не найдено${ms.status === 'partial' ? ' — ящик просмотрен не полностью' : ''} (искали от ${ms.searchedFrom}${ms.diag ? `${ms.diag.criteria.since ? `, окно ${ms.diag.criteria.since}–${ms.diag.criteria.before} (${ms.diag.criteria.windowSource ?? 'letter'})` : ''}, папок просмотрено ${ms.diag.folders.length}, писем в окне дат ${ms.diag.folders.reduce((n, f) => n + f.inWindow, 0)}, от отправителя ${ms.diag.folders.reduce((n, f) => n + f.bySender + f.bySenderWithoutDate, 0)}` : ''}${ms.error ? `: ${ms.error}` : ''})`
              : `Ящик не прочитан: ${ms.error}`,
        details: { userId: job.userId, status: ms.status, messageId: ms.messageId, folder: ms.folder, matchedBy: ms.matchedBy, taken: ms.taken, uploaded: ms.uploaded, skipped: ms.skipped, retryAt: ms.retryAt, diag: ms.diag },
      });
    }
    // Пересборка без единой позиции не заменяет рабочий черновик (KP-REBUILD-MAIL, п. 2): прежний остаётся с пометкой,
    // причина — в журнале kp_error. Новый черновик создаётся, только если позиции есть или прежнего с позициями нет.
    const prevItems = prevPayload.items?.length ?? 0;
    if (!r.payload.items.length && prev && prevItems > 0) {
      const why = r.payload.needs_manager.filter((n) => n.request_index === -1).map((n) => n.reason).join('; ') || 'позиции не найдены';
      const note = `пересборка ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} без позиций (${why}) — черновик сохранён`;
      const needs = (prevPayload.needs_manager ?? []).filter((n) => !(n.request_index === -1 && n.reason.startsWith('пересборка ')));
      needs.push({ request_index: -1, reason: note });
      await core.kp.setPayloadIfVersion(prev.id, prev.version, { ...prevPayload, needs_manager: needs } as unknown as Record<string, unknown>).catch(() => false);
      await core.journal.add({
        accountId,
        leadId,
        kind: 'kp_error',
        summary: `Черновик ${prev.id} сохранён: пересборка не дала ни одной позиции (${why}); прежний черновик с позициями (${prevItems}) не заменён`,
        details: { draftId: prev.id, userId: job.userId, keptDraft: true, reason: why, mail: ms ? { status: ms.status, error: ms.error } : null },
      });
      return { draftId: prev.id };
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
      summary:
        `Черновик КП: позиций ${r.payload.items.length}, документов ${r.payload.source.documents.length}` +
        (r.payload.source.skipped.length ? `, пропущено файлов ${r.payload.source.skipped.length}` : '') +
        (r.files.length ? `; файлы: ${r.files.map((f) => `${f.name} — позиций ${f.positions}${f.ms !== null ? `, ${(f.ms / 1000).toFixed(1)} с` : ''}${f.method ? ` (${METHOD_LABEL[f.method]}${f.chunks && f.chunks > 1 ? `, порций ${f.chunks}` : ''}${f.knownFromKb ? `, из базы знаний ${f.knownFromKb}` : ''})` : ''}${f.warnings.length ? `, пометок ${f.warnings.length}` : ''}`).join('; ')}` : ''),
      details: { draftId, model: r.model, provider: r.provider, userId: job.userId, skipped: r.payload.source.skipped, files: r.files },
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
