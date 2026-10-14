import type { LlmClient, LlmRequest, LlmResponse } from '@retail/agent';
import type { CatalogRepo } from '@retail/catalog';
import { defaultSettings, type DocumentsRepo, type NewDocument } from '@core/db';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { analyzeDocument, DocumentError, DocumentService, documentJsonSchema, type DocumentData, type OcrProvider } from '../src/index.ts';

const baseDoc: DocumentData = {
  kind: 'request',
  title: 'Запрос КП',
  summary: 'Запрос на 3 двери.',
  customer_type: 'b2b',
  openings: [],
  positions: [
    { name: 'Дверь межкомнатная AquaDoor влагостойкая', marking: null, width_mm: 700, height_mm: 2000, qty: 2, unit: 'шт', price_rub: null, material: 'ПВХ', color: 'белый', fireproof: null, note: null },
    { name: 'Дверь ДПС 01 EI30', marking: 'ДПС 01 2340х960 Л EI30', width_mm: 960, height_mm: 2340, qty: 1, unit: 'шт', price_rub: null, material: 'сталь', color: null, fireproof: true, note: null },
  ],
  requirements: ['поставка до 30.09'],
  questions: [],
  photo: null,
};

function fakeLlm(data: unknown, capture?: (req: LlmRequest) => void): LlmClient {
  return {
    async create(req) {
      capture?.(req);
      return {
        id: 'm',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'text', text: JSON.stringify(data), citations: null }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      } as unknown as LlmResponse;
    },
  };
}

const catalog = {
  async search(_acc: number, q: { query?: string }) {
    return /aquadoor/i.test(q.query ?? '') ? [{ id: 'p1', name: 'AquaDoor Белый', price: 9900, url: 'https://x/p1' }] : [];
  },
} as unknown as CatalogRepo;

function fakeRepo() {
  const saved: NewDocument[] = [];
  const repo = { async add(d: NewDocument) { saved.push(d); return saved.length; }, async countToday() { return saved.length; } } as unknown as DocumentsRepo;
  return { repo, saved };
}

