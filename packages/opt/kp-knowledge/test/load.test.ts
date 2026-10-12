import { describe, expect, it } from 'vitest';
import { knowledgeHints, knowledgeSummary } from '../src/apply.ts';
import { parseCsv, parseNumber } from '../src/csv.ts';
import { KNOWLEDGE_KINDS } from '../src/kinds.ts';
import { loadKnowledge, templateText } from '../src/load.ts';
import { EMPTY_KNOWLEDGE, type KnowledgeSet } from '../src/repo.ts';

describe('CSV справочников', () => {
  it('разделитель по заголовку, кавычки, комментарии и пустые строки пропускаются, номера строк сохраняются', () => {
    const t = parseCsv('\uFEFF# шапка\nзона;цена, ₽;примечание\n\n# пример\n"Москва; центр";"1 500";"с ""кавычкой"""\nМО до 30 км;2000;\n');
    expect(t.delimiter).toBe(';');
    expect(t.header).toEqual(['зона', 'цена, ₽', 'примечание']);
    expect(t.rows).toEqual([{ line: 5, cells: ['Москва; центр', '1 500', 'с "кавычкой"'] }, { line: 6, cells: ['МО до 30 км', '2000', ''] }]);
    expect(parseCsv('a,b\n1,2').delimiter).toBe(',');
    expect(() => parseCsv('# только комментарий\n')).toThrow('нет строки заголовка');
    expect(() => parseCsv('a;b\n"x;y')).toThrow('незакрытая кавычка');
  });

  it('числа прайса: пробелы, запятая, знак рубля', () => {
    expect(parseNumber('1 500')).toBe(1500);
    expect(parseNumber('1500,50 ₽')).toBe(1500.5);
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('много')).toBeNull();
  });
});

describe('шаблоны и загрузка справочников', () => {
  it('каждый шаблон загружается без ошибок и даёт 0 строк: пример помечен # и пропускается', async () => {
    for (const kind of KNOWLEDGE_KINDS) {
      const r = loadKnowledge(kind, await templateText(kind));
      if (kind === 'b2b') {
        // Регламент: пример-раздел в шаблоне остаётся, пока заказчик его не заменил — это один раздел с пометкой ПРИМЕР.
        expect(r.ok && r.rows, kind).toBe(1);
      } else {
        expect(r, kind).toEqual({ ok: true, data: [], rows: 0 });
      }
    }
  });

  it('доставка: заполненный файл → строки с числами; ошибки с номером строки и колонкой', () => {
    const ok = loadKnowledge('delivery', 'Зона;Описание;Цена, ₽;Бесплатно от, ₽;Примечание\nМосква;внутри МКАД;1 500;30 000;\nМО;до 30 км;2500;;по договорённости');
    expect(ok).toEqual({ ok: true, rows: 2, data: [{ zone: 'Москва', description: 'внутри МКАД', priceRub: 1500, minOrderRub: 30_000, note: '' }, { zone: 'МО', description: 'до 30 км', priceRub: 2500, minOrderRub: null, note: 'по договорённости' }] });
    const bad = loadKnowledge('delivery', 'зона;цена, ₽\nМосква;дорого\n;1000');
    expect(bad).toEqual({ ok: false, errors: [{ line: 2, message: 'колонка «цена»: не число: «дорого»' }, { line: 2, message: 'колонка «цена»: Required' }, { line: 3, message: expect.stringContaining('колонка «зона»') }] });
    expect(loadKnowledge('delivery', 'зона;примечание\nМосква;x')).toEqual({ ok: false, errors: [{ line: 1, message: 'нет обязательных колонок: цена' }] });
  });

  it('монтаж, аналоги, стоп-лист: заголовки с другим регистром и «ё» принимаются', () => {
    expect(loadKnowledge('installation', 'Услуга;Единица;Цена;Примечание\nВыезд замерщика;выезд;0;бесплатно в МКАД')).toMatchObject({ ok: true, rows: 1, data: [{ service: 'Выезд замерщика', unit: 'выезд', priceRub: 0 }] });
    expect(loadKnowledge('analogs', 'Фабрика;Модель;Фабрика-аналог;Модель-аналог;Отличия\nА;М1;Б;М2;другая фурнитура')).toMatchObject({ ok: true, data: [{ factory: 'А', model: 'М1', analogFactory: 'Б', analogModel: 'М2', note: 'другая фурнитура' }] });
    expect(loadKnowledge('stoplist', 'Тема;Правило;Ключевые слова\nСроки;не обещаем срок без фабрики;срок, срочно')).toMatchObject({ ok: true, data: [{ topic: 'Сроки', keywords: 'срок, срочно' }] });
    expect(loadKnowledge('stoplist', 'тема;правило\nСроки;')).toMatchObject({ ok: false, errors: [{ line: 2 }] });
  });

  it('регламент: разделы по «##», HTML-комментарий шаблона вырезается, пустой файл — ошибка', () => {
    const r = loadKnowledge('b2b', '<!-- подсказка -->\n## Документы\nСчёт, договор.\n\n## Сроки оплаты\nПредоплата 50 %.\n');
    expect(r).toEqual({ ok: true, rows: 2, data: { sections: [{ title: 'Документы', text: 'Счёт, договор.' }, { title: 'Сроки оплаты', text: 'Предоплата 50 %.' }] } });
    expect(loadKnowledge('b2b', 'просто текст без разделов').ok).toBe(false);
  });
});

