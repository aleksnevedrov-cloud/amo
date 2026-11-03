// KB-MARKUP: наценка в % у прайса-источника «Базы знаний». Цены kb_prices — цены фабрики; наценка — при расчёте КП:
// новые черновики и «Пересчитать»; нестандарт — сначала надбавка фабрики, затем наценка; ручные цены не трогаются;
// в черновике «фабрика · наценка · цена», в письме и файле КП — только цена; повторная загрузка прайса наценку сохраняет.
import { readFileSync } from 'node:fs';
import type { LlmGateway, RoutedResponse } from '@core/llm';
import type { OptAiProvider } from '@opt/kp';
import { resolveKpPath } from '@opt/kp';
import PizZip from 'pizzip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookXlsx, onyxBook } from '../../../packages/opt/kb/test/fixtures/price-book.ts';
import { ACCOUNT_ID, answerSurvey, LEAD_ID, setup, widgetToken } from './helpers.ts';

const DOOR = 'Оникс Авангард наборный шпон — шпон, гр.1 — глухое';
const letter = {
  client: { org: 'ООО Заказчик', fio: '', email: 'client@example.ru', phone: '' },
  request_items: [
    { raw: `${DOOR} 900×2000 — 1 шт`, name: DOOR, width_mm: 900, height_mm: 2000, qty: 1 },
    { raw: 'Коробка — 1 шт', name: 'Коробка', width_mm: null, height_mm: null, qty: 1 },
    { raw: 'Наличник — 1 шт', name: 'Наличник', width_mm: null, height_mm: null, qty: 1 },
    { raw: 'Добор — 1 шт', name: 'Добор', width_mm: null, height_mm: null, qty: 1 },
    { raw: 'Стекло сатинат белый, категория 1 — 1 шт', name: 'Стекло сатинат белый, категория 1', width_mm: null, height_mm: null, qty: 1 },
    { raw: `${DOOR} 1000×2000 — 1 шт`, name: DOOR, width_mm: 1000, height_mm: 2000, qty: 1 },
  ],
  required_blocks: ['price'],
  questions: [] as string[],
};

function gateway(): OptAiProvider {
  const llm: LlmGateway = {
    async chat(req, route) {
      // Веб-поиска в этом сценарии быть не должно: все цены — из прайса.
      const text = req.webSearch ? JSON.stringify({ offers: [] }) : JSON.stringify(letter);
      const res: RoutedResponse = { text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, cacheWriteTokens: 0 }, provider: route.primary.provider, model: route.primary.model, assistantMessage: { role: 'assistant', content: text }, latencyMs: 1, fallbackUsed: false, requested: route.primary, attempts: [] };
      return res;
    },
    providers: async () => ['openai'],
    provider: async () => null,
  };
  return async () => ({ llm, source: 'account', providers: ['openai'], keySources: { openai: 'account' } });
}

type Line = { request_index: number; name: string; price: number | null; priceSource?: string; priceOutcome?: string; markup?: { factoryPrice: number; pct: number; price: number } | null; qty: number };
type Src = { id: number; title: string; priceKey: string | null; markupPct: number; prices: number };

