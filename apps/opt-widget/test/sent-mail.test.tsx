// @vitest-environment jsdom
// KP-SENT-COPY: у отправленного КП — «Посмотреть письмо» (от кого, кому, копия, тема, дата МСК, текст, вложение со ссылкой,
// Message-ID, копия в «Отправленные»), жёлтая пометка, если копия не сохранена; старые КП — данные журнала с пометкой.
// Настройки «Письмо»: «Папка отправленных» и «Проверить IMAP».
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AmoWidgetSelf } from '@core/widget-core';
import { createCallbacks } from '../src/index.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Responder = unknown | ((data?: string) => unknown);

function fakeSelf(area: string, responses: Record<string, Responder>) {
  const calls: { url: string; method?: string; data?: string }[] = [];
  const self: AmoWidgetSelf = {
    get_settings: () => ({ widget_code: 'opt_agent' }),
    system: () => ({ area }),
    i18n: () => '',
    render_template: ({ render }) => document.body.insertAdjacentHTML('beforeend', render),
    $authorizedAjax: async (opts) => {
      calls.push(opts);
      const key = `${opts.method} ${new URL(opts.url).pathname}`;
      const r = key === 'GET /widget/v1/kp/research' && responses[key] === undefined ? { draftId: 80, pending: false, positions: [] } : responses[key];
      if (r === undefined) throw { status: 404, responseJSON: { message: `нет ответа для ${key}` } };
      return typeof r === 'function' ? (r as (d?: string) => unknown)(opts.data) : r;
    },
  };
  return { self, calls };
}
const flush = () => act(async () => new Promise((r) => setTimeout(r, 20)));
const button = (text: string, root: ParentNode = document) => [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const click = (text: string, root: ParentNode = document) =>
  act(async () => {
    const b = button(text, root);
    if (!b) throw new Error(`Нет кнопки «${text}»`);
    b.click();
  });
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\u00a0/g, ' ') ?? '';

const draft = (over: Record<string, unknown> = {}) => ({
  id: 80, leadId: 30022107, status: 'sent', kpNo: 'КП-2026-16', createdAt: '2026-10-21T07:00:00Z', builtAt: '2026-10-21T07:30:00Z', sentAt: '2026-10-21T07:48:00Z', hasDocx: true, hasPdf: true,
  client: { org: 'ООО М-47', fio: '', email: 'borovova@m-47.ru', phone: '' }, requestItems: [], requiredBlocks: [], questions: [],
  items: [{ request_index: 0, page_id: null, name: 'Дверь', size: '900×2000 мм', qty: 1, price: 19_680, lead_time: '', discount: 0, priceSource: 'price_file' }],
  needsManager: [], source: null, ...over,
});
const mail = {
  legacy: false, kpNo: 'КП-2026-16', at: '2026-10-21T07:48:00Z', messageId: '<ai-door-kp.mh1.abc@yandex.ru>', from: 'РФ-Двери <rf-dveri@yandex.ru>', to: 'borovova@m-47.ru', cc: 'manager@rf-dveri.ru',
  subject: 'Коммерческое предложение КП-2026-16', text: 'Здравствуйте!\n\nКП во вложении.\n\n--\nРФ-Двери', attachment: { name: 'KP-КП-2026-16.pdf', bytes: 245_760 }, attachmentKind: 'pdf',
  smtp: { accepted: ['borovova@m-47.ru'], rejected: [], response: '250 2.0.0 Ok: queued' }, eml: 'kp/1/30022107/KP-КП-2026-16.eml', copy: { status: 'failed', folder: null, error: 'IMAP imap.yandex.ru: вход rf-dveri@yandex.ru не удался (AUTHENTICATIONFAILED)' },
};

beforeEach(() => {
  document.body.innerHTML = '';
  window.APP = { data: { current_card: { id: 30022107 } } };
});

