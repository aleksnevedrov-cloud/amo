// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { amojoAccountId, MessengerApi, mountSettings, renderHtml, type AmoWidgetSelf, type StatusView } from '../src/index.ts';

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
});
