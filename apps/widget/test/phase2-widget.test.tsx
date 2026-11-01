// @vitest-environment jsdom
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AmoWidgetSelf } from '../src/amo.ts';
import { createCallbacks, salesbotSteps } from '../src/index.tsx';

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

const calc = {
  lines: [{ name: 'Порта 21 80*200', article: '1004', qty: 2, unit: 'шт.', price: 7900, total: 15800, basis: 'цена из каталога' }],
  total: 15800,
  complete: true,
  missing: [],
  doorsCount: 2,
};
const suggestion = (id: number, kind: 'draft' | 'hint', text: string) => ({
  id, leadId: 555, kind, text, status: 'pending', details: {}, createdAt: '2026-09-24T10:00:00Z', decidedAt: null, decidedBy: null,
});
const panel = (hints: unknown[]) => ({
  leadId: 555,
  ai: { enabled: true, mode: 'semi', paused: false, pauseReason: null, pausedAt: null },
  hints,
  products: [],
  calculations: [calc],
  log: [],
  costRub: 0,
});

beforeEach(() => {
  document.body.innerHTML = '';
  window.APP = { data: { current_card: { id: 555 } } };
});

describe('панель сделки: черновики, подсказки, расчёт', () => {
  const dialogOf = (hints: { id: number; text: string }[]) => ({
    leadId: 555,
    items: hints.map((h) => ({ id: `s-${h.id}`, at: '2026-09-24T10:00:00Z', who: 'hint', channel: null, channelLabel: null, text: h.text, notSent: true, suggestionId: h.id })),
    send: { available: false, reason: 'Wazzup не подключён — ответ из окна недоступен; скопируйте текст и отправьте в чате amo' },
  });

  it('черновик: «В поле», правка, «Одобрить черновик» — уходит ботом-отправщиком с правкой', async () => {
    let hints = [suggestion(1, 'draft', 'Здравствуйте!')];
    const { self, calls } = fakeSelf('lcard', {
      'GET /widget/v1/leads/555/panel': () => panel(hints),
      'GET /widget/v1/leads/555/dialog': () => dialogOf(hints),
      'POST /widget/v1/suggestions/1/approve': () => {
        hints = [];
        return { ok: true };
      },
    });
    const cb = createCallbacks(self, 'https://ai.test.ru');
    await act(async () => void cb.render!());
    await flush();
    await click('Черновик на одобрение (1) →');
    await flush();
    const modal = () => (document.querySelector('.ai-door-modal')?.textContent ?? '').replace(/\s/g, ' ');
    expect(modal()).toContain('Черновик ответа · не отправлен');
    expect(modal()).toContain('Итого: 15 800 ₽');
    await click('Товары и расчёт');
    expect(modal()).toContain('Порта 21 80*200');
    await click('Диалог');
    await flush();

    await click('В поле');
    const ta = document.querySelector<HTMLTextAreaElement>('.ai-door-composer textarea')!;
    expect(ta.value).toBe('Здравствуйте!');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, 'Здравствуйте! Чем помочь?');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Одобрить черновик');
    await flush();
    const approve = calls.find((c) => c.url.endsWith('/approve'));
    expect(JSON.parse(approve!.data!)).toEqual({ text: 'Здравствуйте! Чем помочь?' });
    expect(modal()).not.toContain('Черновик ответа');
    await act(async () => void cb.destroy!());
  });

  it('подсказка: «В поле» → «Открыть чат» вставляет её в поле чата amo и закрывает окно', async () => {
    document.body.innerHTML = '<div class="feed-compose"><div contenteditable="true"></div></div>';
    const hints = [suggestion(2, 'hint', 'Предложите Турин 1')];
    const { self, calls } = fakeSelf('lcard', {
      'GET /widget/v1/leads/555/panel': () => panel(hints),
      'GET /widget/v1/leads/555/dialog': () => dialogOf(hints),
      'POST /widget/v1/suggestions/2/used': { ok: true },
    });
    const cb = createCallbacks(self, 'https://ai.test.ru');
    await act(async () => void cb.render!());
    await flush();
    await click('Развернуть ⤢');
    await flush();
    expect(document.querySelector('.ai-door-modal')?.textContent).toContain('Подсказка менеджеру · не отправлена');
    // Отправить из окна нельзя (нет Wazzup) — причина и запасной вариант.
    expect([...document.querySelectorAll('button')].some((b) => b.textContent === 'Отправить')).toBe(false);
    expect(document.querySelector('.ai-door-modal')?.textContent).toContain('Wazzup не подключён');
    await click('В поле');
    await click('Открыть чат');
    await flush();
    expect(document.querySelector<HTMLElement>('.feed-compose [contenteditable]')!.innerText).toBe('Предложите Турин 1');
    expect(calls.some((c) => c.url.endsWith('/suggestions/2/used'))).toBe(true);
    expect(document.querySelector('.ai-door-modal')).toBeNull();
    await act(async () => void cb.destroy!());
  });
});

describe('Salesbot: бот-отправщик', () => {
  it('шаг ai_send забирает черновик', () => {
    const steps = JSON.parse(salesbotSteps('https://ai.test.ru', 'ai_send'));
    expect(steps[0].question[0].params.data).toEqual({ lead_id: '{{lead.id}}', kind: 'send' });
  });
});

describe('вкладка «Правила цен»', () => {
  it('добавление услуги и сохранение правил', async () => {
    document.body.innerHTML = '<div id="work-area-ai_door"></div>';
    const rules = { sizes: { standardWidths: [600, 700, 800, 900], standardHeights: [2000], nonStandardMarkupPct: null }, components: [], services: [], disclaimer: 'Расчёт предварительный.' };
    const { self, calls } = fakeSelf('settings', {
      'GET /widget/v1/status': { accountId: 1, isAdmin: true, connected: true, tokenExpiresAt: null, tokenError: null, enabled: true, mode: 'auto', llmConfigured: true, spend: { todayRub: 0, monthRub: 0 }, dailyLimitRub: null, catalog: { products: 16, lastImport: null } },
      'GET /widget/v1/settings': { settings: {}, version: 1 },
      'GET /widget/v1/pricing': { rules, version: 0 },
      'PUT /widget/v1/pricing': (d?: string) => ({ rules: JSON.parse(d ?? '{}'), version: 1 }),
    });
    const cb = createCallbacks(self, 'https://ai.test.ru');
    await act(async () => void cb.advancedSettings!());
    await flush();
    await click('Правила цен');
    await flush();
    await click('+ Услуга');
    await click('Сохранить');
    await flush();
    const put = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/pricing'));
    expect(JSON.parse(put!.data!).services).toEqual([{ code: 'svc_1', name: '', unit: 'fixed', price: 0, basePrice: 0 }]);
  });
});