describe('отправленное КП (KP-SENT-COPY)', () => {
  it('копия не сохранена — жёлтая пометка в колонке и в окне; «Посмотреть письмо» — все поля, вложение по ссылке', async () => {
    const { self, calls } = fakeSelf('lcard', {
      'GET /widget/v1/kp/draft': { draft: draft({ sentMail: { at: mail.at, to: mail.to, messageId: mail.messageId, copy: mail.copy } }), job: null },
      'GET /widget/v1/kp/draft/80/sent-mail': mail,
      'GET /widget/v1/kp/file/link': { url: 'https://opt.test.ru/kp/file?draftId=80&kind=pdf&t=x', filename: 'KP-КП-2026-16.pdf', expiresAt: '2026-10-21T08:00:00Z' },
    });
    const cbs = createCallbacks(self, 'https://opt.test.ru');
    await act(async () => cbs.render!());
    await flush();
    expect(text(document.querySelector('.opt-kp-narrow .opt-kp-copy-failed'))).toBe('Копия в «Отправленные» не сохранена: IMAP imap.yandex.ru: вход rf-dveri@yandex.ru не удался (AUTHENTICATIONFAILED)');
    await click('Развернуть ⤢');
    const modal = document.querySelector('.opt-kp-modal')!;
    expect(modal.querySelector('.opt-kp-copy-failed')).not.toBeNull();
    await click('Посмотреть письмо', modal);
    await flush();
    const layer = modal.querySelector('.opt-kp-send-layer')!;
    const rows = Object.fromEntries([...layer.querySelectorAll('.opt-kp-mail-row')].map((r) => [text(r.querySelector('.opt-kp-label')), text(r.querySelector('.opt-kp-mail-value'))]));
    expect(rows).toEqual({
      'От кого': 'РФ-Двери <rf-dveri@yandex.ru>',
      Кому: 'borovova@m-47.ru',
      Копия: 'manager@rf-dveri.ru',
      Тема: 'Коммерческое предложение КП-2026-16',
      Дата: '21.10.2026, 10:48 МСК',
      Вложение: 'KP-КП-2026-16.pdf · 240 КБ',
      'Message-ID': '<ai-door-kp.mh1.abc@yandex.ru>',
      'Ответ SMTP': '250 2.0.0 Ok: queued',
      'Копия в «Отправленные»': 'не сохранена: IMAP imap.yandex.ru: вход rf-dveri@yandex.ru не удался (AUTHENTICATIONFAILED)',
    });
    expect(text(layer.querySelector('.opt-kp-mail-text'))).toBe('Здравствуйте!\n\nКП во вложении.\n\n--\nРФ-Двери');
    const orig = HTMLAnchorElement.prototype.click;
    const opened: string[] = [];
    HTMLAnchorElement.prototype.click = function () {
      opened.push(this.href);
    };
    try {
      await click('KP-КП-2026-16.pdf', layer);
      await flush();
    } finally {
      HTMLAnchorElement.prototype.click = orig;
    }
    expect(calls.some((c) => c.url.includes('/kp/file/link?draftId=80&kind=pdf'))).toBe(true);
    expect(opened).toEqual(['https://opt.test.ru/kp/file?draftId=80&kind=pdf&t=x']);
    await click('✕', layer);
    expect(modal.querySelector('.opt-kp-send-layer')).toBeNull();
  });

  it('КП, отправленное до сохранения копий: данные журнала с пометкой, без текста; копия сохранена — пометки нет', async () => {
    const legacy = { legacy: true, note: 'письмо отправлено до сохранения копий', kpNo: 'КП-2026-16', at: '2026-10-21T07:48:00Z', messageId: null, from: null, to: 'borovova@m-47.ru', cc: null, subject: null, text: null, attachment: { name: 'KP-КП-2026-16.pdf', bytes: null }, attachmentKind: 'pdf', smtp: null, eml: null, copy: { status: 'unknown', folder: null, error: null } };
    const { self } = fakeSelf('lcard', {
      'GET /widget/v1/kp/draft': { draft: draft(), job: null },
      'GET /widget/v1/kp/draft/80/sent-mail': legacy,
    });
    const cbs = createCallbacks(self, 'https://opt.test.ru');
    await act(async () => cbs.render!());
    await flush();
    expect(document.querySelector('.opt-kp-copy-failed')).toBeNull();
    await click('Развернуть ⤢');
    await click('Посмотреть письмо', document.querySelector('.opt-kp-modal')!);
    await flush();
    const layer = document.querySelector('.opt-kp-send-layer')!;
    expect(text(layer.querySelector('.opt-kp-mail-legacy'))).toBe('письмо отправлено до сохранения копий: текст письма и копия не сохранялись, ниже — данные из журнала.');
    expect(text(layer)).toContain('borovova@m-47.ru');
    expect(text(layer.querySelector('.opt-kp-mail-copy .opt-kp-mail-value'))).toBe('неизвестно — письмо отправлено до сохранения копий');
    expect(layer.querySelector('.opt-kp-mail-text')).toBeNull();
  });

  it('у неотправленного КП кнопки нет', async () => {
    const { self } = fakeSelf('lcard', { 'GET /widget/v1/kp/draft': { draft: draft({ status: 'built', sentAt: null }), job: null } });
    const cbs = createCallbacks(self, 'https://opt.test.ru');
    await act(async () => cbs.render!());
    await flush();
    await click('Развернуть ⤢');
    expect(button('Посмотреть письмо')).toBeUndefined();
  });
});

