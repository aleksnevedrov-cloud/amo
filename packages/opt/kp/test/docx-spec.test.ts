// KP-DOCX-APPENDIX: спецификация в Word-файле ТЗ — последняя таблица «Приложение №1» после длинного текста и 25 других таблиц.
import type { LlmGateway, RoutedRequest, RoutedResponse } from '@core/llm';
import { describe, expect, it } from 'vitest';
import { equipmentFor, equipmentSections, looksLikeRequisites, markersOf, matrixPositions, pickSpecTable, positionsOf, readDocxBlocks, requirementsOf, specCandidates } from '../src/docx-spec.ts';
import { analyzeDraftFile, type DraftFileDeps } from '../src/file-analyze.ts';
import { notRequestReason, positionToRequest } from '../src/draft.ts';
import { defaultOptSettings, toWidgetSettings } from '../src/settings.ts';
import { docx, REAL_EQUIPMENT, REAL_HEAD, tzReal, type Block, type Cell } from './fixtures/docx-builder.ts';

const route = { primary: { provider: 'openai' as const, model: 'gpt-5.5' }, fallback: { provider: 'openai' as const, model: 'gpt-5.1' } };
const settings = toWidgetSettings(defaultOptSettings());
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';


/** Приложение №1 сделки 90091: 13 колонок, строка-заголовок через всю ширину, 19 позиций. */
const HEAD = ['№ п/п', 'Наименование товара', 'Марка / модель', 'Производитель', 'Цвет / отделка', 'Размер, мм', 'Открывание', 'Огнестойкость', 'ГОСТ', 'Ед. изм.', 'Кол-во', 'Срок поставки', 'Примечание'];
const SPEC: [string, string, string, string, string, string, string, string, string, number, string][] = [
  ['Дверь AquaDoor', 'Аква ДПК ДГ-01', 'AquaDoor', 'серый RAL 7035', '700×2000', '', '', '', 'шт', 1, ''],
  ['Дверь AquaDoor', 'Аква ДПК ДГ-01', 'AquaDoor', 'серый RAL 7035', '600×2000', '', '', '', 'шт', 6, ''],
  ['Дверь AquaDoor', 'Аква ДПК ДГ-01', 'AquaDoor', 'серый RAL 7035', '800×2000', '', '', '', 'шт', 2, ''],
  ['Петля', '750-4 STD 100×70', 'Нора-М', '', '', '', '', '', 'шт', 18, ''],
  ['Ручка', 'H-0661-CR', 'Apecs', 'хром', '', '', '', '', 'шт', 9, ''],
  ['Замок врезной', '6000-CR', 'Apecs', 'хром', '', '', '', '', 'шт', 9, ''],
  ['Полотно ПГ Классика', 'Классика', 'Pleskovdoor', 'шпон дуб', '600×2000', '', '', '', 'шт', 2, ''],
  ['Коробка массив', '76×33, длина 2100', '', 'шпон дуб', '', '', '', '', 'шт', 6, ''],
  ['Наличник полукруглый', '70×11', '', 'шпон дуб', '', '', '', '', 'шт', 6, ''],
  ['Наличник телескопический Аква ДПК', '70×10×2200', 'AquaDoor', '', '', '', '', '', 'шт', 27, ''],
  ['Коробка Аква ДПК', '74×10×2200', 'AquaDoor', '', '', '', '', '', 'шт', 27, ''],
  ['Замок', 'L03 PG', 'Morelli', '', '', '', '', '', 'шт', 5, ''],
  ['Порог алюминиевый', '40×1800', '', 'дуб', '', '', '', '', 'шт', 30, ''],
  ['Дверь ДПС 01\nEI60', 'ДПС 01', '', 'RAL 7035', '900×2100', 'левая', 'EI60', 'ГОСТ Р 57327-2016', 'шт', 1, 'базовая комплектация — см. раздел 15'],
  ['Дверь ДПС 01\nEI60', 'ДПС 01', '', 'RAL 7035', '900×2100', 'правая', 'EI60', 'ГОСТ Р 57327-2016', 'шт', 1, 'базовая комплектация — см. раздел 15'],
  ['Дверь ДПС 01\nEI60', 'ДПС 01', '', 'RAL 7035', '1000×2100', 'левая', 'EI60', 'ГОСТ Р 57327-2016', 'шт', 1, 'базовая комплектация — см. раздел 15'],
  ['Дверь ДПС 01\nEI60', 'ДПС 01', '', 'RAL 7035', '1000×2100', 'правая', 'EI60', 'ГОСТ Р 57327-2016', 'шт', 1, 'базовая комплектация — см. раздел 15'],
  // Пятая — без ссылки на раздел: комплектация по обозначению ДПС / EI60 / номеру ГОСТ.
  ['Дверь ДПС 01\nEI60', 'ДПС 01', '', 'RAL 7035', '800×2100', 'правая', 'EI60', 'ГОСТ Р 57327-2016', 'шт', 1, ''],
  ['Блок ДСН двупольный', 'ДСН', '', '', '1430×2300', '', '', 'ГОСТ 31173-2016', 'шт', 1, ''],
];
const EQUIPMENT = 'Каждая дверь ДПС 01 EI60 комплектуется: коробка стальная с терморасширяющимся уплотнителем, 3 петли, противопожарный замок с цилиндром, ручка-скоба, доводчик, противосъёмные штыри.';

