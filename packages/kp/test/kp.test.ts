import type { LlmGateway, RoutedRequest, RoutedResponse } from '@ai-door/llm';
import { describe, expect, it } from 'vitest';
import { lineSum, plural, rublesInWords, templateData } from '../src/build.ts';
import { buildKpDraft, parseDraft, type KpProduct } from '../src/draft.ts';

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
    const data = templateData({ kpNo: 'КП-2026-1', date: new Date(2026, 9, 12), basis: 'запрос от 09.10.2026', clientName: 'ООО Ромашка', clientPhone: '+7 900', lines: [line, { ...line, price: null }], vatRate: 22 });
    // Разделитель тысяч в ru-RU — неразрывный пробел.
    const plain = (v: string) => v.replace(/\u00a0/g, ' ');
    expect(data.items.map((i) => [i.n, plain(i.price), plain(i.sum)])).toEqual([[1, '10 000 ₽', '18 000 ₽'], [2, '—', '0 ₽']]);
    expect(plain(data.grand_total)).toBe('18 000 ₽');
    expect(data.total_qty).toBe('4 позиции');
    expect(plain(data.vat_phrase)).toBe('в том числе НДС 22% — 3 245,90 ₽');
    expect(templateData({ kpNo: '1', date: new Date(), basis: '', clientName: '', clientPhone: '', lines: [line], vatRate: 0 }).vat_phrase).toBe('НДС не облагается');
  });
});

describe('черновик КП: разбор ответа модели', () => {
  it('обёртка ```json и мусор вокруг объекта допускаются, лишнее отсекается', () => {
    const p = parseDraft('Вот JSON:\n```json\n{"client":{"org":" ООО Ромашка ","fio":"","email":"a@b.ru","phone":""},"request_items":[{"raw":"Дверь 2100*900 — 3 шт","name":"дверь белая","width_mm":"900","height_mm":2100,"qty":"3"},{"raw":"","name":""}],"required_blocks":["price","foo"],"questions":["Цвет?",""]}\n```');
    expect(p.client).toEqual({ org: 'ООО Ромашка', fio: '', email: 'a@b.ru', phone: '' });
    expect(p.request_items).toEqual([{ raw: 'Дверь 2100*900 — 3 шт', name: 'дверь белая', width_mm: 900, height_mm: 2100, qty: 3 }]);
    expect(p.required_blocks).toEqual(['price']);
    expect(p.questions).toEqual(['Цвет?']);
    expect(parseDraft('не json').request_items).toEqual([]);
  });
});

const product = (id: string, price: number | null, extra: Partial<KpProduct> = {}): KpProduct => ({
  id, name: `Товар ${id}`, price, available: true, url: `https://rf-dveri.ru/catalog/${id}/`, vendorCode: null, category: 'Межкомнатные', params: [{ name: 'Производитель', value: 'Фабрика А' }, { name: 'Срок поставки', value: '5', unit: 'дн.' }], ...extra,
});

/** Шлюз, который отдаёт заранее заданный текст и запоминает запрос. */
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