describe('наценка прайса-источника (KB-MARKUP)', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let headers: Record<string, string>;
  let onyx: Src;
  const upload = async (filename: string) =>
    (await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/sources/file', headers, payload: { filename, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBase64: (await bookXlsx(onyxBook())).toString('base64') } })).json().source as Src;
  const draft = async () => (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft as { id: number; status: string; items: Line[] };
  const newDraft = async () => {
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const d = await draft();
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: d.id } });
    // Дверей в заявке две (900 и 1000 мм) — коробка, наличник и добор: «к какой двери» → к поз. 1, затем цены.
    for (const i of [1, 2, 3]) await ctx.app.inject({ method: 'POST', url: `/widget/v1/kp/draft/${d.id}/component-door`, headers, payload: { requestIndex: i, doorRequestIndex: 0 } });
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: d.id } });
    return draft();
  };
  const prices = (d: { items: Line[] }) => d.items.map((l) => l.price);
  const setMarkup = (id: number, markupPct: number | null) => ctx.app.inject({ method: 'PUT', url: `/widget/v1/kb/sources/${id}/markup`, headers, payload: { markupPct } });

  beforeAll(async () => {
    ctx = await setup({ ai: gateway() });
    headers = { 'x-auth-token': await widgetToken() };
    await ctx.app.inject({ method: 'GET', url: '/oauth/amo/callback', query: { code: 'c', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
    ctx.amo.mail = { id: 5, created_at: 1_760_000_000, params: { income: true, subject: 'Заявка', text: 'Нужны двери Оникс', from: 'client@example.ru', attachments: [] } };
    onyx = await upload('Оникс прайс октябрь 2026.xlsx');
  });
  afterAll(() => ctx.close());

  it('наценка 0 (у всех источников после миграции): цены фабрики, как до доработки; у строк наценки нет', async () => {
    expect(onyx).toMatchObject({ markupPct: 0 });
    expect(onyx.priceKey).toBeTruthy();
    const d = await newDraft();
    // Полотно, коробка, наличник, добор, стекло (Дополнения), нестандарт 1000×2000 (+30 % к 16 400).
    expect(prices(d)).toEqual([16_400, 3125, 5050, 2525, 1520, 21_320]);
    expect(d.items.every((l) => !l.markup)).toBe(true);
  });

  it('«Наценка, %»: −50…300 с шагом 0,1, пусто — 0; только у прайса; в журнал — кто, источник, было → стало', async () => {
    for (const bad of [301, -50.5, 12.34]) expect((await setMarkup(onyx.id, bad)).statusCode).toBe(400);
    const r = await setMarkup(onyx.id, 20);
    expect(r.statusCode).toBe(200);
    expect(r.json().source).toMatchObject({ id: onyx.id, markupPct: 20 });
    const log = (await ctx.app.inject({ url: '/widget/v1/journal?kind=note', headers })).json().items as { summary: string; details: Record<string, unknown> }[];
    expect(log[0]).toMatchObject({ summary: 'База знаний: наценка прайса «Оникс прайс октябрь 2026.xlsx»: 0 % → 20 % (новые черновики и «Пересчитать»)', details: { sourceId: onyx.id, before: 0, after: 20, audit: 'kb_markup' } });
    expect(typeof log[0]?.details.userId).toBe('number');
    // Цены в базе — цены фабрики, не перезаписаны.
    const kb = (await ctx.app.inject({ url: '/widget/v1/kb/prices?limit=100', headers })).json().items as { productId: string | null; tariffId: string | null; price: number; category: string }[];
    expect(kb.find((p) => p.productId === 'ONX-0001' && p.category === 'door')?.price).toBe(16_400);
    expect(kb.find((p) => p.tariffId === 'ONX-OPT-001')?.price).toBe(1520);
  });

  it('созданный черновик сам не пересчитывается; «Пересчитать» — 19 680 / 3 750 / 6 060 / 3 030 / 1 824, нестандарт 21 320 × 1,2 = 25 584', async () => {
    const before = await draft();
    expect(prices(before)).toEqual([16_400, 3125, 5050, 2525, 1520, 21_320]);
    // Ручная цена менеджера в последней строке — «Пересчитать» её не трогает.
    const edited = before.items.map((l, i) => (i === 5 ? { ...l, price: 20_000 } : l));
    await ctx.app.inject({ method: 'PUT', url: `/widget/v1/kp/draft/${before.id}`, headers, payload: { items: edited } });
    const r = (await ctx.app.inject({ method: 'POST', url: `/widget/v1/kp/draft/${before.id}/recalc-markup`, headers })).json();
    expect(r.changed).toBe(5);
    const d = r.draft as { items: Line[] };
    expect(prices(d)).toEqual([19_680, 3750, 6060, 3030, 1824, 20_000]);
    // Комплект ONX-0001: 16 400 + 3 125 + 5 050 + 2 525 = 27 100 → 32 520.
    expect(d.items.slice(0, 4).reduce((s, l) => s + (l.price ?? 0), 0)).toBe(32_520);
    expect(d.items[0]?.markup).toMatchObject({ factoryPrice: 16_400, pct: 20, price: 19_680 });
    expect(d.items[5]).toMatchObject({ priceSource: 'manager', markup: null });
    const log = (await ctx.app.inject({ url: '/widget/v1/journal?kind=kp_price_research', headers })).json().items as { summary: string }[];
    expect(log[0]?.summary.replace(/\s/g, ' ')).toMatch(/^Пересчёт наценки по черновику \d+: изменено позиций 5 — «.+» 16 400 → 19 680 ₽/);
    // Повторное «Пересчитать» без смены наценки — ничего не меняет.
    expect((await ctx.app.inject({ method: 'POST', url: `/widget/v1/kp/draft/${before.id}/recalc-markup`, headers })).json().changed).toBe(0);
  });

  it('новый черновик — сразу с наценкой; нестандарт: надбавка фабрики, затем наценка; журнал поиска — «фабрика + наценка»', async () => {
    const d = await newDraft();
    expect(prices(d)).toEqual([19_680, 3750, 6060, 3030, 1824, 25_584]);
    expect(d.items[5]?.markup).toMatchObject({ factoryPrice: 21_320, pct: 20, price: 25_584 });
    expect(d.items[4]?.markup).toMatchObject({ factoryPrice: 1520, pct: 20, price: 1824 });
    const log = (await ctx.app.inject({ url: '/widget/v1/journal?kind=kp_price_research', headers })).json().items as { summary: string }[];
    expect(log.some((j) => j.summary.replace(/\s/g, ' ').includes('19 680 ₽ (фабрика 16 400 ₽ + наценка 20 %)'))).toBe(true);
  });

  it('в письме и файле КП — только цена с наценкой, без «фабрика» и «наценка»', async () => {
    const d = await draft();
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/template', headers, payload: { filename: 'kp.docx', contentBase64: templateDocx() } });
    await answerSurvey(ctx.app, headers, LEAD_ID);
    const built = (await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/build', headers, payload: { draftId: d.id } })).json();
    expect(built).toMatchObject({ draft: { status: 'built' } });
    const doc = await ctx.deps.kp.byId(ACCOUNT_ID, d.id);
    const text = new PizZip(readFileSync(resolveKpPath(ctx.deps.filesRoot, doc!.docxPath!))).file('word/document.xml')!.asText().replace(/<[^>]+>/g, '');
    expect(text.replace(/\s/g, ' ')).toContain('19 680');
    expect(text).not.toMatch(/наценк|фабрик|16 400|16400/i);
    const mail = (await ctx.app.inject({ url: `/widget/v1/kp/send/preview?draftId=${d.id}`, headers })).json();
    expect(JSON.stringify(mail)).not.toMatch(/наценк|фабрика \d/i);
  }, 30_000);

  it('повторная загрузка того же прайса — наценка сохраняется; наценка 0 — снова цены фабрики', async () => {
    const again = await upload('Оникс прайс октябрь 2026.xlsx');
    const sources = (await ctx.app.inject({ url: '/widget/v1/kb/sources', headers })).json().sources as Src[];
    expect(sources.find((s) => s.id === again.id)?.markupPct).toBe(20);
    const idx = (await ctx.app.inject({ url: '/widget/v1/journal?kind=kb_index', headers })).json().items as { summary: string }[];
    expect(idx[0]?.summary).toContain('наценка 20 % перенесена с прежнего файла');
    expect(prices(await newDraft())).toEqual([19_680, 3750, 6060, 3030, 1824, 25_584]);
    expect((await setMarkup(again.id, null)).json().source.markupPct).toBe(0);
    const d = await newDraft();
    expect(prices(d)).toEqual([16_400, 3125, 5050, 2525, 1520, 21_320]);
    expect(d.items.every((l) => !l.markup)).toBe(true);
  });
});

function templateDocx(): string {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{{#items}}{{n}}. {{name}} — {{price}} × {{qty}} = {{sum}}; {{/items}}итого {{grand_total}}</w:t></w:r></w:p></w:body></w:document>');
  return zip.generate({ type: 'base64' });
}
