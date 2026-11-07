// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { amojoAccountId, cardContext, MessengerApi, mountSettings, openComposer, renderComposer, renderHtml, type AmoWidgetSelf, type StatusView } from '../src/index.ts';

const status: StatusView = {
  amojo: { configured: true, connected: false },
  channels: [
    { id: 1, kind: 'telegram_bot', kindText: 'Telegram-бот', title: '<b>@bot</b>', status: 'connected', statusText: 'Подключён', statusDetail: null, createdAt: '' },
    { id: 2, kind: 'telegram_bot', kindText: 'Telegram-бот', title: '@bot2', status: 'error', statusText: 'Ошибка', statusDetail: 'Токен бота недействителен', createdAt: '' },
  ],
};

function fakeSelf(responses: Record<string, unknown>, calls: { url: string; method?: string; data?: string }[]): AmoWidgetSelf {
  return {
    get_settings: () => ({ widget_code: 'rfm' }),
    $authorizedAjax: (o) => {
      calls.push(o);
      const key = `${o.method} ${new URL(o.url).pathname}`;
      return key in responses ? Promise.resolve(responses[key]) : Promise.reject({ status: 500 });
    },
  };
}

describe('виджет РФ-Мессенджер', () => {
  it('статусы каналов, экранирование названий, кнопка подключения amo', () => {
    const html = renderHtml(status);
    expect(html).toContain('&lt;b&gt;@bot&lt;/b&gt;');
    expect(html).not.toContain('<b>@bot</b>');
    expect(html).toContain('Подключён');
    expect(html).toContain('Токен бота недействителен');
    expect(html).toContain('data-rfm="connect"');
    expect(renderHtml({ ...status, amojo: { configured: false, connected: false } })).toContain('ещё не зарегистрирован');
  });

  it('amojo_id берётся из констант amo', () => {
    const w = { APP: { constant: (n: string) => (n === 'account' ? { amojo_id: 'abc' } : null) } } as unknown as Window;
    expect(amojoAccountId(w)).toBe('abc');
    expect(amojoAccountId({} as Window)).toBeNull();
  });

  it('подключение бота: токен уходит в API и стирается из поля', async () => {
    const calls: { url: string; method?: string; data?: string }[] = [];
    const api = new MessengerApi(fakeSelf({ 'GET /widget/v1/status': status, 'POST /widget/v1/channels': { id: 3 } }, calls), 'https://chat.example.ru');
    const el = document.createElement('div');
    document.body.appendChild(el);
    await mountSettings(el, api);
    const input = el.querySelector<HTMLInputElement>('input[name=token]')!;
    input.value = ' 123:ABC ';
    el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('https://chat.example.ru/widget/v1/channels');
    expect(JSON.parse(post.data!)).toEqual({ kind: 'telegram_bot', token: '123:ABC' });
    expect(el.textContent).toContain('Бот подключён');
    expect(el.querySelector<HTMLInputElement>('input[name=token]')!.value).toBe('');
  });

  it('ошибка сервиса показывается текстом', async () => {
    const api = new MessengerApi(fakeSelf({}, []), 'https://chat.example.ru');
    const el = document.createElement('div');
    await mountSettings(el, api);
    expect(el.textContent).toContain('Сервис мессенджеров недоступен (HTTP 500)');
  });

  it('WhatsApp: кнопка подключения, «Показать QR» до входа, QR из ответа сервера', async () => {
    const wa: StatusView = {
      amojo: { configured: true, connected: true },
      channels: [{ id: 7, kind: 'whatsapp', kindText: 'WhatsApp', title: 'WhatsApp (ожидает QR)', status: 'starting', statusText: 'Подключается…', statusDetail: null, createdAt: '' }],
    };
    const html = renderHtml(wa);
    expect(html).toContain('data-rfm="add-wa"');
    expect(html).toContain('data-rfm="qr" data-id="7"');
    expect(renderHtml({ ...wa, channels: [{ ...wa.channels[0]!, status: 'connected' }] })).not.toContain('data-rfm="qr"');

    const calls: { url: string; method?: string; data?: string }[] = [];
    const self = fakeSelf(
      {
        'GET /widget/v1/status': wa,
        'POST /widget/v1/channels': { id: 7 },
        'GET /widget/v1/channels/7/qr': { status: 'starting', statusText: 'Подключается…', statusDetail: null, title: 'WhatsApp (ожидает QR)', svg: '<svg data-test="qr"></svg>' },
      },
      calls,
    );
    const el = document.createElement('div');
    await mountSettings(el, new MessengerApi(self, 'https://chat.example.ru'));
    el.querySelector<HTMLElement>('[data-rfm="add-wa"]')!.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.some((c) => c.method === 'POST' && JSON.parse(c.data ?? '{}').kind === 'whatsapp')).toBe(true);
    expect(el.querySelector('[data-test="qr"]')).not.toBeNull();
  });
});

