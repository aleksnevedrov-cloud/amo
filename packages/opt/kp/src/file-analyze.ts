import type { DocumentsRepo, WidgetSettings } from '@core/db';
import type { DocumentService } from '@core/docs';
import { costOfUsage, type ChatRoute, type LlmGateway, type PricingOverrides } from '@core/llm';
import { categoryOf } from '@opt/kb';
import { convertLegacyOffice, type OfficeFile } from './convert.ts';
import { equipmentFor, equipmentSections, looksLikeRequisites, matrixPositions, pickSpecTable, readDocxBlocks, requirementsOf, specCandidates, tableRows, type DocxBlock, type DocxTable, type MatrixPosition, type SpecTable } from './docx-spec.ts';
import type { ParsedFile } from './draft.ts';
import { askByText, clipRaw, isRetryableParseError, localText, validateDocument, type AskResult, type ParseAttempt } from './request-parse.ts';
import type { DocumentData } from '@core/docs';
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
  /** KP-PARSE-RETRY: последний сырой ответ модели на разбор документа @core/docs (шлюз с записью); нет — сырой ответ не виден. */
  lastRaw?: () => string | null;
  resetRaw?: () => void;
}

/** KP-PARSE-RETRY: файл не разобран ни разбором, ни повторами, ни запасным путём — причина и попытки (в окно КП и журнал). */
export class FileParseError extends Error {
  override name = 'FileParseError';
  constructor(
    message: string,
    public readonly attempts: ParseAttempt[],
  ) {
    super(message);
  }
}

/** Таблица Excel (после конвертации старого .xls тоже xlsx). */
export const isSpreadsheet = (file: Pick<OfficeFile, 'filename' | 'mime'>): boolean =>
  /spreadsheetml|ms-excel/i.test(file.mime) || /\.(xlsx|xlsm)$/i.test(file.filename);

/** Документ Word (после конвертации .doc / .rtf / .odt тоже docx). */
export const isWordDocx = (file: Pick<OfficeFile, 'filename' | 'mime'>): boolean => /wordprocessingml/i.test(file.mime) || /\.docx$/i.test(file.filename);

/**
 * KP-DOCX-APPENDIX / KP-AGENT-V2, п. 2: что в Word-файле, без модели — таблица спецификации, матрица характеристик (позиция —
 * колонка или блок строк) или реквизиты предприятия (не заявка). Ничего из этого — null: документ целиком в @core/docs.
 */
type DocxFound =
  | { kind: 'spec'; blocks: DocxBlock[]; spec: SpecTable; others: SpecTable[] }
  | { kind: 'matrix'; blocks: DocxBlock[]; table: DocxTable; positions: MatrixPosition[] }
  | { kind: 'requisites' };
function findDocxSpec(file: OfficeFile): DocxFound | null {
  let blocks: DocxBlock[];
  try {
    blocks = readDocxBlocks(file.bytes);
  } catch {
    return null;
  }
  const cands = specCandidates(blocks);
  const spec = pickSpecTable(cands);
  if (spec) return { kind: 'spec', blocks, spec, others: cands.filter((c) => c !== spec) };
  const matrices = blocks.filter((b): b is DocxTable => b.kind === 'table').map((t) => ({ table: t, positions: matrixPositions(t) })).filter((m) => m.positions.length >= 2).sort((a, b) => b.positions.length - a.positions.length);
  if (matrices[0]) return { kind: 'matrix', blocks, ...matrices[0] };
  const text = blocks.map((b) => (b.kind === 'p' ? b.text : b.rows.map((r) => r.join(' ')).join(' '))).join(' ');
  if (looksLikeRequisites(text)) return { kind: 'requisites' };
  return null;
}

/** Матрица характеристик → позиции без модели: название, размер, остальное в примечание; нет количества — «уточнить» (qty null). */
function matrixParsed(found: Extract<DocxFound, { kind: 'matrix' }>, filename: string): TableParsed {
  const positions = found.positions.map((m) => ({ name: m.name, marking: null, width_mm: m.widthMm, height_mm: m.heightMm, qty: m.qty, unit: 'шт', price_rub: null, material: null, color: null, fireproof: null, note: m.note, kind: 'product' as const }));
  const noQty = positions.filter((p) => p.qty === null).length;
  return {
    data: { kind: 'request', title: filename.replace(/\.[^.]+$/, '').slice(0, 80), summary: `Матрица характеристик (таблица ${found.table.n}): позиций ${positions.length}${noQty ? `, без количества ${noQty} — уточнить` : ''}.`, customer_type: 'unknown', openings: [], positions, requirements: requirementsOf(found.blocks, null), questions: [], photo: null },
    method: 'columns', chunks: [], cost: { inputTokens: 0, outputTokens: 0, usd: 0 }, model: null, provider: null, warnings: noQty ? [`количество не указано у ${noQty} поз. — вопрос менеджеру`] : [], textChars: 0, piiRemoved: 0, knownFromKb: 0,
  };
}

