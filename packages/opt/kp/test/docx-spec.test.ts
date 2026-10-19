// KP-DOCX-APPENDIX: спецификация в Word-файле ТЗ — последняя таблица «Приложение №1» после длинного текста и 25 других таблиц.
import PizZip from 'pizzip';
import type { LlmGateway, RoutedRequest, RoutedResponse } from '@core/llm';
import { describe, expect, it } from 'vitest';
import { equipmentFor, equipmentSections, markersOf, pickSpecTable, readDocxBlocks, specCandidates } from '../src/docx-spec.ts';
import { analyzeDraftFile, type DraftFileDeps } from '../src/file-analyze.ts';
import { positionToRequest } from '../src/draft.ts';
import { defaultOptSettings, toWidgetSettings } from '../src/settings.ts';

const route = { primary: { provider: 'openai' as const, model: 'gpt-5.5' }, fallback: { provider: 'openai' as const, model: 'gpt-5.1' } };
const settings = toWidgetSettings(defaultOptSettings());
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

type Cell = string | { text: string; span?: number; vMerge?: 'restart' | 'continue' };
type Block = { p: string; style?: string; numbered?: boolean } | { table: Cell[][] };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const run = (s: string) => `<w:r><w:rPr><w:sz w:val="22"/></w:rPr><w:t xml:space="preserve">${esc(s)}</w:t></w:r>`;
const para = (b: { p: string; style?: string; numbered?: boolean }) =>
  `<w:p><w:pPr>${b.style ? `<w:pStyle w:val="${b.style}"/>` : ''}${b.numbered ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr>' : ''}</w:pPr>${run(b.p)}</w:p>`;
const cellXml = (c: Cell) => {
  const o = typeof c === 'string' ? { text: c } : c;
  const pr = `${o.span ? `<w:gridSpan w:val="${o.span}"/>` : ''}${o.vMerge ? `<w:vMerge${o.vMerge === 'restart' ? ' w:val="restart"' : ''}/>` : ''}`;
  // Текст ячейки — двумя абзацами, если в нём «\n» (как в ТЗ: «Дверь ДПС 01» / «EI60»).
  return `<w:tc><w:tcPr><w:tcW w:w="1000" w:type="dxa"/>${pr}</w:tcPr>${o.text.split('\n').map((t) => `<w:p>${run(t)}</w:p>`).join('')}</w:tc>`;
};
function docx(blocks: Block[]): Uint8Array {
  const body = blocks.map((b) => ('p' in b ? para(b) : `<w:tbl><w:tblPr/>${b.table.map((r) => `<w:tr>${r.map(cellXml).join('')}</w:tr>`).join('')}</w:tbl>`)).join('');
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`);
  return new Uint8Array(zip.generate({ type: 'uint8array' }));
}

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
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ title: 'Базовая комплектация противопожарных дверей', number: null });
    expect(sections[0]?.text).toContain('3 петли, противопожарный замок');
    expect(sections[0]?.text).toContain('Петля — 3; Доводчик — 1');
    expect(sections[0]?.text).not.toContain('стретч-плёнку');
    expect(markersOf('Дверь ДПС 01 EI60 | ГОСТ Р 57327-2016 | RAL 7035')).toEqual(['дпс', 'ei60', '57327-2016']);
    expect(equipmentFor('Дверь ДПС 01 EI60 | правая', sections)?.title).toBe('Базовая комплектация противопожарных дверей');
    expect(equipmentFor('Блок ДСН двупольный | ГОСТ 31173-2016', sections)).toBeNull();
    expect(equipmentFor('Дверь AquaDoor | Аква ДПК ДГ-01 | серый RAL 7035', sections)).toBeNull();
    // Ссылка «раздел N» — на раздел с этим номером в заголовке.
    const numbered = [{ title: '15. Базовая комплектация', number: '15', text: 'доводчик' }, { title: '16. Комплектация ДСН', number: '16', text: 'ДСН' }];
    expect(equipmentFor('Дверь | см. раздел 16', numbered)?.number).toBe('16');
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
    expect(r.positions[17]?.tzEquipment).toBe(`раздел «Базовая комплектация противопожарных дверей»: ${EQUIPMENT} Наименование — Кол-во на 1 дверь, шт; Петля — 3; Доводчик — 1; Замок противопожарный — 1`);
    // В строку черновика: комплектация по ТЗ идёт с позицией.
    expect(positionToRequest(r.positions[14]!)).toMatchObject({ name: 'Дверь ДПС 01 EI60', qty: 1, tzEquipment: expect.stringContaining('3 петли') });
    expect(positionToRequest(r.positions[0]!).tzEquipment).toBeUndefined();
    expect(r.warnings).toEqual(['ещё таблиц с колонками «наименование / количество»: 1 (25) — позиции взяты только из таблицы 26']);
    expect(added[0]).toMatchObject({ leadId: 90091, format: 'docx', kind: 'request' });
    expect(progress[0]).toBe('№ 204 68 двери и комп-ющие_ТЗ.docx: таблиц 26, спецификация — таблица 26 («Приложение №1 к техническому заданию»), строк с количеством 19');
    expect(progress).toContain('№ 204 68 двери и комп-ющие_ТЗ.docx: комплектация из ТЗ приложена к 5 поз.');
  });

  it('Word без таблицы спецификации — как раньше, весь документ в @core/docs', async () => {
    const { llm, requests } = gateway();
    const docsCalls: string[] = [];
    const r = await analyzeDraftFile(deps(llm, docsCalls, []), { filename: 'письмо.docx', mime: DOCX_MIME, bytes: docx([{ p: 'Просим посчитать двери' }, { table: [['Показатель', 'Значение'], ['Цвет', 'белый']] }]) });
    expect(r.method).toBe('docs');
    expect(docsCalls).toEqual(['письмо.docx']);
    expect(requests).toHaveLength(0);
  });
});
