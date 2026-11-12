// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ChatListItem, ChatsView } from '../src/chat.ts';
import { ChatApi } from '../src/chat.ts';
import { chatRowHtml, inboxHeaderTitle, lastPreview, mountInbox, rowTime } from '../src/inbox.ts';
import { INBOX_MENU_CODE, MessengerApi, createCallbacks, inboxHost, setMenuBadge, type AmoWidgetSelf } from '../src/index.ts';

const NOW = new Date('2026-11-07T12:00:00+03:00');
const row = (over: Partial<ChatListItem>): ChatListItem => ({
  id: 1,
  channelId: 1,
  kind: 'whatsapp',
  kindText: 'WhatsApp',
  channelTitle: 'WA · 2324',
  channelConnected: true,
  title: 'Иван Петров',
  isGroup: false,
  contact: { phone: '+79361472324' },
  unread: 0,
  unanswered: 0,
  answered: 0,
  pinned: false,
  lastAt: '2026-11-07T08:00:00Z',
  last: { text: 'Жду замер', kind: 'text', direction: 'in' },
  historyAvailable: true,
  ...over,
});

type Calls = { url: string; method?: string; data?: string }[];
function fakeSelf(responses: Record<string, unknown | ((data?: string, url?: URL) => unknown)>, calls: Calls): AmoWidgetSelf & { badge: (number | string)[] } {
  const badge: (number | string)[] = [];
  return {
    badge,
    get_settings: () => ({ widget_code: 'rfm' }),
    system: () => ({ area: INBOX_MENU_CODE }),
    set_badge: (n) => void badge.push(n),
    $authorizedAjax: (o) => {
      calls.push(o);
      const u = new URL(o.url);
      const key = `${o.method} ${u.pathname}`;
      const r = responses[key];
      if (r === undefined) return Promise.reject({ status: 404, responseJSON: { error: `нет ответа для ${key}` } });
      // Как по сети: каждый ответ — отдельная копия, а не общие объекты.
      return Promise.resolve(JSON.parse(JSON.stringify(typeof r === 'function' ? (r as (d?: string, u?: URL) => unknown)(o.data, u) : r)));
    },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('строки списка', () => {
  it('красный счётчик — неотвеченные, серый — закрытые, без счётчика — ничего; группа помечена', () => {
    const red = chatRowHtml(row({ unanswered: 3, answered: 0 }), null, NOW);
    expect(red).toContain('rfm-ib-red">3<');
    expect(red).not.toContain('rfm-ib-grey');
    const grey = chatRowHtml(row({ unanswered: 0, answered: 2 }), null, NOW);
    expect(grey).toContain('rfm-ib-grey">2<');
    expect(grey).not.toContain('rfm-ib-red');
    expect(chatRowHtml(row({}), null, NOW)).not.toContain('rfm-ib-cnt');
    const grp = chatRowHtml(row({ isGroup: true, title: 'Монтажники' }), null, NOW);
    expect(grp).toContain('rfm-ib-grp');
    expect(chatRowHtml(row({ pinned: true }), 1, NOW)).toContain('rfm-ib-pinned');
    expect(chatRowHtml(row({ title: '<b>' }), null, NOW)).toContain('&lt;b&gt;');
  });

  it('превью: файл — значок и имя; «Вы:» для исходящих; время сегодня/вчера/дата', () => {
    expect(lastPreview(row({ last: { text: '', kind: 'picture', direction: 'in', fileName: 'door.jpg' } }))).toBe('🖼 door.jpg');
    expect(lastPreview(row({ last: { text: 'Готово', kind: 'text', direction: 'out' } }))).toBe('Вы: Готово');
    expect(rowTime('2026-11-07T08:00:00Z', NOW)).toMatch(/^\d\d:\d\d$/);
    expect(rowTime('2026-11-06T08:00:00Z', NOW)).toBe('Вчера');
    expect(rowTime('2026-10-20T08:00:00Z', NOW)).not.toMatch(/Вчера|^\d\d:\d\d$/);
  });

  it('заголовок: один канал — его имя, несколько — «Все каналы», выбранный — его имя', () => {
    const ch = [
      { id: 1, kind: 'whatsapp', kindText: 'WhatsApp', title: 'WhatsApp · 2324', connected: true },
      { id: 2, kind: 'max_phone', kindText: 'MAX', title: 'MAX · 0011', connected: true },
    ];
    expect(inboxHeaderTitle(ch, null)).toBe('Все каналы · 2');
    expect(inboxHeaderTitle(ch, 2)).toBe('MAX · 0011');
    expect(inboxHeaderTitle([ch[0]!], null)).toBe('WhatsApp · 2324');
  });
});

describe('раздел «Rf Messenger»', () => {
  const list = [row({ id: 11, unanswered: 2, lastAt: '2026-11-07T08:00:00Z' }), row({ id: 12, title: 'Монтажники', isGroup: true, answered: 1, lastAt: '2026-11-07T07:00:00Z' }), row({ id: 13, title: 'Ольга', lastAt: '2026-11-06T07:00:00Z' })];
  const view = (id: number): ChatsView => ({ me: { userId: 7, isAdmin: true }, lead: null, contacts: [], chats: list.filter((c) => c.id === id), startChannels: [] });
  const responses = (calls: Calls, extra: Record<string, unknown> = {}) => ({
    'GET /inbox/v1/channels': { channels: [{ id: 1, kind: 'whatsapp', kindText: 'WhatsApp', title: 'WhatsApp · 2324', connected: true }] },
    'GET /inbox/v1/chats': (_d?: string, u?: URL) => {
      const f = u?.searchParams.get('filter');
      const q = u?.searchParams.get('q') ?? '';
      let chats = list;
      if (f === 'unanswered') chats = list.filter((c) => (c.unanswered ?? 0) > 0);
      if (q) chats = list.filter((c) => c.title.includes(q));
      return { me: { userId: 7, isAdmin: true }, chats, hasMore: false, unansweredChats: 1 };
    },
    'GET /inbox/v1/counters': { unansweredChats: 1 },
    'POST /chat/v1/session': { token: 'a'.repeat(48) },
    'GET /chat/v1/chats': (_d?: string, u?: URL) => view(Number(u?.searchParams.get('chatId'))),
    'GET /chat/v1/chats/11/messages': { messages: [{ id: 1, direction: 'in', source: 'client', kind: 'text', text: 'Жду замер', at: '2026-11-07T08:00:00Z', status: 'received', error: null, senderName: null, author: null, fromHistory: false, file: null, replyTo: null }], hasMore: false },
    'POST /chat/v1/chats/11/messages': { messages: [{ id: 2, direction: 'out', source: 'amo', kind: 'text', text: 'Едем', at: '2026-11-07T08:05:00Z', status: 'sent', error: null, senderName: 'Мария', author: null, fromHistory: false, file: null, replyTo: null }] },
    'POST /inbox/v1/chats/11/no-reply': { ok: true, answered: 2, unansweredChats: 0 },
    'POST /inbox/v1/chats/13/pin': { ok: true },
    ...extra,
  });

  it('список: фильтры и поиск уходят в API, открытие чата НЕ вызывает /read и не меняет счётчик', async () => {
    document.body.innerHTML = '<div id="host"></div>';
    const calls: Calls = [];
    const self = fakeSelf(responses(calls), calls);
    const chat = new ChatApi(new MessengerApi(self, 'https://chat.example.ru'), 'https://chat.example.ru');
    const host = document.getElementById('host') as HTMLElement;
    const badges: number[] = [];
    const stop = await mountInbox(chat, host, { onBadge: (n) => badges.push(n) });
    expect(host.querySelectorAll('.rfm-ib-row')).toHaveLength(3);
    expect(host.querySelector('[data-ib-title]')!.textContent).toBe('WhatsApp · 2324');
    expect(badges).toEqual([1]);

    host.querySelector<HTMLElement>('[data-ib="filter"][data-f="unanswered"]')!.click();
    await tick();
    expect(host.querySelectorAll('.rfm-ib-row')).toHaveLength(1);
    expect(calls.at(-1)!.url).toContain('filter=unanswered');
    host.querySelector<HTMLElement>('[data-ib="filter"][data-f="all"]')!.click();
    await tick();

    const q = host.querySelector<HTMLInputElement>('[data-ib-q]')!;
    q.value = 'Ольга';
    q.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 350));
    expect(host.querySelectorAll('.rfm-ib-row')).toHaveLength(1);
    expect(decodeURIComponent(calls.at(-1)!.url)).toContain('q=Ольга');
    q.value = '';
    q.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 350));

    host.querySelector<HTMLElement>('.rfm-ib-row[data-id="11"]')!.click();
    await tick();
    await tick();
    expect(calls.some((c) => c.url.includes('/read'))).toBe(false);
    expect(host.querySelector('.rfm-ib-row[data-id="11"] .rfm-ib-red')!.textContent).toBe('2');
    // Встроенное окно: красная кнопка «Отвечать не нужно» с числом неотвеченных.
    const btn = host.querySelector<HTMLElement>('[data-cw="noreply"]')!;
    expect(btn.textContent).toContain('2');
    btn.click();
    await tick();
    expect(calls.some((c) => c.url.endsWith('/inbox/v1/chats/11/no-reply'))).toBe(true);
    expect(host.querySelector('[data-cw="noreply"]')).toBeNull();
    expect(host.querySelector('.rfm-ib-row[data-id="11"] .rfm-ib-grey')!.textContent).toBe('2');
    expect(host.querySelector('.rfm-ib-row[data-id="11"] .rfm-ib-red')).toBeNull();
    expect(badges.at(-1)).toBe(0);
    stop();
  });

  it('ответ из раздела закрывает неотвеченные (серый счётчик); меню строки: закрепить', async () => {
    document.body.innerHTML = '<div id="host"></div>';
    const calls: Calls = [];
    const self = fakeSelf(responses(calls), calls);
    const chat = new ChatApi(new MessengerApi(self, 'https://chat.example.ru'), 'https://chat.example.ru');
    const host = document.getElementById('host') as HTMLElement;
    const stop = await mountInbox(chat, host);
    host.querySelector<HTMLElement>('.rfm-ib-row[data-id="11"]')!.click();
    await tick();
    await tick();
    const ta = host.querySelector<HTMLTextAreaElement>('[data-cw-ta]')!;
    ta.value = 'Едем';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    await tick();
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/chat/v1/chats/11/messages'))).toBe(true);
    expect(host.querySelector('[data-cw="noreply"]')).toBeNull();
    expect(host.querySelector('.rfm-ib-row[data-id="11"] .rfm-ib-grey')!.textContent).toBe('2');

    host.querySelector<HTMLElement>('[data-ib="row-menu"][data-id="13"]')!.click();
    expect(host.querySelector('.rfm-ib-menu')!.textContent).toContain('Закрепить');
    host.querySelector<HTMLElement>('[data-ib="row-pin"][data-id="13"]')!.click();
    await tick();
    const pin = calls.find((c) => c.url.endsWith('/chats/13/pin'))!;
    expect(JSON.parse(pin.data!)).toEqual({ pinned: true });
    stop();
  });

  it('render в области раздела монтирует страницу; init ставит значок меню через set_badge', async () => {
    document.body.innerHTML = '<div id="work-area-rfm"></div>';
    const calls: Calls = [];
    const self = fakeSelf(responses(calls), calls);
    const cb = createCallbacks(self, 'https://chat.example.ru');
    cb.init?.();
    cb.render?.();
    await tick();
    await tick();
    expect(document.querySelector('#work-area-rfm .rfm-ib')).not.toBeNull();
    expect(self.badge).toContain(1);
    cb.destroy?.();
  });

  it('без set_badge значок рисуется у ссылки раздела; без рабочей области — свой контейнер', () => {
    document.body.innerHTML = `<a href="/widgets/${INBOX_MENU_CODE}">Rf Messenger</a>`;
    const self = { get_settings: () => ({ widget_code: 'rfm' }), $authorizedAjax: () => Promise.resolve({}) } as AmoWidgetSelf;
    setMenuBadge(self, 5);
    expect(document.querySelector('.rfm-menu-badge')!.textContent).toBe('5');
    setMenuBadge(self, 0);
    expect((document.querySelector('.rfm-menu-badge') as HTMLElement).style.display).toBe('none');
    const host = inboxHost(document, 'rfm');
    expect(host.style.position).toBe('fixed');
    expect(inboxHost(document, 'rfm')).toBe(host);
  });
});