/**
 * Строки таблицы спецификации — по колонкам с нормализацией моделью (как xlsx); к дверям прикладывается раздел ТЗ о комплектации:
 * строка ссылается на него («см. раздел 15») или в нём есть обозначение позиции (ДПС, EI60, номер ГОСТ).
 */
async function parseDocxSpec(d: DraftFileDeps, found: Extract<DocxFound, { kind: 'spec' }>, filename: string): Promise<TableParsed> {
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
      // № п/п строки — первая ячейка-число («14 | Дверь ДПС 01 …»), иначе порядковый номер.
      const rowNo = Number(/^\s*(\d{1,3})\s*\|/.exec(raw[i]?.raw ?? '')?.[1] ?? i + 1);
      const hit = equipmentFor([p.marking, p.name, raw[i]?.raw ?? ''].filter(Boolean).join(' | '), sections, rowNo);
      return hit ? { ...p, tzEquipment: `раздел «${hit.section.title}»: ${hit.text}`.slice(0, MAX_TZ_EQUIPMENT) } : p;
    });
    const attached = parsed.data.positions.filter((p) => p.tzEquipment).length;
    if (attached) d.onProgress?.(`${filename}: комплектация из ТЗ приложена к ${attached} поз.`);
  }
  parsed.data.requirements = [...new Set([...parsed.data.requirements, ...requirementsOf(blocks, spec.table)])];
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
  // Карточка предприятия — не заявка: без модели и без записи документа.
  if (word?.kind === 'requisites') return { id: 0, filename: orig.filename, kind: 'requisites', positions: [], questions: [], requirements: [], ms: Date.now() - t0, method: 'skipped', chunks: 0, model: null, warnings: ['реквизиты предприятия — не заявка'], costUsd: 0 };
  if (!isSpreadsheet(file) && !word) return analyzeWithRetry(d, file, orig.filename, t0);
  // Дневной лимит разбора — тот же, что у @core/docs: таблица тоже считается одним документом.
  if ((await d.documents.countToday(d.accountId)) >= d.settings.vision.maxFilesPerDay) {
    throw new Error(`Достигнут дневной лимит разбора файлов (${d.settings.vision.maxFilesPerDay})`);
  }
  const t = word?.kind === 'spec' ? await parseDocxSpec(d, word, orig.filename) : word?.kind === 'matrix' ? matrixParsed(word, orig.filename) : await parseTable(file.bytes, tableOptions(d, orig.filename));
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
    method: word?.kind === 'matrix' ? 'matrix' : t.method,
    chunks: t.chunks.length,
    model: t.model ? `${t.provider}/${t.model}` : null,
    warnings: t.warnings,
    costUsd: t.cost.usd,
    knownFromKb: t.knownFromKb,
  };
}

/**
 * KP-PARSE-RETRY: разбор документа @core/docs с повтором и запасным путём.
 * 1) разбор @core/docs; ответ не по схеме — сырой ответ в журнал и починка без нового запроса (недостающие необязательные
 *    поля — null / []); 2) повтор того же разбора; 3) запрос по тексту файла с текстом ошибки проверки; 4) запасной путь —
 *    только список позиций по тексту. Ничего не вышло — FileParseError с причиной: файл не выбрасывается молча.
 * Ошибки не про ответ модели (распознавание выключено, дневной лимит, файл не читается) — как раньше, без повторов.
 */
