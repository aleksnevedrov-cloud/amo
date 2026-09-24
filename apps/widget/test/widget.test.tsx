// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AmoWidgetSelf } from '../src/amo.ts';
import { createCallbacks } from '../src/index.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeSelf(area: string, responses: Record<string, unknown>, fail?: number) {
  const calls: { url: string; method?: string; data?: string }[] = [];
  const self: AmoWidgetSelf = {
    get_settings: () => ({ widget_code: 'ai_door' }),
    system: () => ({ area }),
    i18n: () => '',
    render_template: ({ render }) => {
      document.body.insertAdjacentHTML('beforeend', render);
    },
    $authorizedAjax: async (opts) => {
      calls.push(opts);
      if (fail) throw { status: fail };
      const path = new URL(opts.url).pathname;
      return responses[`${opts.method} ${path}`];
    },
  };
  return { self, calls };
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  document.body.innerHTML = '';
  window.APP = { data: { current_card: { id: 555 } } };
});
afterEach(() => vi.restoreAllMocks());

describe('панель в карточке сделки', () => {
  it('рендерит статус AI из API', async () => {
    const { self, calls } = fakeSelf('lcard', {
      'GET /widget/v1/leads/555/panel': { leadId: 555, ai: { mode: 'off', paused: false }, hints: [], products: [], calculations: [], log: [] },
    });
    const cb = createCallbacks(self, 'https://ai.test.ru');
    await act(async () => void cb.render!());
    await flush();
    expect(calls[0]?.url).toBe('https://ai.test.ru/widget/v1/leads/555/panel');
    expect(document.body.textContent).toContain('Выключен');
    expect(document.body.textContent).toContain('Подсказок пока нет');
    await act(async () => void cb.destroy!());
  });

  it('показывает понятную ошибку, если бэкенд недоступен', async () => {
    const { self } = fakeSelf('lcard', {}, 401);
    const cb = createCallbacks(self, 'https://ai.test.ru');
    await act(async () => void cb.render!());
    await flush();
    expect(document.body.textContent).toContain('Переустановите интеграцию');
    expect(document.body.textContent).toContain('Повторить');
  });

  it('вне карточки сделки ничего не рендерит и не ходит в API', async () => {
    const { self, calls } = fakeSelf('clist', {});
    await act(async () => void createCallbacks(self, 'https://ai.test.ru').render!());
    expect(calls).toHaveLength(0);
    expect(document.body.innerHTML).toBe('');
  });

  it('ошибка внутри колбэка не пробрасывается в amo', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const self = { ...fakeSelf('lcard', {}).self, system: () => { throw new Error('boom'); } };
    expect(createCallbacks(self, 'https://ai.test.ru').render!()).toBe(true);
  });
});

describe('расширенные настройки', () => {
  it('загружает и сохраняет режим', async () => {
    document.body.innerHTML = '<div id="work-area-ai_door"></div>';
    const { self, calls } = fakeSelf('settings', {
      'GET /widget/v1/status': { accountId: 1, connected: true, tokenExpiresAt: null, tokenError: null, enabled: false, mode: 'off' },
      'GET /widget/v1/settings': { settings: { enabled: false, mode: 'off' }, version: 0 },
      'PUT /widget/v1/settings': { settings: { enabled: true, mode: 'hints' }, version: 1 },
    });
    const cb = createCallbacks(self, 'https://ai.test.ru');
    await act(async () => void cb.advancedSettings!());
    await flush();
    expect(document.body.textContent).toContain('amoCRM подключён');

    const checkbox = document.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    const select = document.querySelector<HTMLSelectElement>('select')!;
    await act(async () => {
      checkbox.click();
      select.value = 'hints';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => document.querySelector<HTMLButtonElement>('button')!.click());
    await flush();

    const put = calls.find((c) => c.method === 'PUT');
    expect(JSON.parse(put!.data!)).toEqual({ enabled: true, mode: 'hints' });
  });
});
