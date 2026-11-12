// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ChatApi, chatListHtml, dayLabel, findRightColumn, messagesHtml, openChatWindow, placeWindow, statusMark, templatesPopoverHtml, type ChatsView, type MessageView } from '../src/chat.ts';
import { MessengerApi, type AmoWidgetSelf } from '../src/index.ts';
import { filterTemplates, groupByFolder, renderTemplate, slashQuery, unresolvedVariables, type TemplateView } from '../src/templates.ts';

const NOW = new Date('2026-11-07T12:00:00+03:00');
const msg = (over: Partial<MessageView>): MessageView => ({
  id: 1,
  direction: 'in',
  source: 'client',
  kind: 'text',
  text: 'Здравствуйте',
  at: '2026-11-07T09:30:00Z',
  status: 'received',
  error: null,
  senderName: null,
  author: null,
  fromHistory: false,
  file: null,
  replyTo: null,
  ...over,
});

describe('шаблоны: переменные и поиск', () => {
  const ctx = { client: 'Иван', manager: 'Мария', leadId: 30053436, budget: 25000, fields: { 'Дата доставки': '15.11.2026' } };

  it('подставляет имя клиента, менеджера, номер сделки, бюджет и поле сделки; пустые остаются и помечаются', () => {
    const r = renderTemplate('{имя_клиента}, это {имя_менеджера}. Сделка {номер_сделки}, бюджет {бюджет}, доставка {поле:дата доставки}, {поле:Адрес}', ctx);
    expect(r.text).toBe('Иван, это Мария. Сделка 30053436, бюджет 25 000 ₽, доставка 15.11.2026, {поле:Адрес}');
    expect(r.missing).toEqual(['{поле:Адрес}']);
    expect(renderTemplate('Привет, {имя_клиента}!', null)).toEqual({ text: 'Привет, {имя_клиента}!', missing: ['{имя_клиента}'] });
    expect(renderTemplate('Бюджет {бюджет}', { ...ctx, budget: null }).missing).toEqual(['{бюджет}']);
    expect(unresolvedVariables('ок {бюджет} и {бюджет} и {что-то}')).toEqual(['{бюджет}']);
  });

  it('поиск по названию, папке и тексту; группировка по папкам, «Без папки» в конце; режим «/»', () => {
    const list: TemplateView[] = [
      { id: 1, title: 'Замер', text: 'Приедем на замер', folder: 'Замер', attachments: [], shared: true, useCount: 5 },
      { id: 2, title: 'Счёт', text: 'Отправляю счёт', folder: 'Оплата', attachments: [], shared: false, useCount: 1 },
      { id: 3, title: 'Спасибо', text: 'Спасибо за заказ', folder: '', attachments: [], shared: true, useCount: 0 },
    ];
    expect(filterTemplates(list, 'зам').map((t) => t.id)).toEqual([1]);
    expect(filterTemplates(list, 'ОПЛАТА счёт').map((t) => t.id)).toEqual([2]);
    expect(filterTemplates(list, '').map((t) => t.id)).toEqual([1, 2, 3]);
    expect(groupByFolder(list).map((g) => g.folder)).toEqual(['Замер', 'Оплата', 'Без папки']);
    expect(slashQuery('/зам')).toBe('зам');
    expect(slashQuery('/')).toBe('');
    expect(slashQuery('текст /зам')).toBeNull();
    const html = templatesPopoverHtml(list, 'с', 1);
    expect(html).toContain('data-id="2" data-idx="0"');
    expect(html).toContain('rfm-cw-pop-on');
    expect(templatesPopoverHtml([], '', 0)).toContain('Шаблонов пока нет');
  });
});