describe('написать первым', () => {
  const view = {
    channels: [
      { id: 3, kind: 'whatsapp', kindText: 'WhatsApp', title: 'WhatsApp +79295418663', connected: true },
      { id: 4, kind: 'telegram_user', kindText: 'Telegram', title: '<i>tg</i>', connected: false },
    ],
    contacts: [{ id: 1, name: 'Иван', phones: ['+7 936 147-23-24'] }],
  };

  it('карточка: сделка или контакт по области виджета', () => {
    const w = { APP: { data: { current_card: { id: 90535 } } } } as unknown as Window;
    const self = (area: string) => ({ get_settings: () => ({ widget_code: 'x' }), $authorizedAjax: () => Promise.resolve(), system: () => ({ area }) }) as AmoWidgetSelf;
    expect(cardContext(self('lcard'), w)).toEqual({ leadId: 90535 });
    expect(cardContext(self('ccard'), w)).toEqual({ contactId: 90535 });
    expect(cardContext(self('settings'), w)).toBeNull();
  });

  it('окно: неподключённый канал недоступен, названия экранируются, номер из контакта', () => {
    const html = renderComposer(view, { channelId: 3, contactId: 1, phone: '+7 936 147-23-24' });
    expect(html).toContain('Не подключён');
    expect(html).not.toContain('<i>tg</i>');
    expect(html).toMatch(/data-id="4" aria-pressed="false" disabled/);
    expect(html).toContain('+7 936 147-23-24 — Иван');
  });

  it('отправка: без текста — подсказка, с текстом — запрос и сообщение об успехе', async () => {
    const calls: { url: string; method?: string; data?: string }[] = [];
    const api = new MessengerApi(fakeSelf({ 'GET /widget/v1/compose': view, 'POST /widget/v1/chats/start': { chatId: 1, messageId: 2 } }, calls), 'https://chat.example.ru');
    await openComposer(api, { leadId: 90535 });
    const overlay = document.querySelector<HTMLElement>('.rfm-overlay')!;
    expect(calls[0]!.url).toBe('https://chat.example.ru/widget/v1/compose?leadId=90535');
    overlay.querySelector<HTMLElement>('[data-rfm="send"]')!.click();
    expect(overlay.textContent).toContain('Введите текст');
    const ta = overlay.querySelector<HTMLTextAreaElement>('textarea')!;
    ta.value = 'Добрый день';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    overlay.querySelector<HTMLElement>('[data-rfm="send"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(calls.at(-1)!.data!)).toEqual({ channelId: 3, contactId: 1, phone: '+7 936 147-23-24', text: 'Добрый день' });
    expect(overlay.textContent).toContain('Сообщение отправлено');
    overlay.remove();
  });
});

it('кнопка в карточке подписана «Написать», шапка — «Rf Messenger»', async () => {
  const { renderCardPanel } = await import('../src/index.ts');
  const html = renderCardPanel();
  expect(html).toMatch(/data-rfm="first">.*Написать<\/button>/);
  expect(html).not.toContain('Написать первым');
  expect(html).toContain("content:'Rf Messenger'");
});

describe('этап 4: MAX, VK, Авито', () => {
  const base: StatusView = { amojo: { configured: true, connected: true }, channels: [] };

  it('плитки MAX, VK и Авито вместо «Скоро»; у каждой — своя форма, ключи — поля password', () => {
    const html = renderHtml(base);
    expect(html).not.toContain('Скоро');
    for (const kind of ['max', 'vk', 'avito']) expect(html).toContain(`data-rfm="show-form" data-kind="${kind}"`);
    expect(html).toMatch(/form data-rfm="add-key" data-kind="vk"[\s\S]*name="groupId"[\s\S]*type="password" name="token"/);
    expect(html).toMatch(/data-kind="avito"[\s\S]*type="text" name="clientId"[\s\S]*type="password" name="clientSecret"/);
  });

  it('подключение VK: id сообщества и ключ уходят в API, ключ стирается из поля', async () => {
    const calls: { url: string; method?: string; data?: string }[] = [];
    const api = new MessengerApi(fakeSelf({ 'GET /widget/v1/status': base, 'POST /widget/v1/channels': { id: 3 } }, calls), 'https://chat.example.ru');
    const el = document.createElement('div');
    document.body.appendChild(el);
    await mountSettings(el, api);
    el.querySelector<HTMLElement>('[data-rfm="show-form"][data-kind="vk"]')!.click();
    const form = el.querySelector<HTMLFormElement>('form[data-kind="vk"]')!;
    expect(form.style.display).toBe('flex');
    expect(el.querySelector<HTMLFormElement>('form[data-kind="max"]')!.style.display).toBe('none');
    (form.elements.namedItem('groupId') as HTMLInputElement).value = ' 123 ';
    (form.elements.namedItem('token') as HTMLInputElement).value = 'vk-key';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(calls.find((c) => c.method === 'POST')!.data!)).toEqual({ kind: 'vk', groupId: '123', token: 'vk-key' });
    expect(el.textContent).toContain('Сообщество VK подключено');
    el.remove();
  });

  it('статусы каналов MAX/VK/Авито с текстом ошибки', () => {
    const html = renderHtml({
      ...base,
      channels: [
        { id: 1, kind: 'max', kindText: 'MAX', title: '@rfd_bot', status: 'connected', statusText: 'Подключён', statusDetail: null, createdAt: '' },
        { id: 2, kind: 'vk', kindText: 'VK', title: 'РФ-Двери', status: 'error', statusText: 'Ошибка', statusDetail: 'VK не принял ключ доступа сообщества', createdAt: '' },
      ],
    });
    expect(html).toContain('rfm-ico rfm-max');
    expect(html).toContain('VK не принял ключ доступа сообщества');
    expect(html).not.toContain('data-rfm="qr"');
  });

  it('«Написать»: для VK — выбор из тех, кто уже писал; отправка с chatId', async () => {
    const view = {
      channels: [
        { id: 3, kind: 'whatsapp', kindText: 'WhatsApp', title: 'WA', connected: true },
        { id: 5, kind: 'vk', kindText: 'VK', title: 'РФ-Двери', connected: true, byChat: true, chats: [{ id: 11, title: '<b>Иван</b>' }] },
        { id: 6, kind: 'max', kindText: 'MAX', title: '@bot', connected: true, byChat: true, chats: [] },
      ],
      contacts: [{ id: 1, name: 'Иван', phones: ['+7 936 147-23-24'] }],
    };
    expect(renderComposer(view, { channelId: 5 })).toContain('&lt;b&gt;Иван&lt;/b&gt;');
    expect(renderComposer(view, { channelId: 5 })).not.toContain('name="phone"');
    expect(renderComposer(view, { channelId: 6 })).toContain('ещё никто не писал');
    expect(renderComposer(view, { channelId: 3 })).toContain('name="phone"');

    const calls: { url: string; method?: string; data?: string }[] = [];
    const api = new MessengerApi(fakeSelf({ 'GET /widget/v1/compose': view, 'POST /widget/v1/chats/start': { chatId: 11, messageId: 2 } }, calls), 'https://chat.example.ru');
    await openComposer(api, { leadId: 1 });
    const overlay = document.querySelector<HTMLElement>('.rfm-overlay')!;
    overlay.querySelector<HTMLElement>('[data-rfm="pick-channel"][data-id="5"]')!.click();
    const ta = overlay.querySelector<HTMLTextAreaElement>('textarea')!;
    ta.value = 'Добрый день';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    overlay.querySelector<HTMLElement>('[data-rfm="send"]')!.click();
    expect(overlay.textContent).toContain('Выберите клиента');
    const sel = overlay.querySelector<HTMLSelectElement>('select[name=chat]')!;
    sel.value = '11';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    overlay.querySelector<HTMLElement>('[data-rfm="send"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(calls.at(-1)!.data!)).toEqual({ channelId: 5, contactId: 1, chatId: 11, text: 'Добрый день' });
    overlay.remove();
  });
});
