// KP-SENT-COPY: после отправки КП тот же MIME — копией в «Отправленные» (IMAP APPEND, \Seen, папка по признаку \Sent) и
// файлом .eml рядом с КП; в журнале kp_sent — messageId, ответ SMTP, адреса, тема, вложение, папка. Сбой копии отправку
// не отменяет (kp_sent_copy_failed, пометка в окне), повторного письма нет. «Посмотреть письмо» — для новых и старых КП.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveKpPath } from '@opt/kp';
import PizZip from 'pizzip';
import { ACCOUNT_ID, answerSurvey, fakeGateway, LEAD_ID, setup, widgetToken } from './helpers.ts';

const letter = JSON.stringify({
  client: { org: 'ООО Мега', fio: '', email: 'borovova@m-47.ru', phone: '' },
  request_items: [{ raw: 'Дверь 2000*800 — 2 шт', name: 'дверь белая', width_mm: 800, height_mm: 2000, qty: 2 }],
  required_blocks: ['price'],
  questions: [],
});

type SentMail = { legacy: boolean; note?: string; kpNo: string | null; at: string | null; messageId: string | null; from: string | null; to: string | null; cc: string | null; subject: string | null; text: string | null; attachment: { name: string; bytes: number | null } | null; attachmentKind: string | null; smtp: { accepted: string[]; rejected: string[]; response: string } | null; eml: string | null; copy: { status: string; folder: string | null; error: string | null } };

