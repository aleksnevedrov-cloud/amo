// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AmoWidgetSelf } from '../src/amo.ts';
import { createCallbacks, salesbotSteps } from '../src/index.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Responder = unknown | ((data?: string) => unknown);

function fakeSelf(area: string, responses: Record<string, Responder>, fail?: number) {
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
      const u = new URL(opts.url);
      const r = responses[`${opts.method} ${u.pathname}`];
      return typeof r === 'function' ? (r as (d?: string) => unknown)(opts.data) : r;
    },
  };
  return { self, calls };
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const click = (text: string) =>
  act(async () => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === text);
    if (!b) throw new Error(`Нет кнопки «${text}»`);
    b.click();
  });

const panel = (paused: boolean) => ({
  leadId: 555,
  ai: { enabled: true, mode: 'auto', paused, pauseReason: paused ? 'manager_message' : null, pausedAt: null },
  hints: [],
  products: [{ type: 'product', id: '1001', title: 'Турин 1', url: 'https://rf-dveri.ru/t1' }],
  calculations: [],
  log: [{ id: 1, kind: 'reply', summary: 'Турин 1 — 14 900 ₽', costRub: 1.2, createdAt: '2026-09-24T10:00:00Z' }],
  costRub: 1.2,
});

const status = {
  accountId: 1,
  isAdmin: true,
  connected: true,
  tokenExpiresAt: null,
  tokenError: null,
  enabled: false,
  mode: 'off',
  llmConfigured: true,
  spend: { todayRub: 12.5, monthRub: 100 },
  dailyLimitRub: null,
  catalog: { products: 16, lastImport: null },
};

beforeEach(() => {
  document.body.innerHTML = '';
  window.APP = { data: { current_card: { id: 555 } } };
});
afterEach(() => vi.restoreAllMocks());

describe('панель в карточке сделки', () => {
  it('показывает статус, товары и журнал; «Пауза» ставит AI на паузу', async () => {
    let paused = false;
    const { self, calls } = fakeSelf('lcard', {
      'GET /widget/v1/leads/555/panel': () => panel(paused),
      'POST /widget/v1/leads/555/pause': () => {
        paused = true;
        return { ok: true };
      },
    });
    const cb = createCallbacks(self, 'https://ai.test.ru');
    await act(async () => void cb.render!());
    await flush();
    expect(calls[0]?.url).toBe('https://ai.test.ru/widget/v1/leads/555/panel');
    expect(document.body.textContent).toContain('Автоматический');
    expect(document.body.textContent).toContain('Турин 1');
    expect(document.body.textContent).toContain('Турин 1 — 14 900 ₽');

    await click('Пауза');
    await flush();
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/pause'))).toBe(true);
    expect(document.body.textContent).toContain('на паузе');
    expect(document.body.textContent).toContain('Менеджер написал клиенту');
    expect(document.body.textContent).toContain('Вернуть AI');
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
  const settings = {
    enabled: false,
    mode: 'off',
    behavior: { persona: 'p', rules: '', forbiddenTopics: [], greeting: '', handoffPhrase: 'Передаю менеджеру' },
    model: { provider: 'anthropic', model: 'claude-opus-5', fallbackModel: 'claude-sonnet-5', effort: 'low', maxTokens: 4096 },
    where: { pipelineIds: null, disabledStatusIds: [], batchWindowSec: 8, typingDelay: false },
    handoff: { taskTypeId: 1, taskDeadlineMin: 60, responsibleUserId: null, statusId: null },
    catalog: { feedUrl: '', importEveryHours: 24 },
    limits: { dailyRub: null },
    billing: { usdRubRate: 90 },
  };

  it('статус, включение и режим сохраняются целиком', async () => {
    document.body.innerHTML = '<div id="work-area-ai_door"></div>';
    const { self, calls } = fakeSelf('settings', {
      'GET /widget/v1/status': status,
      'GET /widget/v1/settings': { settings, version: 0 },
      'PUT /widget/v1/settings': (d?: string) => ({ settings: JSON.parse(d ?? '{}'), version: 1 }),
    });
    const cb = createCallbacks(self, 'https://ai.test.ru');
    await act(async () => void cb.advancedSettings!());
    await flush();
    expect(document.body.textContent).toContain('amoCRM подключён');
    expect(document.body.textContent).toContain('Каталог: 16 товаров');
    expect(document.body.textContent).toContain('12,5 ₽');

    const checkbox = document.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    const select = document.querySelector<HTMLSelectElement>('select')!;
    await act(async () => {
      checkbox.click();
      select.value = 'auto';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click('Сохранить');
    await flush();
    const put = calls.find((c) => c.method === 'PUT');
    expect(JSON.parse(put!.data!)).toEqual({ ...settings, enabled: true, mode: 'auto' });
  });

  it('песочница показывает ответ и вызванные инструменты', async () => {
    document.body.innerHTML = '<div id="work-area-ai_door"></div>';
    const { self, calls } = fakeSelf('settings', {
      'GET /widget/v1/status': status,
      'GET /widget/v1/settings': { settings, version: 0 },
      'POST /widget/v1/sandbox': {
        kind: 'reply',
        text: 'Порта 21 — 7 900 ₽',
        handoff: null,
        blockedReason: null,
        toolCalls: [{ name: 'catalog_search', specName: 'catalog.search', input: { query: 'экошпон' }, ok: true, empty: false, durationMs: 12 }],
        sources: [{ type: 'product', id: '1004', title: 'Порта 21', url: 'https://rf-dveri.ru/p21' }],
        rejections: [],
        notes: [],
        model: 'claude-opus-5',
        cost: { usd: 0.01, rub: 0.9, inputTokens: 100, outputTokens: 10 },
      },
    });
    const cb = createCallbacks(self, 'https://ai.test.ru');
    await act(async () => void cb.advancedSettings!());
    await flush();
    await click('Песочница');
    const ta = document.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(ta, 'Нужна дверь в экошпоне');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Отправить');
    await flush();
    const req = calls.find((c) => c.url.endsWith('/sandbox'));
    expect(JSON.parse(req!.data!)).toEqual({ messages: [{ role: 'client', text: 'Нужна дверь в экошпоне' }] });
    expect(document.body.textContent).toContain('Порта 21 — 7 900 ₽');
    expect(document.body.textContent).toContain('catalog.search');
  });
});

describe('Salesbot', () => {
  it('шаг виджета отправляет сообщение и id сделки на бэкенд', () => {
    const steps = JSON.parse(salesbotSteps('https://ai.test.ru'));
    expect(steps[0].question[0]).toEqual({
      handler: 'widget_request',
      params: { url: 'https://ai.test.ru/salesbot/v1/hook', data: { lead_id: '{{lead.id}}', message: '{{message_text}}' } },
    });
  });
});
