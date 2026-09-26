import type { LlmClient } from '@ai-door/agent';
import type { CatalogRepo } from '@ai-door/catalog';
import type { DocumentSource, DocumentsRepo, WidgetSettings } from '@ai-door/db';
import { analyzeDocument } from './analyze.ts';
import type { DwgConverter } from './dwg.ts';
import { extract, ExtractError, type Extracted } from './extract.ts';
import { estimateKit, type KitEstimate } from './kit.ts';
import { matchPositions, type PositionMatch } from './match.ts';
import type { OcrProvider } from './ocr.ts';
import { cleanPersonalData } from './pii.ts';
import { documentToNote, documentToText } from './render.ts';
import type { DocumentData } from './schema.ts';

export interface DocumentServiceDeps {
  llm: LlmClient | null;
  catalog: CatalogRepo;
  documents: DocumentsRepo;
  /** OCR по настройке аккаунта; null — выключен или нет ключа. */
  ocr(provider: WidgetSettings['vision']['provider']): OcrProvider | null;
  /** Конвертер DWG → DXF (в тестах подменяется). */
  dwg?: DwgConverter;
}

export interface AnalyzeFileInput {
  accountId: number;
  leadId: number | null;
  source: DocumentSource;
  filename: string;
  mime: string;
  bytes: Uint8Array;
  settings: WidgetSettings;
  createdBy?: number | null;
  hint?: 'measurement' | 'request' | 'photo';
}

export interface DocumentResult {
  id: number;
  kind: DocumentData['kind'];
  data: DocumentData;
  matches: PositionMatch[];
  /** Комплект по замерному листу (полотно, коробки, наличники, доборы). */
  kit: KitEstimate | null;
  format: Extracted['format'];
  ocr: string | null;
  piiRemoved: number;
  textChars: number;
  costUsd: number;
  model: string;
  /** Кратко для контекста агента. */
  text: string;
  /** Примечание в сделку для менеджера. */
  note: string;
  /** Проёмы для памяти клиента. */
  memoryOpenings: { room?: string; width_mm?: number; height_mm?: number; wall_mm?: number; qty?: number }[];
}

export class DocumentError extends Error {
  override name = 'DocumentError';
}

/** Фото без текста короче этого — считаем фотографией двери/проёма, не документом. */
const PHOTO_TEXT_THRESHOLD = 40;
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/**
 * Разбор файла клиента (media.parse_document / media.analyze_image, раздел 4 ТЗ):
 * извлечение текста → OCR при необходимости → чистка ПДн → структура через LLM →
 * сопоставление с каталогом → запись результата (без самого файла).
 */
export class DocumentService {
  constructor(private readonly d: DocumentServiceDeps) {}

  async analyze(input: AnalyzeFileInput): Promise<DocumentResult> {
    const { settings } = input;
    if (!this.d.llm) throw new DocumentError('LLM не настроена (ANTHROPIC_API_KEY)');
    if ((await this.d.documents.countToday(input.accountId)) >= settings.vision.maxFilesPerDay) {
      throw new DocumentError(`Достигнут дневной лимит разбора файлов (${settings.vision.maxFilesPerDay})`);
    }
    let extracted: Extracted;
    try {
      extracted = await extract(input.bytes, input.mime, input.filename, this.d.dwg ? { dwg: this.d.dwg } : {});
    } catch (err) {
      throw new DocumentError(err instanceof ExtractError ? err.message : `Файл не читается: ${(err as Error).message}`);
    }

    let text = extracted.text;
    let ocrName: string | null = null;
    let image: { bytes: Uint8Array; mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' } | undefined;
    if (extracted.needsOcr) {
      const ocr = this.d.ocr(settings.vision.provider);
      if (!ocr) throw new DocumentError(extracted.format === 'image' ? 'Распознавание фото выключено (настройка «Файлы и фото клиентов»)' : 'В PDF нет текста, а распознавание сканов выключено');
      try {
        const r = await ocr.recognize(input.bytes, mimeFor(extracted, input.mime));
        ocrName = r.provider;
        text = [text, r.text].filter((x) => x.trim()).join('\n');
      } catch (err) {
        throw new DocumentError(`Распознавание: ${(err as Error).message}`);
      }
    }
    // Фото без текста (дверь, проём, интерьер): картинку смотрит Claude, если заказчик это разрешил.
    const mimeLower = input.mime.toLowerCase().split(';')[0]?.trim() ?? '';
    if (extracted.format === 'image' && text.trim().length < PHOTO_TEXT_THRESHOLD) {
      if (!settings.vision.photosToClaude) throw new DocumentError('На фото нет текста, а анализ фотографий моделью выключен');
      if (!IMAGE_MIMES.has(mimeLower)) throw new DocumentError(`Формат фото ${mimeLower || 'неизвестен'} не поддерживается`);
      image = { bytes: input.bytes, mime: mimeLower as NonNullable<typeof image>['mime'] };
    }

    const cleaned = cleanPersonalData(text);
    const analyzed = await analyzeDocument(this.d.llm, settings, {
      text: cleaned.text,
      filename: input.filename,
      ...(image ? { image } : {}),
      ...(input.hint ? { hint: input.hint } : image ? { hint: 'photo' as const } : {}),
    });
    const data = analyzed.data;
    const matches = await matchPositions(this.d.catalog, input.accountId, data);
    const kit = data.kind === 'measurement' && data.openings.length ? estimateKit(data.openings) : null;

    const id = await this.d.documents.add({
      accountId: input.accountId,
      leadId: input.leadId,
      source: input.source,
      filename: input.filename,
      mime: input.mime,
      sizeBytes: input.bytes.byteLength,
      format: extracted.format,
      ocr: ocrName,
      kind: data.kind,
      data: { ...data, matches, kit },
      textChars: cleaned.text.length,
      piiRemoved: cleaned.removed,
      model: analyzed.model,
      costUsd: analyzed.cost.usd,
      createdBy: input.createdBy ?? null,
    });
    const result: DocumentResult = {
      id,
      kind: data.kind,
      data,
      matches,
      kit,
      format: extracted.format,
      ocr: ocrName,
      piiRemoved: cleaned.removed,
      textChars: cleaned.text.length,
      costUsd: analyzed.cost.usd,
      model: analyzed.model,
      text: '',
      note: '',
      memoryOpenings: data.openings
        .filter((o) => o.width_mm || o.height_mm)
        .slice(0, 50)
        .map((o) => ({
          ...(o.room ? { room: o.room.slice(0, 100) } : {}),
          ...(o.width_mm && o.width_mm >= 300 && o.width_mm <= 3000 ? { width_mm: Math.round(o.width_mm) } : {}),
          ...(o.height_mm && o.height_mm >= 1000 && o.height_mm <= 3500 ? { height_mm: Math.round(o.height_mm) } : {}),
          ...(o.wall_mm && o.wall_mm >= 50 && o.wall_mm <= 1000 ? { wall_mm: Math.round(o.wall_mm) } : {}),
          ...(o.qty && o.qty >= 1 && o.qty <= 100 ? { qty: Math.round(o.qty) } : {}),
        })),
    };
    result.text = documentToText(result, input.filename);
    result.note = documentToNote(result, input.filename);
    return result;
  }
}

function mimeFor(e: Extracted, mime: string): string {
  if (e.format === 'pdf') return 'application/pdf';
  const m = mime.toLowerCase().split(';')[0]?.trim() ?? '';
  return m || 'image/jpeg';
}
