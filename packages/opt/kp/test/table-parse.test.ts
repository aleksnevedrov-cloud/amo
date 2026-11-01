import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { LlmError, LlmUnavailableError, type LlmGateway, type RoutedRequest, type RoutedResponse } from '@core/llm';
import { describe, expect, it } from 'vitest';
import { analyzeDraftFile, isSpreadsheet, type DraftFileDeps } from '../src/file-analyze.ts';
import { columnsOf, detectHeader, detectHeaderless, isService, mergeNormalized, parseTable, readSheetRows, sizeFromText, tableItems, TABLE_CHUNK_ROWS } from '../src/table-parse.ts';
import { defaultOptSettings, toWidgetSettings } from '../src/settings.ts';

const route = { primary: { provider: 'openai' as const, model: 'gpt-5.5' }, fallback: { provider: 'openai' as const, model: 'gpt-5.1' } };
const settings = toWidgetSettings(defaultOptSettings());

/** xlsx из строк (null — пустая ячейка). */
async function xlsx(sheets: Record<string, (string | number | null)[][]>): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const r of rows) ws.addRow(r.map((c) => (c === null ? undefined : c)));
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/** Шлюз: ответ по функции от текста запроса; Error — бросить. Запоминает запросы. */
function gatewayBy(answer: (text: string, n: number) => string | Error) {
  const requests: RoutedRequest[] = [];
  const gateway: LlmGateway = {
    async chat(req, r) {
      requests.push(req);
      const last = req.messages[req.messages.length - 1];
      const text = typeof last?.content === 'string' ? last.content : (last?.content ?? []).map((p) => ('text' in p ? p.text : '')).join('\n');
      const a = answer(text, requests.length);
      if (a instanceof Error) throw a;
      const res: RoutedResponse = {
        text: a, toolCalls: [], stopReason: 'end', usage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0 },
        provider: r.primary.provider, model: r.primary.model, assistantMessage: { role: 'assistant', content: a }, latencyMs: 1, fallbackUsed: false, requested: r.primary, attempts: [],
      };
      return res;
    },
    providers: async () => ['openai'],
    provider: async () => null,
  };
  return { gateway, requests };
}

