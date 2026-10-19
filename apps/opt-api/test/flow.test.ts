// Эталонный набор KP-AGENT-V2, п. 7: 12 сделок из tests/fixtures/flow/<сделка>/ (deal.json — письмо и файлы, expected.json —
// эталон). Каждая сделка проходит весь путь, как у кнопок виджета: прайсы заказчика («Межкомнатные двери.xlsx», «Металлические
// двери.xlsx») → письмо и файлы сделки → «Собрать КП» → «Найти цены» → опросник → документ. Проверяется: позиции, размеры и
// количества — 100 %; у каждой двери ГОСТ-профиль (пустое обязательное поле — вопрос «неполная позиция», не догадка); ни одной
// цены без источника; цена интернета в КП сама не ставится; в документе нет «0 ₽». Сделки без файлов («source": "missing") —
// пропуск с пометкой: их выгружает flow-export на сервере. FLOW_REPORT=<путь> — таблица «эталон / получено / открытые вопросы».
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LlmGateway, RoutedRequest, RoutedResponse } from '@core/llm';
import { missingFields, type GostProfile } from '@opt/kb';
import type { OptAiProvider } from '@opt/kp';
import { resolveKpPath } from '@opt/kp';
import PizZip from 'pizzip';
import { afterAll, describe, expect, it } from 'vitest';
import { matrix89835, tzReal } from '../../../packages/opt/kp/test/fixtures/docx-builder.ts';
import { ACCOUNT_ID, answerSurvey, leadFile, LEAD_ID, setup, widgetToken } from './helpers.ts';

const FLOW = fileURLToPath(new URL('../../../tests/fixtures/flow/', import.meta.url));
const PRICES = fileURLToPath(new URL('../../../packages/opt/kb/test/fixtures/real/', import.meta.url));
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const SYNTHETIC: Record<string, () => Uint8Array> = { tz90091: tzReal, matrix89835 };

interface Deal {
  deal: number;
  leadId: number | null;
  source: 'synthetic' | 'real' | 'missing';
  title?: string;
  note?: string;
  letter?: { subject: string; text: string };
  files?: { name: string; synthetic?: string }[];
  letterItems?: Record<string, unknown>[];
  /** Цены интернета по слову в запросе поиска: [цены источников]. */
  web?: Record<string, number[]>;
}
interface Expected {
  positions: { name: string; size: string; qty: number; door: boolean }[];
  prices?: { position: number; price: number; source: string }[];
  tzEquipment?: number[];
  gostDesignation?: { position: number; contains: string }[];
  mustAsk?: { type: string; position?: number; fields?: string[] }[];
  note?: string;
}
type Line = { request_index: number; name: string; size: string; qty: number; price: number | null; priceSource?: string; priceOutcome?: string; category?: string; kind?: string; gostProfile?: Record<string, unknown> | null; gostDesignation?: string | null; web?: unknown; tzEquipment?: string | null; excluded?: boolean };
type Q = { key: string; type: string; blocking: boolean; title: string; requestIndexes: number[]; fields?: { name: string }[]; answer: unknown };

const deals = readdirSync(FLOW)
  .filter((n) => /^\d+$/.test(n) && statSync(join(FLOW, n)).isDirectory())
  .sort()
  .map((n) => {
    const dir = join(FLOW, n);
    const deal = JSON.parse(readFileSync(join(dir, 'deal.json'), 'utf8')) as Deal;
    const expected = deal.source === 'missing' ? null : (JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as Expected);
    return { dir, deal, expected };
  });

/** Строка таблицы отчёта. */
interface Row {
  deal: number;
  source: string;
  etalon: string;
  got: string;
  prices: string;
  questions: string;
  doc: string;
}
const rows: Row[] = [];

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z0-9]+/g, ' ').trim();