describe('лента сообщений', () => {
  it('разделители дат, стороны, имя менеджера, статусы, цитата, кнопка «Повторить»', () => {
    const list = [
      msg({ id: 1, at: '2026-11-05T09:00:00Z', text: 'Старое' }),
      msg({ id: 2, at: '2026-11-06T09:00:00Z', direction: 'out', source: 'amo', senderName: 'Мария', status: 'read', text: 'Ответ' }),
      msg({ id: 3, at: '2026-11-07T08:00:00Z', direction: 'out', source: 'amo', status: 'failed', error: 'сеть', text: 'Не дошло', replyTo: { id: 1, text: 'Старое', kind: 'text', direction: 'in', senderName: null } }),
      msg({ id: 4, at: '2026-11-07T08:05:00Z', kind: 'picture', text: '', file: { id: 'f', name: 'a.jpg', mime: 'image/jpeg', size: 10, url: 'https://chat.example.ru/f/x' } }),
      msg({ id: 5, at: '2026-11-07T08:06:00Z', kind: 'voice', text: '', file: { id: 'v', name: 'v.ogg', mime: 'audio/ogg', size: 10, url: 'https://chat.example.ru/f/v' }, author: { id: '7', name: 'Ольга' } }),
    ];
    const html = messagesHtml(list, { now: NOW, isGroup: true });
    expect(html.match(/rfm-cw-day/g)).toHaveLength(3);
    expect(html).toContain('5 ноября');
    expect(html).toContain('Вчера');
    expect(html).toContain('Сегодня');
    expect(html).toContain('rfm-cw-out');
    expect(html).toContain('<div class="rfm-cw-who">Мария</div>');
    expect(html).toContain('rfm-cw-st-read');
    // Время и галочки внутри пузыря: у текста — место под них, у вложения без текста — отдельной строкой.
    expect(html).toContain('Ответ<span class="rfm-cw-sp rfm-cw-sp-st" aria-hidden="true"></span>');
    expect(html).toContain('Старое<span class="rfm-cw-sp" aria-hidden="true"></span>');
    expect(html.match(/rfm-cw-meta rfm-cw-meta-block/g)).toHaveLength(2);
    expect(html).toContain('data-cw="retry" data-id="3"');
    expect(html).toContain('rfm-cw-quote');
    expect(html).toContain('<img src="https://chat.example.ru/f/x"');
    expect(html).toContain('<audio src="https://chat.example.ru/f/v"');
    expect(html).toContain('<div class="rfm-cw-who">Ольга</div>');
    expect(dayLabel('2025-01-03T10:00:00Z', NOW)).toBe('3 января 2025');
    expect(statusMark({ direction: 'out', source: 'phone', status: 'synced' }).title).toBe('Отправлено');
    expect(statusMark({ direction: 'in', source: 'client', status: 'received' }).text).toBe('');
  });

  it('ссылки кликабельны, HTML экранируется', () => {
    const html = messagesHtml([msg({ text: '<b>x</b> https://rf-dveri.ru/a?b=1' })], { now: NOW });
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('<a href="https://rf-dveri.ru/a?b=1"');
  });

  it('список чатов: канал, непрочитанные, последнее сообщение', () => {
    const html = chatListHtml(
      [
        { id: 1, channelId: 1, kind: 'whatsapp', kindText: 'WhatsApp', channelTitle: 'WA', channelConnected: true, title: 'Иван', isGroup: false, contact: { phone: '+79361472324' }, unread: 2, lastAt: '2026-11-07T08:00:00Z', last: { text: 'Жду', kind: 'text', direction: 'in' }, historyAvailable: true },
        { id: 2, channelId: 2, kind: 'telegram_bot', kindText: 'Telegram-бот', channelTitle: '@bot', channelConnected: true, title: 'Иван', isGroup: false, contact: { username: 'ivan' }, unread: 0, lastAt: '2026-11-06T08:00:00Z', last: null, historyAvailable: false },
      ],
      2,
    );
    expect(html).toContain('rfm-cw-unread">2<');
    expect(html).toContain('+79361472324');
    expect(html).toContain('@ivan');
    expect(html).toMatch(/data-id="2"[^>]*|rfm-cw-item-on/);
    expect(chatListHtml([], null)).toContain('пока нет');
  });
});