/** ТЗ: 14 разделов текста (≈ 38 тыс. знаков) с 24 таблицами характеристик и документов, раздел 15 о комплектации со своей таблицей количества, приложение. */
function tz(): Uint8Array {
  const blocks: Block[] = [{ p: 'Техническое задание на поставку дверей и комплектующих', style: 'Title' }];
  const filler = 'Поставщик обязан поставить товар надлежащего качества в соответствии с требованиями настоящего технического задания, нормативных документов и условиями договора. ';
  for (let s = 1; s <= 14; s += 1) {
    blocks.push({ p: `${s}. Требования раздела ${s}`, style: 'Heading1' });
    for (let k = 0; k < 15; k += 1) blocks.push({ p: filler.repeat(1) });
    blocks.push({ table: [['Наименование показателя', 'Значение показателя'], ['Толщина полотна', 'не менее 40 мм'], ['Срок гарантии', '24 месяца']] });
    if (s % 2 === 0) blocks.push({ table: [['Характеристика', 'Требование'], ['Цвет', 'по согласованию']] });
    if (s <= 3) blocks.push({ table: [['Документ', 'Номер'], ['Сертификат соответствия', 'обязателен']] });
  }
  blocks.push({ p: 'Базовая комплектация противопожарных дверей', style: 'Heading1', numbered: true });
  blocks.push({ p: EQUIPMENT });
  blocks.push({ table: [['Наименование', 'Кол-во на 1 дверь, шт'], ['Петля', '3'], ['Доводчик', '1'], ['Замок противопожарный', '1']] });
  blocks.push({ p: '16. Требования к упаковке и маркировке', style: 'Heading1' });
  blocks.push({ p: 'Каждое изделие упаковывается в стретч-плёнку и гофрокартон.' });
  blocks.push({ p: 'Приложение №1' }, { p: 'к техническому заданию' });
  // Двери ДПС 01 (поз. 14–18): наименование — одна ячейка, объединённая по вертикали на пять строк.
  const name = (i: number, v: string): Cell => (i === 13 ? { text: v, vMerge: 'restart' } : i > 13 && i < 18 ? { text: '', vMerge: 'continue' } : v);
  blocks.push({ table: [[{ text: 'Спецификация поставляемого товара', span: 13 }], HEAD, ...SPEC.map((r, i) => [String(i + 1), name(i, r[0]), ...r.slice(1, 9).map(String), String(r[9]), '30 дней', r[10] as string])] });
  return docx(blocks);
}


