// @vitest-environment jsdom
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultSettings } from '@ai-door/db';
import type { AmoWidgetSelf } from '../src/amo.ts';
import { createCallbacks } from '../src/index.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Responder = unknown | ((data?: string, url?: URL) => unknown);

function fakeSelf(area: string, responses: Record<string, Responder>) {
  const calls: { url: string; method?: string; data?: string }[] = [];
  const self: AmoWidgetSelf = {
    get_settings: () => ({ widget_code: 'ai_door' }),
    params: { path: 'https://widgets.amocrm.ru/ai_door' },
    system: () => ({ area }),
    i18n: () => '',
    render_template: ({ render }) => document.body.insertAdjacentHTML('beforeend', render),
    $authorizedAjax: async (opts) => {
      calls.push(opts);
      const u = new URL(opts.url);
      const r = responses[`${opts.method} ${u.pathname}`];
      if (r === undefined) throw new Error(`нет ответа для ${opts.method} ${opts.url}`);
      return typeof r === 'function' ? (r as (d?: string, url?: URL) => unknown)(opts.data, u) : r;
    },
  };
  return { self, calls };
}
const flush = () => act(async () => new Promise((r) => setTimeout(r, 20)));
const click = (text: string, nth = 0) =>
  act(async () => {
    const all = [...document.querySelectorAll('button')].filter((x) => x.textContent?.trim() === text);
    const b = all[nth];
    if (!b) throw new Error(`Нет кнопки «${text}»`);
    b.click();
  });
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
const choose = (sel: HTMLSelectElement, value: string) =>
  act(async () => {
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });

const status = { accountId: 1, isAdmin: true, connected: true, tokenExpiresAt: null, tokenError: null, enabled: true, mode: 'auto', llmConfigured: true, llm: { provider: 'anthropic', model: 'claude-opus-5', fallback: null, providers: ['anthropic'], missingModels: [], lastError: null }, spend: { todayRub: 0, monthRub: 0 }, dailyLimitRub: null, catalog: { products: 16, lastImport: null } };
const model = (id: string, provider: string, extra: Record<string, unknown> = {}) => ({ id, name: id, provider, vision: true, tools: true, reasoning: true, temperature: false, maxOutputTokens: null, createdAt: null, price: { input: 1, output: 5, cachedInput: 0.1 }, recommended: 1, ...extra });

beforeEach(() => {
  document.body.innerHTML = '<div id="work-area-ai_door"></div>';
  window.APP = { data: { current_card: { id: 555 } } };
  localStorage.clear();
});

