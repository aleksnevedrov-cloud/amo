// RFD-AI-AGENT-OPT-DEAL-FILES: файлы сделки «90287» (30038356) — список amo отдаёт только id и file_uuid, карточка файла в
// Files API на drive_url; без карточки — «пропущено» с причиной. Разбор файлов — через замоканную модель.
import type { LlmGateway, RoutedResponse } from '@core/llm';
import type { OptAiProvider } from '@opt/kp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { leadFileCard, LEAD_ID, setup, widgetToken } from './helpers.ts';

const DOC = (title: string) => JSON.stringify({ kind: 'request', title, summary: title, customer_type: 'b2b', openings: [], positions: [{ name: `Дверь из «${title}»`, marking: null, width_mm: 900, height_mm: 2100, qty: 1, unit: 'шт', price_rub: null, material: null, color: null, fireproof: null, note: null }], requirements: [], questions: [], photo: null });
const LETTER = JSON.stringify({ client: { org: 'ООО Заказчик', fio: '', email: 'client@example.ru', phone: '' }, request_items: [], required_blocks: ['price'], questions: [] });

/** Шлюз: письмо — без позиций; документ — одна дверь с названием файла (чтобы видеть, какие файлы разобраны). */
function gateway() {
  const docs: string[] = [];
  const llm: LlmGateway = {
    async chat(req, route) {
      const schema = req.outputSchema?.name ?? 'letter';
      const text = req.messages.map((msg) => (typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n') : '')).join('\n');
      // Имя файла @core/docs ставит в запрос сам («Имя файла: …»); строка внутри текста может уйти под чистку персональных данных.
      const m = /Имя файла: ([^\n]+)/.exec(text);
      const title = m?.[1]?.trim() ?? 'документ';
      if (schema !== 'letter') docs.push(title);
      const out = schema === 'letter' ? LETTER : DOC(title);
      return { text: out, toolCalls: [], stopReason: 'end', usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, cacheWriteTokens: 0 }, provider: route.primary.provider, model: route.primary.model, assistantMessage: { role: 'assistant', content: out }, latencyMs: 1, fallbackUsed: false, requested: route.primary, attempts: [] } as unknown as RoutedResponse;
    },
    providers: async () => ['openai'],
    provider: async () => null,
  };
  const ai: OptAiProvider = async () => ({ llm, source: 'account', providers: ['openai'], keySources: { openai: 'account' } });
  return { ai, docs };
}

type Draft = { id: number; items: { name: string }[]; source: { attachments: string[]; skipped: { name: string; reason: string }[]; files?: { name: string; status: string; positions: number; reason: string | null }[] } };

describe('файлы сделки опта (RFD-AI-AGENT-OPT-DEAL-FILES, часть 0)', () => {
  const g = gateway();
  let ctx: Awaited<ReturnType<typeof setup>>;
  let headers: Record<string, string>;
  const draft = async () => (await ctx.app.inject({ url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft as Draft;
  const build = async () => {
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    return draft();
  };
  const txt = (title: string) => new TextEncoder().encode(`${title}\nЗаявка на двери: дверной блок 900×2100, 1 шт.`);

  beforeAll(async () => {
    ctx = await setup({ ai: g.ai });
    headers = { 'x-auth-token': await widgetToken() };
    await ctx.app.inject({ method: 'GET', url: '/oauth/amo/callback', query: { code: 'c', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
    ctx.amo.mail = { id: 5, created_at: 1_760_000_000, params: { income: true, subject: 'Заявка', text: 'Файлы в сделке', from: 'client@example.ru' } };
  });
  afterAll(() => ctx.close());

  it('ответ /leads/{id}/files только с file_uuid и id (реальный формат): 3 файла с именами из Files API разобраны; файл без карточки — «карточка файла не получена: HTTP 404»', async () => {
    leadFileCard(ctx.amo, '2a5408d7-f411-4919-88cc-b714b9f6f2ac', 'Двери внутренние Данилково (4).txt', txt('Двери внутренние Данилково (4).txt'), 'text/plain');
    leadFileCard(ctx.amo, '5fb0943d-f045-4edf-897d-a87cc3118b12', 'Двери наружные Данилково (4).txt', txt('Двери наружные Данилково (4).txt'), 'text/plain');
    leadFileCard(ctx.amo, '7c1e0000-0000-0000-0000-000000000003', 'Счет покупателю № 126 от 3 ноября 2026 г.txt', txt('Счет покупателю № 126 от 3 ноября 2026 г.txt'), 'text/plain');
    leadFileCard(ctx.amo, 'dead-beef-0000-0000-0000-000000000004', null, new Uint8Array(), 'application/pdf');
    const d = await build();
    expect(d.source.attachments).toEqual(['Двери внутренние Данилково (4).txt', 'Двери наружные Данилково (4).txt', 'Счет покупателю № 126 от 3 ноября 2026 г.txt']);
    expect(d.source.skipped).toEqual([{ name: 'файл dead-beef-0000-0000-0000-000000000004', reason: 'карточка файла не получена: HTTP 404' }]);
    expect(d.source.files?.map((f) => [f.name, f.status, f.positions])).toEqual([
      ['Двери внутренние Данилково (4).txt', 'parsed', 1],
      ['Двери наружные Данилково (4).txt', 'parsed', 1],
      ['Счет покупателю № 126 от 3 ноября 2026 г.txt', 'parsed', 1],
      ['файл dead-beef-0000-0000-0000-000000000004', 'skipped', 0],
    ]);
    expect(d.items.map((i) => i.name)).toEqual(['Дверь из «Двери внутренние Данилково (4).txt»', 'Дверь из «Двери наружные Данилково (4).txt»', 'Дверь из «Счет покупателю № 126 от 3 ноября 2026 г.txt»']);
    // Карточки запрошены в Files API на drive_url, а не на домене аккаунта.
    const urls = ctx.amo.calls.map((c) => c.url);
    expect(urls.filter((u) => u.startsWith('https://drive-b.amocrm.ru/v1.0/files/'))).toHaveLength(4);
    expect(urls.some((u) => u.includes('aleksnevedrov.amocrm.ru/api/v4/files/dead-beef'))).toBe(true);
  }, 30_000);
});