/** Шлюз нормализации: имя — вторая ячейка строки (без переноса), остальное null. Запоминает запросы. */
function gateway() {
  const requests: RoutedRequest[] = [];
  const llm: LlmGateway = {
    async chat(req, r) {
      requests.push(req);
      const last = req.messages[req.messages.length - 1];
      const text = typeof last?.content === 'string' ? last.content : (last?.content ?? []).map((p) => ('text' in p ? p.text : '')).join('\n');
      const rows = [...text.matchAll(/^(\d+)\. (.+)$/gm)].map((m) => ({ i: Number(m[1]), name: (m[2] as string).split(' | ')[1] ?? '', marking: null, width_mm: null, height_mm: null, material: null, color: null, fireproof: null, note: null }));
      const a = JSON.stringify({ rows });
      const res: RoutedResponse = {
        text: a, toolCalls: [], stopReason: 'end', usage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0 },
        provider: r.primary.provider, model: r.primary.model, assistantMessage: { role: 'assistant', content: a }, latencyMs: 1, fallbackUsed: false, requested: r.primary, attempts: [],
      };
      return res;
    },
    providers: async () => ['openai'],
    provider: async () => null,
  };
  return { llm, requests };
}

const deps = (llm: LlmGateway, docsCalls: string[], added: Record<string, unknown>[], progress: string[] = []): DraftFileDeps => ({
  docs: {
    analyze: async (i) => {
      docsCalls.push(i.filename);
      return { id: 500, kind: 'request', data: { kind: 'request', title: '', summary: '', customer_type: 'unknown', openings: [], positions: [], requirements: [], questions: [] as string[], photo: null }, matches: [], kit: null, format: 'docx', ocr: null, piiRemoved: 0, textChars: 38_000, costUsd: 0.2, model: 'gpt-5.5', provider: 'openai', text: '', note: '', memoryOpenings: [] };
    },
  },
  documents: {
    add: async (doc) => {
      added.push(doc as unknown as Record<string, unknown>);
      return 801;
    },
    countToday: async () => 0,
  },
  llm,
  settings,
  route,
  accountId: 1,
  leadId: 90091,
  userId: 5,
  onProgress: (l) => progress.push(l),
});

