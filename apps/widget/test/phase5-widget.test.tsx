// @vitest-environment jsdom
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@ai-door/db';
import type { AmoWidgetSelf } from '../src/amo.ts';
import { createCallbacks } from '../src/index.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeSelf(area: string, responses: Record<string, unknown | ((data?: string) => unknown)>) {
  const calls: { url: string; method?: string; data?: string }[] = [];
  const self: AmoWidgetSelf = {
    get_settings: () => ({ widget_code: 'ai_door' }),
    system: () => ({ area }),
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
const click = (text: string) =>
  act(async () => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === text);
    if (!b) throw new Error(`Нет кнопки «${text}»`);
    b.click();
  });
const status = { accountId: 1, isAdmin: true, connected: true, tokenExpiresAt: null, tokenError: null, enabled: true, mode: 'auto', llmConfigured: false, spend: { todayRub: 0, monthRub: 0 }, dailyLimitRub: null, catalog: { products: 0, lastImport: null } };

beforeEach(() => {
  document.body.innerHTML = '<div id="work-area-ai_door"></div>';
  window.APP = { data: { current_card: { id: 555 } } };
});

describe('устойчивость (модерация Маркетплейса)', () => {
  it('карточка без APP: колбэки не бросают исключений и возвращают true', async () => {
    (window as { APP?: unknown }).APP = undefined;
    const { self, calls } = fakeSelf('lcard', {});
    const cb = createCallbacks(self, 'https://ai.test.ru');
    for (const name of ['init', 'bind_actions', 'render', 'settings', 'advancedSettings', 'destroy']) {
      expect(cb[name]!(), name).toBe(true);
    }
    await flush();
    expect(calls.filter((c) => c.url.includes('/panel'))).toHaveLength(0);
  });

  it('ошибка отрисовки ловится границей и не ломает страницу', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Панель падает на некорректном ответе бэкенда (нет полей) — граница показывает сообщение.
    const { self } = fakeSelf('lcard', { 'GET /widget/v1/leads/555/panel': { ai: null }, 'GET /widget/v1/leads/555/documents': { items: [] } });
    const cb = createCallbacks(self, 'https://ai.test.ru');
    await act(async () => void cb.render!());
    await flush();
    expect(document.body.textContent).toContain('не удалось отобразить блок');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('вкладка «Модель»: ключ Anthropic', () => {
  it('статус без ключа, проверка, сохранение, удаление', async () => {
    let hasKey = false;
    const { self, calls } = fakeSelf('settings', {
      'GET /widget/v1/status': () => ({ ...status, llmConfigured: hasKey }),
      'GET /widget/v1/settings': { settings: defaultSettings(), version: 1 },
      'GET /widget/v1/llm/status': () => ({ hasOwnKey: hasKey, configured: hasKey, source: hasKey ? 'account' : null }),
      'POST /widget/v1/llm/test': (d?: string) => (JSON.parse(d ?? '{}').key?.startsWith('sk-ant-good') ? { ok: true, models: ['claude-opus-5'] } : { ok: false, error: 'Ключ не принят' }),
      'PUT /widget/v1/llm/key': () => ((hasKey = true), { ok: true }),
      'DELETE /widget/v1/llm/key': () => ((hasKey = false), { ok: true }),
    });
    const cb = createCallbacks(self, 'https://ai.test.ru');
    await act(async () => void cb.advancedSettings!());
    await flush();
    expect(document.body.textContent).toContain('Нет ключа Anthropic');
    await click('Модель');
    await flush();
    expect(document.body.textContent).toContain('Ключа нет — AI не отвечает');
    const input = document.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'sk-ant-good-00000000000000000');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Проверить');
    await flush();
    expect(document.body.textContent).toContain('Ключ работает, моделей доступно: 1');
    await click('Сохранить ключ');
    await flush();
    expect(JSON.parse(calls.find((c) => c.method === 'PUT' && c.url.endsWith('/llm/key'))!.data!)).toEqual({ key: 'sk-ant-good-00000000000000000' });
    expect(document.body.textContent).toContain('Используется ключ вашего аккаунта');
    await click('Удалить ключ');
    await flush();
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/llm/key'))).toBe(true);
  });
});
