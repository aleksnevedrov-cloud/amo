// @vitest-environment jsdom
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AmoWidgetSelf } from '@ai-door/widget-core';
import { createCallbacks } from '../src/index.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeSelf(area: string, responses: Record<string, unknown | ((data?: string) => unknown)>) {
  const calls: { url: string; method?: string; data?: string }[] = [];
  const self: AmoWidgetSelf = {
    get_settings: () => ({ widget_code: 'ai_door_kp' }),
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

const draft = {
  id: 7, leadId: 555, status: 'draft', kpNo: null, createdAt: '2026-10-12T10:00:00Z', builtAt: null, sentAt: null, hasDocx: false, hasPdf: false,
  client: { org: 'ООО Ромашка', fio: 'Иванов', email: 'i@romashka.ru', phone: '' },
  requestItems: [{ raw: 'Турин 1 2000*800 — 2 шт', name: 'Турин 1', width_mm: 800, height_mm: 2000, qty: 2 }],
  candidates: [], components: [], requiredBlocks: ['price'], questions: ['Нужен ли монтаж?'],
  items: [{ request_index: 0, page_id: '1001', name: 'Турин 1 эмаль белая', size: '2000×800 мм', qty: 2, price: 14900, lead_time: '5 дн.', discount: 0 }],
  needsManager: [],
};

beforeEach(() => {
  document.body.innerHTML = '';
  window.APP = { data: { current_card: { id: 555 } } };
});

describe('виджет «АИ-агент КП»', () => {
  it('карточка сделки: без черновика — кнопка «Подготовить КП», после неё — таблица позиций с ценами каталога', async () => {
    let made = false;
    const { self, calls } = fakeSelf('lcard', {
      'GET /widget/v1/kp/draft': () => ({ draft: made ? draft : null }),
      'POST /widget/v1/kp/draft': (data?: string) => {
        expect(JSON.parse(data ?? '{}')).toEqual({ leadId: 555 });
        made = true;
        return { draft };
      },
    });
    const cbs = createCallbacks(self, 'https://ai.test.ru');
    await act(async () => cbs.render!());
    await flush();
    expect(document.body.textContent).toContain('КП по этой сделке ещё не готовили');
    await click('Подготовить КП');
    await flush();
    expect(document.body.textContent).toContain('Покупатель: ООО Ромашка, Иванов');
    expect(document.body.textContent).toContain('Турин 1 эмаль белая');
    expect(document.body.textContent).toContain('Нужен ли монтаж?');
    expect((document.querySelector('input[type=number][min="0"]') as HTMLInputElement).value).toBe('14900');
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['GET /widget/v1/kp/draft', 'POST /widget/v1/kp/draft']);
    // Отправка недоступна, пока документ не собран.
    const send = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Отправить') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });

  it('страница настроек: константы КП и шаблон; сохранение уходит PUT', async () => {
    const { self, calls } = fakeSelf('settings', {
      'GET /widget/v1/kp/settings': {
        constants: { sellerName: 'ООО "РУС-ДВЕРИ"', vatRate: 22, validDays: 12 },
        certsDir: null,
        numbering: { prefix: 'КП', year: null, counter: 0 },
        template: { exists: true, name: 'kp.docx', md5: 'abc', updatedAt: '2026-10-01T00:00:00Z' },
      },
      'PUT /widget/v1/kp/settings': { ok: true },
    });
    document.body.innerHTML = '<div id="work-area-ai_door_kp"></div>';
    const cbs = createCallbacks(self, 'https://ai.test.ru');
    await act(async () => cbs.advancedSettings!());
    await flush();
    expect(document.body.textContent).toContain('Загружен: kp.docx, md5 abc');
    expect(document.body.textContent).toContain('Следующий номер: КП-');
    await click('Сохранить');
    await flush();
    const put = calls.find((c) => c.method === 'PUT');
    expect(JSON.parse(put!.data!)).toMatchObject({ constants: { sellerName: 'ООО "РУС-ДВЕРИ"', vatRate: 22 }, numbering: { prefix: 'КП', counter: 0 } });
    expect(document.body.textContent).toContain('Сохранено');
  });

  it('ошибка сервера показывается текстом, карточка не ломается', async () => {
    const { self } = fakeSelf('lcard', { 'GET /widget/v1/kp/draft': { draft: null }, 'POST /widget/v1/kp/draft': () => { throw { status: 502, responseJSON: { message: 'Шаблон не загружен' } }; } });
    const cbs = createCallbacks(self, 'https://ai.test.ru');
    await act(async () => cbs.render!());
    await flush();
    await click('Подготовить КП');
    await flush();
    expect(document.body.textContent).toContain('Шаблон не загружен');
    await act(async () => cbs.destroy!());
  });
});