describe('спецификация в Word-файле ТЗ (KP-DOCX-APPENDIX, сделка 90091)', () => {
  it('документ читается кодом: абзацы и таблицы по порядку, объединённая ячейка не сдвигает колонки, абзацы в ячейке — через пробел', () => {
    const blocks = readDocxBlocks(tz());
    const tables = blocks.filter((b) => b.kind === 'table');
    expect(tables).toHaveLength(26);
    const text = blocks.filter((b) => b.kind === 'p').map((b) => (b.kind === 'p' ? b.text : '')).join(' ');
    expect(text.length).toBeGreaterThan(30_000);
    const last = tables[25]!;
    expect(last.kind === 'table' && last.rows[0]).toEqual(['Спецификация поставляемого товара']);
    expect(last.kind === 'table' && last.rows[1]).toEqual(HEAD);
    expect(last.kind === 'table' && last.rows[15]?.slice(0, 3)).toEqual(['14', 'Дверь ДПС 01 EI60', 'ДПС 01']);
    // Объединённая по вертикали ячейка наименования — в каждой из пяти строк.
    expect(last.kind === 'table' && last.rows.slice(15, 20).map((r) => r[1])).toEqual(Array(5).fill('Дверь ДПС 01 EI60'));
    expect(last.kind === 'table' && last.rows).toHaveLength(21);
    expect(readDocxBlocks(docx([{ p: 'A &amp; B < C' }, { table: [[{ text: 'x', span: 2 }, 'y']] }]))).toEqual([
      { kind: 'p', text: 'A &amp; B < C', style: null, numbered: false, level: null },
      { kind: 'table', n: 1, rows: [['x', '', 'y']] },
    ]);
  });

  it('таблица спецификации — «Приложение №1» (19 строк с количеством); таблица комплектации раздела 15 — кандидат, но не спецификация', () => {
    const blocks = readDocxBlocks(tz());
    const cands = specCandidates(blocks);
    expect(cands.map((c) => [c.table.n, c.items])).toEqual([[25, 3], [26, 19]]);
    const spec = pickSpecTable(cands)!;
    expect(spec.table.n).toBe(26);
    expect(spec.title).toBe('Приложение №1 к техническому заданию');
    // Без заголовка «Приложение» — больше позиций; поровну — последняя.
    expect(pickSpecTable(cands.map((c) => ({ ...c, title: '' })))?.table.n).toBe(26);
  });

  it('раздел о комплектации: заголовок (нумерованный абзац) и текст до следующего заголовка; к позиции — по ссылке «раздел 15» или по обозначению ДПС / EI60 / ГОСТ', () => {
    const sections = equipmentSections(readDocxBlocks(tz()));
    // Разделы с номером (1–14, 16) и раздел о комплектации без номера.
    expect(sections.map((x) => x.number)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', null, '16']);
    const eq = sections.find((x) => !x.number)!;
    expect(eq).toMatchObject({ title: 'Базовая комплектация противопожарных дверей', number: null });
    expect(eq.text).toContain('3 петли, противопожарный замок');
    expect(eq.text).toContain('Петля — 3 Доводчик — 1');
    expect(eq.text).not.toContain('стретч-плёнку');
    // Раздел 16 кончается перед «Приложение №1»: спецификация в его текст не входит.
    expect(sections.find((x) => x.number === '16')?.text).toBe('Каждое изделие упаковывается в стретч-плёнку и гофрокартон.');
    expect(markersOf('Дверь ДПС 01 EI60 | ГОСТ Р 57327-2016 | RAL 7035')).toEqual(['дпс', 'ei60', '57327-2016']);
    expect(equipmentFor('Дверь ДПС 01 EI60 | правая', sections)?.section.title).toBe('Базовая комплектация противопожарных дверей');
    expect(equipmentFor('Блок ДСН двупольный | ГОСТ 31173-2016', sections)).toBeNull();
    expect(equipmentFor('Дверь AquaDoor | Аква ДПК ДГ-01 | серый RAL 7035', sections)).toBeNull();
    // Ссылка «раздел N» — на раздел с этим номером в заголовке.
    const numbered = [{ title: '15. Базовая комплектация', number: '15', text: 'доводчик', parts: [{ text: 'доводчик', positions: null }] }, { title: '16. Комплектация ДСН', number: '16', text: 'ДСН', parts: [{ text: 'ДСН', positions: null }] }];
    expect(equipmentFor('Дверь | см. раздел 16', numbered)).toMatchObject({ section: { number: '16' }, by: 'ref' });
  });

  it('«Собрать заново» на 90091: 19 позиций из «Приложения №1» одним вызовом нормализации, весь документ в модель не уходит; к дверям ДПС 01 (поз. 14–18) — комплектация из раздела 15', async () => {
    const { llm, requests } = gateway();
    const docsCalls: string[] = [];
    const added: Record<string, unknown>[] = [];
    const progress: string[] = [];
    const r = await analyzeDraftFile(deps(llm, docsCalls, added, progress), { filename: '№ 204 68 двери и комп-ющие_ТЗ.docx', mime: DOCX_MIME, bytes: tz() });
    expect(docsCalls).toEqual([]);
    expect(requests).toHaveLength(1);
    const sent = (requests[0]?.messages[0]?.content as { text: string }[])[0]?.text ?? '';
    expect(sent.length).toBeLessThan(6000);
    expect(sent).not.toContain('Поставщик обязан');
    expect(r).toMatchObject({ id: 801, method: 'columns+model', chunks: 1 });
    expect(r.positions).toHaveLength(19);
    expect(r.positions.map((p) => p.qty)).toEqual([1, 6, 2, 18, 9, 9, 2, 6, 6, 27, 27, 5, 30, 1, 1, 1, 1, 1, 1]);
    expect(r.positions.slice(0, 3).map((p) => [p.name, p.width_mm, p.height_mm])).toEqual([['Дверь AquaDoor', 700, 2000], ['Дверь AquaDoor', 600, 2000], ['Дверь AquaDoor', 800, 2000]]);
    expect(r.positions.slice(13, 18).map((p) => [p.name, p.width_mm])).toEqual([['Дверь ДПС 01 EI60', 900], ['Дверь ДПС 01 EI60', 900], ['Дверь ДПС 01 EI60', 1000], ['Дверь ДПС 01 EI60', 1000], ['Дверь ДПС 01 EI60', 800]]);
    expect(r.positions[13]?.note).toContain('Открывание: левая');
    expect(r.positions[18]).toMatchObject({ name: 'Блок ДСН двупольный', width_mm: 1430, height_mm: 2300 });
    // Комплектация из ТЗ — у пяти дверей ДПС 01 (четыре по ссылке «раздел 15», пятая по обозначению), у остальных нет.
    const withEq = r.positions.map((p, i) => (p.tzEquipment ? i + 1 : null)).filter(Boolean);
    expect(withEq).toEqual([14, 15, 16, 17, 18]);
    expect(r.positions[17]?.tzEquipment).toBe(`раздел «Базовая комплектация противопожарных дверей»: ${EQUIPMENT} Наименование — Кол-во на 1 дверь, шт Петля — 3 Доводчик — 1 Замок противопожарный — 1`);
    // В строку черновика: комплектация по ТЗ идёт с позицией.
    expect(positionToRequest(r.positions[14]!)).toMatchObject({ name: 'Дверь ДПС 01 EI60', qty: 1, tzEquipment: expect.stringContaining('3 петли') });
    expect(positionToRequest(r.positions[0]!).tzEquipment).toBeUndefined();
    expect(r.warnings).toEqual(['ещё таблиц с колонками «наименование / количество»: 1 (25) — позиции взяты только из таблицы 26']);
    expect(added[0]).toMatchObject({ leadId: 90091, format: 'docx', kind: 'request' });
    expect(progress[0]).toBe('№ 204 68 двери и комп-ющие_ТЗ.docx: таблиц 26, спецификация — таблица 26 («Приложение №1 к техническому заданию»), строк с количеством 19');
    expect(progress).toContain('№ 204 68 двери и комп-ющие_ТЗ.docx: комплектация из ТЗ приложена к 5 поз.');
  });

  it('настоящее ТЗ 90091: перечень приложений — не спецификация; «Приложение № 1» — 19 позиций; «СМ. РАЗДЕЛ 15» → часть раздела 15 с «поз. 14-18 Приложения 1» — у поз. 14–18; ДСН и Аква — без неё', async () => {
    const blocks = readDocxBlocks(tzReal());
    expect(blocks.filter((b) => b.kind === 'table')).toHaveLength(26);
    const cands = specCandidates(blocks);
    expect(cands.map((c) => c.table.n)).toEqual([26]);
    expect(pickSpecTable(cands)?.title).toBe('Приложение № 1');
    const sections = equipmentSections(blocks);
    const s15 = sections.find((x) => x.number === '15')!;
    expect(s15.title).toBe('РАЗДЕЛ 15. ДОПОЛНИТЕЛЬНЫЕ (ИНЫЕ) ТРЕБОВАНИЯ');
    expect(s15.parts).toEqual([{ text: `ДЛЯ ПРОТИВОПОЖАРНЫХ ДВЕРЕЙ поз. 14-18 Приложения 1 ${REAL_EQUIPMENT}`, positions: [14, 15, 16, 17, 18] }]);
    // Раздел 16 кончается перед «Приложение № 1» — таблица спецификации в него не входит.
    expect(sections.find((x) => x.number === '16')?.text).toBe('№ п/п — Наименование приложения — Количество листов; 1 — Приложение №1 — 12'.split('; ').join(' '));
    const { llm, requests } = gateway();
    const docsCalls: string[] = [];
    const r = await analyzeDraftFile(deps(llm, docsCalls, []), { filename: '№ 204 68 двери и комп-ющие_ТЗ.docx', mime: DOCX_MIME, bytes: tzReal() });
    expect(docsCalls).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(r.positions).toHaveLength(19);
    expect(r.positions.map((p) => p.qty)).toEqual([1, 6, 2, 18, 9, 9, 2, 6, 6, 27, 27, 5, 30, 1, 1, 1, 1, 1, 1]);
    expect(r.positions.slice(0, 3).map((p) => [p.width_mm, p.height_mm])).toEqual([[700, 2000], [600, 2000], [800, 2000]]);
    expect(r.positions.slice(13, 18).map((p) => [p.width_mm, p.height_mm])).toEqual([[780, 2060], [780, 2060], [880, 2060], [880, 2060], [980, 2060]]);
    expect(r.positions.map((p, i) => (p.tzEquipment ? i + 1 : null)).filter(Boolean)).toEqual([14, 15, 16, 17, 18]);
    expect(r.positions[13]?.tzEquipment).toBe(`раздел «РАЗДЕЛ 15. ДОПОЛНИТЕЛЬНЫЕ (ИНЫЕ) ТРЕБОВАНИЯ»: ДЛЯ ПРОТИВОПОЖАРНЫХ ДВЕРЕЙ поз. 14-18 Приложения 1 ${REAL_EQUIPMENT}`);
    expect(r.positions[13]?.note).toContain('ГОСТ, ТУ: ГОСТ Р 57327-2016');
    expect(r.warnings).toEqual([]);
  });

  it('Word без таблицы спецификации — как раньше, весь документ в @core/docs', async () => {
    const { llm, requests } = gateway();
    const docsCalls: string[] = [];
    const r = await analyzeDraftFile(deps(llm, docsCalls, []), { filename: 'письмо.docx', mime: DOCX_MIME, bytes: docx([{ p: 'Просим посчитать двери' }, { table: [['Показатель', 'Значение'], ['Цвет', 'белый']] }]) });
    expect(r.method).toBe('docs');
    expect(docsCalls).toEqual(['письмо.docx']);
    expect(requests).toHaveLength(0);
  });

  it('требования закупки: место и срок поставки из колонок спецификации, аванс / НДС / сертификаты из текста', () => {
    const blocks = readDocxBlocks(docx([
      { p: 'Оплата: аванс 30 %, остаток по факту поставки.' },
      { p: 'Цена включает НДС 22 % и доставку до склада заказчика.' },
      { p: 'Поставщик обязан поставить товар надлежащего качества.' },
      { table: [REAL_HEAD, ['1', 'Дверь ДПС 01 EI60', '2060×780', '', '', '', 'сталь', 'ГОСТ Р 57327-2016', 'шт', '1', 'август 2026', 'г. Москва, ул. Строителей, 1', '2 (С)']] },
    ]));
    const spec = blocks.find((b) => b.kind === 'table');
    expect(requirementsOf(blocks, spec && spec.kind === 'table' ? spec : null)).toEqual(['Срок поставки: август 2026', 'Место поставки: г. Москва, ул. Строителей, 1', 'Оплата: аванс 30 %, остаток по факту поставки.', 'Цена включает НДС 22 % и доставку до склада заказчика.']);
    expect(positionsOf('ДЛЯ ДВЕРЕЙ поз. 14-18, 20 Приложения 1')).toEqual([14, 15, 16, 17, 18, 20]);
  });

  it('матрица характеристик (89835 «Двери.docx»): позиция — блок строк или колонка; количества нет — «уточнить»', async () => {
    const types = ['ДМ{w}-С', 'ДМ{w}', 'ДС{w}'];
    const widths = [600, 700, 800, 900, 1000, 1100, 1200];
    const rows: Cell[][] = [];
    for (const t of types) for (const w of widths) rows.push(['Наименование', t.replace('{w}', String(w))], ['Размер', `2100×${w}`], ['Материал', 'МДФ'], ['Покрытие', 'ПВХ белый'], ['Фурнитура', 'петли, замок']);
    const bytes = docx([{ p: 'Перечень дверей' }, { table: rows }]);
    const table = readDocxBlocks(bytes).find((b) => b.kind === 'table');
    const ps = table && table.kind === 'table' ? matrixPositions(table) : [];
    expect(ps).toHaveLength(21);
    expect(ps[0]).toEqual({ name: 'ДМ600-С', qty: null, widthMm: 600, heightMm: 2100, note: 'Размер: 2100×600; Материал: МДФ; Покрытие: ПВХ белый; Фурнитура: петли, замок' });
    expect(ps.map((p) => p.name).slice(6, 9)).toEqual(['ДМ1200-С', 'ДМ600', 'ДМ700']);
    // По колонкам: «Характеристика | ДМ600 | ДМ700», количество есть.
    const cols = readDocxBlocks(docx([{ table: [['Характеристика', 'ДМ600', 'ДМ700'], ['Размер', '2100×600', '2100×700'], ['Материал', 'МДФ', 'МДФ'], ['Кол-во', '4', '2']] }])).find((b) => b.kind === 'table');
    expect(cols && cols.kind === 'table' ? matrixPositions(cols).map((p) => [p.name, p.qty, p.widthMm]) : []).toEqual([['ДМ600', 4, 600], ['ДМ700', 2, 700]]);
    // Через разбор файла: 21 позиция без модели, у всех количество «уточнить», в черновике — флаг qtyUnknown.
    const { llm, requests } = gateway();
    const r = await analyzeDraftFile(deps(llm, [], []), { filename: 'Двери.docx', mime: DOCX_MIME, bytes });
    expect(r).toMatchObject({ method: 'matrix', warnings: ['количество не указано у 21 поз. — вопрос менеджеру'] });
    expect(requests).toHaveLength(0);
    expect(r.positions).toHaveLength(21);
    expect(positionToRequest(r.positions[0]!)).toMatchObject({ name: 'ДМ600-С', width_mm: 600, height_mm: 2100, qty: 1, qtyUnknown: true });
  });

  it('не заявка: карточка предприятия (по содержимому и по имени), наши КП; «КП 1404.docx» клиента — заявка', async () => {
    const card = docx([{ p: 'Карточка предприятия ООО «Ромашка»' }, { table: [['ИНН', '7700000000'], ['КПП', '770001001'], ['ОГРН', '1027700000000'], ['БИК', '044525225'], ['Р/с', '40702810000000000000']] }]);
    expect(looksLikeRequisites('ИНН 7700 КПП 7701 ОГРН 1027 БИК 0445 р/с 4070')).toBe(true);
    expect(looksLikeRequisites('ИНН 7700 КПП 7701 ОГРН 1027 БИК 0445 — двери ДПС 01')).toBe(false);
    const { llm } = gateway();
    const docsCalls: string[] = [];
    const r = await analyzeDraftFile(deps(llm, docsCalls, []), { filename: 'ООО Ромашка.docx', mime: DOCX_MIME, bytes: card });
    expect(r).toMatchObject({ id: 0, kind: 'requisites', positions: [], method: 'skipped', warnings: ['реквизиты предприятия — не заявка'] });
    expect(docsCalls).toEqual([]);
    expect(notRequestReason('Карточка предприятия.pdf')).toBe('реквизиты предприятия — не заявка');
    expect(notRequestReason('Реквизиты ООО Ромашка.rtf')).toBe('реквизиты предприятия — не заявка');
    expect(notRequestReason('KP-КП-2026-13.pdf')).toBe('наше КП — не заявка');
    expect(notRequestReason('kp_dveri_89813.docx')).toBe('наше КП — не заявка');
    expect(notRequestReason('KP_RUS_DVERI_2026.pdf')).toBe('наше КП — не заявка');
    expect(notRequestReason('КП 1404.docx')).toBeNull();
    expect(notRequestReason('Двери.docx')).toBeNull();
  });

  it('фото без позиций — образец; скриншот с позициями — заявка', async () => {
    const { llm } = gateway();
    const photo = await analyzeDraftFile(deps(llm, [], []), { filename: 'IMG_2031.jpg', mime: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]) });
    expect(photo).toMatchObject({ method: 'docs', photo: true, positions: [] });
  });
});
