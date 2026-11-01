// @vitest-environment jsdom
// RETAIL-WIDGET-WINDOW: ответ клиенту из окна (только по кнопке, блокировка повторного нажатия, без автоповтора),
// запасной вариант «Скопировать / Открыть чат», автоповтор загрузки с отчётом в журнал API.
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AmoWidgetSelf } from '../src/amo.ts';
import { RETRY } from '../src/api.ts';
import { createCallbacks } from '../src/index.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Responder = unknown | ((data?: string) => unknown);

function fakeSelf(responses: Record<string, Responder>) {
  const calls: { url: string; method?: string; data?: string }[] = [];
  const self: AmoWidgetSelf = {
    get_settings: () => ({ widget_code: 'ai_door' }),
    system: () => ({ area: 'lcard' }),
    i18n: () => '',
    render_template: ({ render }) => document.body.insertAdjacentHTML('beforeend', render),
    $authorizedAjax: async (opts) => {
      calls.push(opts);
      const r = responses[`${opts.method} ${new URL(opts.url).pathname}`];
      if (r === undefined) throw new Error(`нет ответа для ${opts.method} ${opts.url}`);
      return typeof r === 'function' ? (r as (d?: string) => unknown)(opts.data) : r;
    },
  };
  return { self, calls };
}
const flush = () => act(async () => new Promise((r) => setTimeout(r, 20)));
const button = (text: string) => [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === text) as HTMLButtonElement | undefined;
const click = (text: string) =>
  act(async () => {
    const b = button(text);
    if (!b) throw new Error(`Нет кнопки «${text}»`);
    b.click();
  });
const type = (value: string) =>
  act(async () => {
    const ta = document.querySelector<HTMLTextAreaElement>('.ai-door-composer textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, value);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });

const panel = {
  leadId: 29986849,
  isAdmin: true,
  ai: { enabled: true, mode: 'auto', paused: false, pauseReason: null, pausedAt: null },
  hints: [],
  products: [{ type: 'product', id: '1001', title: 'Валенсия ПГ', url: 'https://rf-dveri.ru/v', price: 12900, available: true }],
  calculations: [],
  log: [],
  costRub: 3.1,
};
const item = (id: string, who: string, text: string, extra: Record<string, unknown> = {}) => ({ id, at: '2026-10-02T09:00:00Z', who, channel: 'whatsapp', channelLabel: 'WhatsApp', text, ...extra });

beforeEach(() => {
  RETRY.delaysMs = [0, 0];
  document.body.innerHTML = '';
  window.APP = { data: { current_card: { id: 29986849 } } };
});

describe('окно виджета: ответ клиенту (RETAIL-WIDGET-WINDOW, п. 3)', () => {
  it('«Отправить» — в WhatsApp от имени менеджера, кнопка заблокирована до ответа сервера, сообщение появляется в ленте', async () => {
    const items = [item('w-1', 'client', 'Здравствуйте, интересует Валенсия ПГ')];
    let release: (() => void) | null = null;
    const { self, calls } = fakeSelf({
      'GET /widget/v1/leads/29986849/panel': panel,
      'GET /widget/v1/leads/29986849/dialog': () => ({ leadId: 29986849, items: [...items], send: { available: true, channel: 'whatsapp', channelLabel: 'WhatsApp', reason: null } }),
      'POST /widget/v1/leads/29986849/send': (d?: string) =>
        new Promise((resolve) => {
          release = () => {
            items.push(item('w-2', 'manager', JSON.parse(d ?? '{}').text, { managerName: 'Анна Петрова', at: '2026-10-02T09:10:00Z' }));
            resolve({ ok: true, channel: 'whatsapp', channelLabel: 'WhatsApp', userName: 'Анна Петрова', at: '2026-10-02T09:10:00Z' });
          };
        }),
    });
    const cb = createCallbacks(self, 'https://ai.test.ru');
    await act(async () => void cb.render!());
    await flush();
    await click('Развернуть ⤢');
    await flush();
    expect(button('Отправить')?.disabled).toBe(true);
    await type('Счёт отправлю сегодня');
    await click('Отправить');
    // Пока сервер не ответил — кнопка заблокирована, повторное нажатие не отправляет второй раз.
    expect(button('Отправляю…')?.disabled).toBe(true);
    await act(async () => button('Отправляю…')!.click());
    expect(calls.filter((c) => c.url.endsWith('/send'))).toHaveLength(1);
    await act(async () => release!());
    await flush();
    expect(JSON.parse(calls.find((c) => c.url.endsWith('/send'))!.data!)).toEqual({ text: 'Счёт отправлю сегодня' });
    const modal = document.querySelector('.ai-door-modal')!.textContent ?? '';
    expect(modal).toContain('Отправлено в WhatsApp от имени Анна Петрова.');
    expect(modal).toContain('Менеджер · Анна Петрова');
    expect(document.querySelector<HTMLTextAreaElement>('.ai-door-composer textarea')!.value).toBe('');
    await act(async () => void cb.destroy!());
  });

  it('сбой отправки — причина, без автоповтора (иначе клиент получил бы сообщение дважды)', async () => {
    const { self, calls } = fakeSelf({
      'GET /widget/v1/leads/29986849/panel': panel,
      'GET /widget/v1/leads/29986849/dialog': { leadId: 29986849, items: [], send: { available: true, channel: 'whatsapp', channelLabel: 'WhatsApp', reason: null } },
      'POST /widget/v1/leads/29986849/send': () => {
        throw { status: 502, responseJSON: { error: 'send_failed', message: 'Wazzup не принял сообщение: HTTP 400' } };
      },
    });
    const cb = createCallbacks(self, 'https://ai.test.ru');
    await act(async () => void cb.render!());
    await flush();
    await click('Развернуть ⤢');
    await flush();
    await type('тест');
    await click('Отправить');
    await flush();
    expect(calls.filter((c) => c.url.endsWith('/send'))).toHaveLength(1);
    expect(document.querySelector('.ai-door-modal')!.textContent).toContain('Не отправлено: Wazzup не принял сообщение: HTTP 400');
    // Текст не потерян — можно поправить и отправить снова.
    expect(document.querySelector<HTMLTextAreaElement>('.ai-door-composer textarea')!.value).toBe('тест');
    await act(async () => void cb.destroy!());
  });

  it('отправка недоступна (почта, Wazzup не подключён): кнопки «Отправить» нет, причина, «Скопировать» и «Открыть чат»', async () => {
    let copied = '';
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t: string) => void (copied = t) }, configurable: true });
    const { self } = fakeSelf({
      'GET /widget/v1/leads/29986849/panel': panel,
      'GET /widget/v1/leads/29986849/dialog': { leadId: 29986849, items: [item('d-1', 'client', 'Пришлите счёт на почту', { channel: 'email', channelLabel: 'почта' })], send: { available: false, reason: 'Wazzup не подключён — ответ из окна недоступен; скопируйте текст и отправьте в чате amo' } },
    });
    const cb = createCallbacks(self, 'https://ai.test.ru');
    await act(async () => void cb.render!());
    await flush();
    await click('Развернуть ⤢');
    await flush();
    const modal = () => document.querySelector('.ai-door-modal')?.textContent ?? '';
    expect(modal()).toContain('Клиент · почта');
    expect(button('Отправить')).toBeUndefined();
    expect(modal()).toContain('Wazzup не подключён — ответ из окна недоступен');
    await type('Счёт во вложении');
    await click('Скопировать');
    expect(copied).toBe('Счёт во вложении');
    expect(modal()).toContain('Скопировано — вставьте в чат amo.');
    // «Открыть чат» закрывает окно (текст — в поле чата amo или в буфере обмена).
    await click('Открыть чат');
    await flush();
    expect(document.querySelector('.ai-door-modal')).toBeNull();
    await act(async () => void cb.destroy!());
  });

  it('закрыли окно с набранным текстом — при повторном открытии текст на месте', async () => {
    const { self } = fakeSelf({
      'GET /widget/v1/leads/29986849/panel': panel,
      'GET /widget/v1/leads/29986849/dialog': { leadId: 29986849, items: [], send: { available: true, channel: 'whatsapp', channelLabel: 'WhatsApp', reason: null } },
    });
    const cb = createCallbacks(self, 'https://ai.test.ru');
    await act(async () => void cb.render!());
    await flush();
    await click('Развернуть ⤢');
    await flush();
    await type('Черновик менеджера');
    await click('✕');
    expect(document.querySelector('.ai-door-modal')).toBeNull();
    await click('Развернуть ⤢');
    await flush();
    expect(document.querySelector<HTMLTextAreaElement>('.ai-door-composer textarea')!.value).toBe('Черновик менеджера');
    await type('');
    await act(async () => void cb.destroy!());
  });
});