describe('подсказки из справочников для черновика', () => {
  const k: KnowledgeSet = {
    delivery: [{ zone: 'Москва', description: '', priceRub: 1500, minOrderRub: null, note: '' }],
    installation: [{ service: 'Монтаж полотна', unit: 'шт', priceRub: 3000, note: '' }],
    b2b: { sections: [{ title: 'Документы', text: '…' }, { title: 'Оплата', text: '…' }] },
    analogs: [{ factory: 'Фабрика А', model: 'Турин', analogFactory: 'Фабрика Б', analogModel: 'Верона', note: 'без стекла' }],
    stoplist: [{ topic: 'Сроки', rule: 'не обещаем срок без фабрики', keywords: 'срок, срочно' }, { topic: 'Сертификаты', rule: 'только по запросу у фабрики', keywords: 'сертификат' }],
  };
  const items = [{ request_index: 0, name: 'Дверь Турин эмаль', raw: 'Турин 2000*800 срочно' }, { request_index: 1, name: 'Добор' }];

  it('пустые справочники не дают подсказок — черновик как без базы знаний', () => {
    expect(knowledgeHints({ items, requiredBlocks: ['delivery'], text: 'нужна доставка и монтаж, юрлицо', isLegalEntity: true }, EMPTY_KNOWLEDGE)).toEqual([]);
    expect(knowledgeSummary(EMPTY_KNOWLEDGE)).toEqual({ delivery: 0, installation: 0, b2b: 0, analogs: 0, stoplist: 0 });
  });

  it('стоп-лист у позиции и у письма, аналог у позиции, доставка, монтаж и регламент — у черновика', () => {
    const hints = knowledgeHints({ items, requiredBlocks: ['delivery'], text: 'Прошу КП, нужен монтаж и сертификаты. Турин 2000*800 срочно', isLegalEntity: true }, k);
    expect(hints).toEqual([
      { request_index: 0, reason: 'стоп-лист (Сроки): не обещаем срок без фабрики' },
      { request_index: -1, reason: 'стоп-лист (Сертификаты): только по запросу у фабрики' },
      { request_index: 0, reason: 'аналог по справочнику: Фабрика Б Верона (без стекла)' },
      { request_index: -1, reason: 'доставка: в справочнике 1 зон — добавьте строку по адресу клиента' },
      { request_index: -1, reason: 'замер и монтаж: в справочнике 1 услуг — добавьте нужные строки' },
      { request_index: -1, reason: 'юрлицо: сверьтесь с регламентом (Документы; Оплата)' },
    ]);
    expect(knowledgeSummary(k)).toEqual({ delivery: 1, installation: 1, b2b: 2, analogs: 1, stoplist: 2 });
    // Физлицо без доставки и монтажа — только то, что нашлось в позициях.
    expect(knowledgeHints({ items: [items[1]!], requiredBlocks: [], text: 'добор', isLegalEntity: false }, k)).toEqual([]);
  });
});
