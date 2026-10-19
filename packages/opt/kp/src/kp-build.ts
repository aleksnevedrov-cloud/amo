import { access, readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { AmoApiClient } from '@core/amo';
import type { JournalRepo } from '@core/db';
import { buildKp, DEFAULT_PRICE_NOTE, findCertificates, SERVICE_NOTE, templateData } from './build.ts';
import { isServiceLine, kpLineParts, lineCategory, tidyName, type KpLine, type KpPayload } from './draft.ts';
import { describeFsError, kpLeadDirRel, relativeKpPath, resolveKpPath } from './paths.ts';
import type { KpDraft, KpRepo } from './repo.ts';

/**
 * Сборка документа КП по черновику (RFD-AI-AGENT-OPT-KP-DOWNLOAD): одна функция для маршрута POST /kp/build и для
 * консольной утилиты kp-build. DOCX по шаблону, PDF через LibreOffice, сертификаты по фабрикам, файлы — в карточку
 * сделки, в kp_drafts — пути (относительно KP_FILES_ROOT), номер и built_at, в журнал kp_build — размеры файлов и
 * имена приложенных в amo.
 *
 * Дефект 2в (пустые docx_path / pdf_path у черновика): документ собирался по черновику, который виджет держал в
 * памяти, а к тому времени по сделке уже был создан новый («Собрать заново»); setBuilt писал в старый. Теперь
 * сборка отвергает черновик, который не последний по сделке (stale_draft), а запись в kp_drafts проверяется.
 */
export type KpBuildErrorCode = 'not_found' | 'already_sent' | 'no_template' | 'no_priced_lines' | 'stale_draft' | 'build_failed' | 'component_questions';

export class KpBuildError extends Error {
  override name = 'KpBuildError';
  constructor(
    readonly code: KpBuildErrorCode,
    message: string,
    readonly latestDraftId: number | null = null,
  ) {
    super(message);
  }
}

export interface KpBuildDeps {
  kp: KpRepo;
  filesRoot: string;
  journal: Pick<JournalRepo, 'add'>;
  amoFor(accountId: number): Promise<Pick<AmoApiClient, 'uploadFileToLead'>>;
}

export interface KpBuildFile {
  kind: 'docx' | 'pdf';
  name: string;
  /** Путь относительно KP_FILES_ROOT — как в kp_drafts. */
  path: string;
  bytes: number;
}

export interface KpBuildResultInfo {
  draft: KpDraft;
  kpNo: string;
  pdf: boolean;
  pdfError: string | null;
  files: KpBuildFile[];
  certificates: string[];
  /** Имена файлов, приложенных в сделку amo (КП и сертификаты). */
  attached: string[];
  priceNoteFallback: boolean;
  ms: number;
}

export async function buildDraftDocument(d: KpBuildDeps, input: { accountId: number; draftId: number; userId: number | null; now?: Date }): Promise<KpBuildResultInfo> {
  const started = Date.now();
  const { accountId, draftId } = input;
  const draft = await d.kp.byId(accountId, draftId);
  if (!draft) throw new KpBuildError('not_found', `черновик ${draftId} не найден`);
  if (draft.status === 'sent') throw new KpBuildError('already_sent', `КП по черновику ${draftId} уже отправлено`);
  // Последний черновик сделки — единственный, по которому собирают: иначе файлы и номер уйдут в запись, которую виджет не показывает.
  const latest = await d.kp.latestByLead(accountId, draft.leadId);
  if (latest && latest.id !== draft.id) {
    throw new KpBuildError('stale_draft', `по сделке ${draft.leadId} есть более новый черновик ${latest.id} (этот — ${draft.id}): обновите блок и соберите документ по нему`, latest.id);
  }
  const s = await d.kp.getSettings(accountId);
  if (!s.templatePath) throw new KpBuildError('no_template', 'шаблон КП не загружен (вкладка «КП» → «Шаблон»)');
  const template = resolveKpPath(d.filesRoot, s.templatePath);
  try {
    await access(template);
  } catch (err) {
    throw new KpBuildError('no_template', `шаблон КП: ${describeFsError(err, template)}`);
  }
  const payload = draft.payload as unknown as KpPayload;
  // KB-COMPONENTS, п. 5: работы (монтаж, врезка, доставка) в таблицу и итог не входят — под таблицей фраза о расчёте после замера.
  // KB-HW-NULL: строка из базы с ценой 0, которая не «входит в блок» (черновик искал цену, когда тариф без цены хранился как 0,00), —
  // это «в прайсе цены нет»: в таблице «уточнить у менеджера», не 0 ₽, в итог не входит.
  const goods = (payload.items ?? []).filter((l) => !isServiceLine(l)).map((l) => (l.priceSource === 'kb' && l.price === 0 && l.priceOutcome !== 'included' ? { ...l, price: null, priceOutcome: 'not_priced' as const } : l));
  const hasServices = (payload.items ?? []).length > goods.length;
  // KB-PRICE-SHEETS: «входит в цену блока» — не строка таблицы, а примечание под ближайшей дверью выше; «в прайсе цены нет» —
  // строка с «уточнить у менеджера» вместо цены, в итог не входит.
  // KB-COMPONENT-DOOR: пока менеджер не ответил, к какой двери считать комплектующее, документ не собирается.
  const questions = goods.filter((l) => l.question && l.priceOutcome === 'question');
  if (questions.length) throw new KpBuildError('component_questions', `ответьте на вопросы по комплектующим: ${questions.length} (${questions.slice(0, 3).map((l) => `поз. ${l.request_index + 1}`).join(', ')}${questions.length > 3 ? ', …' : ''})`);
  const included = goods.filter((l) => l.priceOutcome === 'included');
  const lines = goods.filter((l): l is KpLine & { price: number } => l.price !== null && l.priceOutcome !== 'included').concat(goods.filter((l) => l.price === null && l.priceOutcome === 'not_priced') as (KpLine & { price: number })[]).sort((a, b) => a.request_index - b.request_index);
  if (!lines.some((l) => l.price !== null)) throw new KpBuildError('no_priced_lines', hasServices ? 'ни у одной позиции (кроме работ) нет цены' : 'ни у одной позиции нет цены');
  const notesOf = (l: KpLine): string[] => {
    const own = l.quoteNotes ?? [];
    if (lineCategory(l) !== 'door') return own;
    // Позиции группы этой двери (до следующей двери) со статусом «входит»: в цену блока — одной строкой; в комплект фурнитуры — своей.
    const group = included.filter((c) => c.request_index > l.request_index && !lines.some((d) => lineCategory(d) === 'door' && d.request_index > l.request_index && d.request_index < c.request_index));
    const inBlock = group.filter((c) => !c.includedIn || c.includedIn === l.productId).map((c) => tidyName(c.name));
    const sets = new Map<string, string[]>();
    for (const c of group) if (c.includedIn && c.includedIn !== l.productId) sets.set(c.includedIn, [...(sets.get(c.includedIn) ?? []), tidyName(c.name)]);
    return [...own, ...(inBlock.length ? [`В цену блока входит: ${inBlock.join(', ')}`] : []), ...[...sets].map(([set, names]) => `В составе комплекта «${set}»: ${names.join(', ')}`)];
  };

  const kpNo = draft.kpNo ?? (await d.kp.nextNumber(accountId, input.now));
  const letterAt = payload.source?.letterAt ? new Date(payload.source.letterAt) : null;
  const data = templateData({
    kpNo,
    date: input.now ?? new Date(),
    basis: letterAt ? `запрос от ${letterAt.toLocaleDateString('ru-RU')}` : 'запрос клиента',
    clientName: payload.client?.org || payload.client?.fio || '',
    clientPhone: payload.client?.phone || '',
    // KP-LAYOUT: ячейка в три уровня — короткое название по прайсу / комплектация / обозначение заказчика (его строка
    // запроса); в шаблоне без {{equipment}} и {{designation}} второй и третий уровни идут строками под названием.
    lines: lines.map((l) => ({ ...kpLineParts(l, payload.request_items?.[l.request_index] ?? null), size: l.size, qty: l.qty, price: l.price, discount: l.discount, priceText: l.price === null ? 'уточнить у менеджера' : undefined, notes: notesOf(l) })),
    vatRate: s.constants.vatRate ?? 0,
    priceNote: s.constants.priceNote ?? DEFAULT_PRICE_NOTE,
    serviceNote: hasServices ? SERVICE_NOTE : '',
  });
  const outRel = kpLeadDirRel(accountId, draft.leadId);
  const outDir = resolveKpPath(d.filesRoot, outRel);
  let built: Awaited<ReturnType<typeof buildKp>>;
  try {
    built = await buildKp(template, data, outDir, `KP-${kpNo.replace(/[^0-9A-Za-zА-Яа-я._-]+/g, '_')}`);
  } catch (err) {
    const msg = (err as { code?: string }).code ? describeFsError(err, outDir) : (err as Error).message;
    await d.journal.add({ accountId, leadId: draft.leadId, kind: 'kp_error', summary: `КП не собрано: ${msg}`, details: { draftId: draft.id, userId: input.userId, outDir, code: (err as { code?: string }).code ?? null } });
    throw new KpBuildError('build_failed', msg);
  }
  const files: KpBuildFile[] = [];
  for (const [kind, path] of [['docx', built.docxPath], ['pdf', built.pdfPath]] as const) {
    if (!path) continue;
    const size = await stat(path).then((x) => x.size).catch(() => 0);
    files.push({ kind, name: basename(path), path: relativeKpPath(d.filesRoot, path), bytes: size });
  }
  // Фабрики у опта берутся из названий позиций: каталога нет, сертификат подбирается по вхождению имени фабрики в файл.
  const certs = await findCertificates(resolveKpPath(d.filesRoot, s.certsDir), lines.map((l) => l.name));
  const attached = await attachToLead(d, accountId, draft.leadId, [built.pdfPath ?? built.docxPath, ...certs]);
  const docxRel = files.find((f) => f.kind === 'docx')?.path ?? relativeKpPath(d.filesRoot, built.docxPath);
  const pdfRel = files.find((f) => f.kind === 'pdf')?.path ?? null;
  const written = await d.kp.setBuilt(draft.id, { docxPath: docxRel, pdfPath: pdfRel, kpNo });
  if (!written) throw new KpBuildError('build_failed', `файлы собраны, но черновик ${draft.id} в kp_drafts не обновлён (запись не найдена)`);
  const fresh = (await d.kp.byId(accountId, draft.id)) ?? draft;
  const ms = Date.now() - started;
  await d.journal.add({
    accountId,
    leadId: draft.leadId,
    kind: 'kp_build',
    summary:
      `КП ${kpNo} собрано: позиций ${lines.length}; файлы: ${files.map((f) => `${f.name} (${kb(f.bytes)})`).join(', ')}` +
      (built.pdfPath ? '' : `; PDF не собран${built.pdfError ? ` (${built.pdfError})` : ''}`) +
      (attached.length ? `; в сделку: ${attached.join(', ')}` : '; в сделку не приложено') +
      (built.priceNoteFallback ? '; в шаблоне нет {{price_note}} — фраза о ценах добавлена под строку НДС' : '') +
      (built.layoutFallback ? '; в шаблоне нет {{equipment}} / {{designation}} — комплектация и обозначение заказчика добавлены строками под названием' : '') +
      (built.currencyStripped.length ? `; в шаблоне знак ₽ стоит после ${built.currencyStripped.map((t) => `{{${t}}}`).join(', ')} — из значений убран` : '') +
      (built.pageBreaksRemoved ? `; разрывов страницы после таблицы убрано: ${built.pageBreaksRemoved}` : '') +
      (hasServices ? `; работ вне таблицы: ${(payload.items ?? []).length - goods.length}${built.serviceNoteFallback ? ' (в шаблоне нет {{service_note}} — фраза под фразой о ценах)' : ''}` : '') +
      (included.length ? `; входит в цену блока (под дверью, не в таблице): ${included.length}` : '') +
      (lines.some((l) => l.price === null) ? `; без цены в прайсе («уточнить у менеджера», не в итоге): ${lines.filter((l) => l.price === null).length}` : '') +
      `; ${(ms / 1000).toFixed(1)} с`,
    details: { draftId: draft.id, kpNo, files, certificates: certs.length, attached, pdfError: built.pdfError ?? null, priceNoteFallback: built.priceNoteFallback, layoutFallback: built.layoutFallback, currencyStripped: built.currencyStripped, pageBreaksRemoved: built.pageBreaksRemoved, services: (payload.items ?? []).length - goods.length, serviceNoteFallback: built.serviceNoteFallback, userId: input.userId, ms },
  });
  return { draft: fresh, kpNo, pdf: Boolean(built.pdfPath), pdfError: built.pdfError ?? null, files, certificates: certs, attached, priceNoteFallback: built.priceNoteFallback, ms };
}

/** Файлы — в карточку сделки: менеджер открывает их там же, где письмо. Сбой загрузки не ломает сборку. */
async function attachToLead(d: KpBuildDeps, accountId: number, leadId: number, files: string[]): Promise<string[]> {
  const amo = await d.amoFor(accountId).catch(() => null);
  if (!amo) return [];
  const attached: string[] = [];
  for (const f of files) {
    const bytes = await readFile(f).catch(() => null);
    if (!bytes) continue;
    const mime = f.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    await amo
      .uploadFileToLead(leadId, { filename: basename(f), mime, bytes })
      .then(() => attached.push(basename(f)))
      .catch(() => undefined);
  }
  return attached;
}

const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`);

/** Файл КП для скачивания: имя и абсолютный путь; null — файла этого вида у черновика нет. */
export function kpFileOf(filesRoot: string, draft: Pick<KpDraft, 'docxPath' | 'pdfPath'>, kind: 'docx' | 'pdf'): { name: string; path: string; mime: string } | null {
  const rel = kind === 'pdf' ? draft.pdfPath : draft.docxPath;
  if (!rel) return null;
  const path = resolveKpPath(filesRoot, rel);
  return { name: basename(path), path, mime: kind === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
}
