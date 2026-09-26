// @vitest-environment jsdom
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AmoWidgetSelf } from '../src/amo.ts';
import { createCallbacks } from '../src/index.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeSelf(responses: Record<string, unknown | ((data?: string) => unknown)>) {
  const calls: { url: string; method?: string; data?: string }[] = [];
  const self: AmoWidgetSelf = {
    get_settings: () => ({ widget_code: 'ai_door' }),
    system: () => ({ area: 'settings' }),
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

const status = { accountId: 1, isAdmin: true, connected: true, tokenExpiresAt: null, tokenError: null, enabled: true, mode: 'auto', llmConfigured: true, spend: { todayRub: 0, monthRub: 0 }, dailyLimitRub: null, catalog: { products: 16, lastImport: null } };
const analytics = {
  from: '2026-09-01', to: '2026-09-26', dialogs: 40, replies: 120, drafts: 3, hints: 5, handoffs: 8, documents: 4, errors: 1, costRub: 812.5, avgCostPerDialogRub: 20.31,
  outcomes: { tracked: 40, advanced: 14, won: 3, lost: 6, conversionPct: 35 },
  handoffReasons: [{ reason: 'discount', count: 5 }, { reason: 'legal_entity', count: 3 }],
  byDay: [{ day: '2026-09-25', dialogs: 4, replies: 12, handoffs: 1, costRub: 80 }],
};
const billing = { months: [{ month: '2026-09', costRub: 812.5, costUsd: 9.03, inputTokens: 1200000, outputTokens: 45000, dialogs: 40, replies: 120 }] };

beforeEach(() => {
  document.body.innerHTML = '<div id="work-area-ai_door"></div>';
});

describe('вкладка «Аналитика»', () => {
  it('плитки, причины передач, по дням и расход по месяцам; смена периода — новый запрос', async () => {
    const { self, calls } = fakeSelf({
      'GET /widget/v1/status': status,
      'GET /widget/v1/settings': { settings: {}, version: 1 },
      'GET /widget/v1/analytics': analytics,
      'GET /widget/v1/billing': billing,
    });
    const cb = createCallbacks(self, 'https://ai.test.ru');
    await act(async () => void cb.advancedSettings!());
    await flush();
    await click('Аналитика');
    await flush();
    const t = document.body.textContent ?? '';
    expect(t).toContain('Диалогов с AI40');
    expect(t).toContain('35 %');
    expect(t).toContain('14 из 40 сделок ушли вперёд');
    expect(t).toContain('Скидка');
    expect(t).toContain('2026-09-25');
    expect(t).toContain('2026-09');
    expect(t.replace(/\s/g, ' ')).toContain('1 200 000 / 45 000');
    await click('7 дней');
    await flush();
    expect(calls.filter((c) => c.url.includes('/analytics?days=')).map((c) => new URL(c.url).search)).toEqual(['?days=30', '?days=7']);
  });
});

describe('вкладка «Версии»', () => {
  it('история с разделами, откат по подтверждению', async () => {
    window.confirm = () => true;
    const { self, calls } = fakeSelf({
      'GET /widget/v1/status': status,
      'GET /widget/v1/settings': { settings: {}, version: 3 },
      'GET /widget/v1/settings/history': {
        items: [
          { id: 3, userId: 7, changedAt: '2026-09-26T10:00:00Z', changed: ['behavior'] },
          { id: 2, userId: 7, changedAt: '2026-09-25T10:00:00Z', changed: ['limits', 'vision'] },
        ],
      },
      'GET /widget/v1/settings/history/2': { id: 2, userId: 7, changedAt: '2026-09-25T10:00:00Z', changed: ['limits'], settings: { behavior: { greeting: 'Привет!' }, model: { model: 'claude-opus-5' } } },
      'POST /widget/v1/settings/history/2/restore': { version: 4 },
    });
    const cb = createCallbacks(self, 'https://ai.test.ru');
    await act(async () => void cb.advancedSettings!());
    await flush();
    await click('Версии');
    await flush();
    const t = document.body.textContent ?? '';
    expect(t).toContain('#3');
    expect(t).toContain('текущая');
    expect(t).toContain('Изменено: Лимиты, Файлы и фото');
    const shows = [...document.querySelectorAll('button')].filter((b) => b.textContent === 'Показать');
    await act(async () => void shows[1]!.click());
    await flush();
    expect(document.body.textContent).toContain('Привет!');
    await click('Откатить');
    await flush();
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/settings/history/2/restore'))).toBe(true);
    expect(document.body.textContent).toContain('возвращены к версии #2');
  });
});