function fakeSelf(responses: Record<string, unknown | ((data?: string) => unknown)>, calls: { url: string; method?: string; data?: string }[]): AmoWidgetSelf {
  return {
    get_settings: () => ({ widget_code: 'rfm' }),
    $authorizedAjax: (o) => {
      calls.push(o);
      const key = `${o.method} ${new URL(o.url).pathname}`;
      const r = responses[key];
      if (r === undefined) return Promise.reject({ status: 404, responseJSON: { error: `нет ответа для ${key}` } });
      return Promise.resolve(typeof r === 'function' ? (r as (d?: string) => unknown)(o.data) : r);
    },
  };
}

const chatsView: ChatsView = {
  me: { userId: 7, isAdmin: false },
  lead: { id: 30053436, name: 'Дверь', price: 25000 },
  contacts: [{ id: 77, name: 'Иван Петров', phones: ['+7 936 147-23-24'] }],
  chats: [
    { id: 11, channelId: 1, kind: 'whatsapp', kindText: 'WhatsApp', channelTitle: 'WA', channelConnected: true, title: 'Иван Петров', isGroup: false, contact: { phone: '+79361472324' }, unread: 1, lastAt: '2026-11-07T08:00:00Z', last: { text: 'Жду', kind: 'text', direction: 'in' }, historyAvailable: true },
    { id: 12, channelId: 2, kind: 'telegram_bot', kindText: 'Telegram-бот', channelTitle: '@bot', channelConnected: true, title: 'Иван Петров', isGroup: false, contact: { username: 'ivan' }, unread: 0, lastAt: '2026-11-01T08:00:00Z', last: null, historyAvailable: false },
  ],
  startChannels: [],
};