async function analyzeWithRetry(d: DraftFileDeps, file: OfficeFile, filename: string, t0: number): Promise<ParsedFile> {
  const attempts: ParseAttempt[] = [];
  const input = { accountId: d.accountId, leadId: d.leadId, source: 'widget' as const, filename: file.filename, mime: file.mime, bytes: file.bytes, settings: d.settings, createdBy: d.userId, hint: 'request' as const, route: d.route };
  let lastError = '';
  for (const n of [1, 2]) {
    try {
      d.resetRaw?.();
      const r = await d.docs.analyze(input);
      attempts.push({ n, via: n === 1 ? 'docs' : 'retry', ok: true, error: null, raw: null });
      // П. 2.5: картинка без позиций — фото-образец; текст скриншота разбирает модель с vision как раньше.
      const photo = /^image\//i.test(file.mime) && !r.data.positions.length;
      return { id: r.id, filename, kind: r.kind, positions: r.data.positions, questions: r.data.questions, requirements: r.data.requirements, ms: Date.now() - t0, method: 'docs', chunks: 1, model: `${r.provider}/${r.model}`, warnings: n > 1 ? [`разобран со ${n}-й попытки`] : [], costUsd: r.costUsd, ...(photo ? { photo: true } : {}), ...(n > 1 ? { attempts } : {}) };
    } catch (err) {
      if (!isRetryableParseError(err)) throw err;
      lastError = (err as Error).message;
      const raw = d.lastRaw?.() ?? null;
      attempts.push({ n, via: n === 1 ? 'docs' : 'retry', ok: false, error: lastError, raw: raw === null ? null : clipRaw(raw) });
      d.onProgress?.(`${filename}: попытка ${n} — ${lastError}`);
      // Ответ есть, но без необязательного поля — дописываем пустое значение, без нового запроса.
      const fixed = raw ? validateDocument(raw) : null;
      if (fixed?.ok) {
        attempts.push({ n, via: 'repair', ok: true, error: null, raw: null, repaired: fixed.repaired });
        return recordParsed(d, file, filename, t0, fixed.data, attempts, { model: null, costUsd: 0, warnings: [`ответ модели дополнен пустыми полями: ${fixed.repaired.join(', ') || '—'}`] });
      }
    }
  }
  const lt = await localText(file);
  if (!lt.text.trim()) throw new FileParseError(`${lastError}; повтор не помог, а текста в файле нет (скан или фото) — нажмите «Разобрать заново» или пришлите файл с текстом`, attempts);
  let cost = 0;
  const costOf = (a: AskResult) => (a.res ? costOfUsage({ provider: a.res.provider, model: a.res.model }, a.res.usage, d.pricing).usd : 0);
  for (const [n, mode] of [[3, 'document'], [4, 'positions']] as const) {
    d.onProgress?.(`${filename}: попытка ${n} — ${mode === 'document' ? 'по тексту файла с ошибкой проверки' : 'запасной путь: только позиции по тексту'}`);
    const a = await askByText(d.llm, d.route, { text: lt.text, filename, mode, errorHint: mode === 'document' ? lastError : null });
    cost += costOf(a);
    attempts.push({ n, via: mode === 'document' ? 'text+error' : 'positions', ok: Boolean(a.data), error: a.error, raw: a.data ? null : clipRaw(a.raw), ...(a.repaired.length ? { repaired: a.repaired } : {}) });
    if (a.data) {
      return recordParsed(d, file, filename, t0, a.data, attempts, {
        model: a.res ? `${a.res.provider}/${a.res.model}` : null,
        costUsd: cost,
        warnings: [mode === 'document' ? `разобран по тексту файла с ${n}-й попытки` : 'разобран запасным путём: только позиции по тексту файла — проверьте характеристики'],
        format: lt.format,
        textChars: lt.text.length,
        piiRemoved: lt.piiRemoved,
      });
    }
    lastError = a.error ?? lastError;
  }
  throw new FileParseError(`${lastError}; повторы и разбор по тексту не помогли`, attempts);
}

/** Разобранное повтором или запасным путём — запись документа (как у таблиц) и ParsedFile с попытками. */
async function recordParsed(d: DraftFileDeps, file: OfficeFile, filename: string, t0: number, data: DocumentData, attempts: ParseAttempt[], o: { model: string | null; costUsd: number; warnings: string[]; format?: string; textChars?: number; piiRemoved?: number }): Promise<ParsedFile> {
  const id = await d.documents.add({
    accountId: d.accountId,
    leadId: d.leadId,
    source: 'widget',
    filename,
    mime: file.mime,
    sizeBytes: file.bytes.byteLength,
    format: o.format ?? 'pdf',
    ocr: null,
    kind: data.kind,
    data: { ...data, matches: [], kit: null, parse: { method: 'retry', attempts: attempts.map((a) => ({ n: a.n, via: a.via, ok: a.ok, error: a.error })) } },
    textChars: o.textChars ?? 0,
    piiRemoved: o.piiRemoved ?? 0,
    model: o.model,
    costUsd: o.costUsd,
    createdBy: d.userId,
  });
  return { id, filename, kind: data.kind, positions: data.positions, questions: data.questions, requirements: data.requirements, ms: Date.now() - t0, method: 'docs', chunks: 1, model: o.model, warnings: o.warnings, costUsd: o.costUsd, attempts };
}