async function xlsxBytes(rows: unknown[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Лист1');
  for (const r of rows) ws.addRow(r);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

describe('analyzeDocument', () => {
  it('structured output: схема в output_config, текст в <document>, подсказки ГОСТ', async () => {
    let req: LlmRequest | null = null;
    const r = await analyzeDocument(fakeLlm(baseDoc, (x) => (req = x)), defaultSettings(), { text: '1\tДВ 1 Рп 23,8х10 Г ПрБ\t2', filename: 'spec.xlsx' });
    expect(r.data.kind).toBe('request');
    expect(r.cost.usd).toBeGreaterThan(0);
    const format = (req!.output_config as { format: { type: string; schema: Record<string, unknown> } }).format;
    expect(format.type).toBe('json_schema');
    expect(format.schema).toEqual(documentJsonSchema());
    expect(format.schema).not.toHaveProperty('$schema');
    const text = (req!.messages[0]!.content as { type: string; text?: string }[]).map((b) => b.text ?? '').join('\n');
    expect(text).toContain('<document>\n1\tДВ 1 Рп 23,8х10 Г ПрБ\t2\n</document>');
    expect(text).toContain('→ деревянная, внутренняя, глухая, распашная, 2380×1000 мм');
    expect(text).toContain('Имя файла: spec.xlsx');
  });

  it('невалидный ответ — ошибка, а не выдумка', async () => {
    await expect(analyzeDocument(fakeLlm({ kind: 'nope' }), defaultSettings(), { text: 'x' })).rejects.toThrow(/схеме/);
  });
});

describe('DocumentService', () => {
  const settings = defaultSettings();

  it('XLSX → чистка ПДн → LLM → каталог → запись без файла; текст и примечание', async () => {
    const { repo, saved } = fakeRepo();
    let llmText = '';
    const svc = new DocumentService({
      llm: fakeLlm(baseDoc, (r) => (llmText = JSON.stringify(r.messages))),
      catalog,
      documents: repo,
      ocr: () => null,
    });
    const bytes = await xlsxBytes([['Контактное лицо: Иванов Иван Иванович, +7 912 345-67-89'], ['1', 'Дверь AquaDoor 700х2000', '2'], ['2', 'ДПС 01 2340х960 Л EI30', '1']]);
    const r = await svc.analyze({ accountId: 1, leadId: 10, source: 'widget', filename: 'запрос.xlsx', mime: '', bytes, settings, createdBy: 5 });
    expect(llmText).not.toMatch(/Иванов|345-67/);
    expect(r.piiRemoved).toBeGreaterThan(0);
    expect(r.matches[0]).toMatchObject({ index: 0, flags: [], products: [{ id: 'p1' }] });
    expect(r.matches[1]!.flags).toEqual(['fireproof', 'steel', 'nonstandard_size']);
    expect(r.text).toContain('[Файл «запрос.xlsx»: Запрос / спецификация] Запрос на 3 двери.');
    expect(r.text).toContain('противопожарная — не ассортимент');
    expect(r.text).toContain('похоже: AquaDoor Белый 9900 ₽ (id p1)');
    expect(r.note).toContain('[AI] Разбор файла «запрос.xlsx»');
    expect(r.note).toContain('Условия:\n• поставка до 30.09');
    expect(saved[0]).toMatchObject({ accountId: 1, leadId: 10, source: 'widget', format: 'xlsx', ocr: null, kind: 'request', createdBy: 5, sizeBytes: bytes.byteLength });
    expect(saved[0]!.data).toHaveProperty('matches');
  });

  it('фото замерного листа: OCR → проёмы → комплект и память', async () => {
    const { repo } = fakeRepo();
    const ocr: OcrProvider = { name: 'yandex', async recognize() { return { provider: 'yandex', pages: [], text: 'Спальня\t838\t2050\t105\nЗал\t1400\t2060\t235' }; } };
    const measurement: DocumentData = {
      ...baseDoc,
      kind: 'measurement',
      title: 'Замерный лист',
      summary: 'Два проёма.',
      customer_type: 'b2c',
      positions: [],
      requirements: [],
      openings: [
        { room: 'Спальня', label: null, width_mm: 838, height_mm: 2050, wall_mm: 105, leaf_width_mm: null, qty: 1, double: null, side: null, note: null },
        { room: 'Зал', label: null, width_mm: 1400, height_mm: 2060, wall_mm: 235, leaf_width_mm: null, qty: 1, double: true, side: null, note: null },
      ],
    };
    const svc = new DocumentService({ llm: fakeLlm(measurement), catalog, documents: repo, ocr: (p) => (p === 'yandex' ? ocr : null) });
    const r = await svc.analyze({ accountId: 1, leadId: 10, source: 'chat', filename: 'IMG_1.jpg', mime: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]), settings });
    expect(r.ocr).toBe('yandex');
    expect(r.kit!.totals).toEqual({ doors: 2, boxes: 5.5, casings: 11, extensions: 5.5 });
    expect(r.memoryOpenings).toEqual([
      { room: 'Спальня', width_mm: 838, height_mm: 2050, wall_mm: 105, qty: 1 },
      { room: 'Зал', width_mm: 1400, height_mm: 2060, wall_mm: 235, qty: 1 },
    ]);
    expect(r.note).toContain('→ полотно 700×2000');
    expect(r.note).toContain('Комплект: полотен 2, коробок 5.5, наличников 11, доборов 5.5 (100/250 мм).');
  });

  it('фото без текста уходит в Claude картинкой только при разрешении', async () => {
    const { repo } = fakeRepo();
    const ocr: OcrProvider = { name: 'yandex', async recognize() { return { provider: 'yandex', pages: [], text: '' }; } };
    let hasImage = false;
    const photo: DocumentData = { ...baseDoc, kind: 'photo', positions: [], requirements: [], customer_type: 'unknown', photo: { subject: 'дверь', door_type: 'межкомнатная', color: 'белая', style: 'классика', note: null } };
    const llm = fakeLlm(photo, (r) => (hasImage = (r.messages[0]!.content as { type: string }[]).some((b) => b.type === 'image')));
    const svc = new DocumentService({ llm, catalog, documents: repo, ocr: () => ocr });
    const r = await svc.analyze({ accountId: 1, leadId: 1, source: 'chat', filename: 'door.jpg', mime: 'image/jpeg', bytes: new Uint8Array([1]), settings });
    expect(hasImage).toBe(true);
    expect(r.text).toContain('Фото: дверь, межкомнатная, белая, классика');

    const strict = { ...settings, vision: { ...settings.vision, photosToClaude: false } };
    await expect(svc.analyze({ accountId: 1, leadId: 1, source: 'chat', filename: 'door.jpg', mime: 'image/jpeg', bytes: new Uint8Array([1]), settings: strict })).rejects.toThrow(/выключен/);
  });

  it('фото документа (смета в WhatsApp): картинку видит модель с vision вместе с текстом OCR; OCR упал или выключен — всё равно разбирается (RFD-AI-AGENT-WA-PHOTO, п. 3)', async () => {
    const { repo, saved } = fakeRepo();
    const estimate: DocumentData = { ...baseDoc, kind: 'estimate', title: 'Смета', summary: 'Дверь и фурнитура.', positions: [{ name: 'Дверь межкомнатная массив дуба', marking: null, width_mm: 900, height_mm: 2000, qty: 1, unit: 'компл.', price_rub: 93_833.33, material: 'массив дуба', color: null, fireproof: null, note: 'коробка 78×38, наличник 80/2200, добор 250/2200' }], questions: ['фото нечёткое, уточнить: строка 5'] };
    const seen: LlmRequest[] = [];
    const llm = fakeLlm(estimate, (r) => seen.push(r));
    const ocr: OcrProvider = { name: 'tesseract', async recognize() { return { provider: 'tesseract', pages: [], text: 'Дверь массив дуба 900х2000 93 833,33\nФурнитура 22 633,33' }; } };
    const svc = new DocumentService({ llm, catalog, documents: repo, ocr: () => ocr });
    const r = await svc.analyze({ accountId: 1, leadId: 1, source: 'chat', filename: 'photo.jpeg', mime: 'image/jpeg', bytes: new Uint8Array([1, 2]), settings });
    const blocks = seen[0]!.messages[0]!.content as { type: string; text?: string }[];
    expect(blocks.some((b) => b.type === 'image')).toBe(true);
    expect(blocks.find((b) => b.type === 'text')?.text).toContain('Дверь массив дуба 900х2000 93 833,33');
    expect(blocks.find((b) => b.type === 'text')?.text).toContain('разберите его как скан');
    expect(r.ocr).toBe('tesseract');
    expect(r.kind).toBe('estimate');
    expect(r.text).toContain('фото нечёткое, уточнить');
    expect(saved[0]).toMatchObject({ format: 'image', ocr: 'tesseract', kind: 'estimate' });
    // OCR упал — фото всё равно уходит модели, в записи ocr = null.
    const broken: OcrProvider = { name: 'tesseract', async recognize() { throw new Error('Tesseract не запустился'); } };
    const r2 = await new DocumentService({ llm, catalog, documents: repo, ocr: () => broken }).analyze({ accountId: 1, leadId: 1, source: 'chat', filename: 'photo.jpeg', mime: 'image/jpeg', bytes: new Uint8Array([1, 2]), settings });
    expect(r2.ocr).toBeNull();
    expect(r2.kind).toBe('estimate');
    // OCR выключен — модель с vision разбирает фото сама.
    const r3 = await new DocumentService({ llm, catalog, documents: repo, ocr: () => null }).analyze({ accountId: 1, leadId: 1, source: 'chat', filename: 'photo.jpeg', mime: 'image/jpeg', bytes: new Uint8Array([1, 2]), settings });
    expect(r3.kind).toBe('estimate');
    // «Фото — модели» выключено: только OCR, его сбой — ошибка с этапом ocr.
    const strict = { ...settings, vision: { ...settings.vision, photosToClaude: false } };
    const err = await new DocumentService({ llm, catalog, documents: repo, ocr: () => broken }).analyze({ accountId: 1, leadId: 1, source: 'chat', filename: 'photo.jpeg', mime: 'image/jpeg', bytes: new Uint8Array([1, 2]), settings: strict }).catch((e: DocumentError) => e);
    expect(err).toBeInstanceOf(DocumentError);
    expect(err).toMatchObject({ stage: 'ocr', message: 'Распознавание: Tesseract не запустился' });
  });

  it('OCR выключен — понятная ошибка; без LLM — ошибка', async () => {
    const { repo } = fakeRepo();
    const strict = { ...settings, vision: { ...settings.vision, photosToClaude: false } };
    const svc = new DocumentService({ llm: fakeLlm(baseDoc), catalog, documents: repo, ocr: () => null });
    await expect(svc.analyze({ accountId: 1, leadId: 1, source: 'chat', filename: 'a.jpg', mime: 'image/jpeg', bytes: new Uint8Array([1]), settings: strict })).rejects.toMatchObject({ name: 'DocumentError', stage: 'ocr' });
    const none = new DocumentService({ llm: null, catalog, documents: repo, ocr: () => null });
    await expect(none.analyze({ accountId: 1, leadId: 1, source: 'chat', filename: 'a.txt', mime: 'text/plain', bytes: new Uint8Array([65]), settings })).rejects.toThrow(/LLM/);
  });
});
