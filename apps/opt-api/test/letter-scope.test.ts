// KP-LETTER-SCOPE (сделка 89518, черновик 74): письмо называет марки ДНО-1/2/3 — в черновике только они, размеры из ведомости;
// остальной проект — «Ещё в проекте» с «добавить» (POST /kp/draft/:id/project-item), добавленное переносится на «Собрать заново»;
// требования письма — в требованиях заявки, у позиций и в КП.
import { readFileSync } from 'node:fs';
import type { LlmGateway, RoutedResponse } from '@core/llm';
import type { OptAiProvider } from '@opt/kp';
import { resolveKpPath } from '@opt/kp';
import PizZip from 'pizzip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { plan89518, vedomost89518 } from '../../../packages/opt/kp/test/fixtures/docx-builder.ts';
import { ACCOUNT_ID, answerSurvey, leadFile, LEAD_ID, setup, widgetToken } from './helpers.ts';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const LETTER = 'Добрый день! Планируется закупка 3 дверей. Нужны двери ДНО-1 — 1 шт; ДНО-2 — 1 шт; ДНО-3 — 1 шт.\nКаркас металлический, филёнка дуб/ламинация под дуб, цена изделие+фурнитура, доставка, установка.';

/** Модель: письмо → марки и работы; нормализация таблиц → строки как есть (имя — вторая ячейка). */
function gateway() {
  const llm: LlmGateway = {
    async chat(req, route) {
      const last = req.messages[req.messages.length - 1];
      const content = typeof last?.content === 'string' ? last.content : (last?.content ?? []).map((p) => ('text' in p ? p.text : '')).join('\n');
      const text = req.outputSchema?.name === 'table_rows'
        ? JSON.stringify({ rows: [...content.matchAll(/^(\d+)\. (.+)$/gm)].map((m) => ({ i: Number(m[1]), name: (m[2] as string).split(' | ')[1] ?? '', marking: null, width_mm: null, height_mm: null, material: null, color: null, fireproof: null, note: null })) })
        : JSON.stringify({ client: { org: 'ООО Заказчик', fio: '', email: 'client@example.ru', phone: '' }, request_items: [{ raw: 'ДНО-1 — 1 шт', name: 'дверь ДНО-1', width_mm: null, height_mm: null, qty: 1 }, { raw: 'доставка', name: 'Доставка', width_mm: null, height_mm: null, qty: 1 }, { raw: 'установка', name: 'Установка', width_mm: null, height_mm: null, qty: 1 }], required_blocks: ['price', 'delivery'], questions: [] });
      const res: RoutedResponse = { text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, cacheWriteTokens: 0 }, provider: route.primary.provider, model: route.primary.model, assistantMessage: { role: 'assistant', content: text }, latencyMs: 1, fallbackUsed: false, requested: route.primary, attempts: [] };
      return res;
    },
    providers: async () => ['openai'],
    provider: async () => null,
  };
  const ai: OptAiProvider = async () => ({ llm, source: 'account', providers: ['openai'], keySources: { openai: 'account' } });
  return ai;
}

type Item = { raw: string; name: string; width_mm: number | null; height_mm: number | null; qty: number; mark?: string | null };
type Line = { request_index: number; name: string; size: string; qty: number; mark?: string | null; letterSpec?: string | null; kind?: string; category?: string };
type Draft = { id: number; items: Line[]; scope: { by: string; selected: number; project: number; missing: string[] } | null; projectRest: Item[]; requirements: string[]; needsManager: { request_index: number; reason: string }[] };

