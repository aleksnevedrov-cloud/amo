// @vitest-environment jsdom
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AmoWidgetSelf } from '@core/widget-core';
import { createCallbacks } from '../src/index.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Responder = unknown | ((data?: string) => unknown);

function fakeSelf(area: string, responses: Record<string, Responder>) {
  const calls: { url: string; method?: string; data?: string }[] = [];
  const self: AmoWidgetSelf = {
    get_settings: () => ({ widget_code: 'opt_agent' }),
    system: () => ({ area }),
    i18n: () => '',
    render_template: ({ render }) => document.body.insertAdjacentHTML('beforeend', render),
    $authorizedAjax: async (opts) => {
      calls.push(opts);
      const r = responses[`${opts.method} ${new URL(opts.url).pathname}`];
      if (r === undefined) throw { status: 404, responseJSON: { message: `нет ответа для ${opts.method} ${opts.url}` } };
      return typeof r === 'function' ? (r as (d?: string) => unknown)(opts.data) : r;
    },
  };
  return { self, calls };
}
const flush = () => act(async () => new Promise((r) => setTimeout(r, 20)));
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const click = (text: string) =>
  act(async () => {
    const b = button(text);
    if (!b) throw new Error(`Нет кнопки «${text}»`);
    b.click();
  });
const setInput = (el: Element | null, value: string) =>
  act(async () => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

const draft = {
  id: 7, leadId: 555, status: 'draft', kpNo: null as string | null, createdAt: '2026-10-12T10:00:00Z', builtAt: null, sentAt: null as string | null, hasDocx: false, hasPdf: false,
  client: { org: 'ООО Ромашка', fio: 'Иванов Иван', email: 'ivanov@romashka.ru', phone: '' },
  requestItems: [], requiredBlocks: ['price'], questions: ['Сторона открывания?'],
  items: [{ request_index: 0, page_id: null, name: 'Дверь ДПС 01', size: '2100×900 мм', qty: 11, price: null, lead_time: '', discount: 0 }],
  needsManager: [{ request_index: 0, reason: 'цена не задана' }],
  source: { from: 'amo_card', mails: 1, letterAt: '2026-10-09T10:00:00Z', attachments: ['Двери (3).docx', 'big.pdf'], documents: [501], skipped: [{ name: 'big.pdf', reason: 'файл больше 20 МБ' }] },
};

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  window.APP = { data: { current_card: { id: 555 } } };
});