describe('вкладка «Модель» 1.1.0', () => {
  it('переключение провайдера, ключ OpenAI под раскрывашкой, список моделей из API, резерв другого провайдера', async () => {
    const keys: Record<string, { saved: boolean; mask: string | null; source: string | null }> = { anthropic: { saved: false, mask: null, source: 'server' }, openai: { saved: false, mask: null, source: null } };
    let providers = ['anthropic'];
    let stored: unknown = defaultSettings();
    const { self, calls } = fakeSelf('settings', {
      'GET /widget/v1/status': status,
      'GET /widget/v1/settings': () => ({ settings: stored, version: 1 }),
      'GET /widget/v1/amo/dictionaries': { pipelines: [{ id: 1, name: 'Продажи', statuses: [{ id: 10, name: 'Новая' }] }], taskTypes: [] },
      'GET /widget/v1/llm/status': { hasOwnKey: false, configured: true, source: 'server' },
      'GET /widget/v1/llm/keys': () => ({ provider: 'anthropic', fallbackProvider: 'anthropic', keys, providers }),
      'GET /widget/v1/llm/models': (_d?: string, u?: URL) =>
        u?.searchParams.get('provider') === 'openai'
          ? { provider: 'openai', models: [model('gpt-5', 'openai'), model('gpt-5-mini', 'openai', { vision: false })], fetchedAt: '2026-09-29T10:00:00Z', fromCache: false, source: 'api', noKey: false }
          : { provider: 'anthropic', models: [model('claude-opus-5', 'anthropic'), model('claude-sonnet-5', 'anthropic')], fetchedAt: null, fromCache: true, source: 'api', noKey: false },
      'POST /widget/v1/llm/test': (d?: string) => (JSON.parse(d ?? '{}').key?.startsWith('sk-good') ? { ok: true, models: ['gpt-5', 'gpt-5-mini'] } : { ok: false, error: 'Ключ не принят' }),
      'PUT /widget/v1/llm/key': (d?: string) => {
        const b = JSON.parse(d ?? '{}');
        if (!String(b.key).startsWith('sk-good')) throw { status: 422, responseJSON: { error: 'key_invalid', message: 'Ключ не принят провайдером' } };
        keys.openai = { saved: true, mask: 'sk-…0000', source: 'account' };
        providers = ['anthropic', 'openai'];
        return { ok: true };
      },
      'PUT /widget/v1/settings': (d?: string) => ((stored = JSON.parse(d ?? '{}')), { settings: stored, version: 2 }),
    });
    const cb = createCallbacks(self, 'https://ai.test.ru');
    await act(async () => void cb.advancedSettings!());
    await flush();
    await click('Модель');
    await flush();
    let t = document.body.textContent ?? '';
    expect(t).toContain('Используется общий ключ сервера');
    expect(t).toContain('видит изображения');
    expect(t).toContain('$1 / $5 за 1M');

    // Переключаем на OpenAI: модель по умолчанию — первая из списка, ключа нет → «Сохранить» недоступна.
    const providerSelect = [...document.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.value === 'openai'))!;
    await choose(providerSelect, 'openai');
    await flush();
    t = document.body.textContent ?? '';
    expect(t).toContain('Ключа нет — AI не отвечает. Получите ключ на platform.openai.com');
    expect(t).toContain('Введите ключ OpenAI');
    const save = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Сохранить')!;
    expect(save.disabled).toBe(true);

    // Невалидный ключ не сохраняется.
    const input = document.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(input.placeholder).toBe('sk-…');
    await type(input, 'sk-bad-00000000000000000000');
    await click('Сохранить ключ');
    await flush();
    expect(document.body.textContent).toContain('Ключ не сохранён: Ключ не принят провайдером');
    expect(document.body.textContent).toContain('ключ не принят');

    // Проверка и сохранение хорошего ключа: провайдер уходит в теле только для OpenAI.
    await type(input, 'sk-good-0000000000000000000');
    await click('Проверить');
    await flush();
    expect(document.body.textContent).toContain('Ключ работает, моделей доступно: 2');
    expect(document.body.textContent).toContain('ключ действует');
    await click('Сохранить ключ');
    await flush();
    const put = calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/llm/key')).at(-1);
    expect(JSON.parse(put!.data!)).toEqual({ key: 'sk-good-0000000000000000000', provider: 'openai' });
    t = document.body.textContent ?? '';
    expect(t).toContain('Используется ключ вашего аккаунта (sk-…0000)');
    expect(t).toContain('gpt-5-mini');
    expect(t).toContain('Список из API OpenAI ChatGPT');
    // Ключ другого провайдера — под раскрывашкой.
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(1);
    await click('▸ Ключ другого провайдера (Anthropic Claude)');
    await flush();
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(2);

    // Резервная модель — Claude (другой провайдер), сохранение настроек.
    const fallback = [...document.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.value === 'anthropic:claude-sonnet-5') && [...x.options].some((o) => o.value === ''))!;
    await choose(fallback, 'anthropic:claude-sonnet-5');
    await flush();
    const save2 = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Сохранить')!;
    expect(save2.disabled).toBe(false);
    await click('Сохранить');
    await flush();
    const saved = JSON.parse(calls.find((c) => c.method === 'PUT' && c.url.endsWith('/settings'))!.data!);
    // При первом выборе провайдера модель — первая рекомендованная из таблицы тарифов (раздел 4 ТЗ).
    expect(saved.model).toMatchObject({ provider: 'openai', model: 'gpt-5.2', fallbackModel: 'claude-sonnet-5', fallbackProvider: 'anthropic' });
    // Ссылка «Сравнить» ведёт в песочницу с двумя моделями.
    // После сохранения форма перечитывает настройки и открывается на «Статусе».
    await click('Модель');
    await flush();
    const cmp = [...document.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Сравнить в песочнице'))!;
    expect(cmp.textContent).toBe('Сравнить в песочнице: ChatGPT gpt-5.2 и Claude claude-sonnet-5');
    await act(async () => void cmp.click());
    await flush();
    expect(document.body.textContent).toContain('Сравнить две модели');
    expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
  });

  it('песочница: сравнение двух моделей рядом с токенами, стоимостью и временем; прогон eval', async () => {
    const result = (provider: string, m: string, text: string) => ({
      model: { provider, model: m }, kind: 'reply', text, handoff: null, blockedReason: null, toolCalls: [{ name: 'catalog_search', specName: 'catalog.search', input: { query: 'эмаль' }, ok: true, empty: false, durationMs: 5 }],
      sources: [], rejections: [], notes: [], tasks: [], memory: {}, calculation: null, provider, requestedModel: m, fallbackUsed: false, latencyMs: 1200, cost: { usd: 0.01, rub: 0.9, inputTokens: 1200, outputTokens: 80 },
    });
    let run: Record<string, unknown> = { id: 1, status: 'running', models: [{ provider: 'openai', model: 'gpt-5' }], dialogIds: [], results: [{ ref: { provider: 'openai', model: 'gpt-5' }, reports: [], summary: null }], summary: null, error: null, startedAt: '2026-09-29T10:00:00Z', finishedAt: null, progress: { done: 0, total: 5 } };
    const { self, calls } = fakeSelf('settings', {
      'GET /widget/v1/status': { ...status, llm: { ...status.llm, providers: ['anthropic', 'openai'] } },
      'GET /widget/v1/settings': { settings: defaultSettings(), version: 1 },
      'GET /widget/v1/llm/models': (_d?: string, u?: URL) => ({ provider: u?.searchParams.get('provider'), models: [model(u?.searchParams.get('provider') === 'openai' ? 'gpt-5' : 'claude-opus-5', u?.searchParams.get('provider') ?? '')], fetchedAt: null, fromCache: false, source: 'api', noKey: false }),
      'POST /widget/v1/sandbox/compare': { results: [result('anthropic', 'claude-opus-5', 'Турин 1 — 14 900 ₽'), result('openai', 'gpt-5', 'Рекомендую Турин 1: 14 900 ₽')] },
      'GET /widget/v1/evals/runs': () => ({ items: [run] }),
      'POST /widget/v1/evals/run': () => ({ id: 1 }),
      'GET /widget/v1/evals/runs/1': () => run,
    });
    const cb = createCallbacks(self, 'https://ai.test.ru');
    await act(async () => void cb.advancedSettings!());
    await flush();
    await click('Песочница');
    await flush();
    await act(async () => void document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await flush();
    const selects = document.querySelectorAll('select');
    await choose(selects[0]!, 'anthropic:claude-opus-5');
    await choose(selects[1]!, 'openai:gpt-5');
    await type(document.querySelector('textarea')!, 'Белая эмаль');
    await click('Отправить');
    await flush();
    const req = JSON.parse(calls.find((c) => c.url.endsWith('/sandbox/compare'))!.data!);
    expect(req).toEqual({ messages: [{ role: 'client', text: 'Белая эмаль' }], models: [{ provider: 'anthropic', model: 'claude-opus-5' }, { provider: 'openai', model: 'gpt-5' }] });
    const t = document.body.textContent ?? '';
    expect(t).toContain('Claude · claude-opus-5');
    expect(t).toContain('ChatGPT · gpt-5');
    expect(t).toContain('Рекомендую Турин 1: 14 900 ₽');
    expect(t.replace(/\s/g, ' ')).toContain('1 200 / 80 токенов');
    expect(t).toContain('0,9 ₽');
    expect(t).toContain('1.2 с');

    await click('▸ Прогнать eval на модели…');
    await flush();
    await click('Прогнать eval');
    await flush();
    expect(JSON.parse(calls.find((c) => c.url.endsWith('/evals/run'))!.data!)).toEqual({ models: [{ provider: 'anthropic', model: 'claude-opus-5' }, { provider: 'openai', model: 'gpt-5' }] });
    expect(document.body.textContent).toContain('идёт: 0 из 5');
    run = { ...run, status: 'done', finishedAt: '2026-09-29T10:05:00Z', progress: { done: 5, total: 5 }, results: [{ ref: { provider: 'openai', model: 'gpt-5' }, reports: [{ id: '07-x', topic: 'подбор', passed: false, failures: ['в ответе нет «замер»'], fabricated: [], final: 'reply', handoffReason: null, costUsd: 0.02, latencyMs: [900], provider: 'openai', model: 'gpt-5', fallbackUsed: false }], summary: { total: 5, passed: 4, fabricated: 0, rejections: 1, costUsd: 0.1, avgCostUsd: 0.02, p95LatencyMs: 2100, handoffExpected: 2, handoffOk: 2, fallbacks: 0 } }] };
    await act(async () => new Promise((r) => setTimeout(r, 3100)));
    await flush();
    const tt = document.body.textContent ?? '';
    expect(tt).toContain('готово');
    expect(tt).toContain('4/5');
    expect(tt).toContain('2/2');
    expect(tt).toContain('$0.02');
    expect(tt).toContain('в ответе нет «замер»');
  }, 15_000);
});

