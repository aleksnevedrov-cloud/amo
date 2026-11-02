// Старые черновики (формат 12.10, без requirements и прочих полей KP-AGENT-V2) при выдаче дозаполняются: GET /kp/draft — 200 и
// все массивы / объекты на месте, виджет открывает сделку.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNT_ID, setup, widgetToken } from './helpers.ts';

describe('GET /kp/draft по черновику старого формата', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let headers: Record<string, string>;
  beforeAll(async () => {
    ctx = await setup();
    headers = { 'x-auth-token': await widgetToken() };
    // Установка интеграции — как в остальных тестах: аккаунт появляется в БД.
    await ctx.app.inject({ method: 'GET', url: '/oauth/amo/callback', query: { code: 'c', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
  });
  afterAll(async () => ctx.close());

  it('черновик 12.10 (как kp_drafts id 8 сделки 29996635) → 200, requirements / photos / survey / counters / source.skipped заполнены', async () => {
    const payload = {
      items: [{ request_index: 0, page_id: null, name: 'Дверь ДПС 01', size: '2100×900 мм', qty: 11, price: null, lead_time: '', discount: 0 }],
      client: { org: 'ООО Ромашка', fio: '', email: 'ivanov@romashka.ru', phone: '' },
      source: { from: 'amo_card', mails: 1, letterAt: '2026-10-09T10:00:00Z', attachments: ['Двери (3).docx'], documents: [501] },
      questions: ['Сторона открывания?'],
      candidates: [],
      components: [],
      generatedAt: '2026-10-12T10:00:00Z',
      needs_manager: [{ request_index: 0, reason: 'цена не задана' }],
      request_items: [{ raw: 'ДПС 01', name: 'Дверь ДПС 01', width_mm: 900, height_mm: 2100, qty: 11 }],
      required_blocks: ['price'],
    };
    const id = await ctx.deps.kp.createDraft(ACCOUNT_ID, 29996635, payload, null);
    const res = await ctx.app.inject({ url: '/widget/v1/kp/draft?leadId=29996635', headers });
    expect(res.statusCode).toBe(200);
    const d = res.json().draft;
    expect(d.id).toBe(id);
    expect(d).toMatchObject({ requirements: [], photos: [], projectRest: [], scope: null, delivery: null, letterText: null, questions: ['Сторона открывания?'], requiredBlocks: ['price'] });
    expect(d.source).toMatchObject({ from: 'amo_card', attachments: ['Двери (3).docx'], documents: [501], skipped: [] });
    expect(Array.isArray(d.survey)).toBe(true);
    expect(d.counters).toMatchObject({ positions: 1 });
    expect(d.client).toEqual({ org: 'ООО Ромашка', fio: '', email: 'ivanov@romashka.ru', phone: '' });
    // В базе черновик не изменён.
    const stored = await ctx.deps.kp.byId(ACCOUNT_ID, id);
    expect(Object.keys(stored?.payload ?? {}).sort()).toEqual(Object.keys(payload).sort());
  });
});