describe('надёжность загрузки (RETRY, п. 4)', () => {
  it('HTTP 503 один раз — повтор помог: панель показана, в журнал API — «повтор помог»', async () => {
    let n = 0;
    const { self, calls } = fakeSelf({
      'GET /widget/v1/leads/29986849/panel': () => {
        n += 1;
        if (n === 1) throw { status: 503 };
        return panel;
      },
      'POST /widget/v1/client-errors': { ok: true },
    });
    const cb = createCallbacks(self, 'https://ai.test.ru');
    await act(async () => void cb.render!());
    await flush();
    expect(document.body.textContent).toContain('Товаров 1');
    expect(document.body.textContent).not.toContain('недоступен');
    expect(JSON.parse(calls.find((c) => c.url.endsWith('/client-errors'))!.data!)).toEqual({ method: 'GET', path: '/widget/v1/leads/29986849/panel', reason: 'HTTP 503', status: null, attempts: 2, recovered: true, leadId: 29986849 });
    await act(async () => void cb.destroy!());
  });

  it('401 — без повтора, причина в тексте; 5xx после повторов — «ответил ошибкой (HTTP 502)»', async () => {
    const one = fakeSelf({ 'GET /widget/v1/leads/29986849/panel': () => { throw { status: 401 }; }, 'POST /widget/v1/client-errors': { ok: true } });
    let cb = createCallbacks(one.self, 'https://ai.test.ru');
    await act(async () => void cb.render!());
    await flush();
    expect(one.calls.filter((c) => c.url.endsWith('/panel'))).toHaveLength(1);
    expect(document.body.textContent).toContain('Нет доступа к серверу AI-агента (401)');
    await act(async () => void cb.destroy!());

    document.body.innerHTML = '';
    const two = fakeSelf({ 'GET /widget/v1/leads/29986849/panel': () => { throw { status: 502 }; }, 'POST /widget/v1/client-errors': { ok: true } });
    cb = createCallbacks(two.self, 'https://ai.test.ru');
    await act(async () => void cb.render!());
    await flush();
    expect(two.calls.filter((c) => c.url.endsWith('/panel'))).toHaveLength(3);
    expect(document.body.textContent).toContain('Сервер AI-агента ответил ошибкой (HTTP 502).');
    expect(JSON.parse(two.calls.find((c) => c.url.endsWith('/client-errors'))!.data!)).toMatchObject({ reason: 'HTTP 502', status: 502, attempts: 3, recovered: false });
    await act(async () => void cb.destroy!());
  });
});
