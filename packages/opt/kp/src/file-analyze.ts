import type { DocumentsRepo, WidgetSettings } from '@core/db';
import type { DocumentService } from '@core/docs';
import type { ChatRoute, LlmGateway, PricingOverrides } from '@core/llm';
import { categoryOf } from '@opt/kb';
import { convertLegacyOffice, type OfficeFile } from './convert.ts';
import { equipmentFor, equipmentSections, pickSpecTable, readDocxBlocks, specCandidates, tableRows, type DocxBlock, type SpecTable } from './docx-spec.ts';
import type { ParsedFile } from './draft.ts';
import { detectHeader, parseRows, parseTable, tableItems, type TableParsed, type TableParseOptions } from './table-parse.ts';

/**
 * Разбор одного файла заявки для черновика КП (RFD-AI-AGENT-OPT-XLSX-TIMEOUT):
 * старый Office → LibreOffice; таблицы xlsx и таблица спецификации Word (KP-DOCX-APPENDIX) — своим разборщиком по колонкам
 * и порциями (table-parse.ts), остальное — @core/docs как раньше. Время разбора и способ — в ParsedFile, дальше в журнал.
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
  /** Названия из базы знаний (этап 4): известные модели — без вызова модели. */
  known?: TableParseOptions['known'];
}

/** Таблица Excel (после конвертации старого .xls тоже xlsx). */
export const isSpreadsheet = (file: Pick<OfficeFile, 'filename' | 'mime'>): boolean =>
  /spreadsheetml|ms-excel/i.test(file.mime) || /\.(xlsx|xlsm)$/i.test(file.filename);

/** Документ Word (после конвертации .doc / .rtf / .odt тоже docx). */
export const isWordDocx = (file: Pick<OfficeFile, 'filename' | 'mime'>): boolean => /wordprocessingml/i.test(file.mime) || /\.docx$/i.test(file.filename);

/** KP-DOCX-APPENDIX: таблица спецификации Word-файла и разделы ТЗ о комплектации (docx-spec.ts); без модели. Нет таблицы — null. */
function findDocxSpec(file: OfficeFile): { blocks: DocxBlock[]; spec: SpecTable; others: SpecTable[] } | null {
  let blocks: DocxBlock[];
  try {
    blocks = readDocxBlocks(file.bytes);
  } catch {
    return null;
  }
  const cands = specCandidates(blocks);
  const spec = pickSpecTable(cands);
  return spec ? { blocks, spec, others: cands.filter((c) => c !== spec) } : null;
}

/**
 * Строки таблицы спецификации — по колонкам с нормализацией моделью (как xlsx); к дверям прикладывается раздел ТЗ о комплектации:
 * строка ссылается на него («см. раздел 15») или в нём есть обозначение позиции (ДПС, EI60, номер ГОСТ).
 */
async function parseDocxSpec(d: DraftFileDeps, found: NonNullable<ReturnType<typeof findDocxSpec>>, filename: string): Promise<TableParsed> {
  const { blocks, spec, others } = found;
  const tables = blocks.filter((b) => b.kind === 'table').length;
  d.onProgress?.(`${filename}: таблиц ${tables}, спецификация — таблица ${spec.table.n}${spec.title ? ` («${spec.title.slice(0, 80)}»)` : ''}, строк с количеством ${spec.items}`);
  const rows = tableRows(spec.table);
  const parsed = await parseRows(rows, tableOptions(d, filename));
  if (others.length) parsed.warnings.push(`ещё таблиц с колонками «наименование / количество»: ${others.length} (${others.map((c) => c.table.n).join(', ')}) — позиции взяты только из таблицы ${spec.table.n}`);
  const sections = equipmentSections(blocks);
  const h = detectHeader(rows);
  if (sections.length && h) {
    // Позиции идут в порядке строк таблицы (parseRows по колонкам): i-я позиция — i-я строка.
    const raw = tableItems(rows, h.index + 1, h.cols).items;
    parsed.data.positions = parsed.data.positions.map((p, i) => {
      if (p.kind === 'service' || categoryOf(`${p.name} | ${p.marking ?? ''}`) !== 'door') return p;
      const s = equipmentFor([p.marking, p.name, raw[i]?.raw ?? ''].filter(Boolean).join(' | '), sections);
      return s ? { ...p, tzEquipment: `раздел «${s.title}»: ${s.text}`.slice(0, MAX_TZ_EQUIPMENT) } : p;
    });
    const attached = parsed.data.positions.filter((p) => p.tzEquipment).length;
    if (attached) d.onProgress?.(`${filename}: комплектация из ТЗ приложена к ${attached} поз.`);
  }
  parsed.data.summary = `${parsed.data.summary} Word: таблица ${spec.table.n} из ${tables}${spec.title ? ` («${spec.title.slice(0, 80)}»)` : ''}.`;
  return parsed;
}

/** Комплектация из ТЗ у позиции — не длиннее (заголовок раздела и текст). */
const MAX_TZ_EQUIPMENT = 1600;

const tableOptions = (d: DraftFileDeps, filename: string): TableParseOptions => ({
  llm: d.llm,
  route: d.route,
  settings: d.settings,
  ...(d.pricing ? { pricing: d.pricing } : {}),
  filename,
  ...(d.chunkRows ? { chunkRows: d.chunkRows } : {}),
  ...(d.onProgress ? { onProgress: d.onProgress } : {}),
  ...(d.known ? { known: d.known } : {}),
});

export async function analyzeDraftFile(d: DraftFileDeps, orig: OfficeFile): Promise<ParsedFile> {
  const t0 = Date.now();
  const file = await convertLegacyOffice(orig);
  const word = isWordDocx(file) ? findDocxSpec(file) : null;
  if (!isSpreadsheet(file) && !word) {
    const r = await d.docs.analyze({ accountId: d.accountId, leadId: d.leadId, source: 'widget', filename: file.filename, mime: file.mime, bytes: file.bytes, settings: d.settings, createdBy: d.userId, hint: 'request', route: d.route });
    return { id: r.id, filename: orig.filename, kind: r.kind, positions: r.data.positions, questions: r.data.questions, requirements: r.data.requirements, ms: Date.now() - t0, method: 'docs', chunks: 1, model: `${r.provider}/${r.model}`, warnings: [], costUsd: r.costUsd };
  }
  // Дневной лимит разбора — тот же, что у @core/docs: таблица тоже считается одним документом.
  if ((await d.documents.countToday(d.accountId)) >= d.settings.vision.maxFilesPerDay) {
    throw new Error(`Достигнут дневной лимит разбора файлов (${d.settings.vision.maxFilesPerDay})`);
  }
  const t = word ? await parseDocxSpec(d, word, orig.filename) : await parseTable(file.bytes, tableOptions(d, orig.filename));
  const id = await d.documents.add({
    accountId: d.accountId,
    leadId: d.leadId,
    source: 'widget',
    filename: orig.filename,
    mime: file.mime,
    sizeBytes: file.bytes.byteLength,
    format: word ? 'docx' : 'xlsx',
    ocr: null,
    kind: t.data.kind,
    data: { ...t.data, matches: [], kit: null, parse: { method: t.method, chunks: t.chunks, warnings: t.warnings, knownFromKb: t.knownFromKb } },
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
    knownFromKb: t.knownFromKb,
  };
}