describe('виджет «Агент опт»: карточка сделки', () => {
  it('«Собрать КП» ставит задание, блок показывает очередь, потом черновик с источником и позициями без цены', async () => {
    let stage: 'none' | 'queued' | 'done' = 'none';
    const { self, calls } = fakeSelf('lcard', {
      'GET /widget/v1/kp/draft': () => (stage === 'none' ? { draft: null, job: null } : stage === 'queued' ? { draft: null, job: { state: 'queued' } } : { draft, job: null }),
      'POST /widget/v1/kp/draft': (data?: string) => {
        expect(JSON.parse(data ?? '{}')).toEqual({ leadId: 555 });
        stage = 'queued';
        return { queued: true };
      },
    });
    const cbs = createCallbacks(self, 'https://opt.test.ru');
    await act(async () => cbs.render!());
    await flush();
    expect(document.body.textContent).toContain('КП по этой сделке ещё не собирали');
    await click('Собрать КП');
    await flush();
    expect(document.body.textContent).toContain('В очереди…');
    expect(button('Собрать КП')?.disabled).toBe(true);
    // Воркер закончил — следующий опрос приносит черновик.
    stage = 'done';
    await act(async () => cbs.render!());
    await flush();
    expect(document.body.textContent).toContain('Покупатель: ООО Ромашка, Иванов Иван · ivanov@romashka.ru');
    expect(document.body.textContent).toContain('Источник: письмо от 09.10.2026, разобрано файлов: 1');
    expect(document.body.textContent).toContain('Файл «big.pdf» пропущен: файл больше 20 МБ');
    expect(document.body.textContent).toContain('Дверь ДПС 01');
    expect(document.body.textContent).toContain('Сторона открывания?');
    expect(button('Собрать документ')?.disabled).toBe(true);
    expect(button('Отправить клиенту')?.disabled).toBe(true);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('ошибка задания показывается текстом, кнопка снова доступна', async () => {
    const { self } = fakeSelf('lcard', { 'GET /widget/v1/kp/draft': { draft: null, job: { state: 'failed', error: 'LLM не настроена' } } });
    const cbs = createCallbacks(self, 'https://opt.test.ru');
    await act(async () => cbs.render!());
    await flush();
    expect(document.body.textContent).toContain('Черновик не собран: LLM не настроена');
    expect(button('Собрать КП')?.disabled).toBe(false);
  });

  it('цена → сохранить → собрать документ → окно предпросмотра → отправка только по кнопке', async () => {
    let current = { ...draft };
    const sent: string[] = [];
    const { self } = fakeSelf('lcard', {
      'GET /widget/v1/kp/draft': () => ({ draft: current, job: null }),
      'PUT /widget/v1/kp/draft/7': (data?: string) => {
        current = { ...current, items: JSON.parse(data ?? '{}').items };
        return { draft: current };
      },
      'POST /widget/v1/kp/build': () => {
        current = { ...current, status: 'built', kpNo: 'КП-2026-1', hasDocx: true, hasPdf: true };
        return { draft: current, pdf: true, attached: ['KP-КП-2026-1.pdf'] };
      },
      'GET /widget/v1/kp/send/preview': { to: 'ivanov@romashka.ru', cc: '', subject: 'Коммерческое предложение КП-2026-1', text: 'Здравствуйте!', signature: 'Иван', attachment: { name: 'KP-КП-2026-1.pdf', bytes: 120_000 }, blockers: [], warnings: [], alreadySent: false },
      'POST /widget/v1/kp/send': (data?: string) => {
        sent.push(data ?? '');
        current = { ...current, status: 'sent', sentAt: '2026-10-12T12:00:00Z' };
        return { draft: current, to: 'ivanov@romashka.ru' };
      },
    });
    const cbs = createCallbacks(self, 'https://opt.test.ru');
    await act(async () => cbs.render!());
    await flush();
    await setInput(document.querySelector('input[placeholder="нет цены"]'), '14900');
    expect(button('Собрать документ')?.disabled).toBe(true);
    await click('Сохранить правки');
    await flush();
    expect(document.body.textContent?.replace(/\u00a0/g, ' ')).toContain('Итого: 163 900 ₽');
    await click('Собрать документ');
    await flush();
    expect(document.body.textContent).toContain('КП-2026-1 · документ собран');
    expect(document.body.textContent).toContain('Документ собран (DOCX и PDF)');
    await click('Отправить клиенту');
    await flush();
    expect(document.body.textContent).toContain('Вложение: KP-КП-2026-1.pdf (117 КБ)');
    expect(sent).toHaveLength(0);
    // Адрес правится в окне; кривой адрес блокирует кнопку.
    const to = [...document.querySelectorAll('input')].find((i) => i.value === 'ivanov@romashka.ru')!;
    await setInput(to, 'кривой');
    expect(document.body.textContent).toContain('Нельзя отправить: адрес получателя пустой или не похож на e-mail');
    await setInput(to, 'buyer@romashka.ru');
    await click('Проверено, отправить');
    await flush();
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toMatchObject({ draftId: 7, to: 'buyer@romashka.ru', subject: 'Коммерческое предложение КП-2026-1', text: 'Здравствуйте!', resendConfirmed: false });
    expect(document.body.textContent).toContain('отправлено');
    expect(document.getElementById('ai-door-opt-styles')).toBeNull(); // в тестах define __STYLES__ нет — тег не вставляется
  });
});

describe('виджет «Агент опт»: настройки', () => {
  const settings = {
    model: { provider: 'openai', model: 'gpt-5.5', fallbackModel: 'gpt-5.1', fallbackProvider: null, effort: 'low', maxTokens: 4096 },
    vision: { provider: 'tesseract', photosToClaude: false, maxFilesPerDay: 100 },
    mail: { smtpHost: '', smtpPort: 465, smtpSecure: true, username: '', fromName: 'РФ-Двери', fromAddress: '', cc: '', subject: 'Коммерческое предложение {kpNo}', text: 'Здравствуйте!', signature: '' },
    billing: { usdRubRate: 90, pricing: {} },
  };

  it('вкладки КП, Модель, Письмо, Журнал; письмо сохраняется вместе с паролем', async () => {
    const saved: string[] = [];
    const { self } = fakeSelf('settings', {
      'GET /widget/v1/kp/settings': { constants: { vatRate: 22 }, certsDir: null, numbering: { prefix: 'КП', year: null, counter: 0 }, template: { exists: false, name: null, md5: null, updatedAt: null } },
      'GET /widget/v1/settings': { settings, version: 1 },
      'PUT /widget/v1/settings': (data?: string) => {
        saved.push(data ?? '');
        return { settings: JSON.parse(data ?? '{}'), version: 2 };
      },
      'PUT /widget/v1/settings/smtp-password': (data?: string) => {
        saved.push(data ?? '');
        return { ok: true };
      },
      'GET /widget/v1/llm/keys': { provider: 'openai', fallbackProvider: 'openai', keys: { openai: { saved: true, mask: 'sk-…ab12', source: 'account' }, anthropic: { saved: false, mask: null, source: null } }, providers: ['openai'] },
      'GET /widget/v1/llm/models': { provider: 'openai', models: [{ id: 'gpt-5.5', name: 'GPT-5.5', price: { input: 1.25, output: 10 } }], fetchedAt: null, fromCache: false, source: 'api', noKey: false },
      'GET /widget/v1/journal': { items: [{ id: 1, leadId: 555, kind: 'kp_sent', summary: 'КП КП-2026-1 отправлено на ivanov@romashka.ru', details: {}, costRub: 0, createdAt: '2026-10-12T12:00:00Z' }] },
    });
    document.body.innerHTML = '<div id="work-area-opt_agent"></div>';
    const cbs = createCallbacks(self, 'https://opt.test.ru');
    await act(async () => cbs.advancedSettings!());
    await flush();
    expect(document.body.textContent).toContain('Шаблон ещё не загружен');
    await click('Модель');
    await flush();
    expect(document.body.textContent).toContain('Сохранён ключ sk-…ab12');
    expect(document.body.textContent).toContain('GPT-5.5 · $1.25/$10 за 1M');
    await click('Письмо');
    await flush();
    const inputs = [...document.querySelectorAll('input')];
    await setInput(inputs.find((i) => i.value === '')!, 'smtp.yandex.ru');
    await setInput(document.querySelector('input[type=password]'), 'secret');
    await click('Сохранить');
    await flush();
    expect(saved).toHaveLength(2);
    expect(JSON.parse(saved[0]!).mail).toMatchObject({ smtpHost: 'smtp.yandex.ru', smtpPort: 465 });
    expect(JSON.parse(saved[1]!)).toEqual({ password: 'secret' });
    expect(document.body.textContent).toContain('Сохранено (версия 2)');
    await click('Журнал сборок');
    await flush();
    expect(document.body.textContent).toContain('КП КП-2026-1 отправлено на ivanov@romashka.ru');
  });
});