describe('копия отправленного КП в «Отправленные» (KP-SENT-COPY)', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let headers: Record<string, string>;
  let draftId = 0;
  const send = (resendConfirmed = false) => ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/send', headers, payload: { draftId, to: 'borovova@m-47.ru', cc: 'manager@rf-dveri.ru', subject: 'Коммерческое предложение КП-2026-1', text: 'Здравствуйте!\n\nКП во вложении.', ...(resendConfirmed ? { resendConfirmed } : {}) } });
  const sentMail = async (id = draftId) => (await ctx.app.inject({ url: `/widget/v1/kp/draft/${id}/sent-mail`, headers })).json() as SentMail;

  beforeAll(async () => {
    ctx = await setup({ ai: fakeGateway(letter).ai });
    headers = { 'x-auth-token': await widgetToken() };
    await ctx.app.inject({ method: 'GET', url: '/oauth/amo/callback', query: { code: 'c', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
    await ctx.app.inject({ method: 'PUT', url: '/widget/v1/settings', headers, payload: { mail: { smtpHost: 'smtp.yandex.ru', smtpPort: 465, username: 'rf-dveri@yandex.ru', fromName: 'РФ-Двери' } } });
    await ctx.app.inject({ method: 'PUT', url: '/widget/v1/settings/smtp-password', headers, payload: { password: 'app-password' } });
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/template', headers, payload: { filename: 'kp.docx', contentBase64: templateDocx() } });
    ctx.amo.mail = { id: 5, created_at: 1_760_000_000, params: { income: true, subject: 'Запрос', text: 'Нужны двери', from: 'borovova@m-47.ru' } };
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    const d = (await ctx.app.inject({ url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft;
    draftId = d.id;
    await ctx.app.inject({ method: 'PUT', url: `/widget/v1/kp/draft/${draftId}`, headers, payload: { items: [{ ...d.items[0], price: 14_900 }] } });
    await answerSurvey(ctx.app, headers, LEAD_ID);
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/build', headers, payload: { draftId } })).json()).toMatchObject({ draft: { status: 'built' } });
  }, 30_000);
  afterAll(() => ctx.close());

  it('после SMTP — тот же MIME в папке \\Sent (\\Seen, imap.yandex.ru:993, логин SMTP) и .eml рядом с КП; вложение на месте', async () => {
    const r = await send();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ draft: { status: 'sent', sentMail: { copy: { status: 'saved', folder: 'Отправленные', error: null } } }, copy: { status: 'saved', folder: 'Отправленные' } });
    expect(ctx.sent).toHaveLength(1);
    const raw = ctx.sent[0]!.raw;
    const box = ctx.imap.boxes.get('Отправленные')!;
    expect(box).toHaveLength(1);
    expect(box[0]!.raw.equals(raw)).toBe(true);
    expect(box[0]!.flags).toEqual(['\\Seen']);
    expect(box[0]!.cfg).toEqual({ host: 'imap.yandex.ru', port: 993, secure: true, username: 'rf-dveri@yandex.ru', password: 'app-password' });
    const mime = raw.toString('utf8');
    const d = await ctx.deps.kp.byId(ACCOUNT_ID, draftId);
    const kpFile = resolveKpPath(ctx.deps.filesRoot, d!.pdfPath ?? d!.docxPath)!;
    const name = kpFile.split('/').pop()!;
    expect(mime).toContain(`Message-ID: ${ctx.sent[0]!.mail.messageId}`);
    expect(mime).toMatch(/Content-Disposition: attachment/);
    // Вложение — файл КП целиком (base64 в MIME).
    expect(mime.replace(/\r?\n/g, '')).toContain(readFileSync(kpFile).toString('base64').slice(0, 2000));
    const emlRel = `kp/${ACCOUNT_ID}/${LEAD_ID}/${name.replace(/\.(pdf|docx)$/, '')}.eml`;
    expect(readFileSync(resolveKpPath(ctx.deps.filesRoot, emlRel)).equals(raw)).toBe(true);
    // Журнал kp_sent: всё, что нужно, чтобы проверить, что и как ушло клиенту.
    const j = (await ctx.app.inject({ url: '/widget/v1/journal?kind=kp_sent', headers })).json().items[0];
    expect(j.summary).toBe('КП КП-2026-1 отправлено на borovova@m-47.ru, копия — в «Отправленные»');
    expect(j.details).toMatchObject({
      draftId, kpNo: 'КП-2026-1', messageId: ctx.sent[0]!.mail.messageId, from: 'РФ-Двери <rf-dveri@yandex.ru>', to: 'borovova@m-47.ru', cc: 'manager@rf-dveri.ru', subject: 'Коммерческое предложение КП-2026-1',
      attachment: { name, bytes: readFileSync(kpFile).length }, smtp: { accepted: ['borovova@m-47.ru', 'manager@rf-dveri.ru'], rejected: [], response: '250 2.0.0 Ok: queued' }, eml: emlRel, copy: { status: 'saved', folder: 'Отправленные', error: null },
    });
    expect(j.details.text).toBeUndefined();
  });

  it('«Посмотреть письмо»: от кого, кому, копия, тема, дата, текст, вложение, messageId, копия в «Отправленные»', async () => {
    const m = await sentMail();
    expect(m).toMatchObject({ legacy: false, kpNo: 'КП-2026-1', from: 'РФ-Двери <rf-dveri@yandex.ru>', to: 'borovova@m-47.ru', cc: 'manager@rf-dveri.ru', subject: 'Коммерческое предложение КП-2026-1', messageId: ctx.sent[0]!.mail.messageId, copy: { status: 'saved', folder: 'Отправленные' }, attachment: { name: expect.stringMatching(/^KP-КП-2026-1\.(pdf|docx)$/) } });
    expect(m.text).toBe('Здравствуйте!\n\nКП во вложении.');
    expect(new Date(m.at!).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(['pdf', 'docx']).toContain(m.attachmentKind);
  });

  it('APPEND упал — КП отправлено (sent), запись kp_sent_copy_failed с причиной, пометка в черновике; второго SMTP-письма нет', async () => {
    ctx.imap.failAppend = 'IMAP imap.yandex.ru: вход rf-dveri@yandex.ru не удался (AUTHENTICATIONFAILED)';
    const r = await send(true);
    ctx.imap.failAppend = null;
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ draft: { status: 'sent', sentMail: { copy: { status: 'failed', error: 'IMAP imap.yandex.ru: вход rf-dveri@yandex.ru не удался (AUTHENTICATIONFAILED)' } } }, copy: { status: 'failed' } });
    expect(ctx.sent).toHaveLength(2);
    expect(ctx.imap.boxes.get('Отправленные')).toHaveLength(1);
    const failed = (await ctx.app.inject({ url: '/widget/v1/journal?kind=kp_sent_copy_failed', headers })).json().items;
    expect(failed[0]).toMatchObject({ summary: 'КП КП-2026-1: копия в «Отправленные» не сохранена — IMAP imap.yandex.ru: вход rf-dveri@yandex.ru не удался (AUTHENTICATIONFAILED)', details: { draftId, messageId: ctx.sent[1]!.mail.messageId } });
    expect((await ctx.app.inject({ url: '/widget/v1/journal?kind=kp_sent', headers })).json().items[0].details.copy).toMatchObject({ status: 'failed' });
    expect((await sentMail()).copy).toMatchObject({ status: 'failed' });
  });

  it('КП, отправленное до сохранения копий (как КП-2026-16): данные из журнала с пометкой', async () => {
    const d = await ctx.deps.kp.byId(ACCOUNT_ID, draftId);
    const old = await ctx.deps.kp.createDraft(ACCOUNT_ID, LEAD_ID, { ...(d!.payload as Record<string, unknown>), sentMail: null }, 7);
    await ctx.deps.kp.setStatus(old, 'sent');
    await ctx.deps.journal.add({ accountId: ACCOUNT_ID, leadId: LEAD_ID, kind: 'kp_sent', summary: 'КП КП-2026-16 отправлено на borovova@m-47.ru', details: { draftId: old, to: 'borovova@m-47.ru', cc: null, kpNo: 'КП-2026-16', userId: 7, attachment: 'KP-КП-2026-16.pdf' } });
    const m = await sentMail(old);
    expect(m).toMatchObject({ legacy: true, note: 'письмо отправлено до сохранения копий', to: 'borovova@m-47.ru', cc: null, messageId: null, text: null, attachment: { name: 'KP-КП-2026-16.pdf', bytes: null }, copy: { status: 'unknown' } });
    expect(m.at).toBeTruthy();
    // Не отправленное КП — 404.
    const fresh = await ctx.deps.kp.createDraft(ACCOUNT_ID, LEAD_ID, { ...(d!.payload as Record<string, unknown>), sentMail: null }, 7);
    expect((await ctx.app.inject({ url: `/widget/v1/kp/draft/${fresh}/sent-mail`, headers })).statusCode).toBe(404);
  });

  it('«Проверить IMAP»: вход и найденная папка; заданная несуществующая — не ok; сбой — причина; поле «Папка отправленных» сохраняется, пароль не отдаётся', async () => {
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/settings/imap-test', headers, payload: {} })).json()).toMatchObject({ ok: true, host: 'imap.yandex.ru:993', username: 'rf-dveri@yandex.ru', folder: 'Отправленные', how: 'special_use', exists: true });
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/settings/imap-test', headers, payload: { sentFolder: 'Нет такой' } })).json()).toMatchObject({ ok: false, folder: 'Нет такой', how: 'settings', exists: false });
    ctx.imap.failAppend = 'IMAP imap.yandex.ru:993: нет соединения';
    expect((await ctx.app.inject({ method: 'POST', url: '/widget/v1/settings/imap-test', headers, payload: {} })).json()).toMatchObject({ ok: false, error: 'IMAP imap.yandex.ru:993: нет соединения' });
    ctx.imap.failAppend = null;
    const s = (await ctx.app.inject({ url: '/widget/v1/settings', headers })).json().settings;
    expect(s.mail.sentFolder).toBe('');
    await ctx.app.inject({ method: 'PUT', url: '/widget/v1/settings', headers, payload: { ...s, mail: { ...s.mail, sentFolder: 'Отправленные' } } });
    const again = (await ctx.app.inject({ url: '/widget/v1/settings', headers }));
    expect(again.json().settings.mail.sentFolder).toBe('Отправленные');
    expect(again.body).not.toContain('app-password');
  });
});

function templateDocx(): string {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{{#items}}{{n}}. {{name}} — {{sum}}; {{/items}}итого {{grand_total}}</w:t></w:r></w:p></w:body></w:document>');
  return zip.generate({ type: 'base64' });
}
