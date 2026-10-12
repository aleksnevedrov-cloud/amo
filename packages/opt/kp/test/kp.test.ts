import type { LeadFile } from '@core/amo';
import type { LlmGateway, RoutedRequest, RoutedResponse } from '@core/llm';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PRICE_NOTE, lineSum, plural, rublesInWords, templateData, withPriceNoteFallback } from '../src/build.ts';
import { buildKpDraft, parseDraft, positionToRequest, type KpDraftDeps, type ParsedFile } from '../src/draft.ts';

describe('сборка КП: значения для шаблона', () => {
  it('сумма прописью и формы слов', () => {
    expect(plural(1, 'рубль', 'рубля', 'рублей')).toBe('рубль');
    expect(plural(22, 'рубль', 'рубля', 'рублей')).toBe('рубля');
    expect(plural(111, 'рубль', 'рубля', 'рублей')).toBe('рублей');
    expect(rublesInWords(123456.78)).toBe('Сто двадцать три тысячи четыреста пятьдесят шесть рублей 78 копеек');
    expect(rublesInWords(1001)).toBe('Одна тысяча один рубль 00 копеек');
    expect(rublesInWords(0.5)).toBe('ноль рублей 50 копеек');
  });

  it('итоги по строкам со скидкой, НДС внутри цены', () => {
    const line = { name: 'Турин 1', size: '2000×800 мм', qty: 2, price: 10_000, discount: 10 };
    expect(lineSum(line)).toBe(18_000);
    const data = templateData({ kpNo: 'КП-2026-1', date: new Date(2026, 9, 12), basis: 'запрос от 09.10.2026', clientName: 'ООО Ромашка', clientPhone: '+7 900', lines: [line, { ...line, price: null }], vatRate: 22, priceNote: DEFAULT_PRICE_NOTE });
    // Разделитель тысяч в ru-RU — неразрывный пробел.
    const plain = (v: string) => v.replace(/\u00a0/g, ' ');
    expect(data.items.map((i) => [i.n, plain(i.price), plain(i.sum)])).toEqual([[1, '10 000 ₽', '18 000 ₽'], [2, '—', '0 ₽']]);
    expect(plain(data.grand_total)).toBe('18 000 ₽');
    expect(data.total_qty).toBe('4 позиции');
    expect(plain(data.vat_phrase)).toBe('в том числе НДС 22% — 3 245,90 ₽');
    expect(templateData({ kpNo: '1', date: new Date(), basis: '', clientName: '', clientPhone: '', lines: [line], vatRate: 0, priceNote: '' }).vat_phrase).toBe('НДС не облагается');
    expect(data.price_note).toBe('Цены носят ориентировочный характер и могут быть скорректированы после уточнения всех деталей заказа.');
  });

  it('фраза о ценах: есть тег — как есть; нет тега — под строкой НДС; пустая фраза — ничего', () => {
    const line = { name: 'Турин 1', size: '', qty: 1, price: 1_000, discount: 0 };
    const data = templateData({ kpNo: '1', date: new Date(), basis: '', clientName: '', clientPhone: '', lines: [line], vatRate: 0, priceNote: ' Цены ориентировочные. ' });
    expect(data.price_note).toBe('Цены ориентировочные.');
    expect(withPriceNoteFallback(true, data)).toEqual({ data, fallback: false });
    const fb = withPriceNoteFallback(false, data);
    expect(fb.fallback).toBe(true);
    expect(fb.data.vat_phrase).toBe('НДС не облагается\nЦены ориентировочные.');
    expect(withPriceNoteFallback(false, { ...data, price_note: '' })).toEqual({ data: { ...data, price_note: '' }, fallback: false });
  });
});

describe('черновик: разбор ответа модели и позиций спецификации', () => {
  it('обёртка ```json и мусор вокруг объекта допускаются, лишнее отсекается', () => {
    const p = parseDraft('Вот JSON:\n```json\n{"client":{"org":" ООО Ромашка ","fio":"","email":"a@b.ru","phone":""},"request_items":[{"raw":"Дверь 2100*900 — 3 шт","name":"дверь белая","width_mm":"900","height_mm":2100,"qty":"3"},{"raw":"","name":""}],"required_blocks":["price","foo"],"questions":["Цвет?",""]}\n```');
    expect(p.client).toEqual({ org: 'ООО Ромашка', fio: '', email: 'a@b.ru', phone: '' });
    expect(p.request_items).toEqual([{ raw: 'Дверь 2100*900 — 3 шт', name: 'дверь белая', width_mm: 900, height_mm: 2100, qty: 3 }]);
    expect(p.required_blocks).toEqual(['price']);
    expect(p.questions).toEqual(['Цвет?']);
    expect(parseDraft('не json').request_items).toEqual([]);
  });

  it('позиция спецификации → позиция запроса; цена клиента из документа не берётся', () => {
    const r = positionToRequest({ name: 'Дверь противопожарная', marking: 'ДПС 01 EI30', width_mm: 900, height_mm: 2100, qty: 3, unit: 'компл.', price_rub: 25_000, material: 'сталь', color: 'RAL 7035', fireproof: true, note: null });
    expect(r).toEqual({ raw: 'ДПС 01 EI30 Дверь противопожарная 2100×900 3 компл.', name: 'Дверь противопожарная, сталь, RAL 7035', width_mm: 900, height_mm: 2100, qty: 3 });
    expect(positionToRequest({ name: 'Добор', marking: null, width_mm: null, height_mm: null, qty: null, unit: null, price_rub: null, material: null, color: null, fireproof: null, note: null })).toEqual({ raw: 'Добор 1 шт', name: 'Добор', width_mm: null, height_mm: null, qty: 1 });
  });
});