describe('объём заявки по письму (KP-LETTER-SCOPE, 89518)', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let headers: Record<string, string>;
  const draft = async () => (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft as Draft;
  beforeAll(async () => {
    ctx = await setup({ ai: gateway() });
    headers = { 'x-auth-token': await widgetToken() };
    await ctx.app.inject({ method: 'GET', url: '/oauth/amo/callback', query: { code: 'c', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
    leadFile(ctx.amo, 'f-1', '28. Ведомость дверей.наружные.docx', vedomost89518(), DOCX);
    leadFile(ctx.amo, 'f-2', '21.План заполнения проемов.docx', plan89518(), DOCX);
    ctx.amo.mail = { id: 5, created_at: 1_760_000_000, params: { income: true, subject: 'Закупка дверей', text: LETTER, from: 'client@example.ru', attachments: ['28. Ведомость дверей.наружные.docx', '21.План заполнения проемов.docx'] } };
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
  });
  afterAll(() => ctx.close());

  it('в позициях — ДНО-1/2/3 по 1 шт с Н×Ш из ведомости, затем работы письма; остальное — «Ещё в проекте» (15), требования письма', async () => {
    const d = await draft();
    const goods = d.items.filter((l) => l.kind !== 'service');
    expect(goods.map((l) => [l.mark, l.size, l.qty])).toEqual([['ДНО1', '1010×2070 мм', 1], ['ДНО2', '1310×2070 мм', 1], ['ДНО3', '910×2070 мм', 1]]);
    expect(d.items.filter((l) => l.kind === 'service').map((l) => l.name)).toEqual(['Доставка', 'Установка']);
    expect(goods[0]?.letterSpec).toBe('Каркас металлический, филёнка дуб/ламинация под дуб, цена изделие+фурнитура');
    expect(d.scope).toEqual({ by: 'marks', selected: 3, project: 18, missing: [] });
    expect(d.projectRest).toHaveLength(15);
    expect(d.projectRest.filter((it) => it.mark === 'ДН1').map((it) => [it.width_mm, it.height_mm, it.qty])).toEqual([[1010, 2070, 2]]);
    expect(d.requirements).toEqual(expect.arrayContaining(['Каркас металлический', 'Филёнка дуб/ламинация под дуб', 'Цена изделие+фурнитура', 'Доставка', 'Установка']));
    expect(d.needsManager.map((n) => n.reason)).toContain('письмо задаёт объём (марки ДНО1, ДНО2, ДНО3): в КП 3 поз. из 18 в проекте; остальные — «Ещё в проекте»');
    // Размер у всех позиций полный — вопросов «неполная позиция» по размеру нет.
    expect(d.items.some((l) => l.size.includes('—'))).toBe(false);
  });

  it('«добавить» из «Ещё в проекте» — позиция КП; неверный номер — 404; «Собрать заново» добавляет её снова', async () => {
    const d = await draft();
    const i = d.projectRest.findIndex((it) => it.mark === 'ДН1');
    expect((await ctx.app.inject({ method: 'POST', url: `/widget/v1/kp/draft/${d.id}/project-item`, headers, payload: { index: 99 } })).statusCode).toBe(404);
    const r = await ctx.app.inject({ method: 'POST', url: `/widget/v1/kp/draft/${d.id}/project-item`, headers, payload: { index: i } });
    expect(r.statusCode).toBe(200);
    const after = r.json().draft as Draft;
    expect(after.items.at(-1)).toMatchObject({ mark: 'ДН1', size: '1010×2070 мм', qty: 2 });
    expect(after.projectRest).toHaveLength(14);
    expect(after.scope).toMatchObject({ selected: 4 });
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const again = await draft();
    expect(again.id).not.toBe(d.id);
    expect(again.items.filter((l) => l.kind !== 'service').map((l) => l.mark)).toEqual(['ДНО1', 'ДНО2', 'ДНО3', 'ДН1']);
    expect(again.projectRest).toHaveLength(14);
  });

  it('в КП у позиции — «Требования заявки: каркас металлический, …»', async () => {
    const d = await draft();
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/template', headers, payload: { filename: 'kp.docx', contentBase64: templateDocx() } });
    await ctx.app.inject({ method: 'PUT', url: `/widget/v1/kp/draft/${d.id}`, headers, payload: { items: d.items.map((l) => (l.kind === 'service' ? l : { ...l, price: 50_000 })) } });
    await answerSurvey(ctx.app, headers, LEAD_ID);
    const built = (await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/build', headers, payload: { draftId: d.id } })).json();
    expect(built).toMatchObject({ draft: { status: 'built' } });
    const doc = await ctx.deps.kp.byId(ACCOUNT_ID, d.id);
    const text = new PizZip(readFileSync(resolveKpPath(ctx.deps.filesRoot, doc!.docxPath!))).file('word/document.xml')!.asText().replace(/<[^>]+>/g, '');
    expect(text).toContain('Требования заявки: Каркас металлический, филёнка дуб/ламинация под дуб, цена изделие+фурнитура');
  });
});

function templateDocx(): string {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{{#items}}{{n}}. {{name}} — {{sum}}; {{/items}}итого {{grand_total}}</w:t></w:r></w:p></w:body></w:document>');
  return zip.generate({ type: 'base64' });
}
