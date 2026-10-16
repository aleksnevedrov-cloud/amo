import { access, readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { AmoApiClient } from '@core/amo';
import type { JournalRepo } from '@core/db';
import { buildKp, DEFAULT_PRICE_NOTE, findCertificates, templateData } from './build.ts';
import { kpLineName, type KpLine, type KpPayload } from './draft.ts';
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
export type KpBuildErrorCode = 'not_found' | 'already_sent' | 'no_template' | 'no_priced_lines' | 'stale_draft' | 'build_failed';

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
  const lines = (payload.items ?? []).filter((l): l is KpLine & { price: number } => l.price !== null);
  if (!lines.length) throw new KpBuildError('no_priced_lines', 'ни у одной позиции нет цены');

  const kpNo = draft.kpNo ?? (await d.kp.nextNumber(accountId, input.now));
  const letterAt = payload.source?.letterAt ? new Date(payload.source.letterAt) : null;
  const data = templateData({
    kpNo,
    date: input.now ?? new Date(),
    basis: letterAt ? `запрос от ${letterAt.toLocaleDateString('ru-RU')}` : 'запрос клиента',
    clientName: payload.client?.org || payload.client?.fio || '',
    clientPhone: payload.client?.phone || '',
    // KP-NAME: наименование = название клиента + «по прайсу: модель покрытие»; комплектация — строкой под позицией (перенос в ячейке).
    lines: lines.map((l) => ({ name: `${kpLineName(l)}${l.equipment ? `\nКомплектация: ${l.equipment}` : ''}`, size: l.size, qty: l.qty, price: l.price, discount: l.discount })),
    vatRate: s.constants.vatRate ?? 0,
    priceNote: s.constants.priceNote ?? DEFAULT_PRICE_NOTE,
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
      `; ${(ms / 1000).toFixed(1)} с`,
    details: { draftId: draft.id, kpNo, files, certificates: certs.length, attached, pdfError: built.pdfError ?? null, priceNoteFallback: built.priceNoteFallback, userId: input.userId, ms },
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