describe('окно переписки', () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it('открывается поверх правой колонки, показывает последний активный чат, открытие НЕ помечает прочитанным, Esc закрывает', async () => {
    document.body.innerHTML = '<div class="card-holder"><div class="card-holder__left" style="width:400px">поля</div><div class="card-holder__right" style="width:600px;height:500px">лента</div></div>';
    const calls: { url: string; method?: string; data?: string }[] = [];
    const self = fakeSelf(
      {
        'GET /chat/v1/chats': chatsView,
        'GET /chat/v1/chats/11/messages': { messages: [msg({ id: 1, text: 'Привет' }), msg({ id: 2, direction: 'out', source: 'phone', senderName: 'Мария', status: 'sent', text: 'Добрый день' })], hasMore: false },
        'POST /chat/v1/chats/11/read': { ok: true },
        'POST /chat/v1/session': { token: 'a'.repeat(48) },
      },
      calls,
    );
    const api = new MessengerApi(self, 'https://chat.example.ru');
    const chat = new ChatApi(api, 'https://chat.example.ru');
    const close = await openChatWindow(chat, { ctx: { leadId: 30053436 } });
    await tick();
    const win = document.querySelector<HTMLElement>('.rfm-cw')!;
    expect(win).not.toBeNull();
    expect(win.querySelector('[data-cw-title]')!.textContent).toContain('Иван Петров');
    expect(win.querySelectorAll('.rfm-cw-msg')).toHaveLength(2);
    expect(win.querySelector('.rfm-cw-who')!.textContent).toBe('Мария');
    // Правило счётчиков: открытие ничего не меняет — /read не вызывается.
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/chats/11/read'))).toBe(false);
    // ☰ — список чатов контакта.
    win.querySelector<HTMLElement>('[data-cw="list"]')!.click();
    expect(win.querySelectorAll('[data-cw="open"]')).toHaveLength(2);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(win.querySelector('.rfm-cw-drawer')).toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.rfm-cw')).toBeNull();
    close();
  });

  it('«/» показывает шаблоны с подстановкой переменных, Enter отправляет; ответ на сообщение уходит с replyToMessageId', async () => {
    document.body.innerHTML = '';
    const calls: { url: string; method?: string; data?: string }[] = [];
    const self = fakeSelf(
      {
        'GET /chat/v1/chats': chatsView,
        'GET /chat/v1/chats/11/messages': { messages: [msg({ id: 1, text: 'Привет' })], hasMore: false },
        'POST /chat/v1/chats/11/read': { ok: true },
        'POST /chat/v1/session': { token: 'a'.repeat(48) },
        'GET /chat/v1/templates': { templates: [{ id: 5, title: 'Замер', text: 'Здравствуйте, {имя_клиента}! Это {имя_менеджера}, бюджет {бюджет}', folder: 'Замер', attachments: [], shared: true, useCount: 1 }] },
        'GET /chat/v1/templates/context': { client: 'Иван', manager: 'Мария', leadId: 30053436, budget: null, fields: {} },
        'POST /chat/v1/templates/5/used': { ok: true },
        'POST /chat/v1/chats/11/messages': (data?: string) => ({ messages: [msg({ id: 9, direction: 'out', source: 'phone', text: JSON.parse(data ?? '{}').text, status: 'sent' })] }),
      },
      calls,
    );
    const chat = new ChatApi(new MessengerApi(self, 'https://chat.example.ru'), 'https://chat.example.ru');
    await openChatWindow(chat, { ctx: { leadId: 30053436 } });
    await tick();
    const win = document.querySelector<HTMLElement>('.rfm-cw')!;
    const ta = win.querySelector<HTMLTextAreaElement>('[data-cw-ta]')!;
    ta.value = '/зам';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    await tick();
    expect(win.querySelector('[data-cw="tpl"]')).not.toBeNull();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    expect(ta.value).toBe('Здравствуйте, Иван! Это Мария, бюджет {бюджет}');
    expect(win.querySelector('[data-cw-warn]')!.textContent).toContain('{бюджет}');
    ta.value = 'Здравствуйте, Иван!';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(win.querySelector('[data-cw-warn]')!.textContent).toBe('');
    win.querySelector<HTMLElement>('[data-cw="reply"][data-id="1"]')!.click();
    expect(win.querySelector('.rfm-cw-replybar')).not.toBeNull();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    await tick();
    const sent = calls.find((c) => c.method === 'POST' && c.url.endsWith('/chats/11/messages'))!;
    expect(JSON.parse(sent.data!)).toEqual({ text: 'Здравствуйте, Иван!', replyToMessageId: 1, fileIds: [] });
    expect(win.querySelectorAll('.rfm-cw-msg')).toHaveLength(2);
    expect(ta.value).toBe('');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });

  it('без чатов — экран «Написать» с выбором канала и номера из контакта', async () => {
    document.body.innerHTML = '';
    const self = fakeSelf(
      {
        'GET /chat/v1/chats': { ...chatsView, chats: [], startChannels: [{ id: 3, kind: 'whatsapp', kindText: 'WhatsApp', title: 'WA', connected: true }] },
        'POST /chat/v1/session': { token: 'a'.repeat(48) },
      },
      [],
    );
    const chat = new ChatApi(new MessengerApi(self, 'https://chat.example.ru'), 'https://chat.example.ru');
    await openChatWindow(chat, { ctx: { contactId: 77 } });
    await tick();
    const win = document.querySelector<HTMLElement>('.rfm-cw')!;
    expect(win.querySelector('[data-rfm="pick-channel"]')).not.toBeNull();
    expect(win.querySelector('select[name=phone]')!.textContent).toContain('+7 936 147-23-24');
    expect(win.querySelector<HTMLElement>('[data-cw-foot]')!.style.display).toBe('none');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });

  it('положение: над правой колонкой карточки, иначе — правые 58 % экрана', () => {
    document.body.innerHTML = '<div class="card-holder__right"></div>';
    const col = document.querySelector<HTMLElement>('.card-holder__right')!;
    col.getBoundingClientRect = () => ({ left: 500, top: 60, width: 800, height: 700, right: 1300, bottom: 760, x: 500, y: 60, toJSON: () => ({}) });
    expect(findRightColumn(document)).toBe(col);
    const w = { innerWidth: 1400, innerHeight: 900 } as Window;
    const el = document.createElement('div');
    placeWindow(el, col, w);
    expect(el.style.left).toBe('500px');
    expect(el.style.width).toBe('800px');
    expect(el.style.height).toBe('700px');
    placeWindow(el, null, w);
    expect(el.style.left).toBe('588px');
    expect(el.style.height).toBe('900px');
  });
});
