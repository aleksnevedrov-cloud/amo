import PizZip from 'pizzip';

/** Word-файлы для тестов: абзацы (стиль, нумерация) и таблицы (объединение ячеек по горизонтали и вертикали). */
export type Cell = string | { text: string; span?: number; vMerge?: 'restart' | 'continue' };
export type Block = { p: string; style?: string; numbered?: boolean } | { table: Cell[][] };

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
export function docx(blocks: Block[]): Uint8Array {
  const body = blocks.map((b) => ('p' in b ? para(b) : `<w:tbl><w:tblPr/>${b.table.map((r) => `<w:tr>${r.map(cellXml).join('')}</w:tr>`).join('')}</w:tbl>`)).join('');
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`);
  return new Uint8Array(zip.generate({ type: 'uint8array' }));
}

/**
 * ТЗ 90091 как в настоящем файле: 26 таблиц; 25-я — перечень приложений «№ п/п | Наименование приложения | Количество листов»;
 * раздел 15 — «РАЗДЕЛ 15. ДОПОЛНИТЕЛЬНЫЕ (ИНЫЕ) ТРЕБОВАНИЯ», текст — таблица 1×1 «ДЛЯ ПРОТИВОПОЖАРНЫХ ДВЕРЕЙ поз. 14-18
 * Приложения 1 / Комплектация базовая: …»; над 26-й таблицей — «Приложение № 1»; шапка из 13 колонок; в поз. 14–18 —
 * «ДОПОЛНИТЕЛЬНЫЕ ТРЕБОВАНИЯ СМ. РАЗДЕЛ 15 НАСТОЯЩЕГО ТЗ».
 */
export const REAL_HEAD = ['№ п/п', 'Наименование, тип, марка', 'Технические характеристики', 'Класс безопас-ности по НП-001', 'Категория сейсмо-стойкости НП-031', 'Климати-ческое исполнение ГОСТ 15150', 'Материал', 'ГОСТ, ТУ', 'Ед. изм.', 'Кол-во', 'Срок поставки', 'Место поставки', 'Условия хранения по ГОСТ 15150'];
export const REAL_EQUIPMENT = 'Комплектация базовая: коробка, полотно, 3 петли, противопожарный замок, ручка, доводчик, терморасширяющийся уплотнитель, противосъёмные штыри.';
export function tzReal(): Uint8Array {
  const blocks: Block[] = [{ p: 'ТЕХНИЧЕСКОЕ ЗАДАНИЕ', style: 'Title' }];
  const filler = 'Поставщик обязан поставить товар надлежащего качества в соответствии с требованиями настоящего технического задания. ';
  for (let s = 1; s <= 14; s += 1) {
    blocks.push({ p: `РАЗДЕЛ ${s}. ТРЕБОВАНИЯ ${s}` });
    for (let k = 0; k < 14; k += 1) blocks.push({ p: filler });
    blocks.push({ table: [['Наименование показателя', 'Значение'], ['Срок гарантии', '24 месяца']] });
    if (s % 2 === 0) blocks.push({ table: [['Характеристика', 'Требование'], ['Цвет', 'по согласованию']] });
    if (s <= 2) blocks.push({ table: [['Документ', 'Номер'], ['Сертификат', 'обязателен']] });
  }
  blocks.push({ p: 'РАЗДЕЛ 15. ДОПОЛНИТЕЛЬНЫЕ (ИНЫЕ) ТРЕБОВАНИЯ' });
  blocks.push({ table: [['ДЛЯ ПРОТИВОПОЖАРНЫХ ДВЕРЕЙ поз. 14-18 Приложения 1\n' + REAL_EQUIPMENT]] });
  blocks.push({ p: 'РАЗДЕЛ 16. ПРИЛОЖЕНИЯ' });
  blocks.push({ table: [['№ п/п', 'Наименование приложения', 'Количество листов'], ['1', 'Приложение №1', '12']] });
  blocks.push({ p: 'Приложение № 1' });
  const ref = 'ДОПОЛНИТЕЛЬНЫЕ ТРЕБОВАНИЯ СМ. РАЗДЕЛ 15 НАСТОЯЩЕГО ТЗ';
  const row = (n: number, name: string, tech: string, gost: string, qty: number) => [String(n), name, tech, '4', 'II', 'УХЛ4', 'сталь', gost, 'шт', String(qty), 'август 2026', 'г. Москва, ул. Строителей, 1', '2 (С)'];
  const rows = [
    row(1, 'Дверь AquaDoor (Аква ДПК ДГ-01), серый RAL 7035', 'размер 2000×700', '', 1),
    row(2, 'Дверь AquaDoor (Аква ДПК ДГ-01), серый RAL 7035', 'размер 2000×600', '', 6),
    row(3, 'Дверь AquaDoor (Аква ДПК ДГ-01), серый RAL 7035', 'размер 2000×800', '', 2),
    row(4, 'Петля 750-4 STD 100×70, Нора-М', '', '', 18),
    row(5, 'Ручка H-0661-CR Apecs', '', '', 9),
    row(6, 'Замок врезной 6000-CR Apecs', '', '', 9),
    row(7, 'Полотно ПГ Классика Pleskovdoor, шпон дуб', 'размер 2000×600', '', 2),
    row(8, 'Коробка массив, шпон дуб, 76×33, длина 2100', '', '', 6),
    row(9, 'Наличник полукруглый, шпон дуб, 70×11', '', '', 6),
    row(10, 'Наличник телескопический Аква ДПК 70×10×2200', '', '', 27),
    row(11, 'Коробка Аква ДПК 74×10×2200', '', '', 27),
    row(12, 'Замок L03 PG Morelli', '', '', 5),
    row(13, 'Порог алюминиевый 40×1800, дуб', '', '', 30),
    ...[[2060, 780, 'левая'], [2060, 780, 'правая'], [2060, 880, 'левая'], [2060, 880, 'правая'], [2060, 980, 'левая']].map(([h, w, side], k) => row(14 + k, `Дверь ДПС 01 EI60 ${side}`, `${h}×${w}, ${ref}`, 'ГОСТ Р 57327-2016', 1)),
    row(19, 'Блок ДСН двупольный 2300×1430', '', 'ГОСТ 31173-2016', 1),
  ];
  blocks.push({ table: [REAL_HEAD, ...rows] });
  return docx(blocks);
}

/** Матрица характеристик 89835 «Двери.docx»: позиция — блок из пяти строк, количества нет (21 позиция). */
export function matrix89835(): Uint8Array {
  const types = ['ДМ{w}-С', 'ДМ{w}', 'ДС{w}'];
  const widths = [600, 700, 800, 900, 1000, 1100, 1200];
  const rows: Cell[][] = [];
  for (const t of types) for (const w of widths) rows.push(['Наименование', t.replace('{w}', String(w))], ['Размер', `2100×${w}`], ['Материал', 'МДФ'], ['Покрытие', 'ПВХ белый'], ['Фурнитура', 'петли, замок']);
  return docx([{ p: 'Перечень дверей' }, { table: rows }]);
}

/** 89518 «28. Ведомость дверей.наружные»: 5 наружных дверей, размер Н×Ш, открывание. */
export function vedomost89518(): Uint8Array {
  const row = (mark: string, name: string, size: string, side: string, qty: number) => [mark, name, size, side, String(qty)];
  return docx([
    { p: 'Ведомость дверей. Наружные' },
    {
      table: [
        ['Марка', 'Наименование', 'Размер Н×Ш, мм', 'Открывание', 'Кол-во, шт'],
        row('ДНО-1', 'Дверь наружная металлическая остеклённая', '2070×1010', 'левое', 1),
        row('ДНО-2', 'Дверь наружная металлическая остеклённая двупольная', '2070×1310', 'правое', 1),
        row('ДНО-3', 'Дверь наружная металлическая остеклённая', '2070×910', 'правое', 1),
        row('ДН-1', 'Дверь наружная металлическая глухая', '2070×1010', 'левое', 2),
        row('ДН-2', 'Дверь наружная металлическая глухая', '2070×910', 'левое', 1),
      ],
    },
  ]);
}

/** 89518 «21. План заполнения проёмов»: 18 проёмов — Д1–Д12, наружные ДНО / ДН; только ширина проёма. */
export function plan89518(): Uint8Array {
  const rows: Cell[][] = [['Обозначение', 'Наименование', 'Ширина, мм', 'Кол-во, шт']];
  for (let i = 1; i <= 12; i += 1) rows.push([`Д${i}`, 'Дверь внутренняя', String(700 + (i % 3) * 100), '1']);
  for (const [mark, w, q] of [['ДНО-1', 1000, 1], ['ДНО-2', 1300, 1], ['ДНО-3', 900, 1], ['ДН-1', 1000, 2], ['ДН-2', 900, 1], ['ДН-3', 900, 1]] as const) rows.push([mark, 'Дверь наружная', String(w), String(q)]);
  return docx([{ p: 'План заполнения проёмов' }, { table: rows }]);
}