/** Номера строк «i. …» из текста запроса нормализации. */
const rowIndexes = (text: string): number[] => [...text.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
/** Ответ нормализации: имя «Изделие i», размер из текста строки модель не трогает. */
const normalizeAnswer = (text: string) =>
  JSON.stringify({ rows: rowIndexes(text).map((i) => ({ i, name: `Изделие ${i}`, marking: i % 10 === 0 ? `ДПМ-0${i / 10}` : null, width_mm: null, height_mm: null, material: i % 2 ? 'сталь' : null, color: null, fireproof: i % 10 === 0, note: null })) });
const timeout = (model = 'gpt-5.5') => new LlmUnavailableError(`openai/${model}: Request timed out; openai/gpt-5.1: Request timed out`, [{ ref: { provider: 'openai', model }, error: 'Request timed out', code: 'timeout' }, { ref: { provider: 'openai', model: 'gpt-5.1' }, error: 'Request timed out', code: 'timeout' }]);

/** Заявка как у сделки 30008823: заголовок, шапка, разделы по этажам, 49 строк, итог. */
function requestRows(): (string | number | null)[][] {
  const rows: (string | number | null)[][] = [['Заявка на двери. Москва'], [null], ['№', 'Наименование', 'Размер, мм', 'Кол-во, шт', 'Примечание'], ['1 этаж']];
  for (let i = 1; i <= 49; i += 1) {
    if (i === 26) rows.push(['2 этаж']);
    rows.push([i, `Дверь противопожарная ДПМ-01/60 ${i % 3 ? 'правая' : 'левая'}`, i % 5 ? '900х2100' : '1200×2100', i % 4 ? 1 : 2, i % 7 ? null : 'с доводчиком']);
  }
  rows.push(['Итого', null, null, 56]);
  return rows;
}

describe('таблица xlsx по колонкам (RFD-AI-AGENT-OPT-XLSX-TIMEOUT, п. 3)', () => {
  it('шапка: наименование + размер/кол-во; номер, цена и итог не колонки; ширина/высота двухуровневой шапки', () => {
    expect(columnsOf(['№', 'Наименование', 'Размер, мм', 'Кол-во, шт', 'Цена', 'Примечание'])).toMatchObject({ name: 1, size: 2, qty: 3, unit: null, extra: [{ col: 5, title: 'Примечание' }] });
    expect(columnsOf(['Позиция', 'Ширина', 'Высота', 'Ед. изм.', 'Количество'])).toMatchObject({ name: 0, width: 1, height: 2, unit: 3, qty: 4 });
    expect(columnsOf(['Заявка на двери. Москва'])).toBeNull();
    expect(columnsOf(['Наименование', 'Цвет'])).toBeNull();
    const two = detectHeader([
      { sheet: 's', row: 1, cells: ['Наименование', 'Размер', '', 'Кол-во'] },
      { sheet: 's', row: 2, cells: ['', 'ширина', 'высота', ''] },
      { sheet: 's', row: 3, cells: ['Дверь', '900', '2100', '2'] },
    ]);
    expect(two).toMatchObject({ index: 1, cols: { name: 0, width: 1, height: 2, qty: 3, size: null } });
  });

  it('строки: количество и размер из ячеек, раздел в примечание, метры и сантиметры → мм, размер из названия, итог пропущен', () => {
    const rows = [
      { sheet: 's', row: 1, cells: ['Наименование', 'Ширина, м', 'Высота, м', 'Кол-во', 'Открывание'] },
      { sheet: 's', row: 2, cells: ['Корпус А'] },
      { sheet: 's', row: 3, cells: ['Дверь входная', '0,9', '2,1', '3 шт', 'правое'] },
      { sheet: 's', row: 4, cells: ['Дверь техническая', '90', '210', '1', ''] },
      { sheet: 's', row: 5, cells: ['Люк 600×600', '', '', '2 компл.', ''] },
      { sheet: 's', row: 6, cells: ['', '', '', '5', ''] },
      { sheet: 's', row: 7, cells: ['Итого', '', '', '11', ''] },
    ];
    const h = detectHeader(rows);
    expect(h?.index).toBe(0);
    const { items, skippedRows } = tableItems(rows, 1, h?.cols as NonNullable<typeof h>['cols']);
    expect(skippedRows).toBe(1);
    expect(items.map((it) => [it.i, it.name, it.width_mm, it.height_mm, it.qty, it.unit, it.note])).toEqual([
      [1, 'Дверь входная', 900, 2100, 3, 'шт', 'раздел: Корпус А; Открывание: правое'],
      [2, 'Дверь техническая', 900, 2100, 1, null, 'раздел: Корпус А'],
      [3, 'Люк 600×600', 600, 600, 2, 'компл.', 'раздел: Корпус А'],
    ]);
    expect(items[0]?.raw).toBe('(Корпус А) Дверь входная | 0,9 | 2,1 | 3 шт | правое');
  });

  it('ответ модели не перекрывает количество и размер из файла; имя и обозначение — от модели', () => {
    const it0 = { i: 1, sheet: 's', row: 2, section: null, name: 'Дверь ДПМ 900х2100 2 шт', width_mm: 900, height_mm: 2100, qty: 2, unit: 'шт', note: 'раздел: 1 этаж', kind: 'product' as const, raw: '' };
    const p = mergeNormalized(it0, { i: 1, name: 'Дверь противопожарная ДПМ', marking: 'ДПМ-01/60', width_mm: 1000, height_mm: 2000, material: 'сталь', color: 'RAL 7035', fireproof: true, note: 'с доводчиком' });
    expect(p).toMatchObject({ name: 'Дверь противопожарная ДПМ', marking: 'ДПМ-01/60', width_mm: 900, height_mm: 2100, qty: 2, unit: 'шт', material: 'сталь', color: 'RAL 7035', fireproof: true, note: 'раздел: 1 этаж; с доводчиком', price_rub: null });
    // Размера в файле нет — берётся из ответа модели; пустое имя — остаётся как в файле.
    expect(mergeNormalized({ ...it0, width_mm: null, height_mm: null }, { i: 1, name: ' ', marking: null, width_mm: 1000, height_mm: 2000, material: null, color: null, fireproof: null, note: null })).toMatchObject({ name: 'Дверь ДПМ 900х2100 2 шт', width_mm: 1000, height_mm: 2000 });
  });

  it('49 строк: позиции по колонкам в порядке файла, модель нормализует порциями по 20 с общим контекстом', async () => {
    const bytes = await xlsx({ Заявка: requestRows() });
    expect((await readSheetRows(bytes)).length).toBe(54);
    const lines: string[] = [];
    const { gateway, requests } = gatewayBy((text) => normalizeAnswer(text));
    const r = await parseTable(bytes, { llm: gateway, route, settings, filename: 'Заявка на двери. Москва..xlsx', onProgress: (l) => lines.push(l) });
    expect(r.method).toBe('columns+model');
    expect(r.data.kind).toBe('request');
    expect(r.data.positions).toHaveLength(49);
    expect(r.chunks.map((c) => [c.from, c.to, c.ok, c.retried])).toEqual([[1, 20, true, false], [21, 40, true, false], [41, 49, true, false]]);
    expect(TABLE_CHUNK_ROWS).toBe(20);
    expect(requests).toHaveLength(3);
    // В каждой порции — файл, лист, колонки и строки с номерами; данные уже без размера/количества модель не меняет.
    expect(requests[1]?.messages[0]?.content).toEqual([{ type: 'text', text: expect.stringContaining('Колонки: № | Наименование | Размер, мм | Кол-во, шт | Примечание') }]);
    expect(rowIndexes((requests[1]?.messages[0]?.content as { text: string }[])[0]?.text ?? '')).toEqual(Array.from({ length: 20 }, (_, k) => 21 + k));
    expect(requests[0]?.outputSchema?.name).toBe('table_rows');
    // Количество и размер — из файла, имя — от модели, раздел — в примечании.
    expect(r.data.positions[0]).toMatchObject({ name: 'Изделие 1', width_mm: 900, height_mm: 2100, qty: 1, unit: 'шт', material: 'сталь', note: 'раздел: 1 этаж', price_rub: null });
    expect(r.data.positions[4]).toMatchObject({ name: 'Изделие 5', width_mm: 1200, height_mm: 2100, qty: 1 });
    expect(r.data.positions[3]).toMatchObject({ qty: 2 });
    expect(r.data.positions[9]).toMatchObject({ marking: 'ДПМ-01', fireproof: true });
    expect(r.data.positions[27]).toMatchObject({ name: 'Изделие 28', note: 'раздел: 2 этаж; Примечание: с доводчиком' });
    expect(r.data.positions.every((p) => p.qty && p.width_mm && p.height_mm)).toBe(true);
    expect(r.cost).toEqual({ inputTokens: 3000, outputTokens: 300, usd: expect.any(Number) });
    expect(r.model).toBe('gpt-5.5');
    expect(r.warnings).toEqual([]);
    expect(r.data.summary).toContain('49 позиций');
    expect(lines[0]).toContain('таблица по колонкам');
    expect(lines.filter((l) => /порция \d из 3 .*модель ответила/.test(l))).toHaveLength(3);
  });

  it('таймаут модели на порции: один повтор; после второго таймаута строки остаются как разобраны по колонкам, файл не пропадает', async () => {
    const bytes = await xlsx({ Заявка: requestRows() });
    // Первый вызов второй порции — таймаут, повтор удачный.
    let calls = 0;
    const once = gatewayBy((text) => {
      calls += 1;
      return calls === 2 ? timeout() : normalizeAnswer(text);
    });
    const lines: string[] = [];
    const r = await parseTable(bytes, { llm: once.gateway, route, settings, filename: 'z.xlsx', onProgress: (l) => lines.push(l) });
    expect(once.requests).toHaveLength(4);
    expect(r.chunks.map((c) => [c.ok, c.retried])).toEqual([[true, false], [true, true], [true, false]]);
    expect(r.data.positions[20]?.name).toBe('Изделие 21');
    expect(lines.some((l) => /порция 2 из 3 .*таймаут модели .*повтор/.test(l))).toBe(true);
    // Вторая порция не отвечает и после повтора — пометка, позиции 21–40 с названиями из файла, остальные нормализованы.
    const always = gatewayBy((text, n) => (n === 2 || n === 3 ? timeout() : normalizeAnswer(text)));
    const r2 = await parseTable(bytes, { llm: always.gateway, route, settings, filename: 'z.xlsx' });
    expect(always.requests).toHaveLength(4);
    expect(r2.method).toBe('columns+model');
    expect(r2.data.positions).toHaveLength(49);
    expect(r2.chunks[1]).toMatchObject({ from: 21, to: 40, ok: false, retried: true, error: expect.stringContaining('timed out') });
    expect(r2.data.positions[20]).toMatchObject({ name: 'Дверь противопожарная ДПМ-01/60 левая', width_mm: 900, height_mm: 2100, qty: 1 });
    expect(r2.data.positions[40]?.name).toBe('Изделие 41');
    expect(r2.warnings).toEqual([expect.stringMatching(/^строки 21–40: названия не нормализованы, оставлены как в файле — .*timed out/)]);
    // Ошибка не таймаут (ключ) — повтора нет, строки остаются по колонкам.
    const auth = gatewayBy((text, n) => (n === 1 ? new LlmError('auth', 'openai', 'Ключ не принят') : normalizeAnswer(text)));
    const r3 = await parseTable(bytes, { llm: auth.gateway, route, settings, filename: 'z.xlsx' });
    expect(auth.requests).toHaveLength(3);
    expect(r3.chunks[0]).toMatchObject({ ok: false, retried: false, error: 'Ключ не принят' });
    // Модель не ответила ни разу — способ «по колонкам», позиции на месте.
    const dead = gatewayBy(() => timeout());
    const r4 = await parseTable(bytes, { llm: dead.gateway, route, settings, filename: 'z.xlsx' });
    expect(r4.method).toBe('columns');
    expect(r4.data.positions).toHaveLength(49);
    expect(r4.model).toBeNull();
  });
});

/** Ответ @core/docs по схеме документа: позиции — строки «Дверь …» из текста порции. */
const docAnswer = (text: string) => {
  const names = [...text.matchAll(/^(Дверь[^\n|]*)/gm)].map((m) => (m[1] as string).trim());
  return JSON.stringify({
    kind: 'request',
    title: 'Заявка',
    summary: `Позиций ${names.length}.`,
    customer_type: 'b2b',
    openings: [],
    positions: names.map((name) => ({ name, marking: null, width_mm: 900, height_mm: 2100, qty: 1, unit: 'шт', price_rub: null, material: null, color: null, fireproof: null, note: null })),
    requirements: ['Доставка до объекта'],
    questions: [],
    photo: null,
  });
};

describe('таблица без шапки — модель порциями (п. 2)', () => {
  const freeRows = (): (string | number | null)[][] => {
    const rows: (string | number | null)[][] = [['ООО Ромашка, объект: школа'], ['Список дверей'], ['Блок А']];
    for (let i = 1; i <= 45; i += 1) {
      if (i === 23) rows.push(['Блок Б']);
      rows.push([`Дверь ${i} глухая 900х2100, ${i % 3 ? 1 : 2} шт`]);
    }
    return rows;
  };

  it('порции по 20 строк с контекстом (начало таблицы, раздел), позиции склеены в порядке файла, требования без повторов', async () => {
    const bytes = await xlsx({ Лист1: freeRows() });
    const { gateway, requests } = gatewayBy((text) => docAnswer(text));
    const lines: string[] = [];
    const r = await parseTable(bytes, { llm: gateway, route, settings, filename: 'список.xlsx', onProgress: (l) => lines.push(l) });
    expect(r.method).toBe('model-chunks');
    expect(requests).toHaveLength(3);
    expect(r.chunks.map((c) => [c.from, c.to, c.ok])).toEqual([[1, 20, true], [21, 40, true], [41, 49, true]]);
    expect(r.data.positions.map((p) => p.name)).toEqual(Array.from({ length: 45 }, (_, k) => `Дверь ${k + 1} глухая 900х2100, ${(k + 1) % 3 ? 1 : 2} шт`));
    expect(r.data.requirements).toEqual(['Доставка до объекта']);
    expect(r.data.summary).toContain('Разобрано порциями: 3');
    const second = (requests[1]?.messages[0]?.content as { text: string }[]).map((p) => p.text).join('\n');
    expect(second).toContain('Начало таблицы (контекст):\nООО Ромашка, объект: школа\nСписок дверей\nБлок А');
    expect(second).toContain('Раздел: Блок А');
    expect(second).toContain('Строки 21–40 из 49');
    expect(second).toContain('список.xlsx (строки 21–40 из 49)');
    expect(lines[0]).toContain('шапка таблицы не распознана');
    expect(r.cost.inputTokens).toBe(3000);
  });

  it('порция не ответила и после повтора — файл пропускается с причиной (п. 4)', async () => {
    const bytes = await xlsx({ Лист1: freeRows() });
    const { gateway, requests } = gatewayBy((text, n) => (n >= 2 ? timeout() : docAnswer(text)));
    await expect(parseTable(bytes, { llm: gateway, route, settings, filename: 'список.xlsx' })).rejects.toThrow(/^список\.xlsx: порция 2 из 3 \(строки 21–40\): .*timed out/);
    expect(requests).toHaveLength(3);
  });
});

describe('разбор файла для черновика (file-analyze.ts)', () => {
  const deps = (gateway: LlmGateway, docsCalls: string[], added: Record<string, unknown>[]): DraftFileDeps => ({
    docs: {
      analyze: async (i) => {
        docsCalls.push(i.filename);
        return { id: 500, kind: 'request', data: { kind: 'request', title: '', summary: '', customer_type: 'unknown', openings: [], positions: [], requirements: ['срок 10 дней'], questions: [] as string[], photo: null }, matches: [], kit: null, format: 'docx', ocr: null, piiRemoved: 0, textChars: 10, costUsd: 0.01, model: 'gpt-5.5', provider: 'openai', text: '', note: '', memoryOpenings: [] };
      },
    },
    documents: {
      add: async (d) => {
        added.push(d as unknown as Record<string, unknown>);
        return 700 + added.length;
      },
      countToday: async () => added.length,
    },
    llm: gateway,
    settings,
    route,
    accountId: 1,
    leadId: 30008823,
    userId: 5,
  });

  it('xlsx — по колонкам и порциями, документ записан один раз со способом разбора; docx — @core/docs; время разбора в ответе', async () => {
    expect(isSpreadsheet({ filename: 'Заявка на двери. Москва..xlsx', mime: 'application/octet-stream' })).toBe(true);
    expect(isSpreadsheet({ filename: 'x.bin', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })).toBe(true);
    expect(isSpreadsheet({ filename: 'ТЗ.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })).toBe(false);
    const docsCalls: string[] = [];
    const added: Record<string, unknown>[] = [];
    const { gateway, requests } = gatewayBy((text) => normalizeAnswer(text));
    const d = deps(gateway, docsCalls, added);
    const x = await analyzeDraftFile(d, { filename: 'Заявка на двери. Москва..xlsx', mime: 'application/octet-stream', bytes: await xlsx({ Заявка: requestRows() }) });
    expect(x).toMatchObject({ id: 701, kind: 'request', method: 'columns+model', chunks: 3, model: 'openai/gpt-5.5', warnings: [], ms: expect.any(Number) });
    expect(x.positions).toHaveLength(49);
    expect(requests).toHaveLength(3);
    expect(docsCalls).toEqual([]);
    expect(added[0]).toMatchObject({ accountId: 1, leadId: 30008823, source: 'widget', filename: 'Заявка на двери. Москва..xlsx', format: 'xlsx', kind: 'request', model: 'gpt-5.5', createdBy: 5 });
    const parse = (added[0]?.data as { parse: { method: string; chunks: { from: number; to: number; ok: boolean; ms: number }[]; warnings: string[] } }).parse;
    expect(parse.method).toBe('columns+model');
    expect(parse.chunks.map((c) => [c.from, c.to, c.ok])).toEqual([[1, 20, true], [21, 40, true], [41, 49, true]]);
    const w = await analyzeDraftFile(d, { filename: 'ТЗ.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: new Uint8Array([1, 2, 3]) });
    expect(w).toMatchObject({ id: 500, method: 'docs', chunks: 1, model: 'openai/gpt-5.5', requirements: ['срок 10 дней'], ms: expect.any(Number) });
    expect(docsCalls).toEqual(['ТЗ.docx']);
    expect(added).toHaveLength(1);
  });

  it('дневной лимит разбора действует и на таблицы', async () => {
    const { gateway } = gatewayBy((text) => normalizeAnswer(text));
    const d = deps(gateway, [], []);
    const limited: DraftFileDeps = { ...d, settings: { ...settings, vision: { ...settings.vision, maxFilesPerDay: 0 } } };
    await expect(analyzeDraftFile(limited, { filename: 'z.xlsx', mime: 'application/octet-stream', bytes: await xlsx({ Заявка: requestRows() }) })).rejects.toThrow('Достигнут дневной лимит разбора файлов (0)');
  });
});

describe('заявка без шапки: колонки A/B (RFD-AI-AGENT-OPT-XLSX-2, файл сделки 30008823)', () => {
  const fixture = () => new Uint8Array(readFileSync(new URL('./fixtures/zayavka-30008823.xlsx', import.meta.url)));
  const sum = (ps: { name: string; qty: number | null }[], rx: RegExp) => ps.filter((p) => rx.test(p.name)).reduce((s, p) => s + (p.qty ?? 0), 0);
  const count = (ps: { name: string }[], rx: RegExp) => ps.filter((p) => rx.test(p.name)).length;

  it('размер из названия: полотно с толщиной, погонаж с сечением и длиной, автопорог «24*20-1020мм», метры; мелкие пары пропускаются', () => {
    expect(sizeFromText('ДПГ + УПД (сота) 850*2020*40 мм/кромка ПВХ 1 мм')).toEqual({ widthMm: 850, heightMm: 2020, note: 'толщина 40 мм' });
    expect(sizeFromText('ДПГУЧ + УПД (45S3K) (обратная чет-ть 10*12 с 3-х сторон) 820*2020*52 мм/кромка')).toEqual({ widthMm: 820, heightMm: 2020, note: 'толщина 52 мм' });
    expect(sizeFromText('Добор ТЕЛЕСКОП (паз-паз) 300*10*2150 мм/МДФ')).toEqual({ widthMm: 300, heightMm: 2150, note: 'толщина 10 мм' });
    expect(sizeFromText('Коробка ТЕЛЕСКОП 74*32*2150 мм уплотнит./сэндвич')).toEqual({ widthMm: 74, heightMm: 2150, note: 'сечение 74×32 мм, длина 2150 мм' });
    expect(sizeFromText('Автопорог LDM-03 (ЛДМ-03) 24*20-1020мм')).toEqual({ widthMm: 24, heightMm: 1020, note: 'сечение 24×20 мм, длина 1020 мм' });
    expect(sizeFromText('дверь двухпольная 1,4х2,7 м')).toEqual({ widthMm: 1400, heightMm: 2700, note: null });
    expect(sizeFromText('Петля Fuaro IN4400U-R10 INOX (4BB-R10 102х76х3)/44603')).toBeNull();
    expect(sizeFromText('Петля Rucetti без врезки RFH-100*75*2,5 SN')).toBeNull();
    expect(sizeFromText('Ручка дверная Apecs H-0203-INOX')).toBeNull();
    expect(isService('Врезка замка на производстве')).toBe(true);
    expect(isService('Установка доборов')).toBe(true);
    expect(isService('Доставка г. Москва')).toBe(true);
    expect(isService('Добор ТЕЛЕСКОП')).toBe(false);
    expect(isService('Коробка под установку')).toBe(false);
  });

  it('колонки без шапки: текстовая — наименование, числовая в ≥ 70 % строк — количество', () => {
    expect(detectHeaderless([
      { sheet: 's', row: 1, cells: ['1 ЭТАЖ', '1 ЭТАЖ'] },
      { sheet: 's', row: 2, cells: ['Двери:', 'кол-во'] },
      { sheet: 's', row: 3, cells: ['Дверь А', '1'] },
      { sheet: 's', row: 4, cells: ['Дверь Б', '24,5'] },
      { sheet: 's', row: 5, cells: ['Дверь В', '2'] },
      { sheet: 's', row: 6, cells: ['Дверь Г', '2'] },
      { sheet: 's', row: 7, cells: ['Дверь Д', '3'] },
    ])).toMatchObject({ name: 0, qty: 1, titles: ['A: наименование', 'B: количество'] });
    // Одна колонка или числа реже 70 % — не таблица.
    expect(detectHeaderless([{ sheet: 's', row: 1, cells: ['а'] }, { sheet: 's', row: 2, cells: ['б'] }, { sheet: 's', row: 3, cells: ['в'] }])).toBeNull();
    expect(detectHeaderless([{ sheet: 's', row: 1, cells: ['а', 'x'] }, { sheet: 's', row: 2, cells: ['б', '1'] }, { sheet: 's', row: 3, cells: ['в', 'y'] }, { sheet: 's', row: 4, cells: ['г', 'z'] }])).toBeNull();
  });

  it('файл клиента: 136 позиций по колонкам без модели, суммы по группам как в заявке, работы отдельным типом, разделы в примечании', async () => {
    const lines: string[] = [];
    // Модель молчит — позиции и количество всё равно из файла (п. 5).
    const dead = gatewayBy(() => timeout());
    const r = await parseTable(fixture(), { llm: dead.gateway, route, settings, filename: 'Заявка на двери. Москва..xlsx', onProgress: (l) => lines.push(l) });
    expect(r.method).toBe('columns');
    expect(lines[0]).toContain('таблица по колонкам без шапки (A: наименование | B: количество) — позиций 136, из них работ 28');
    const ps = r.data.positions;
    expect(ps).toHaveLength(136);
    expect(sum(ps, /^ДПГУЧ/)).toBe(9);
    expect(sum(ps, /^ДПГ \+ УПД \(сота\)/)).toBe(35);
    expect(sum(ps, /^Аква 01/)).toBe(16);
    expect([count(ps, /^ДПГУЧ/), count(ps, /^ДПГ \+ УПД \(сота\)/), count(ps, /^Аква 01/)]).toEqual([9, 27, 10]);
    expect(sum(ps, /^Коробка/)).toBe(137);
    expect(sum(ps, /^Наличник/)).toBe(278);
    expect(sum(ps, /^Добор/)).toBe(154);
    expect(sum(ps, /^Петля/)).toBe(155);
    expect(sum(ps, /^Доводчик/)).toBe(60);
    expect(sum(ps, /^Автопорог/)).toBe(9);
    expect(ps.filter((p) => p.kind === 'service')).toHaveLength(28);
    expect(ps.filter((p) => p.kind === 'service').every((p) => p.width_mm === null && p.height_mm === null)).toBe(true);
    expect(ps.every((p) => p.qty !== null && p.qty > 0)).toBe(true);
    // Полотно: размер и толщина из названия, раздел — в примечании; подзаголовок «кол-во» не позиция; количество с запятой.
    expect(ps[0]).toMatchObject({ name: expect.stringMatching(/^ДПГУЧ \+ УПД \(45S3K\)/), width_mm: 820, height_mm: 2020, qty: 1, note: 'раздел: 1 ЭТАЖ; толщина 52 мм', kind: 'product' });
    expect(ps[1]).toMatchObject({ width_mm: 850, height_mm: 2020, note: 'раздел: 1 ЭТАЖ; толщина 40 мм' });
    expect(ps.find((p) => /^Наличник ТЕЛЕСКОП 70\*10\*2150/.test(p.name))).toMatchObject({ qty: 24.5, width_mm: 70, height_mm: 2150, note: 'раздел: 1 ЭТАЖ; сечение 70×10 мм, длина 2150 мм' });
    expect(ps.find((p) => /^Автопорог/.test(p.name))).toMatchObject({ width_mm: 24, height_mm: 1020, qty: 1 });
    expect(ps.find((p) => p.kind === 'service')).toMatchObject({ name: 'Врезка карточных петель на производстве', qty: 3, note: 'раздел: 1 ЭТАЖ' });
    // Одинаковые названия в разных разделах — отдельные строки (п. 4).
    const same = ps.filter((p) => p.name === 'Ручка дверная Apecs H-0203-INOX');
    expect(same.map((p) => [p.qty, p.note])).toEqual([[21, 'раздел: 1 ЭТАЖ'], [20, 'раздел: 2 ЭТАЖ'], [19, 'раздел: 3 ЭТАЖ']]);
    expect(ps[135]).toMatchObject({ name: 'Доставка г. Москва', kind: 'service', note: 'раздел: 3 ЭТАЖ' });
    expect(r.data.summary).toContain('136 позиций, из них работ 28');
    // С отвечающей моделью: 108 изделий в 6 порциях, работы в модель не уходят, количество и размеры не меняются.
    const live = gatewayBy((text) => normalizeAnswer(text));
    const r2 = await parseTable(fixture(), { llm: live.gateway, route, settings, filename: 'Заявка на двери. Москва..xlsx' });
    expect(r2.method).toBe('columns+model');
    expect(live.requests).toHaveLength(6);
    // Порции по 20 изделий; from/to — номера строк в файле, работы (42–50 и т. д.) в порции не входят.
    expect(r2.chunks).toHaveLength(6);
    expect(r2.chunks[0]).toMatchObject({ from: 1, to: 20, ok: true });
    expect(r2.chunks[1]).toMatchObject({ from: 21, to: 49, ok: true });
    expect(r2.data.positions).toHaveLength(136);
    expect(r2.data.positions[1]).toMatchObject({ name: 'Изделие 2', width_mm: 850, height_mm: 2020, qty: 1 });
    expect(sum(r2.data.positions, /^Изделие/)).toBe(sum(ps.filter((p) => p.kind === 'product'), /./));
    expect(r2.data.positions.filter((p) => p.kind === 'service').map((p) => p.name)).toEqual(ps.filter((p) => p.kind === 'service').map((p) => p.name));
  });
});
