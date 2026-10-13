import { readFileSync } from 'node:fs';
import PizZip from 'pizzip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeTokenClaims } from '../src/routes/widget.ts';
import { ACCOUNT_ID, CLIENT_ID, fakeGateway, LEAD_ID, setup, widgetToken } from './helpers.ts';

/** Минимальный DOCX с плейсхолдерами: номер, покупатель, строки и итог. */
function templateDocx(): string {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>КП {{kp_number}} для {{client_name}}: {{#items}}{{n}}. {{name}} — {{sum}}; {{/items}}итого {{grand_total}}. {{price_note}}</w:t></w:r></w:p></w:body></w:document>');
  return zip.generate({ type: 'base64' });
}

const modelAnswer = JSON.stringify({
  client: { org: 'ООО Ромашка', fio: '', email: '', phone: '' },
  request_items: [{ raw: 'Дверь 2000*800 — 2 шт', name: 'дверь белая', width_mm: 800, height_mm: 2000, qty: 2 }, { raw: 'Добор', name: 'добор', width_mm: null, height_mm: null, qty: 4 }],
  required_blocks: ['price'],
  questions: [],
});

describe('opt-api: от подключения интеграции до письма с КП', () => {
  const { ai, requests } = fakeGateway(modelAnswer);
  let ctx: Awaited<ReturnType<typeof setup>>;
  let headers: Record<string, string>;
  let draftId = 0;
  beforeAll(async () => {
    ctx = await setup({ ai });
    headers = { 'x-auth-token': await widgetToken() };
  });
  afterAll(() => ctx.close());

  it('health и OAuth: аккаунт и токены своей интеграции', async () => {
    const h = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(h.json()).toEqual({ status: 'ok', checks: { db: 'ok', redis: 'ok' } });
    const cb = await ctx.app.inject({ method: 'GET', url: '/oauth/amo/callback', query: { code: 'c', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1', client_id: '8b4f5e3a-2c1d-4e5f-9a8b-7c6d5e4f3a2b' } });
    expect(cb.statusCode).toBe(200);
    expect(cb.body).toContain('подключён к «Агенту опт»');
    expect(await ctx.deps.accounts.get(ACCOUNT_ID)).toMatchObject({ accountDomain: 'aleksnevedrov.amocrm.ru' });
  });

  it('виджет: токен, подписанный чужим ключом или выпущенный для другой интеграции, → 401; утверждения читаются без подписи', async () => {
    const foreign = await widgetToken({}, 'another-integration-secret-0123456789');
    expect((await ctx.app.inject({ method: 'GET', url: '/widget/v1/settings', headers: { 'x-auth-token': foreign } })).json()).toEqual({ error: 'invalid_token' });
    const otherClient = await widgetToken({ client_uuid: '11111111-2222-3333-4444-555555555555' });
    expect((await ctx.app.inject({ method: 'GET', url: '/widget/v1/settings', headers: { 'x-auth-token': otherClient } })).statusCode).toBe(401);
    expect(decodeTokenClaims(otherClient)).toMatchObject({ client_uuid: '11111111-2222-3333-4444-555555555555', iss: expect.any(String) });
    expect(decodeTokenClaims(foreign)?.client_uuid).toBe(CLIENT_ID);
    expect(decodeTokenClaims('not-a-jwt')).toBeNull();
  });

  it('виджет: без токена 401; статус, настройки strict, пароль SMTP', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/widget/v1/status' })).statusCode).toBe(401);
    const st = await ctx.app.inject({ method: 'GET', url: '/widget/v1/status', headers });
    expect(st.json()).toMatchObject({ accountId: ACCOUNT_ID, connected: true, llmConfigured: true, llm: { provider: 'openai', model: 'gpt-5.5' }, mailConfigured: false, templateLoaded: false });
    const bad = await ctx.app.inject({ method: 'PUT', url: '/widget/v1/settings', headers, payload: { mail: { pop3Host: 'x' } } });
    expect(bad.statusCode).toBe(400);
    const ok = await ctx.app.inject({ method: 'PUT', url: '/widget/v1/settings', headers, payload: { mail: { smtpHost: 'smtp.yandex.ru', username: 'sales@rf-dveri.ru', cc: 'manager@rf-dveri.ru', signature: 'Иван' } } });
    expect(ok.json()).toMatchObject({ version: 1, settings: { mail: { smtpHost: 'smtp.yandex.ru' } } });
    expect((await ctx.app.inject({ method: 'PUT', url: '/widget/v1/settings/smtp-password', headers, payload: { password: 'secret' } })).json()).toEqual({ ok: true });
    expect((await ctx.app.inject({ method: 'GET', url: '/widget/v1/status', headers })).json().mailConfigured).toBe(true);
  });

  it('настройки КП и шаблон DOCX', async () => {
    // До сохранения: допуск 10 и пустой список доменов производителей по умолчанию.
    expect((await ctx.app.inject({ method: 'GET', url: '/widget/v1/kp/settings', headers })).json().constants).toMatchObject({ analogPriceTolerancePct: 10, manufacturerDomains: [] });
    expect((await ctx.app.inject({ method: 'PUT', url: '/widget/v1/kp/settings', headers, payload: { constants: { vatRate: 22, sellerName: 'ООО "РУС-ДВЕРИ"' }, numbering: { prefix: 'КП' } } })).json()).toEqual({ ok: true });
    // Допуск цены аналога: не больше 10 % (решение заказчика 12.10.2026).
    expect((await ctx.app.inject({ method: 'PUT', url: '/widget/v1/kp/settings', headers, payload: { constants: { analogPriceTolerancePct: 15 } } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'PUT', url: '/widget/v1/kp/settings', headers, payload: { constants: { vatRate: 22, sellerName: 'ООО "РУС-ДВЕРИ"', analogPriceTolerancePct: 7, manufacturerDomains: ['fabrika.ru', 'dveri-profil.ru'] } } })).json()).toEqual({ ok: true });
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/template', headers, payload: { filename: 'kp.docx', contentBase64: Buffer.from('not a zip').toString('base64') } })).json()).toEqual({ error: 'not_docx' });
    const up = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/template', headers, payload: { filename: 'kp.docx', contentBase64: templateDocx() } });
    expect(up.json()).toMatchObject({ ok: true, md5: expect.stringMatching(/^[a-f0-9]{32}$/) });
    const s = await ctx.app.inject({ method: 'GET', url: '/widget/v1/kp/settings', headers });
    expect(s.json()).toMatchObject({ constants: { vatRate: 22, analogPriceTolerancePct: 7, manufacturerDomains: ['fabrika.ru', 'dveri-profil.ru'], priceNote: 'Цены носят ориентировочный характер и могут быть скорректированы после уточнения всех деталей заказа.' }, template: { exists: true, name: 'kp.docx' } });
  });

  it('«Собрать КП»: задание в очередь, черновик из письма в карточке, позиции без цен', async () => {
    ctx.amo.mail = { id: 5, created_at: 1_760_000_000, params: { income: true, subject: 'Запрос КП', text: 'Нужны двери', from: 'ivanov@romashka.ru', attachments: [] } };
    expect((await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json()).toEqual({ draft: null, job: null });
    const post = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    expect(post.statusCode).toBe(202);
    const got = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json();
    expect(got.job).toBeNull();
    expect(got.draft).toMatchObject({ leadId: LEAD_ID, status: 'draft', client: { org: 'ООО Ромашка', fio: 'Иванов Иван', email: 'ivanov@romashka.ru' } });
    expect(got.draft.items.map((l: { name: string; price: number | null }) => [l.name, l.price])).toEqual([['дверь белая', null], ['добор', null]]);
    // Ящик настроен (логин и пароль SMTP есть), письмо в нём не найдено: пометка менеджеру и событие mail_fetch, сборка по карточке.
    expect(got.draft.needsManager).toHaveLength(3);
    expect(got.draft.needsManager[2]).toEqual({ request_index: -1, reason: 'письмо в ящике не найдено (искали от ivanov@romashka.ru) — черновик по тому, что есть в карточке' });
    expect(got.draft.source).toMatchObject({ from: 'amo_card', mails: 1, documents: [], skipped: [], mail: { status: 'not_found', searchedFrom: 'ivanov@romashka.ru' } });
    expect((await ctx.app.inject({ method: 'GET', url: '/widget/v1/journal?kind=mail_fetch', headers })).json().items.map((i: { summary: string }) => i.summary)).toEqual(['Письмо в ящике не найдено (искали от ivanov@romashka.ru, папок просмотрено 0, писем в окне дат 0, от отправителя 0)']);
    expect(requests).toHaveLength(1);
    draftId = got.draft.id;
    const journal = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/journal?kind=kp_draft', headers })).json().items;
    expect(journal[0]).toMatchObject({ kind: 'kp_draft', leadId: LEAD_ID, inputTokens: 500 });
  });

  it('без цен сборка отклоняется; после правок — DOCX по шаблону, номер, файл в сделке', async () => {
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/build', headers, payload: { draftId } })).json()).toEqual({ error: 'no_priced_lines' });
    const items = [
      { request_index: 0, page_id: null, name: 'дверь белая', size: '2000×800 мм', qty: 2, price: 14_900, lead_time: '', discount: 0 },
      { request_index: 1, page_id: null, name: 'добор', size: '', qty: 4, price: 1_200, lead_time: '', discount: 10 },
    ];
    expect((await ctx.app.inject({ method: 'PUT', url: `/widget/v1/kp/draft/${draftId}`, headers, payload: { items } })).json().draft.items[1].price).toBe(1_200);
    const built = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/build', headers, payload: { draftId } });
    // PDF появляется, если на машине есть LibreOffice; иначе в сделку уходит DOCX.
    expect(built.json()).toMatchObject({ draft: { status: 'built', kpNo: 'КП-2026-1', hasDocx: true }, attached: [expect.stringMatching(/^KP-КП-2026-1\.(pdf|docx)$/)] });
    const d = await ctx.deps.kp.byId(ACCOUNT_ID, draftId);
    const xml = new PizZip(readFileSync(d!.docxPath!)).file('word/document.xml')!.asText().replace(/\u00a0/g, ' ');
    expect(xml).toContain('КП КП-2026-1 для ООО Ромашка');
    expect(xml).toContain('1. дверь белая — 29 800 ₽; 2. добор — 4 320 ₽; итого 34 120 ₽. Цены носят ориентировочный характер и могут быть скорректированы после уточнения всех деталей заказа.');
    expect(ctx.amo.calls.filter((c) => c.url.endsWith(`/leads/${LEAD_ID}/files`) && c.method === 'POST')).toHaveLength(1);
  });

  it('предпросмотр и отправка: получатель из карточки, тема и текст из шаблонов, статус sent, примечание в сделке', async () => {
    const pv = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/send/preview?draftId=${draftId}`, headers })).json();
    expect(pv).toMatchObject({ to: 'ivanov@romashka.ru', cc: 'manager@rf-dveri.ru', subject: 'Коммерческое предложение КП-2026-1', attachment: { name: expect.stringMatching(/^KP-КП-2026-1\.(pdf|docx)$/) }, blockers: [], warnings: [], alreadySent: false });
    const blocked = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/send', headers, payload: { draftId, to: 'кривой адрес', subject: pv.subject, text: pv.text } });
    expect(blocked.json()).toEqual({ error: 'blocked', reasons: ['адрес получателя пустой или не похож на e-mail'] });
    expect(ctx.sent).toHaveLength(0);
    const sent = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/send', headers, payload: { draftId, to: pv.to, cc: pv.cc, subject: pv.subject, text: pv.text } });
    expect(sent.json()).toMatchObject({ draft: { status: 'sent' }, to: 'ivanov@romashka.ru' });
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]!.cfg).toEqual({ host: 'smtp.yandex.ru', port: 465, secure: true, username: 'sales@rf-dveri.ru', password: 'secret' });
    expect(ctx.sent[0]!.mail).toMatchObject({ from: { name: 'РФ-Двери', address: 'sales@rf-dveri.ru' }, to: 'ivanov@romashka.ru', cc: 'manager@rf-dveri.ru', subject: 'Коммерческое предложение КП-2026-1' });
    expect(ctx.sent[0]!.mail.text).toContain('--\nИван');
    expect(ctx.sent[0]!.mail.attachments[0]?.filename).toMatch(/^KP-КП-2026-1\.(pdf|docx)$/);
    const note = ctx.amo.calls.find((c) => c.url.endsWith(`/leads/${LEAD_ID}/notes`) && c.method === 'POST');
    expect(JSON.stringify(note?.body)).toContain('КП КП-2026-1 отправлено на ivanov@romashka.ru');
    const journal = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/journal?kind=kp_sent', headers })).json().items;
    expect(journal[0]).toMatchObject({ kind: 'kp_sent', details: { to: 'ivanov@romashka.ru', kpNo: 'КП-2026-1', userId: 7 } });
    // Повторная отправка — только с подтверждением.
    const again = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/send', headers, payload: { draftId, to: pv.to, subject: pv.subject, text: pv.text } });
    expect(again.json().reasons).toEqual(['это КП уже отправлялось — нужно подтверждение повторной отправки']);
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/send', headers, payload: { draftId, to: pv.to, subject: pv.subject, text: pv.text, resendConfirmed: true } })).statusCode).toBe(200);
    expect(ctx.sent).toHaveLength(2);
  });
});

describe('opt-api: ошибка SMTP не меняет статус; без LLM черновик не ставится', () => {
  it('ошибка почтового сервера → 502 с текстом, статус built, событие kp_error', async () => {
    const { ai } = fakeGateway(modelAnswer);
    const ctx = await setup({ ai, failSend: 'SMTP 535 Authentication failed' });
    try {
      const headers = { 'x-auth-token': await widgetToken() };
      await ctx.app.inject({ method: 'GET', url: '/oauth/amo/callback', query: { code: 'c', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
      await ctx.app.inject({ method: 'PUT', url: '/widget/v1/settings', headers, payload: { mail: { smtpHost: 'smtp.yandex.ru', username: 'sales@rf-dveri.ru' } } });
      await ctx.app.inject({ method: 'PUT', url: '/widget/v1/settings/smtp-password', headers, payload: { password: 'p' } });
      await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/template', headers, payload: { filename: 'kp.docx', contentBase64: templateDocx() } });
      ctx.amo.mail = { id: 5, created_at: 1_760_000_000, params: { income: true, subject: 'Запрос', text: 'Нужны двери', from: 'ivanov@romashka.ru' } };
      await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
      const draft = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
      await ctx.app.inject({ method: 'PUT', url: `/widget/v1/kp/draft/${draft.id}`, headers, payload: { items: [{ ...draft.items[0], price: 10_000 }] } });
      await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/build', headers, payload: { draftId: draft.id } });
      const r = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/send', headers, payload: { draftId: draft.id, to: 'ivanov@romashka.ru', subject: 'КП', text: 'Текст' } });
      expect(r.statusCode).toBe(502);
      expect(r.json()).toEqual({ error: 'send_failed', message: 'SMTP 535 Authentication failed' });
      expect((await ctx.deps.kp.byId(ACCOUNT_ID, draft.id))?.status).toBe('built');
      const errors = (await ctx.app.inject({ method: 'GET', url: '/widget/v1/journal?kind=kp_error', headers })).json().items;
      expect(errors[0].summary).toContain('SMTP 535');
    } finally {
      await ctx.close();
    }
  });

  it('нет ключей провайдеров — 409 no_llm, задание не ставится', async () => {
    const ctx = await setup({ ai: async () => null });
    try {
      const headers = { 'x-auth-token': await widgetToken() };
      await ctx.app.inject({ method: 'GET', url: '/oauth/amo/callback', query: { code: 'c', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
      const r = await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error: 'no_llm' });
      expect((await ctx.app.inject({ method: 'GET', url: '/widget/v1/status', headers })).json().llmConfigured).toBe(false);
    } finally {
      await ctx.close();
    }
  });
});

describe('opt-api: черновик без базы знаний (решение заказчика 12.10.2026)', () => {
  it('в черновике только пометка «цена не задана», маршрутов базы знаний нет', async () => {
    const { ai } = fakeGateway(JSON.stringify({ client: { org: 'ООО Ромашка', fio: '', email: '', phone: '' }, request_items: [{ raw: 'Турин 2000*800 срочно — 2 шт', name: 'дверь Турин', width_mm: 800, height_mm: 2000, qty: 2 }], required_blocks: ['delivery'], questions: [] }));
    const ctx = await setup({ ai });
    try {
      const headers = { 'x-auth-token': await widgetToken() };
      await ctx.app.inject({ method: 'GET', url: '/oauth/amo/callback', query: { code: 'c', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
      ctx.amo.mail = { id: 5, created_at: 1_760_000_000, params: { income: true, subject: 'Запрос', text: 'Нужна доставка', from: 'ivanov@romashka.ru' } };

      // Черновик без базы знаний (убрана по решению заказчика 12.10.2026): только пометка «цена не задана».
      await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
      const d = (await ctx.app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
      expect(d.needsManager).toEqual([{ request_index: 0, reason: 'цена не задана' }]);
      expect(d.source.from).toBe('amo_card');
      expect(d.knowledge).toBeUndefined();
      expect((await ctx.app.inject({ method: 'GET', url: '/widget/v1/kp/knowledge', headers })).statusCode).toBe(404);
    } finally {
      await ctx.close();
    }
  });
});
