import type { LeadFile } from '@core/amo';
import type { LlmGateway, RoutedRequest, RoutedResponse } from '@core/llm';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PRICE_NOTE, lineSum, plural, rublesInWords, templateData, withPriceNoteFallback, withLayoutFallback, currencyTagsInTemplate, withCurrencyFallback, dropPageBreaksAfterTable } from '../src/build.ts';
import { buildKpDraft, extractEmail, mailSearchOf, parseDraft, positionToRequest, senderFromNotes, type KpDraftDeps, type ParsedFile, fullItemName, kpLineName, kpLineParts, kpShortName, tidyName } from '../src/draft.ts';
import { MailAuthError, type MailSearchDiag } from '../src/mail-read.ts';
import { researchablePositions } from '../src/research-job.ts';

const noDiag: MailSearchDiag = { criteria: { from: '', domain: '', since: '', before: '', subject: null }, folders: [], skippedFolders: [], fallbackWithoutDate: false, errors: [] };

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
    // KP-LAYOUT: размер в документе с пробелами вокруг × — перенос в узкой колонке по пробелу, а не посреди числа.
    expect(data.items[0]?.size).toBe('2000 × 800 мм');
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
    // KB-MATCH: признаки двери от модели — только названные (словами или кодами), пустые/неизвестные отбрасываются, без признаков поля нет.
    const f = parseDraft('{"request_items":[{"raw":"Дверной блок деревянный глухой CPL 1010×2100","name":"дверной блок","width_mm":1010,"height_mm":2100,"qty":1,"features":{"type":"block","material":"деревянный","glazing":"solid","leaves":null,"threshold":"без порога","opening":"","coating":"CPL","fire":null,"closer":true,"lock":"нет"}},{"raw":"Добор","name":"добор","qty":2,"features":{"type":null}}]}');
    // KP-NAME: короткое название модели заменено строкой письма без размера.
    expect(f.request_items[0]).toEqual({ raw: 'Дверной блок деревянный глухой CPL 1010×2100', name: 'Дверной блок деревянный глухой CPL', width_mm: 1010, height_mm: 2100, qty: 1, features: { type: 'block', material: 'wood', glazing: 'solid', threshold: 'without', coating: 'cpl', closer: true } });
    expect(f.request_items[1]).toEqual({ raw: 'Добор', name: 'добор', width_mm: null, height_mm: null, qty: 2 });
  });

  it('KP-NAME: полное наименование как у клиента — сокращение модели заменяется строкой письма без размера и количества; наименование КП с моделью прайса', () => {
    const raw = 'Дверной блок деревянный внутренний глухой однопольный распашной без порога, с доводчиком, внутренним механическим замком с ключом снаружи и изнутри, облицовка CPL светло-серый 1010×2100 — 1 шт';
    const full = 'Дверной блок деревянный внутренний глухой однопольный распашной без порога, с доводчиком, внутренним механическим замком с ключом снаружи и изнутри, облицовка CPL светло-серый';
    expect(fullItemName(raw, 'Дверной блок деревянный внутренний глухой однопольный без порога распашной')).toBe(full);
    expect(fullItemName('3. ' + raw, 'дверной блок')).toBe(full);
    // Модель ответила полнее строки письма или строка — одно слово: остаётся ответ модели.
    expect(fullItemName('Дверь 2100*900 — 3 шт', 'дверь белая')).toBe('дверь белая');
    expect(fullItemName('п. 4 полотно 2000х800х40 мм 12 штук', 'полотно межкомнатное')).toBe('полотно межкомнатное');
    // Слова письма не пересекаются с ответом модели (модель назвала другое) — ответ модели.
    expect(fullItemName('ДПГ сота 800×2000 — 2 шт', 'дверь глухая ламинированная')).toBe('дверь глухая ламинированная');
    expect(fullItemName('', 'добор')).toBe('добор');
    const p = parseDraft(JSON.stringify({ request_items: [{ raw, name: 'Дверной блок деревянный внутренний глухой однопольный без порога распашной', width_mm: 1010, height_mm: 2100, qty: 1 }] }));
    expect(p.request_items[0]?.name).toBe(full);
    expect(kpLineName({ name: full, priceModel: 'ДВ CPL 0,2 мм' })).toBe(`${full} — по прайсу: ДВ CPL 0,2 мм`);
    expect(kpLineName({ name: full, priceModel: null })).toBe(full);
    // KP-LAYOUT, п. 2: ячейка в три уровня — короткое название по прайсу без «по прайсу» / комплектация / обозначение заказчика (его строка).
    const item = { raw: `${full} 1010×2100 — 1 шт`, name: full, features: { material: 'wood' as const } };
    expect(kpShortName({ name: full, priceModel: 'ДВ CPL 0,2 мм' }, item)).toBe('Дверной блок ДВ CPL 0,2 мм, глухой, светло-серый');
    expect(kpLineParts({ name: full, priceModel: 'ДВ CPL 0,2 мм', equipment: 'коробка, 3 петли' }, item)).toEqual({ name: 'Дверной блок ДВ CPL 0,2 мм, глухой, светло-серый', equipment: 'коробка, 3 петли', designation: `${full} 1010×2100 — 1 шт` });
    // Полотно — средний род; двупольная противопожарная — признаки через запятую; модель, начинающаяся с типа, не дублируется.
    expect(kpShortName({ name: 'ДПГ + УПД, сота', priceModel: 'ДПГ сота ламинат' }, { raw: 'ДПГ + УПД, сота 2000×800 — 5 шт', name: 'ДПГ + УПД, сота' })).toBe('Полотно ДПГ сота ламинат, глухое');
    expect(kpShortName({ name: 'Дверь противопожарная металлическая EI60 двупольная серая', priceModel: 'ДМ EI60 2Рп' }, null)).toBe('Дверь ДМ EI60 2Рп, двупольная, EI60, серый');
    expect(kpShortName({ name: 'Дверной блок деревянный глухой', priceModel: 'Дверной блок ДГ 21-9' }, null)).toBe('Дверной блок ДГ 21-9, глухой');
    // Без строки прайса: название клиента как есть, третьего уровня нет.
    expect(kpShortName({ name: 'Врезка замка', priceModel: null }, { raw: 'Врезка замка — 3 шт', name: 'Врезка замка' })).toBe('Врезка замка');
    expect(kpLineParts({ name: 'Врезка замка', priceModel: null, equipment: null }, { raw: 'Врезка замка — 3 шт', name: 'Врезка замка' })).toEqual({ name: 'Врезка замка', equipment: '', designation: '' });
    expect(kpLineParts({ name: 'Добор', priceModel: null, equipment: null }, null)).toEqual({ name: 'Добор', equipment: '', designation: '' });
    // Шаблон без {{equipment}} / {{designation}}: уровни идут строками под названием; с ними — название остаётся чистым.
    const data = templateData({ kpNo: '1', date: new Date(), basis: '', clientName: '', clientPhone: '', lines: [{ name: 'Дверной блок ДВ CPL 0,2 мм, глухой', size: '', qty: 1, price: 100, discount: 0, equipment: 'коробка', designation: 'Дверной блок деревянный глухой CPL 1010×2100 — 1 шт' }, { name: 'Добор', size: '', qty: 1, price: 10, discount: 0 }], vatRate: 0, priceNote: '' });
    expect(data.items.map((i) => [i.name, i.equipment, i.designation])).toEqual([['Дверной блок ДВ CPL 0,2 мм, глухой', 'коробка', 'Дверной блок деревянный глухой CPL 1010×2100 — 1 шт'], ['Добор', '', '']]);
    const legacy = withLayoutFallback({ equipment: false, designation: false }, data);
    expect(legacy.fallback).toBe(true);
    expect(legacy.data.items.map((i) => i.name)).toEqual(['Дверной блок ДВ CPL 0,2 мм, глухой\nКомплектация: коробка\nОбозначение заказчика: Дверной блок деревянный глухой CPL 1010×2100 — 1 шт', 'Добор']);
    expect(withLayoutFallback({ equipment: true, designation: false }, data).data.items[0]?.name).toBe('Дверной блок ДВ CPL 0,2 мм, глухой\nОбозначение заказчика: Дверной блок деревянный глухой CPL 1010×2100 — 1 шт');
    expect(withLayoutFallback({ equipment: true, designation: true }, data)).toEqual({ data, fallback: false });
    // KP-LAYOUT, дефект 4: «{{grand_total}} ₽» в шаблоне — знак из значения убирается, у {{price}} без знака остаётся.
    expect(currencyTagsInTemplate('Итого: {{grand_total}} ₽, цена {{price}}, сумма {{ sum }}руб.')).toEqual(['grand_total', 'sum']);
    const money = withCurrencyFallback(['grand_total', 'sum'], data);
    expect(money.grand_total.replace(/\u00a0/g, ' ')).toBe('110');
    expect(money.items.map((i) => [i.price.replace(/\u00a0/g, ' '), i.sum])).toEqual([['100 ₽', '100'], ['10 ₽', '10']]);
    expect(withCurrencyFallback([], data)).toBe(data);
    // Дефект 5: явные разрывы страницы после последней таблицы убираются, до неё — нет.
    const xml = '<w:p><w:r><w:br w:type="page"/></w:r></w:p><w:tbl><w:tr><w:tc><w:p>x</w:p></w:tc></w:tr></w:tbl><w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>3 позиции</w:t></w:r></w:p><w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    const cut = dropPageBreaksAfterTable(xml);
    expect(cut.removed).toBe(2);
    expect(cut.xml).toBe('<w:p><w:r><w:br w:type="page"/></w:r></w:p><w:tbl><w:tr><w:tc><w:p>x</w:p></w:tc></w:tr></w:tbl><w:p><w:pPr></w:pPr><w:r><w:t>3 позиции</w:t></w:r></w:p><w:p><w:r></w:r></w:p>');
    expect(dropPageBreaksAfterTable('<w:p/>')).toEqual({ xml: '<w:p/>', removed: 0 });
    // KP-REBUILD-MAIL, п. 3: пометка «(h)» из спецификации клиента не попадает в название и строку.
    expect(tidyName('Дверь ДПГ 2100 (h) × 900 , белая')).toBe('Дверь ДПГ 2100 × 900, белая');
    expect(tidyName('Полотно 2000(H)х800')).toBe('Полотно 2000 х800');
    expect(positionToRequest({ name: 'Дверь глухая 2100 (h) х 900', marking: null, width_mm: 900, height_mm: 2100, qty: 2, unit: 'шт', price_rub: null, material: null, color: null, fireproof: null, note: null })).toMatchObject({ name: 'Дверь глухая 2100 х 900', raw: 'Дверь глухая 2100 х 900 900×2100 2 шт' });
    expect(parseDraft(JSON.stringify({ request_items: [{ raw: 'Дверь глухая 2100 (h) х 900 — 2 шт', name: 'дверь глухая', qty: 2 }] })).request_items[0]).toMatchObject({ raw: 'Дверь глухая 2100 х 900 — 2 шт', name: 'дверь глухая' });
  });

  it('позиция спецификации → позиция запроса; цена клиента из документа не берётся', () => {
    const r = positionToRequest({ name: 'Дверь противопожарная', marking: 'ДПС 01 EI30', width_mm: 900, height_mm: 2100, qty: 3, unit: 'компл.', price_rub: 25_000, material: 'сталь', color: 'RAL 7035', fireproof: true, note: null });
    expect(r).toEqual({ raw: 'ДПС 01 EI30 Дверь противопожарная 900×2100 3 компл.', name: 'Дверь противопожарная, сталь, RAL 7035', width_mm: 900, height_mm: 2100, qty: 3 });
    expect(positionToRequest({ name: 'Добор', marking: null, width_mm: null, height_mm: null, qty: null, unit: null, price_rub: null, material: null, color: null, fireproof: null, note: null })).toEqual({ raw: 'Добор 1 шт', name: 'Добор', width_mm: null, height_mm: null, qty: 1 });
    // XLSX-2: работы — без размера и с признаком service; дробное количество из заявки сохраняется.
    expect(positionToRequest({ ...position('Врезка замка на производстве', 900, 2100, 21), kind: 'service' })).toEqual({ raw: 'Врезка замка на производстве 21 шт', name: 'Врезка замка на производстве', width_mm: null, height_mm: null, qty: 21, kind: 'service' });
    expect(positionToRequest(position('Наличник ТЕЛЕСКОП', 70, 2150, 24.5))).toMatchObject({ raw: 'Наличник ТЕЛЕСКОП 70×2150 24.5 шт', qty: 24.5 });
  });

  it('работы и услуги идут после товаров, порядок внутри групп как в файле, одинаковые названия не склеиваются; в поиск цен работы не попадают (XLSX-2)', async () => {
    const { gateway } = fakeGateway(modelAnswer);
    const amo = fakeAmo({ files: [file('u1', 'Заявка.xlsx')], mails: [letter] });
    const analyze: KpDraftDeps['analyze'] = async (f) => ({
      id: 502,
      filename: f.filename,
      kind: 'request',
      positions: [
        { ...position('Дверь ДПГ', 850, 2020, 1), note: 'раздел: 1 ЭТАЖ' },
        { ...position('Врезка замка', null, null, 1), kind: 'service', note: 'раздел: 1 ЭТАЖ' },
        { ...position('Ручка Apecs', null, null, 21), note: 'раздел: 1 ЭТАЖ' },
        { ...position('Дверь ДПГ', 850, 2020, 2), note: 'раздел: 2 ЭТАЖ' },
        { ...position('Ручка Apecs', null, null, 20), note: 'раздел: 2 ЭТАЖ' },
        { ...position('Доставка г. Москва', null, null, 1), kind: 'service' },
      ],
      questions: [],
      requirements: [],
    });
    const r = await buildKpDraft(gateway, { accountId: 1, leadId: 89835, route, pricing: {} }, { amo, analyze });
    expect(r.payload.items.map((l) => [l.request_index, l.name, l.qty, l.kind ?? 'product'])).toEqual([
      [0, 'Дверь ДПГ', 1, 'product'],
      [1, 'Ручка Apecs', 21, 'product'],
      [2, 'Дверь ДПГ', 2, 'product'],
      [3, 'Ручка Apecs', 20, 'product'],
      [4, 'Врезка замка', 1, 'service'],
      [5, 'Доставка г. Москва', 1, 'service'],
    ]);
    expect(r.payload.request_items.map((it) => it.kind ?? 'product')).toEqual(['product', 'product', 'product', 'product', 'service', 'service']);
    expect(r.payload.items[4]).toMatchObject({ size: '' });
    expect(researchablePositions(r.payload, 'all', 30)).toEqual([0, 1, 2, 3]);
    expect(researchablePositions(r.payload, [0, 4, 5], 30)).toEqual([0]);
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

function fakeAmo(opts: { files?: LeadFile[]; mails?: Awaited<ReturnType<KpDraftDeps['amo']['leadMailNotes']>>; notes?: Awaited<ReturnType<KpDraftDeps['amo']['getLeadNotes']>> } = {}): KpDraftDeps['amo'] & { downloaded: string[]; uploaded: { filename: string; size: number }[] } {
  const downloaded: string[] = [];
  const uploaded: { filename: string; size: number }[] = [];
  return {
    downloaded,
    uploaded,
    uploadFileToLead: async (_leadId, file) => {
      uploaded.push({ filename: file.filename, size: file.bytes.byteLength });
      return `uuid-${uploaded.length}`;
    },
    getLead: async () => ({ id: 89835, name: 'Двери для офиса', price: null, status_id: 1, pipeline_id: 1, responsible_user_id: 3, created_at: 0, custom_fields_values: null, _embedded: { contacts: [{ id: 77, is_main: true }] } }),
    getContact: async () => ({ id: 77, name: 'Иванов Иван', custom_fields_values: [{ field_id: 1, field_code: 'EMAIL', values: [{ value: 'ivanov@romashka.ru' }] }, { field_id: 2, field_code: 'PHONE', values: [{ value: '+7 900 000-00-00' }] }] }),
    leadMailNotes: async () => opts.mails ?? [],
    getLeadNotes: async () => opts.notes ?? [],
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
      { request_index: 0, page_id: null, name: 'Дверь ДПС 01', size: '900×2100 мм', qty: 11, price: null, lead_time: '', discount: 0 },
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
      // У свежего черновика ни медианы, ни цены менеджера — опорной цены нет.
      expect(item.price).toBeNull();
      return item.name.includes('венге') ? [{ id: 'p1', name: 'Милан', vendor: 'Фабрика В', price: 8_500, design: ['шпон', 'венге'], standards: [] }] : [];
    };
    const r = await buildKpDraft(gateway, { accountId: 1, leadId: 1, route }, { amo: fakeAmo({ mails: [{ ...letter, text: 'Нужны двери по ГОСТ 6629-88, см. список' }] }), analyze: null, analogs });
    // KP-NAME: название как в письме (без размера), требование ГОСТ при этом выделено отдельно.
    expect(asked).toEqual(['Дверь шпон венге по ГОСТ 6629-88', 'добор']);
    expect(r.payload.requirements).toEqual(['ГОСТ 6629-88']);
    expect(r.payload.items.map((l) => [l.name, l.price])).toEqual([['Дверь шпон венге по ГОСТ 6629-88', null], ['добор', null]]);
    expect(r.payload.needs_manager.map((n) => [n.request_index, n.reason.replace(/\u00a0/g, ' ')])).toEqual([
      [0, 'цена не задана'],
      [1, 'цена не задана'],
      [0, 'предварительно, по аналогу: Фабрика В Милан, источник не указан; 8 500 ₽; совпадение по дизайну (общие признаки «шпон, венге»); цена не сравнивалась'],
    ]);
    // Без источника кандидатов черновик собирается без предложений.
    const r2 = await buildKpDraft(gateway, { accountId: 1, leadId: 1, route }, { amo: fakeAmo({ mails: [letter] }), analyze: null });
    expect(r2.payload.needs_manager.some((n) => n.reason.includes('по аналогу'))).toBe(false);
  });

  it('письмо из ящика: полный текст вместо первой строки amo, вложения — в сделку и в разбор, дубли не заливаются', async () => {
    const { gateway, requests } = fakeGateway(JSON.stringify({ client: { org: 'ООО Стройоптпоставка', fio: '', email: '', phone: '' }, request_items: [{ raw: 'дверь двухпольная, массив лиственницы 1,4×2,7 м, L429 Indigo, 2 шт', name: 'дверь двухпольная', width_mm: 1400, height_mm: 2700, qty: 2 }], required_blocks: [], questions: [] }));
    const spec = Buffer.from('spec bytes');
    const amo = fakeAmo({ mails: [{ ...letter, from: 'stoptpostavka@yandex.ru', subject: 'Запрос', text: 'Добрый день!' }], files: [file('u1', 'already.pdf', spec.byteLength)] });
    const searches: unknown[] = [];
    const mail: KpDraftDeps['mail'] = async (search) => {
      searches.push(search);
      return { diag: noDiag, mail: {
        uid: 7,
        folder: 'INBOX',
        matchedBy: 'address',
        messageId: '<m7@yandex.ru>',
        from: 'stoptpostavka@yandex.ru',
        fromName: 'Стройоптпоставка',
        subject: 'Запрос',
        date: new Date('2026-10-12T13:55:00Z'),
        text: 'Добрый день!\nНужна дверь двухпольная, массив лиственницы 1,4×2,7 м, окраска L429 Indigo, 2 шт. Аналог допустим.',
        attachments: [
          { filename: 'tz.pdf', contentType: 'application/pdf', size: 621_000, content: Buffer.alloc(621_000, 1), inline: false },
          { filename: 'already.pdf', contentType: 'application/pdf', size: spec.byteLength, content: spec, inline: false },
          { filename: 'logo.png', contentType: 'image/png', size: 3_000, content: Buffer.alloc(3_000), inline: true },
        ],
      } };
    };
    const analyzed: string[] = [];
    const analyze: KpDraftDeps['analyze'] = async (f) => {
      analyzed.push(`${f.filename}:${f.bytes.byteLength}`);
      return { id: 900 + analyzed.length, filename: f.filename, kind: 'spec', positions: [], questions: [], requirements: [] };
    };
    const r = await buildKpDraft(gateway, { accountId: 1, leadId: 30013995, route }, { amo, analyze, mail });
    expect(searches).toEqual([{ from: 'stoptpostavka@yandex.ru', around: letter.createdAt, subject: 'Запрос' }]);
    // Полный текст письма ушёл модели вместо первой строки из amo.
    expect(requests[0]?.messages[0]?.content).toContain('окраска L429 Indigo, 2 шт. Аналог допустим');
    // Вложения: новое загружено в сделку, дубль по имени и размеру — нет, мелкая встроенная картинка пропущена; разбор из памяти, без скачивания из amo.
    expect(amo.uploaded).toEqual([{ filename: 'tz.pdf', size: 621_000 }]);
    expect(amo.downloaded).toEqual([]);
    expect(analyzed).toEqual(['tz.pdf:621000', `already.pdf:${spec.byteLength}`]);
    expect(r.payload.source).toMatchObject({ from: 'mailbox', attachments: ['tz.pdf', 'already.pdf'], documents: [901, 902] });
    expect(r.payload.source.mail).toMatchObject({ status: 'found', folder: 'INBOX', messageId: '<m7@yandex.ru>', from: 'stoptpostavka@yandex.ru', fromName: 'Стройоптпоставка', attachments: 3, taken: ['tz.pdf', 'already.pdf'], uploaded: ['tz.pdf'], skipped: [{ name: 'logo.png', reason: 'встроенная картинка меньше 20 КБ' }] });
    // Список вложений со статусами для раздела «Письмо» в карточке (RFD-AI-AGENT-OPT-MAIL-UI).
    expect(r.payload.source.mail?.files).toEqual([
      { name: 'logo.png', size: 3_000, inline: true, status: 'skipped', reason: 'встроенная картинка меньше 20 КБ' },
      { name: 'tz.pdf', size: 621_000, inline: false, status: 'uploaded', reason: null },
      { name: 'already.pdf', size: spec.byteLength, inline: false, status: 'not_uploaded', reason: 'уже есть в файлах сделки' },
    ]);
    // KP-NAME: название как в письме (массив и окраска сохранены), без размера и количества.
    expect(r.payload.items.map((l) => l.name)).toEqual(['дверь двухпольная, массив лиственницы, L429 Indigo']);
    expect(r.payload.needs_manager.some((n) => n.reason.includes('письмо в ящике'))).toBe(false);
    // Привязка файла в amo упала (405) — вложение всё равно разбирается из памяти, причина — в skipped (RFD-AI-AGENT-OPT-MAIL-READ-7).
    const broken = fakeAmo({ mails: [{ ...letter, from: 'stoptpostavka@yandex.ru', subject: 'Запрос', text: 'Добрый день!' }] });
    broken.uploadFileToLead = async () => {
      throw new Error('привязка файла f-1 к сделке: PUT https://acc.amocrm.ru/api/v4/leads/30013995/files → HTTP 405: {}');
    };
    analyzed.length = 0;
    const r2 = await buildKpDraft(gateway, { accountId: 1, leadId: 30013995, route }, { amo: broken, analyze, mail });
    expect(analyzed).toEqual(['tz.pdf:621000', `already.pdf:${spec.byteLength}`]);
    expect(r2.payload.source.documents).toHaveLength(2);
    expect(r2.payload.source.mail).toMatchObject({ status: 'found', uploaded: [], taken: ['tz.pdf', 'already.pdf'] });
    expect(r2.payload.source.mail?.skipped.map((x) => x.name)).toEqual(['logo.png', 'tz.pdf', 'already.pdf']);
    expect(r2.payload.source.mail?.skipped[1]?.reason).toContain('не загружен в сделку: привязка файла f-1 к сделке: PUT');
    expect(r2.payload.source.mail?.files?.map((f) => [f.name, f.status, f.reason?.slice(0, 20) ?? null])).toEqual([['logo.png', 'skipped', 'встроенная картинка '], ['tz.pdf', 'not_uploaded', 'привязка файла f-1 к'], ['already.pdf', 'not_uploaded', 'привязка файла f-1 к']]);
  });

  it('адрес отправителя из mail-note amo: только e-mail, без имени и кириллицы; тема — из письма, не название сделки', async () => {
    expect(extractEmail('Баринов Михаил Анатольевич 914@rolt.ru')).toBe('914@rolt.ru');
    expect(extractEmail('"Иван Петров" <Ivan.Petrov@Client.RU>')).toBe('ivan.petrov@client.ru');
    expect(extractEmail('ivan@client.ru')).toBe('ivan@client.ru');
    expect(extractEmail('Баринов Михаил')).toBe('');
    expect(extractEmail(null)).toBe('');
    const { gateway } = fakeGateway(JSON.stringify({ client: { org: '', fio: '', email: '', phone: '' }, request_items: [], required_blocks: [], questions: [] }));
    const searches: { from: string; subject?: string | null }[] = [];
    const mail: KpDraftDeps['mail'] = async (search) => {
      searches.push({ from: search.from, subject: search.subject });
      return { mail: null, diag: noDiag };
    };
    await buildKpDraft(gateway, { accountId: 1, leadId: 30012689, route }, { amo: fakeAmo({ mails: [{ ...letter, from: 'Баринов Михаил Анатольевич 914@rolt.ru', subject: 'Запрос на двери' }] }), analyze: null, mail });
    expect(searches).toEqual([{ from: '914@rolt.ru', subject: 'Запрос на двери' }]);
    // В mail-note адреса нет — e-mail главного контакта (у fakeAmo это ivanov@romashka.ru).
    await buildKpDraft(gateway, { accountId: 1, leadId: 1, route }, { amo: fakeAmo({ mails: [{ ...letter, from: 'Баринов Михаил', subject: '' }] }), analyze: null, mail });
    expect(searches[1]).toEqual({ from: 'ivanov@romashka.ru', subject: null });
  });

  it('совпадение только по корпоративному домену: текст и вложения в разбор, в сделку ничего не грузится, пометка «проверьте»', async () => {
    const { gateway } = fakeGateway(JSON.stringify({ client: { org: '', fio: '', email: '', phone: '' }, request_items: [{ raw: 'Дверь', name: 'дверь', width_mm: null, height_mm: null, qty: 1 }], required_blocks: [], questions: [] }));
    const amo = fakeAmo({ mails: [{ ...letter, from: 'buyer@stroyopt.ru' }] });
    const diag: MailSearchDiag = { ...noDiag, criteria: { ...noDiag.criteria, from: 'buyer@stroyopt.ru', domain: 'stroyopt.ru' } };
    const analyzed: string[] = [];
    const r = await buildKpDraft(gateway, { accountId: 1, leadId: 1, route }, {
      amo,
      analyze: async (f) => {
        analyzed.push(f.filename);
        return { id: 1, filename: f.filename, kind: 'spec', positions: [], questions: [], requirements: [] };
      },
      mail: async () => ({
        diag,
        mail: { uid: 9, folder: 'INBOX', matchedBy: 'domain', messageId: '<m9@stroyopt.ru>', from: 'other@stroyopt.ru', fromName: null, subject: 'Спецификация', date: new Date('2026-10-12T10:00:00Z'), text: 'Текст от другого адреса', attachments: [{ filename: 'spec.pdf', contentType: 'application/pdf', size: 10, content: Buffer.alloc(10), inline: false }] },
      }),
    });
    expect(amo.uploaded).toEqual([]);
    expect(analyzed).toEqual(['spec.pdf']);
    expect(r.payload.source.mail).toMatchObject({ status: 'found', matchedBy: 'domain', uploaded: [], taken: ['spec.pdf'], files: [{ name: 'spec.pdf', status: 'not_uploaded', reason: 'отправитель совпал только по домену — в сделку не грузим' }] });
    expect(r.payload.needs_manager).toContainEqual({ request_index: -1, reason: 'письмо найдено по домену stroyopt.ru, не по адресу buyer@stroyopt.ru (папка INBOX, «Спецификация») — проверьте, что это та заявка; вложения в сделку не загружены' });
  });

  it('письмо в ящике не найдено — пометка, черновик по карточке; ошибка входа — пометка с временем повтора', async () => {
    const { gateway } = fakeGateway(JSON.stringify({ client: { org: '', fio: '', email: '', phone: '' }, request_items: [{ raw: 'Добор', name: 'добор', width_mm: null, height_mm: null, qty: 1 }], required_blocks: [], questions: [] }));
    const r = await buildKpDraft(gateway, { accountId: 1, leadId: 1, route }, { amo: fakeAmo({ mails: [letter] }), analyze: null, mail: async () => ({ mail: null, diag: noDiag }) });
    expect(r.payload.source.mail).toMatchObject({ status: 'not_found', searchedFrom: 'ivanov@romashka.ru', diag: noDiag });
    expect(r.payload.source.from).toBe('amo_card');
    expect(r.payload.items.map((l) => l.name)).toEqual(['добор']);
    expect(r.payload.needs_manager).toContainEqual({ request_index: -1, reason: 'письмо в ящике не найдено (искали от ivanov@romashka.ru) — черновик по тому, что есть в карточке' });
    // Писем в карточке нет — ищем по email контакта.
    const r2 = await buildKpDraft(gateway, { accountId: 1, leadId: 1, route }, { amo: fakeAmo(), analyze: null, mail: async () => ({ mail: null, diag: noDiag }) });
    expect(r2.payload.source.mail?.searchedFrom).toBe('ivanov@romashka.ru');
    const retryAt = new Date(Date.now() + 30 * 60_000);
    const r3 = await buildKpDraft(gateway, { accountId: 1, leadId: 1, route }, {
      amo: fakeAmo({ mails: [letter] }),
      analyze: null,
      mail: async () => {
        throw new MailAuthError('вход в ящик shop@rf-dveri.ru не удался, следующая попытка не раньше 14:30 МСК', retryAt);
      },
    });
    expect(r3.payload.source.mail).toMatchObject({ status: 'error', error: 'вход в ящик shop@rf-dveri.ru не удался, следующая попытка не раньше 14:30 МСК', retryAt: retryAt.toISOString() });
    expect(r3.payload.needs_manager).toContainEqual({ request_index: -1, reason: 'почта: вход в ящик shop@rf-dveri.ru не удался, следующая попытка не раньше 14:30 МСК' });
    expect(r3.payload.items.map((l) => l.name)).toEqual(['добор']);
  });

  it('файлов нет — позиции из письма; разбор недоступен — файлы в skipped', async () => {
    const { gateway } = fakeGateway(modelAnswer);
    const r = await buildKpDraft(gateway, { accountId: 1, leadId: 1, route }, { amo: fakeAmo({ mails: [letter], files: [file('u1', 'spec.docx')] }), analyze: null });
    expect(r.payload.items.map((l) => [l.name, l.size, l.qty, l.price])).toEqual([['дверь', '800×2000 мм', 2, null]]);
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

describe('критерии поиска письма без даты в карточке (RFD-AI-AGENT-OPT-MAIL-READ-6)', () => {
  const now = new Date('2026-10-14T12:00:00Z');
  it('адрес: письмо → контакт → примечание розницы «От: Имя <адрес>»; окно: дата письма → [создание сделки − 14 дней; сейчас] → последние 30 дней', () => {
    const base = { contact: { fio: '', email: '', phone: '' }, letter: null, leadCreatedAt: null, noteFrom: null };
    expect(senderFromNotes([{ params: { text: 'Запрос КП «89813». От: Туркина Татьяна <t_turkina@sviaznoyalliance.ru>. Вложение: Заявка на двери. Москва..xlsx' } }])).toBe('t_turkina@sviaznoyalliance.ru');
    expect(senderFromNotes([{ params: { text: 'Письмо от клиента: ivanov@romashka.ru, просит КП' } }])).toBe('ivanov@romashka.ru');
    expect(senderFromNotes([{ params: { text: 'Позвонить завтра' } }, { params: {} }])).toBeNull();
    // Только примечание: адрес из него, окно от даты сделки.
    const fromNote = mailSearchOf({ ...base, noteFrom: 't_turkina@sviaznoyalliance.ru', leadCreatedAt: new Date('2026-10-12T06:00:00Z') }, now);
    expect(fromNote).toEqual({ from: 't_turkina@sviaznoyalliance.ru', around: now, subject: null, window: { since: new Date('2026-09-28T06:00:00Z'), before: now, source: 'lead' } });
    // Контакт важнее примечания, письмо важнее контакта; у письма с датой окно не задаётся (±2 дня вокруг даты).
    expect(mailSearchOf({ ...base, contact: { fio: '', email: 'Иван <ivanov@romashka.ru>', phone: '' }, noteFrom: 'x@y.ru' }, now).from).toBe('ivanov@romashka.ru');
    const letter = mailSearchOf({ ...base, letter: { text: '', createdAt: new Date('2026-10-12T09:13:00Z'), from: 'Туркина t_turkina@sviaznoyalliance.ru', subject: 'Заявка' } }, now);
    expect(letter).toEqual({ from: 't_turkina@sviaznoyalliance.ru', around: new Date('2026-10-12T09:13:00Z'), subject: 'Заявка' });
    // Ни письма, ни сделки — последние 30 дней; адреса нет — from пустой.
    expect(mailSearchOf(base, now)).toEqual({ from: '', around: now, subject: null, window: { since: new Date('2026-09-14T12:00:00Z'), before: now, source: 'default' } });
  });

  it('сборка черновика: в карточке письмо без отправителя и даты, адрес только в примечании розницы — ящик читается по окну от даты сделки; partial — пометка, не ошибка', async () => {
    const { gateway } = fakeGateway(modelAnswer);
    const amo = fakeAmo({ notes: [{ id: 1, note_type: 'common', created_at: 0, created_by: 0, params: { text: 'Запрос КП. От: Туркина Татьяна <t_turkina@sviaznoyalliance.ru>' } }] });
    amo.getLead = async () => ({ id: 30008823, name: '89813', price: null, status_id: 1, pipeline_id: 1, responsible_user_id: 3, created_at: Math.floor(new Date('2026-10-12T06:00:00Z').getTime() / 1000), custom_fields_values: null, _embedded: { contacts: [] } });
    const searches: unknown[] = [];
    const partialDiag: MailSearchDiag = { ...noDiag, criteria: { ...noDiag.criteria, windowSource: 'lead' }, partial: { where: 'FETCH ENVELOPE INBOX (9461:9480)', ranges: ['INBOX: 9481:9500'] } };
    const mail: KpDraftDeps['mail'] = async (search) => {
      searches.push(search);
      return { mail: null, diag: partialDiag };
    };
    const r = await buildKpDraft(gateway, { accountId: 1, leadId: 30008823, route }, { amo, analyze: null, mail });
    expect(searches).toHaveLength(1);
    expect(searches[0]).toMatchObject({ from: 't_turkina@sviaznoyalliance.ru', subject: null, window: { since: new Date('2026-09-28T06:00:00Z'), source: 'lead' } });
    expect(r.payload.source.mail).toMatchObject({ status: 'partial', searchedFrom: 't_turkina@sviaznoyalliance.ru', error: 'ящик просмотрен не полностью: лимит времени вышел на FETCH ENVELOPE INBOX (9461:9480); просмотрено порций 1' });
    expect(r.payload.needs_manager.map((n) => n.reason)).toContainEqual(expect.stringContaining('письмо в ящике не найдено среди просмотренного'));
    expect(r.payload.needs_manager.map((n) => n.reason)).not.toContainEqual(expect.stringMatching(/^почта:/));
  });
});
