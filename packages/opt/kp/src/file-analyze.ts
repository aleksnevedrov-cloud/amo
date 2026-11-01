import type { DocumentsRepo, WidgetSettings } from '@core/db';
import type { DocumentService } from '@core/docs';
import type { ChatRoute, LlmGateway, PricingOverrides } from '@core/llm';
import { convertLegacyOffice, type OfficeFile } from './convert.ts';
import type { ParsedFile } from './draft.ts';
import { parseTable } from './table-parse.ts';

/**
 * Разбор одного файла заявки для черновика КП (RFD-AI-AGENT-OPT-XLSX-TIMEOUT):
 * старый Office → LibreOffice; таблицы xlsx — своим разборщиком по колонкам и порциями (table-parse.ts),
 * остальное — @core/docs как раньше. Время разбора и способ — в ParsedFile, дальше в журнал.
 */
export interface DraftFileDeps {
  docs: Pick<DocumentService, 'analyze'>;
  documents: Pick<DocumentsRepo, 'add' | 'countToday'>;
  llm: LlmGateway;
  settings: WidgetSettings;
  route: ChatRoute;
  pricing?: PricingOverrides;
  accountId: number;
  leadId: number;
  userId: number | null;
  onProgress?: (line: string) => void;
  /** Строк в порции для модели (в тестах меньше). */
  chunkRows?: number;
}

/** Таблица Excel (после конвертации старого .xls тоже xlsx). */
export const isSpreadsheet = (file: Pick<OfficeFile, 'filename' | 'mime'>): boolean =>
  /spreadsheetml|ms-excel/i.test(file.mime) || /\.(xlsx|xlsm)$/i.test(file.filename);

export async function analyzeDraftFile(d: DraftFileDeps, orig: OfficeFile): Promise<ParsedFile> {
  const t0 = Date.now();
  const file = await convertLegacyOffice(orig);
  if (!isSpreadsheet(file)) {
    const r = await d.docs.analyze({ accountId: d.accountId, leadId: d.leadId, source: 'widget', filename: file.filename, mime: file.mime, bytes: file.bytes, settings: d.settings, createdBy: d.userId, hint: 'request', route: d.route });
    return { id: r.id, filename: orig.filename, kind: r.kind, positions: r.data.positions, questions: r.data.questions, requirements: r.data.requirements, ms: Date.now() - t0, method: 'docs', chunks: 1, model: `${r.provider}/${r.model}`, warnings: [], costUsd: r.costUsd };
  }
  // Дневной лимит разбора — тот же, что у @core/docs: таблица тоже считается одним документом.
  if ((await d.documents.countToday(d.accountId)) >= d.settings.vision.maxFilesPerDay) {
    throw new Error(`Достигнут дневной лимит разбора файлов (${d.settings.vision.maxFilesPerDay})`);
  }
  const t = await parseTable(file.bytes, {
    llm: d.llm,
    route: d.route,
    settings: d.settings,
    ...(d.pricing ? { pricing: d.pricing } : {}),
    filename: orig.filename,
    ...(d.chunkRows ? { chunkRows: d.chunkRows } : {}),
    ...(d.onProgress ? { onProgress: d.onProgress } : {}),
  });
  const id = await d.documents.add({
    accountId: d.accountId,
    leadId: d.leadId,
    source: 'widget',
    filename: orig.filename,
    mime: file.mime,
    sizeBytes: file.bytes.byteLength,
    format: 'xlsx',
    ocr: null,
    kind: t.data.kind,
    data: { ...t.data, matches: [], kit: null, parse: { method: t.method, chunks: t.chunks, warnings: t.warnings } },
    textChars: t.textChars,
    piiRemoved: t.piiRemoved,
    model: t.model,
    costUsd: t.cost.usd,
    createdBy: d.userId,
  });
  return {
    id,
    filename: orig.filename,
    kind: t.data.kind,
    positions: t.data.positions,
    questions: t.data.questions,
    requirements: t.data.requirements,
    ms: Date.now() - t0,
    method: t.method,
    chunks: t.chunks.length,
    model: t.model ? `${t.provider}/${t.model}` : null,
    warnings: t.warnings,
    costUsd: t.cost.usd,
  };
}