describe('настройки «Письмо»: папка отправленных и «Проверить IMAP» (KP-SENT-COPY)', () => {
  it('поле «Папка отправленных» (пусто — авто); «Проверить IMAP» — найденная папка или причина; пароль не показывается', async () => {
    const settings = {
      model: { provider: 'openai', model: 'gpt-5.5', fallbackModel: null, fallbackProvider: null, effort: 'low', maxTokens: 4096 },
      vision: { provider: 'tesseract', photosToClaude: false, maxFilesPerDay: 100 },
      mail: { imapHost: 'imap.yandex.ru', imapPort: 993, imapSecure: true, smtpHost: 'smtp.yandex.ru', smtpPort: 465, smtpSecure: true, username: 'rf-dveri@yandex.ru', fromName: 'РФ-Двери', fromAddress: '', cc: '', subject: 'КП {kpNo}', text: 'Здравствуйте!', signature: '', sentFolder: '' },
      billing: { usdRubRate: 90, pricing: {} },
    };
    let fail = false;
    const posted: string[] = [];
    const { self } = fakeSelf('settings', {
      'GET /widget/v1/kp/settings': { constants: {}, certsDir: null, numbering: { prefix: 'КП', year: null, counter: 0 }, template: { exists: false, name: null, md5: null, updatedAt: null } },
      'GET /widget/v1/settings': { settings, version: 1 },
      'POST /widget/v1/settings/imap-test': (data?: string) => {
        posted.push(data ?? '');
        return fail ? { ok: false, host: 'imap.yandex.ru:993', username: 'rf-dveri@yandex.ru', error: 'вход rf-dveri@yandex.ru не удался (AUTHENTICATIONFAILED) — проверьте пароль приложения и что в настройках ящика включён доступ по IMAP' } : { ok: true, host: 'imap.yandex.ru:993', username: 'rf-dveri@yandex.ru', folder: 'Sent', how: 'special_use', exists: true, folders: ['INBOX', 'Sent'] };
      },
      'GET /widget/v1/llm/keys': { provider: 'openai', fallbackProvider: 'openai', keys: { openai: { saved: true, mask: 'sk-…ab12', source: 'account' } }, providers: ['openai'] },
      'GET /widget/v1/llm/models': { provider: 'openai', models: [], fetchedAt: null, fromCache: false, source: 'api', noKey: false },
      'GET /widget/v1/journal': { items: [] },
    });
    document.body.innerHTML = '<div id="work-area-opt_agent"></div>';
    const cbs = createCallbacks(self, 'https://opt.test.ru');
    await act(async () => cbs.advancedSettings!());
    await flush();
    await click('Письмо');
    await flush();
    expect(document.body.textContent).toContain('Папка отправленных');
    expect(document.body.textContent).toContain('Пусто — найти автоматически по признаку \\Sent или имени «Отправленные»');
    expect((document.querySelector('input[type=password]') as HTMLInputElement).value).toBe('');
    await click('Проверить IMAP');
    await flush();
    expect(posted).toEqual([JSON.stringify({ sentFolder: '' })]);
    expect(text(document.querySelector('.opt-imap-test'))).toBe('IMAP imap.yandex.ru:993 (rf-dveri@yandex.ru): вход выполнен, папка отправленных — «Sent» (по признаку \\Sent)');
    fail = true;
    await click('Проверить IMAP');
    await flush();
    expect(text(document.querySelector('.opt-imap-test'))).toContain('IMAP imap.yandex.ru:993: вход rf-dveri@yandex.ru не удался (AUTHENTICATIONFAILED) — проверьте пароль приложения');
  });
});