/** Шлюз, который отдаёт заранее заданный текст и запоминает запросы. */
function fakeGateway(text: string) {
  const requests: RoutedRequest[] = [];
  const gateway: LlmGateway = {
    async chat(req, route) {
      requests.push(req);
      const res: RoutedResponse = {
        text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0 },
        provider: route.primary.provider, model: route.primary.model, assistantMessage: { role: 'assistant', content: text }, latencyMs: 1,
        fallbackUsed: false, requested: route.primary, attempts: [],
      };
      return res;
    },
    providers: async () => ['openai'],
    provider: async () => null,
  };
  return { gateway, requests };
}

const route = { primary: { provider: 'openai' as const, model: 'gpt-5.5' }, fallback: null };
const file = (uuid: string, name: string, size = 1000): LeadFile => ({ uuid, name, size, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', createdAt: null, downloadUrl: `https://drive/${uuid}` });
const position = (name: string, w: number | null, h: number | null, qty: number | null): ParsedFile['positions'][number] => ({ name, marking: null, width_mm: w, height_mm: h, qty, unit: 'шт', price_rub: null, material: null, color: null, fireproof: null, note: null });

function fakeAmo(opts: { files?: LeadFile[]; mails?: Awaited<ReturnType<KpDraftDeps['amo']['leadMailNotes']>> } = {}): KpDraftDeps['amo'] & { downloaded: string[] } {
  const downloaded: string[] = [];
  return {
    downloaded,
    getLead: async () => ({ id: 89835, name: 'Двери для офиса', price: null, status_id: 1, pipeline_id: 1, responsible_user_id: 3, created_at: 0, custom_fields_values: null, _embedded: { contacts: [{ id: 77, is_main: true }] } }),
    getContact: async () => ({ id: 77, name: 'Иванов Иван', custom_fields_values: [{ field_id: 1, field_code: 'EMAIL', values: [{ value: 'ivanov@romashka.ru' }] }, { field_id: 2, field_code: 'PHONE', values: [{ value: '+7 900 000-00-00' }] }] }),
    leadMailNotes: async () => opts.mails ?? [],
    listLeadFiles: async () => opts.files ?? [],
    downloadFile: async (f) => {
      downloaded.push(f.name);
      return { bytes: new Uint8Array([1, 2, 3]), mime: f.mime };
    },
  };
}

const modelAnswer = JSON.stringify({
  client: { org: 'ООО Ромашка', fio: '', email: '', phone: '' },
  request_items: [{ raw: 'Дверь 2000*800 — 2 шт, цена 5 000', name: 'дверь', width_mm: 800, height_mm: 2000, qty: 2 }],
  required_blocks: ['price', 'delivery'],
  questions: ['Нужен ли монтаж?'],
});
const letter = { id: 1, createdAt: new Date('2026-10-09T10:00:00Z'), income: true, subject: 'Запрос КП', text: 'Прошу КП по спецификации во вложении', from: 'ivanov@romashka.ru', to: 'sales@rf-dveri.ru', attachments: ['Двери (3).docx'] };

describe('черновик КП опта: источник — карточка сделки', () => {
  it('позиции из разобранной спецификации, клиент из письма и контакта, цены не заданы, лишние файлы пропущены с причиной', async () => {
    const { gateway, requests } = fakeGateway(modelAnswer);
    const amo = fakeAmo({ files: [file('u1', 'Двери (3).docx'), file('u2', 'big.pdf', 30 * 1024 * 1024), file('u3', 'кривой.xlsx')], mails: [letter] });
    const analyze: KpDraftDeps['analyze'] = async (f) => {
      if (f.filename === 'кривой.xlsx') throw new Error('Файл не читается');
      return { id: 501, filename: f.filename, kind: 'request', positions: [position('Дверь ДПС 01', 900, 2100, 11), position('Добор', null, null, null)], questions: ['Сторона открывания?'], requirements: [] };
    };
    const r = await buildKpDraft(gateway, { accountId: 1, leadId: 89835, route, pricing: {} }, { amo, analyze });
    expect(amo.downloaded).toEqual(['Двери (3).docx', 'кривой.xlsx']);
    expect(r.payload.items).toEqual([
      { request_index: 0, page_id: null, name: 'Дверь ДПС 01', size: '2100×900 мм', qty: 11, price: null, lead_time: '', discount: 0 },
      { request_index: 1, page_id: null, name: 'Добор', size: '', qty: 1, price: null, lead_time: '', discount: 0 },
    ]);
    expect(r.payload.needs_manager).toEqual([{ request_index: 0, reason: 'цена не задана' }, { request_index: 1, reason: 'цена не задана' }]);
    // Письмо прочитано моделью ради реквизитов и блоков; позиции из письма не используются, когда есть спецификация.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages[0]?.content).toContain('Тема: Запрос КП');
    expect(r.payload.client).toEqual({ org: 'ООО Ромашка', fio: 'Иванов Иван', email: 'ivanov@romashka.ru', phone: '+7 900 000-00-00' });
    expect(r.payload.required_blocks).toEqual(['price', 'delivery']);
    expect(r.payload.questions).toEqual(['Нужен ли монтаж?', 'Сторона открывания?']);
    expect(r.payload.source).toMatchObject({ from: 'amo_card', mails: 1, letterAt: '2026-10-09T10:00:00.000Z', attachments: ['Двери (3).docx', 'big.pdf', 'кривой.xlsx'], documents: [501], skipped: [{ name: 'big.pdf', reason: 'файл больше 20 МБ' }, { name: 'кривой.xlsx', reason: 'Файл не читается' }] });
    expect(r.payload.candidates).toEqual([]);
    expect(r.cost).toEqual({ inputTokens: 1000, outputTokens: 100, usd: expect.any(Number) });
    expect(r).toMatchObject({ provider: 'openai', model: 'gpt-5.5' });
  });

  it('аналог — только пометка менеджеру с критерием; строка без цены и без замены; требования ГОСТ из письма', async () => {
    const { gateway } = fakeGateway(JSON.stringify({ client: { org: 'ООО Ромашка', fio: '', email: '', phone: '' }, request_items: [{ raw: 'Дверь шпон венге 2000*800 по ГОСТ 6629-88', name: 'дверь шпон венге', width_mm: 800, height_mm: 2000, qty: 1 }, { raw: 'Добор', name: 'добор', width_mm: null, height_mm: null, qty: 2 }], required_blocks: [], questions: [] }));
    const asked: string[] = [];
    const analogs: KpDraftDeps['analogs'] = async (item) => {
      asked.push(item.name);
      expect(item.requirements).toEqual(['ГОСТ 6629-88']);
      return item.name.includes('венге') ? [{ id: 'p1', name: 'Милан', vendor: 'Фабрика В', price: 8_500, design: ['шпон', 'венге'], standards: [] }] : [];
    };
    const r = await buildKpDraft(gateway, { accountId: 1, leadId: 1, route }, { amo: fakeAmo({ mails: [{ ...letter, text: 'Нужны двери по ГОСТ 6629-88, см. список' }] }), analyze: null, analogs });
    expect(asked).toEqual(['дверь шпон венге', 'добор']);
    expect(r.payload.requirements).toEqual(['ГОСТ 6629-88']);
    expect(r.payload.items.map((l) => [l.name, l.price])).toEqual([['дверь шпон венге', null], ['добор', null]]);
    expect(r.payload.needs_manager.map((n) => [n.request_index, n.reason.replace(/\u00a0/g, ' ')])).toEqual([
      [0, 'цена не задана'],
      [1, 'цена не задана'],
      [0, 'предварительно, по аналогу: Фабрика В Милан, источник не указан; 8 500 ₽; совпадение по дизайну (общие признаки «шпон, венге»)'],
    ]);
    // Без источника кандидатов черновик собирается без предложений.
    const r2 = await buildKpDraft(gateway, { accountId: 1, leadId: 1, route }, { amo: fakeAmo({ mails: [letter] }), analyze: null });
    expect(r2.payload.needs_manager.some((n) => n.reason.includes('по аналогу'))).toBe(false);
  });

  it('файлов нет — позиции из письма; разбор недоступен — файлы в skipped', async () => {
    const { gateway } = fakeGateway(modelAnswer);
    const r = await buildKpDraft(gateway, { accountId: 1, leadId: 1, route }, { amo: fakeAmo({ mails: [letter], files: [file('u1', 'spec.docx')] }), analyze: null });
    expect(r.payload.items.map((l) => [l.name, l.size, l.qty, l.price])).toEqual([['дверь', '2000×800 мм', 2, null]]);
    expect(r.payload.source.skipped).toEqual([{ name: 'spec.docx', reason: 'разбор файлов недоступен' }]);
  });

  it('в карточке пусто — модель не вызывается, пометка менеджеру, расход 0', async () => {
    const { gateway, requests } = fakeGateway(modelAnswer);
    const r = await buildKpDraft(gateway, { accountId: 1, leadId: 1, route }, { amo: fakeAmo(), analyze: null });
    expect(requests).toHaveLength(0);
    expect(r.payload.items).toEqual([]);
    expect(r.payload.needs_manager).toEqual([{ request_index: -1, reason: 'в карточке нет ни письма, ни файлов с запросом' }]);
    expect(r.payload.source.from).toBe('none');
    expect(r.payload.client).toEqual({ org: '', fio: 'Иванов Иван', email: 'ivanov@romashka.ru', phone: '+7 900 000-00-00' });
    expect(r).toMatchObject({ cost: { usd: 0 }, provider: null, model: null });
  });
});