/** Модель: письмо → позиции письма (letterItems), нормализация таблицы → строки как есть, карточка позиции, поиск → цены по слову. */
function gateway(deal: Deal) {
  const requests: RoutedRequest[] = [];
  let card = { kind: 'door', factory: null as string | null, model: 'x', widthMm: null as number | null, heightMm: null as number | null };
  const llm: LlmGateway = {
    async chat(req, route) {
      requests.push(req);
      const last = req.messages[req.messages.length - 1];
      const content = typeof last?.content === 'string' ? last.content : (last?.content ?? []).map((p) => ('text' in p ? p.text : '')).join('\n');
      let text: string;
      if (req.webSearch) {
        const key = Object.keys(deal.web ?? {}).find((k) => content.toLowerCase().includes(k.toLowerCase()));
        const prices = key ? (deal.web?.[key] ?? []) : [];
        text = JSON.stringify({ offers: prices.map((price, i) => ({ url: `https://shop-${i + 1}.example.ru/p`, seller: `shop-${i + 1}.example.ru`, title: card.model, price, currency: 'RUB', unit: 'piece', quantityInUnit: null, inStock: true, vatStated: 'included', vatRateStated: null, sourceKind: 'retail', includesDelivery: null, deliveryRub: null, factory: card.factory, model: card.model, design: [], standards: [], widthMm: card.widthMm, heightMm: card.heightMm, kind: card.kind, leaves: 1 })) });
      } else if (req.outputSchema?.name === 'item_card') {
        const m = /Позиция: (.+)/.exec(content);
        const size = /(\d{3,4})\s*×\s*(\d{3,4})/.exec(content);
        const a = Number(size?.[1] ?? 0);
        const b = Number(size?.[2] ?? 0);
        card = { kind: 'door', factory: null, model: m?.[1]?.trim() ?? 'x', widthMm: a && b ? Math.min(a, b) : null, heightMm: a && b ? Math.max(a, b) : null };
        text = JSON.stringify({ ...card, collection: null, finish: null, color: null, glazing: null, leaves: 1, equipment: null, fireRating: null, standards: [] });
      } else if (req.outputSchema?.name === 'table_rows') {
        const out = [...content.matchAll(/^(\d+)\. (.+)$/gm)].map((m) => ({ i: Number(m[1]), name: (m[2] as string).split(' | ')[1] ?? '', marking: null, width_mm: null, height_mm: null, material: null, color: null, fireproof: null, note: null }));
        text = JSON.stringify({ rows: out });
      } else text = JSON.stringify({ client: { org: 'ООО Заказчик', fio: '', email: 'client@example.ru', phone: '' }, request_items: deal.letterItems ?? [], required_blocks: ['price'], questions: [] });
      const res: RoutedResponse = {
        text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 500, outputTokens: 50, cachedInputTokens: 0, cacheWriteTokens: 0, ...(req.webSearch ? { webSearchCalls: 1 } : {}) },
        provider: route.primary.provider, model: route.primary.model, assistantMessage: { role: 'assistant', content: text }, latencyMs: 1, fallbackUsed: false, requested: route.primary, attempts: [],
        ...(req.webSearch ? { sources: [1, 2, 3].map((i) => ({ url: `https://shop-${i}.example.ru/p` })) } : {}),
      };
      return res;
    },
    providers: async () => ['openai'],
    provider: async () => null,
  };
  const ai: OptAiProvider = async () => ({ llm, source: 'account', providers: ['openai'], keySources: { openai: 'account' } });
  return { ai, requests };
}