describe('черновик КП: цены только из каталога', () => {
  const route = { primary: { provider: 'openai' as const, model: 'gpt-5' }, fallback: null };
  const modelAnswer = JSON.stringify({
    client: { org: 'ООО Ромашка', fio: 'Иванов', email: 'i@romashka.ru', phone: '' },
    request_items: [
      { raw: 'Турин 1 2000*800 — 2 шт, цена 5 000', name: 'Турин 1', width_mm: 800, height_mm: 2000, qty: 2 },
      { raw: 'Перегородка лофт', name: 'перегородка лофт', width_mm: null, height_mm: null, qty: 1 },
    ],
    required_blocks: ['price', 'delivery'],
    questions: ['Нужен ли монтаж?'],
  });

  it('письмо из карточки amo, товары и комплектующие из каталога, позиции без товара — менеджеру', async () => {
    const { gateway, requests } = fakeGateway(modelAnswer);
    const searched: string[] = [];
    const r = await buildKpDraft(
      gateway,
      { accountId: 1, leadId: 55, route, pricing: {} },
      {
        catalog: { search: async (_a, q) => { searched.push(q.query ?? ''); return q.query?.includes('Турин') ? [product('1001', 14_900), product('1002', null, { available: false })] : []; } },
        dialog: { history: async () => { throw new Error('переписка не нужна, когда есть письмо'); } },
        mail: { leadMailNotes: async () => [
          { id: 1, createdAt: new Date('2026-10-09T10:00:00Z'), income: true, subject: 'Запрос КП', text: 'Нужны двери', from: 'i@romashka.ru', attachments: ['spec.xlsx'] },
          { id: 2, createdAt: new Date('2026-10-09T11:00:00Z'), income: false, subject: 'Re', text: 'Приняли', from: 'rf@rf-dveri.ru', attachments: [] },
        ] },
        attachments: { listByLead: async () => [{ filename: 'spec.xlsx', extractedText: 'Турин 1 — 2 шт' }] },
        components: { forProduct: async () => [{ group: 'Наличники', name: 'Наличник 70', price: 450 }, { group: 'Наличники', name: 'Наличник 90', price: 520 }] },
      },
    );
    // Модель получает письмо и вложение, но не каталог; её «цена 5 000» в строки не попадает.
    const sent = requests[0]?.messages[0]?.content;
    expect(sent).toContain('Тема: Запрос КП');
    expect(sent).toContain('--- spec.xlsx ---');
    expect(searched).toEqual(['Турин 1 800x2000', 'перегородка лофт']);
    expect(r.payload.items).toEqual([
      { request_index: 0, page_id: '1001', name: 'Товар 1001', size: '2000×800 мм', qty: 2, price: 14_900, lead_time: '5 дн.', discount: 0 },
      { request_index: 1, page_id: null, name: 'перегородка лофт', size: '', qty: 1, price: null, lead_time: '', discount: 0 },
    ]);
    expect(r.payload.candidates.map((c) => [c.page_id, c.factory])).toEqual([['1001', 'Фабрика А'], ['1002', 'Фабрика А']]);
    expect(r.payload.components).toEqual([{ request_index: 0, page_id: '1001', groups: { Наличники: [{ name: 'Наличник 70', price: 450 }, { name: 'Наличник 90', price: 520 }] } }]);
    expect(r.payload.needs_manager).toEqual([{ request_index: 1, reason: 'позиции нет в каталоге' }]);
    expect(r.payload.source).toEqual({ from: 'amo_mail', mails: 2, letterAt: '2026-10-09T10:00:00.000Z', attachments: ['spec.xlsx', 'spec.xlsx'] });
    expect(r.payload.required_blocks).toEqual(['price', 'delivery']);
    expect(r).toMatchObject({ provider: 'openai', model: 'gpt-5' });
    // Тариф gpt-5: 1000×1.25 + 100×10 за миллион.
    expect(r.cost).toEqual({ inputTokens: 1000, outputTokens: 100, usd: (1000 * 1.25 + 100 * 10) / 1e6 });
  });

  it('без писем — последняя реплика клиента из переписки; пустой ответ модели — пометка менеджеру', async () => {
    const { gateway, requests } = fakeGateway('{}');
    const r = await buildKpDraft(gateway, { accountId: 1, leadId: 56, route }, {
      catalog: { search: async () => [] },
      dialog: { history: async () => [{ role: 'client', text: 'Хочу КП на 3 двери', createdAt: new Date('2026-10-10T08:00:00Z') }, { role: 'agent', text: 'Какие?', createdAt: new Date() }] },
    });
    expect(requests[0]?.messages[0]?.content).toContain('Хочу КП на 3 двери');
    expect(r.payload.items).toEqual([]);
    expect(r.payload.needs_manager).toEqual([{ request_index: -1, reason: 'в письме не найдено позиций' }]);
    expect(r.payload.source).toMatchObject({ from: 'dialog', mails: 0, letterAt: '2026-10-10T08:00:00.000Z' });
  });
});
