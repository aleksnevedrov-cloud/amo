// @vitest-environment jsdom
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
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

const panel = {
  leadId: 555,
  ai: { enabled: true, mode: 'auto', paused: false, pauseReason: null, pausedAt: null },
  hints: [],
  products: [],
  calculations: [],
  log: [],
  costRub: 0,
};

const result = {
  id: 1,
  kind: 'measurement',
  data: {
    kind: 'measurement',
    title: 'Замерный лист',
    summary: 'Два проёма.',
    customer_type: 'b2c',
    openings: [
      { room: 'Спальня', label: null, width_mm: 838, height_mm: 2050, wall_mm: 105, leaf_width_mm: null, qty: 1, double: null, side: null, note: null },
      { room: 'Зал', label: null, width_mm: 1400, height_mm: 2060, wall_mm: 235, leaf_width_mm: null, qty: 1, double: true, side: null, note: null },
    ],
    positions: [],
    requirements: [],
    questions: ['Цвет?'],
    photo: null,
  },
  matches: [],
  kit: {
    lines: [
      { opening: 'Спальня', double: false, qty: 1, leaf_width_mm: 700, leaf_height_mm: 2000, nonstandard: false, boxes: 2.5, casings: 5, extensions: 2.5, extension_width_mm: 100 },
      { opening: 'Зал', double: true, qty: 1, leaf_width_mm: 1320, leaf_height_mm: 2000, nonstandard: true, boxes: 3, casings: 6, extensions: 3, extension_width_mm: 250 },
    ],
    totals: { doors: 2, boxes: 5.5, casings: 11, extensions: 5.5 },
  },
  note: '[AI] Разбор файла',
  noted: true,
  ocr: 'yandex',
  piiRemoved: 3,
  costRub: 2.5,
};

beforeEach(() => {
  document.body.innerHTML = '';
  window.APP = { data: { current_card: { id: 555 } } };
});

describe('панель сделки: файлы клиента', () => {
  it('файл уходит в base64, результат разбора показан таблицей', async () => {
    let listed: unknown[] = [];
    const { self, calls } = fakeSelf('lcard', {
      'GET /widget/v1/leads/555/panel': panel,
      'GET /widget/v1/leads/555/documents': () => ({ items: listed }),
      'POST /widget/v1/leads/555/documents': () => {
        listed = [{ id: 1, filename: 'замер.jpg', kind: 'measurement', source: 'widget', title: 'Замерный лист', summary: 'Два проёма.', openings: 2, positions: 0, createdAt: '2026-09-25T10:00:00Z' }];
        return result;
      },
    });
    const cb = createCallbacks(self, 'https://ai.test.ru');
    await act(async () => void cb.render!());
    await flush();
    expect(document.body.textContent).toContain('Разобрать файл');

    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File([new Uint8Array([1, 2, 3])], 'замер.jpg', { type: 'image/jpeg' });
    Object.defineProperty(input, 'files', { value: [file] });
    await act(async () => void input.dispatchEvent(new Event('change', { bubbles: true })));
    await flush();
    await flush();

    const upload = calls.find((c) => c.method === 'POST' && c.url.endsWith('/leads/555/documents'));
    expect(JSON.parse(upload!.data!)).toEqual({ name: 'замер.jpg', mime: 'image/jpeg', file: 'AQID' });
    const t = document.body.textContent ?? '';
    expect(t).toContain('Замерный лист');
    expect(t).toContain('838×2050');
    expect(t).toContain('700×2000');
    expect(t).toContain('нестандарт');
    expect(t).toContain('Комплект: полотен 2, коробок 5.5, наличников 11, доборов 5.5');
    expect(t).toContain('Примечание добавлено в сделку');
    expect(t).toContain('Yandex Vision');
    expect(t).toContain('Уточнить у клиента: Цвет?');
    // Список разобранных обновился.
    expect(t).toContain('проёмов: 2');
  });

  it('ошибка сервера показывается менеджеру', async () => {
    const { self } = fakeSelf('lcard', {
      'GET /widget/v1/leads/555/panel': panel,
      'GET /widget/v1/leads/555/documents': { items: [] },
      'POST /widget/v1/leads/555/documents': () => {
        throw { responseJSON: { message: 'Формат не поддерживается: план.dwg' } };
      },
    });
    const cb = createCallbacks(self, 'https://ai.test.ru');
    await act(async () => void cb.render!());
    await flush();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'план.dwg')] });
    await act(async () => void input.dispatchEvent(new Event('change', { bubbles: true })));
    await flush();
    await flush();
    expect(document.body.textContent).toContain('Формат не поддерживается: план.dwg');
  });
});