/** Минимальный DOCX-шаблон: строки позиций и итог. */
function templateDocx(): string {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{{#items}}{{n}}. {{name}} — {{price}} × {{qty}} = {{sum}}; {{/items}}итого {{grand_total}}; {{vat_phrase}}</w:t></w:r></w:p></w:body></w:document>');
  return zip.generate({ type: 'base64' });
}

describe('эталонный набор KP-AGENT-V2 (tests/fixtures/flow, 12 сделок)', () => {
  afterAll(() => {
    if (!process.env.FLOW_REPORT) return;
    const head = '| Сделка | Данные | Эталон | Получено | Цены | Открытые вопросы (блокируют) | Документ |\n|---|---|---|---|---|---|---|\n';
    writeFileSync(process.env.FLOW_REPORT, head + rows.sort((a, b) => a.deal - b.deal).map((r) => `| ${r.deal} | ${r.source} | ${r.etalon} | ${r.got} | ${r.prices} | ${r.questions} | ${r.doc} |`).join('\n') + '\n');
  });

  it('в наборе 12 сделок из задания', () => {
    expect(deals.map((d) => d.deal.deal)).toEqual([89565, 89682, 89775, 89813, 89835, 89838, 89878, 89933, 90018, 90025, 90066, 90091]);
  });

  for (const { dir, deal, expected } of deals) {
    if (deal.source === 'missing' || !expected) {
      rows.push({ deal: deal.deal, source: 'нет файлов', etalon: '—', got: '—', prices: '—', questions: '—', doc: 'выгрузить flow-export' });
      it.skip(`${deal.deal}: файлов сделки нет — выгрузить командой flow-export на сервере`, () => undefined);
      continue;
    }
    it(`${deal.deal}: ${deal.title}`, async () => {
      const g = gateway(deal);
      const ctx = await setup({ ai: g.ai });
      try {
        const headers = { 'x-auth-token': await widgetToken() };
        await ctx.app.inject({ method: 'GET', url: '/oauth/amo/callback', query: { code: 'c', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
        // Прайсы заказчика — настоящие файлы «Межкомнатные двери.xlsx» и «Металлические двери.xlsx».
        for (const f of ['Межкомнатные двери.xlsx', 'Металлические двери.xlsx']) {
          const r = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kb/sources/file', headers, payload: { filename: f, mime: XLSX, contentBase64: readFileSync(join(PRICES, f)).toString('base64') } });
          expect(r.json().source.priceImport?.error, f).toBeUndefined();
        }
        await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/template', headers, payload: { filename: 'kp.docx', contentBase64: templateDocx() } });
        // Письмо и файлы сделки: файл из папки сделки или синтетический с той же структурой.
        const files = deal.files ?? [];
        files.forEach((f, i) => {
          const bytes = f.synthetic ? (SYNTHETIC[f.synthetic] as () => Uint8Array)() : new Uint8Array(readFileSync(join(dir, f.name)));
          leadFile(ctx.amo, `f-${i + 1}`, f.name, bytes, f.name.endsWith('.xlsx') ? XLSX : DOCX);
        });
        ctx.amo.mail = { id: 5, created_at: 1_760_000_000, params: { income: true, subject: deal.letter?.subject ?? 'Заявка', text: deal.letter?.text ?? '', from: 'client@example.ru', attachments: files.map((f) => f.name) } };
        await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
        const get = async () => (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft as { id: number; items: Line[]; survey: Q[]; counters: { positions: number; open: number; blocking: number; unpriced: number } };
        const d0 = await get();
        expect(d0, 'черновик собран').toBeTruthy();
        await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/research', headers, payload: { draftId: d0.id } });
        const d = await get();
        const goods = d.items.filter((l) => !(l.kind === 'service' || l.category === 'service'));

        // 1. Позиции, размеры, количества — 100 % эталона, в его порядке.
        const got = goods.map((l) => ({ name: l.name, size: l.size, qty: l.qty }));
        const matched = expected.positions.filter((e, i) => got[i] && norm(got[i]!.name).includes(norm(e.name)) && got[i]!.size === e.size && got[i]!.qty === e.qty).length;
        expect(got.map((x) => [x.size, x.qty]), `${deal.deal}: размеры и количества`).toEqual(expected.positions.map((e) => [e.size, e.qty]));
        expect(got.map((x) => norm(x.name)).every((n, i) => n.includes(norm(expected.positions[i]?.name ?? '§'))), `${deal.deal}: названия`).toBe(true);
        expect(matched).toBe(expected.positions.length);

        // 2. Двери: категория «дверь» и ГОСТ-профиль; пустое обязательное поле — вопрос «неполная позиция» с этим полем.
        const doors = expected.positions.map((e, i) => (e.door ? i : -1)).filter((i) => i >= 0);
        for (const i of doors) {
          const l = goods[i] as Line;
          expect(l.category, `${deal.deal}, поз. ${i + 1}: дверь`).toBe('door');
          expect(l.gostProfile, `${deal.deal}, поз. ${i + 1}: ГОСТ-профиль`).toBeTruthy();
          // Обязательные поля — по правилу профиля (fire = null у обычной двери — «не противопожарная», не пропуск).
          const missing = missingFields(l.gostProfile as unknown as GostProfile);
          if (!missing.length) continue;
          const q = d.survey.find((x) => x.type === 'incomplete' && x.requestIndexes.includes(l.request_index));
          expect(q, `${deal.deal}, поз. ${i + 1}: нет полей ${missing.join(', ')} — нужен вопрос`).toBeTruthy();
          for (const f of missing) expect(q!.fields?.map((x) => x.name), `${deal.deal}, поз. ${i + 1}: поле ${f} в вопросе`).toContain(f);
        }

        // 3. Ни одной цены без источника; цена интернета сама не ставится; ожидаемые цены прайса.
        for (const l of goods) {
          if (l.price !== null) expect(['price_file', 'web_confirmed', 'manager'], `${deal.deal}: источник цены «${l.name}»`).toContain(l.priceSource);
          if (l.web) expect(l.price, `${deal.deal}: цена интернета «${l.name}» без выбора менеджера`).toBeNull();
        }
        for (const p of expected.prices ?? []) expect([goods[p.position - 1]?.price, goods[p.position - 1]?.priceSource], `${deal.deal}, поз. ${p.position}: цена`).toEqual([p.price, p.source]);
        for (const g of expected.gostDesignation ?? []) expect(goods[g.position - 1]?.gostDesignation ?? '', `${deal.deal}, поз. ${g.position}: обозначение по ГОСТ`).toContain(g.contains);
        if (expected.tzEquipment) expect(goods.map((l, i) => (l.tzEquipment ? i + 1 : null)).filter(Boolean), `${deal.deal}: комплектация по ТЗ`).toEqual(expected.tzEquipment);

        // 4. Обязательные вопросы опросника.
        for (const m of expected.mustAsk ?? []) {
          const idx = m.position ? goods[m.position - 1]?.request_index : undefined;
          const q = d.survey.find((x) => x.type === m.type && (idx === undefined || x.requestIndexes.includes(idx)));
          expect(q, `${deal.deal}: вопрос ${m.type}${m.position ? ` по поз. ${m.position}` : ''}`).toBeTruthy();
          for (const f of m.fields ?? []) expect(q!.fields?.map((x) => x.name), `${deal.deal}: поле ${f}`).toContain(f);
        }
        const open = d.survey.filter((q) => !q.answer);
        const byTitle = [...open.reduce((m, q) => m.set(q.title, (m.get(q.title) ?? 0) + 1), new Map<string, number>())].map(([t, n]) => `${t} ${n}`).join('; ');

        // 5. После ответов (по умолчанию: самовывоз, 30 дней, медиана, «без цены», аналог — исключить) — документ без «0 ₽» и ссылок.
        // Комплектующие «к какой двери» — первая дверь из вариантов (ответ менеджера в опроснике).
        for (const q of d.survey.filter((x) => x.type === 'component_door' && !x.answer)) {
          const r = await ctx.app.inject({ method: 'POST', url: `/widget/v1/kp/draft/${d0.id}/answer`, headers, payload: { key: q.key, option: (q as unknown as { options: { id: string }[] }).options[0]?.id } });
          expect(r.statusCode, `${deal.deal}: ответ «${q.title}»`).toBe(200);
        }
        await answerSurvey(ctx.app, headers, LEAD_ID);
        const built = (await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/build', headers, payload: { draftId: d0.id } })).json();
        expect(built, `${deal.deal}: документ`).toMatchObject({ draft: { status: 'built' } });
        const doc = await ctx.deps.kp.byId(ACCOUNT_ID, d0.id);
        const text = new PizZip(readFileSync(resolveKpPath(ctx.deps.filesRoot, doc!.docxPath!))).file('word/document.xml')!.asText().replace(/\u00a0/g, ' ').replace(/<[^>]+>/g, '');
        expect(text, `${deal.deal}: «0 ₽» в документе`).not.toMatch(/(?<![\d ])0 ₽/);
        expect(text, `${deal.deal}: источники в документе`).not.toMatch(/https?:|example\.ru/);
        expect(text).toContain('в т.ч. НДС 22 %');

        const priced = goods.filter((l) => l.price !== null && l.priceSource === 'price_file').length;
        const web = goods.filter((l) => l.web && l.price === null).length;
        const included = goods.filter((l) => l.priceOutcome === 'included').length;
        rows.push({
          deal: deal.deal,
          source: deal.source === 'synthetic' ? 'синтетика' : 'файлы сделки',
          etalon: `${expected.positions.length} поз., дверей ${doors.length}`,
          got: `${goods.length} поз., совпало ${matched}; ГОСТ-профиль ${doors.filter((i) => goods[i]?.gostProfile).length}/${doors.length}`,
          prices: `прайс ${priced}${included ? `, в цене блока ${included}` : ''}, интернет → вопрос ${web}, без цены ${goods.length - priced - web - included}`,
          questions: `${open.length} (${open.filter((q) => q.blocking).length}): ${byTitle}`,
          doc: 'собран, без «0 ₽» и источников',
        });
      } finally {
        await ctx.close();
      }
    }, 90_000);
  }
});