describe('панель сделки 1.1.0 (раздел 11 ТЗ)', () => {
  const panel = () => ({
    leadId: 555,
    ai: { enabled: true, mode: 'semi', paused: false, pauseReason: null, pausedAt: null },
    llm: { provider: 'anthropic', model: 'claude-sonnet-5', fallback: null, override: null, providers: ['anthropic', 'openai'], configured: true },
    health: { llmConfigured: true, dailyLimitExhausted: false, lastError: null },
    hints: [{ id: 1, leadId: 555, kind: 'draft', text: 'Добрый день! Дверь Ницца 2 эмаль…', status: 'pending', details: {}, createdAt: '2026-09-28T15:36:00Z', decidedAt: null, decidedBy: null }],
    products: [
      { type: 'product', id: '1', title: 'Ницца 2', url: 'https://rf-dveri.ru/n2', price: 14900, available: true, picture: 'https://rf-dveri.ru/n2.jpg' },
      { type: 'product', id: '2', title: 'Ницца 3', url: 'https://rf-dveri.ru/n3', price: 15900, available: false, picture: null },
      { type: 'product', id: '3', title: 'Турин 1', url: null, price: null, available: null, picture: null },
      { type: 'product', id: '4', title: 'Турин 2', url: null, price: null, available: null, picture: null },
    ],
    calculations: [{ lines: [{ name: 'Полотно', article: '1', qty: 3, unit: 'шт.', price: 14900, total: 44700, basis: 'каталог' }], total: 58700, complete: true, missing: [], doorsCount: 3 }],
    files: [
      { id: 10, name: 'замер.pdf', type: 'application/pdf', url: 'https://files/1', receivedAt: '2026-09-28T15:00:00Z', status: 'parsed', documentId: 3, kind: 'measurement', summary: 'Два проёма.', openings: 2, positions: 0 },
      { id: 11, name: 'фото.jpg', type: 'image/jpeg', url: 'https://files/2', receivedAt: '2026-09-28T15:10:00Z', status: 'unparsed', documentId: null, kind: null, summary: '', openings: 0, positions: 0 },
    ],
    tasks: [{ id: 't1', kind: 'Согласовать замер', text: 'Замер в субботу', createdAt: '2026-09-28T15:20:00Z', source: 'tool' }],
    summary: { text: 'Потребность: 3 двери.\nБюджет: 60 000 ₽.', createdAt: '2026-09-28T15:30:00Z' },
    log: [{ id: 5, kind: 'resume', summary: 'AI возвращён в диалог', costRub: 0, createdAt: '2026-09-28T15:36:00Z', provider: 'anthropic', model: 'claude-sonnet-5' }],
    costRub: 12.4,
  });

  it('блоки по порядку, модель со сменой для сделки, файлы из чата с кнопкой «Разобрать», сворачивание запоминается', async () => {
    const { self, calls } = fakeSelf('lcard', {
      'GET /widget/v1/leads/555/panel': panel,
      'GET /widget/v1/llm/models': (_d?: string, u?: URL) => ({ provider: u?.searchParams.get('provider'), models: [model(u?.searchParams.get('provider') === 'openai' ? 'gpt-5' : 'claude-sonnet-5', u?.searchParams.get('provider') ?? '')], fetchedAt: null, fromCache: false, source: 'api', noKey: false }),
      'PUT /widget/v1/leads/555/llm': { ok: true },
      'POST /widget/v1/leads/555/files/11/analyze': { id: 4, kind: 'photo', data: { kind: 'photo', title: 'Фото двери', summary: 'Дверь белая.', customer_type: 'b2c', openings: [], positions: [], requirements: [], questions: [], photo: { subject: 'дверь', door_type: null, color: 'белый', style: null, note: null } }, matches: [], kit: null, note: '', noted: true, ocr: null, piiRemoved: 0, costRub: 1 },
    });
    const cb = createCallbacks(self, 'https://ai.test.ru');
    await act(async () => void cb.render!());
    await flush();
    const t = (document.body.textContent ?? '').replace(/\s/g, ' ');
    const order = ['AI-агент', 'Полуавтоматический', 'Claude · claude-sonnet-5', '12,4 ₽ по сделке', 'Черновики на одобрение (1)', 'Ницца 2 эмаль', 'Найденные товары (4)', 'Ницца 2', '14 900 ₽', 'в наличии', 'Ещё 1', 'Расчёт', '58 700 ₽', 'В примечание', 'Файлы клиента (2)', 'замер.pdf', 'разобран: Замерный лист', 'фото.jpg', 'не разобран', 'Задачи AI (1)', 'Замер в субботу', 'Резюме диалога', 'Потребность: 3 двери.', 'Журнал AI', 'Возврат AI', 'claude-sonnet-5'];
    let pos = -1;
    for (const x of order) {
      const i = t.indexOf(x, pos + 1);
      expect(i, `«${x}» после позиции ${pos}`).toBeGreaterThan(pos);
      pos = i;
    }
    expect(document.querySelector('img[src$="/images/logo_min.png"]')).not.toBeNull();
    expect(document.querySelector('a[href$="/settings/widgets/ai_door/"]')).not.toBeNull();

    // Смена модели для этой сделки.
    await click('Claude · claude-sonnet-5 ▾');
    await flush();
    const picker = [...document.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.value === 'openai:gpt-5'))!;
    await choose(picker, 'openai:gpt-5');
    await flush();
    expect(JSON.parse(calls.find((c) => c.method === 'PUT' && c.url.endsWith('/leads/555/llm'))!.data!)).toEqual({ model: { provider: 'openai', model: 'gpt-5' } });

    // «Разобрать» у файла из чата.
    await click('Разобрать');
    await flush();
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/files/11/analyze'))).toBe(true);
    expect(document.body.textContent).toContain('Фото: дверь, белый');

    // Сворачивание блока запоминается.
    await click('Найденные товары (4) ▾');
    expect(document.body.textContent).not.toContain('Ницца 3');
    expect(JSON.parse(localStorage.getItem('ai-door-panel-collapsed') ?? '{}')).toEqual({ products: true });
    await act(async () => void cb.destroy!());
  });

  it('ошибка: красный индикатор, причина и «Повторить» перезагружает данные; без ключа провайдера — ошибка в статусе', async () => {
    let fail = true;
    const { self, calls } = fakeSelf('lcard', {
      'GET /widget/v1/leads/555/panel': () => {
        if (fail) throw { status: 0 };
        return { ...panel(), health: { llmConfigured: false, dailyLimitExhausted: false, lastError: null } };
      },
      'GET /widget/v1/llm/models': { provider: 'anthropic', models: [], fetchedAt: null, fromCache: false, source: 'tariff', noKey: true },
    });
    const cb = createCallbacks(self, 'https://ai.test.ru');
    await act(async () => void cb.render!());
    await flush();
    expect(document.body.textContent).toContain('Сервер AI-агента недоступен');
    expect(document.body.textContent).toContain('Повторить');
    fail = false;
    await click('Повторить');
    await flush();
    expect(calls.filter((c) => c.url.endsWith('/panel'))).toHaveLength(2);
    expect(document.body.textContent).toContain('Ключ провайдера не задан или недействителен');
    const dot = document.querySelector<HTMLElement>('span[style*="border-radius: 5px"]')!;
    expect(dot.style.background).toMatch(/rgb\(208, 52, 44\)|#d0342c/);
    await act(async () => void cb.destroy!());
  });
});
