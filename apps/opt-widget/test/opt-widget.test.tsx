// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AmoWidgetSelf } from '@core/widget-core';
import { createCallbacks } from '../src/index.tsx';
import { Section } from '../src/components/KpBlock.tsx';

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
      const key = `${opts.method} ${new URL(opts.url).pathname}`;
      // Состояние поиска цен запрашивается при каждом показе черновика; по умолчанию — поиска не было.
      const r = key === 'GET /widget/v1/kp/research' && responses[key] === undefined ? { draftId: 7, pending: false, positions: [] } : responses[key];
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

/** KP-AGENT-V2, п. 6а: работа с КП — в окне «Развернуть ⤢»; кнопки окна ищутся внутри него (в узкой колонке есть свои). */
const expand = () => click('Развернуть ⤢');
const modal = () => document.querySelector('.opt-kp-modal');
const modalButton = (text: string) => [...(modal()?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const clickIn = (text: string) =>
  act(async () => {
    const b = modalButton(text);
    if (!b) throw new Error(`Нет кнопки «${text}» в окне КП`);
    b.click();
  });
const tab = (prefix: string) =>
  act(async () => {
    const b = [...document.querySelectorAll<HTMLButtonElement>('.opt-kp-tab')].find((x) => x.textContent?.startsWith(prefix));
    if (!b) throw new Error(`Нет вкладки «${prefix}»`);
    b.click();
  });
const plainText = () => document.body.textContent?.replace(/\u00a0/g, ' ') ?? '';
const priceInputs = () => [...document.querySelectorAll<HTMLInputElement>('.opt-kp-table input[aria-label="Цена"]')];
const badges = () => [...document.querySelectorAll('.opt-kp-table .opt-kp-src')].map((b) => [b.className.replace('opt-kp-src opt-kp-src-', ''), b.textContent]);

describe('старые черновики и сбой раздела (виджет 2.0.8)', () => {
  it('черновик формата 12.10 (без requirements, photos, survey, counters, source.skipped) → блок и окно открываются без «не удалось отобразить блок»', async () => {
    // Как отвечал бы старый сервер / как лежит старый черновик: половины полей KP-AGENT-V2 нет, у source нет skipped и documents.
    const oldDraft = {
      id: 8, leadId: 29996635, status: 'draft', kpNo: null, createdAt: '2026-10-12T10:00:00Z', builtAt: null, sentAt: null, hasDocx: false, hasPdf: false,
      client: { org: 'ООО Ромашка', email: 'ivanov@romashka.ru' },
      requestItems: [{ raw: 'ДПС 01', name: 'Дверь ДПС 01', width_mm: 900, height_mm: 2100, qty: 11 }],
      items: [{ request_index: 0, name: 'Дверь ДПС 01', size: '2100×900 мм', qty: 11, price: null }],
      requiredBlocks: ['price'], questions: ['Сторона открывания?'], needsManager: [{ request_index: 0, reason: 'цена не задана' }],
      source: { from: 'amo_card', mails: 1, letterAt: '2026-10-09T10:00:00Z', attachments: ['Двери (3).docx'] },
    };
    const { self } = fakeSelf('lcard', { 'GET /widget/v1/kp/draft': { draft: oldDraft, job: null } });
    const cbs = createCallbacks(self, 'https://opt.test.ru');
    await act(async () => cbs.render!());
    await flush();
    expect(plainText()).not.toContain('не удалось отобразить блок');
    expect(plainText()).toContain('Черновик КП');
    expect(plainText()).toContain('позиций 1');
    await expand();
    expect(modal()).not.toBeNull();
    expect(plainText()).toContain('Дверь ДПС 01');
    await tab('Письмо и файлы');
    expect(plainText()).toContain('Сторона открывания?');
    await tab('Опросник');
    expect(plainText()).not.toContain('не удалось отобразить блок');
    expect(document.querySelectorAll('.opt-kp-section-failed')).toHaveLength(0);
  });

  it('ошибка рендера одного раздела → пометка «<раздел>: нет данных», остальное на месте', async () => {
    const Boom = () => {
      throw new Error('битые данные раздела');
    };
    const silent = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <div>
          <span>Шапка</span>
          <Section name="Позиции">
            <Boom />
          </Section>
          <span>Итог</span>
        </div>,
      ),
    );
    expect(host.textContent).toBe('ШапкаПозиции: нет данныхИтог');
    expect(host.querySelectorAll('.opt-kp-section-failed')).toHaveLength(1);
    expect(silent).toHaveBeenCalled();
    silent.mockRestore();
    await act(async () => root.unmount());
  });
});

describe('виджет «Агент опт»: карточка сделки', () => {
  it('«Собрать КП» ставит задание, блок показывает очередь, потом сводку в узкой колонке; «Развернуть ⤢» — окно с вкладками, таблицей и строкой доставки', async () => {
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
    stage = 'done';
    await act(async () => cbs.render!());
    await flush();
    // Узкая колонка: бейдж статуса, номер, счётчики и две кнопки; таблицы и полей в колонке нет.
    expect(document.querySelector('.opt-kp-badge')?.textContent).toBe('Черновик');
    expect(document.body.textContent).toContain('Номер появится после сборки документа');
    expect(document.querySelectorAll('.opt-kp-card')).toHaveLength(1);
    expect(document.querySelector('.opt-kp-counters')?.textContent).toBe('позиций 1вопросов 0без цены 1');
    expect([...document.querySelectorAll('.opt-kp-narrow .opt-actions .opt-btn')].map((b) => b.textContent)).toEqual(['Развернуть ⤢', 'Собрать документ']);
    expect(button('Собрать документ')?.disabled).toBe(true);
    expect(button('Собрать документ')?.title).toBe('Ни у одной позиции нет цены');
    expect(document.querySelector('.opt-kp-table')).toBeNull();
    expect(document.querySelectorAll('.opt-error')).toHaveLength(0);
    // Окно на 88 %: шапка с кнопками, вкладки, таблица и опросник справа.
    await expand();
    expect(modal()).not.toBeNull();
    expect(modal()?.getAttribute('aria-label')).toBe('КП по сделке');
    expect([...document.querySelectorAll('.opt-kp-tab')].map((t) => t.textContent)).toEqual(['Позиции', 'Опросник (0)', 'Письмо и файлы', 'База знаний', 'Журнал']);
    expect([...document.querySelectorAll('.opt-kp-modal-actions > .opt-btn')].map((b) => b.textContent)).toEqual(['Найти цены', 'Пересчитать', 'Сохранить правки', 'Собрать заново', 'Собрать документ', 'Отправить клиенту', '✕']);
    expect(modalButton('Найти цены')?.disabled).toBe(false);
    expect(modalButton('Сохранить правки')?.disabled).toBe(true);
    expect(modalButton('Отправить клиенту')?.disabled).toBe(true);
    expect([...document.querySelectorAll('.opt-kp-table th')].map((t) => t.textContent)).toEqual(['№', 'Позиция', 'Размер', 'Кол-во', 'Цена с НДС', 'Скидка, %', 'Сумма']);
    const row = document.querySelector('.opt-kp-row')!;
    expect(row.querySelector('.opt-kp-row-name')?.textContent).toBe('Дверь ДПС 01');
    expect(row.querySelector('.opt-kp-col-size')?.textContent).toBe('2100 × 900 мм');
    // KP-NAME: без строки прайса под названием нет «по прайсу» и комплектации.
    expect(row.querySelector('.opt-kp-row-model')).toBeNull();
    expect(row.querySelector('.opt-kp-row-equipment')).toBeNull();
    expect(badges()).toEqual([['none', 'нет цены']]);
    // Последняя строка — доставка; ответа ещё нет.
    expect(document.querySelector('.opt-kp-row-delivery')?.textContent).toContain('Доставкане указана — вопрос в опроснике');
    expect(document.querySelector('.opt-kp-panel-title')?.textContent).toBe('Опросник (0)');
    expect(plainText()).toContain('Итого с НДС 0 ₽ · в т.ч. НДС 22 % — 0 ₽');
    expect(plainText()).toContain('Срок действия цены: не задан — вопрос в опроснике');
    expect(plainText()).toContain('Документ не собирается: Ни у одной позиции нет цены');
    // «Письмо и файлы»: покупатель, письмо, что уточнить у клиента.
    await tab('Письмо и файлы');
    expect(document.querySelector('.opt-kp-buyer')?.textContent).toBe('ПокупательООО Ромашка · Иванов Иванivanov@romashka.ru');
    expect(document.body.textContent).toContain('Письмо: 09.10.2026 (из карточки, ящик не настроен) ›');
    expect(document.body.textContent).not.toContain('big.pdf');
    await click('Письмо: 09.10.2026 (из карточки, ящик не настроен) ›');
    expect(document.body.textContent).toContain('Разобрано файлов: 1 · писем в карточке: 1');
    expect(document.body.textContent).toContain('«big.pdf»: файл больше 20 МБ');
    expect([...document.querySelectorAll('.opt-kp-questions li')].map((l) => l.textContent)).toEqual(['Сторона открывания?']);
    // ✕ закрывает окно.
    await clickIn('✕');
    expect(modal()).toBeNull();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('вкладка «Письмо и файлы»: строка-статус с датой по МСК и числом вложений, по клику — отправитель, тема, папка, вложения со статусом; e-mail покупателя не дублируется', async () => {
    const mailDraft = {
      ...draft,
      client: { org: '', fio: 'stoptpostavka@yandex.ru', email: 'StOptPostavka@yandex.ru', phone: '' },
      letterText: 'Добрый день! Прошу КП на двери по ТЗ.',
      requirements: ['Место поставки: г. Москва, ул. Строителей, 1'],
      photos: [{ name: 'IMG_01.jpg' }],
      source: {
        from: 'mailbox', mails: 1, letterAt: '2026-10-13T08:06:00Z', attachments: ['Карточка (1).doc', 'photo.jpg'], documents: [501], skipped: [{ name: 'Карточка (1).doc', reason: 'LibreOffice: .doc → .docx не удалось: пусто' }],
        mail: {
          status: 'found', searchedFrom: 'stoptpostavka@yandex.ru', from: 'stoptpostavka@yandex.ru', fromName: 'Стройоптпоставка', subject: 'Запрос ООО Стройоптпоставка', date: '2026-10-13T08:06:00Z', folder: 'INBOX', matchedBy: 'address',
          attachments: 3, taken: ['Карточка (1).doc', 'photo.jpg'], uploaded: ['photo.jpg'], skipped: [{ name: 'logo.png', reason: 'встроенная картинка меньше 20 КБ' }],
          files: [
            { name: 'logo.png', size: 3_000, inline: true, status: 'skipped', reason: 'встроенная картинка меньше 20 КБ' },
            { name: 'Карточка (1).doc', size: 48_000, inline: false, status: 'not_uploaded', reason: 'привязка файла f-1 к сделке: PUT … → HTTP 405: {}' },
            { name: 'photo.jpg', size: 1_300_000, inline: false, status: 'uploaded', reason: null },
          ],
          error: null, retryAt: null, diag: null,
        },
      },
    };
    const { self, calls } = fakeSelf('lcard', { 'GET /widget/v1/kp/draft': { draft: mailDraft, job: null } });
    const cbs = createCallbacks(self, 'https://opt.test.ru');
    await act(async () => cbs.render!());
    await flush();
    await expand();
    await tab('Письмо и файлы');
    const text = () => document.body.textContent ?? '';
    // Дубль e-mail убран: имя контакта в amo — тот же адрес.
    expect(document.querySelector('.opt-kp-buyer')?.textContent).toBe('ПокупательStOptPostavka@yandex.ru');
    expect(text().match(/stoptpostavka@yandex\.ru/gi)).toHaveLength(1);
    // Текст письма, требования заявки и фото-образец без позиции.
    expect(document.querySelector('.opt-kp-letter')?.textContent).toBe('Добрый день! Прошу КП на двери по ТЗ.');
    expect(text()).toContain('Требования заявкиМесто поставки: г. Москва, ул. Строителей, 1');
    expect(text()).toContain('IMG_01.jpg — вопрос в опроснике');
    // Свёрнуто: только строка-статус, 08:06 UTC = 11:06 МСК; служебных сведений и красных строк нет.
    expect(text()).toContain('Письмо: 13.10.2026 11:06 · 3 вложения ›');
    expect(text()).not.toContain('Отправитель');
    expect(text()).not.toContain('HTTP 405');
    expect(document.querySelectorAll('.opt-error')).toHaveLength(0);
    await click('Письмо: 13.10.2026 11:06 · 3 вложения ›');
    expect(text()).toContain('Письмо: 13.10.2026 11:06 · 3 вложения ⌄');
    expect(text()).toContain('Отправитель: Стройоптпоставка stoptpostavka@yandex.ru');
    expect(text()).toContain('Тема: Запрос ООО Стройоптпоставка');
    expect(text()).toContain('Папка: INBOX');
    expect(text()).toContain('photo.jpg (1.2 МБ) — загружено в сделку');
    expect(text()).toContain('Карточка (1).doc (47 КБ) — не загружено: привязка файла f-1 к сделке: PUT … → HTTP 405: {}');
    expect(text()).toContain('не разобрано: LibreOffice: .doc → .docx не удалось: пусто');
    expect(text()).toContain('logo.png (3 КБ) — пропущено: встроенная картинка меньше 20 КБ');
    expect(text()).toContain('Разобрано файлов: 1');
    await click('Письмо: 13.10.2026 11:06 · 3 вложения ⌄');
    expect(text()).not.toContain('Папка: INBOX');
    // Новых запросов к почте виджет не делает — только черновик и состояние поиска цен.
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['GET /widget/v1/kp/draft', 'GET /widget/v1/kp/research']);
  });

  it('письмо не найдено: строка «Письмо: не найдено», в раскрытии — критерии поиска и папки из diag', async () => {
    const nf = {
      ...draft,
      source: {
        ...draft.source,
        mail: {
          status: 'not_found', searchedFrom: 'ivanov@romashka.ru', from: null, fromName: null, subject: '', date: null, folder: null, matchedBy: null, attachments: 0, taken: [], uploaded: [], skipped: [], files: [], error: null, retryAt: null,
          diag: { criteria: { from: 'ivanov@romashka.ru', domain: 'romashka.ru', since: '2026-10-07', before: '2026-10-12', subject: 'Запрос КП' }, folders: [{ path: 'INBOX', inWindow: 12, bySender: 0, scannedWithoutDate: 200, bySenderWithoutDate: 0 }, { path: 'Spam', inWindow: 1, bySender: 0 }], skippedFolders: ['Sent', 'Drafts'], fallbackWithoutDate: false, errors: ['Spam: SEARCH по дате прерван по таймауту (30 с), переподключение'] },
        },
      },
    };
    const { self } = fakeSelf('lcard', { 'GET /widget/v1/kp/draft': { draft: nf, job: null } });
    const cbs = createCallbacks(self, 'https://opt.test.ru');
    await act(async () => cbs.render!());
    await flush();
    await expand();
    await tab('Письмо и файлы');
    expect(document.body.textContent).toContain('Письмо: не найдено ›');
    expect(document.querySelectorAll('.opt-error')).toHaveLength(0);
    await click('Письмо: не найдено ›');
    expect(document.body.textContent).toContain('Искали от ivanov@romashka.ru (и весь домен @romashka.ru), даты 2026-10-07 – 2026-10-12, тема «Запрос КП». Черновик собран по карточке.');
    expect(document.body.textContent).toContain('Папки (2):INBOX: в окне дат 12, от отправителя 0Spam: в окне дат 1, от отправителя 0');
    expect(document.body.textContent).toContain('Не смотрели: Sent, Drafts');
    expect(document.body.textContent).toContain('Spam: SEARCH по дате прерван по таймауту');
  });

  it('поиск цен: «Найти цены» ставит задание, строка показывает ход поиска, затем цену из прайса с зелёной меткой; работа — под заголовком, без цены и поиска; «Найти цену» у позиции — по одной строке', async () => {
    // Вторая строка — работа (XLSX-2): после товаров под заголовком «Работы и услуги», без размера и без кнопки поиска цены.
    const service = { request_index: 1, page_id: null, name: 'Врезка замка на производстве', size: '', qty: 21, price: null, lead_time: '', discount: 0, kind: 'service' as const };
    let current = { ...draft, items: [...draft.items, service], needsManager: [{ request_index: 0, reason: 'цена не задана' }, { request_index: 1, reason: 'цена не задана' }] };
    let stage: 'idle' | 'running' | 'done' = 'idle';
    const posts: string[] = [];
    const { self } = fakeSelf('lcard', {
      'GET /widget/v1/kp/draft': () => ({ draft: current, job: null }),
      'GET /widget/v1/kp/research': () => ({ draftId: 7, pending: stage === 'running', positions: [{ requestIndex: 0, job: stage === 'running' ? { state: 'running' } : null, research: null }] }),
      'POST /widget/v1/kp/research': (data?: string) => {
        posts.push(data ?? '');
        stage = 'running';
        return { queued: [0] };
      },
    });
    const cbs = createCallbacks(self, 'https://opt.test.ru');
    await act(async () => cbs.render!());
    await flush();
    await expand();
    expect(modalButton('Найти цены')?.disabled).toBe(false);
    expect([...document.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Найти цену')).toHaveLength(1);
    expect([...document.querySelectorAll('.opt-kp-group')].map((g) => g.textContent)).toEqual(['Работы и услуги — по замеру, в таблицу и итог КП не входят']);
    expect(document.querySelector('.opt-kp-row-service')?.textContent).toContain('Врезка замка на производстве');
    expect(document.querySelector('.opt-kp-row-service .opt-kp-col-price')?.textContent).toBe('по замеру');
    await clickIn('Найти цены');
    await flush();
    expect(JSON.parse(posts[0]!)).toEqual({ draftId: 7, requestIndexes: 'all' });
    expect(plainText()).toContain('идёт поиск цены…');
    // KB-COMPONENTS, п. 6: на кнопке прогресс «обработано / поставлено».
    const searching = [...document.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Ищу цены…'));
    expect(searching?.disabled).toBe(true);
    expect(searching?.textContent).toBe('Ищу цены… 0 / 1');
    // Воркер закончил: цена из прайса легла в черновик, следующий опрос перечитывает черновик.
    stage = 'done';
    current = { ...current, items: [{ ...current.items[0]!, price: 108_900, priceSource: 'price_file', priceLabel: 'по прайсу: Лиственница 2П (строка 3)', priceOutcome: 'priced', kbPriceId: 3 }, service], needsManager: [{ request_index: 0, reason: 'цена из базы: пересчёт по площади с 1000×2700' }] } as unknown as typeof current;
    await act(async () => cbs.render!());
    await flush();
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    // Повторная отрисовка amoCRM монтирует блок заново — окно снова по кнопке.
    await expand();
    expect(priceInputs().map((i) => i.value)).toEqual(['108900']);
    expect(badges()).toEqual([['price', 'по прайсу: Лиственница 2П (строка 3)']]);
    expect(plainText()).toContain('цена из базы: пересчёт по площади с 1000×2700');
    // Работа без цены не мешает сборке и не входит в итог (108 900 × 11 шт = 1 197 900).
    expect(modalButton('Собрать документ')?.disabled).toBe(false);
    expect(plainText()).toContain('Итого с НДС 1 197 900 ₽ · в т.ч. НДС 22 % — 216 015 ₽');
    expect(document.querySelector('.opt-kp-row .opt-kp-col-sum')?.textContent?.replace(/\u00a0/g, ' ')).toBe('1 197 900 ₽');
    // «Найти цену» у позиции — только эта строка.
    await click('Найти цену');
    expect(JSON.parse(posts[1]!)).toEqual({ draftId: 7, requestIndexes: [0] });
    stage = 'done';
    await act(async () => cbs.render!());
    await flush();
    await expand();
    // Правка цены руками — метка «изменено менеджером», сохранение включается.
    await setInput(priceInputs()[0]!, '100000');
    expect(badges()).toEqual([['manager', 'изменено менеджером']]);
    expect(modalButton('Сохранить правки')?.disabled).toBe(false);
    expect(modalButton('Собрать документ')?.title).toBe('Сначала сохраните правки');
  });

  it('KP-WIDGET-REFRESH: поиск завершился мгновенно (цены из прайса) — после POST research виджет перечитывает черновик и показывает цены без F5', async () => {
    const item = (i: number, price: number | null) => ({ request_index: i, page_id: null, name: `Дверной блок ${i + 1}`, size: '910×2100 мм', qty: 1, price, lead_time: '', discount: 0, ...(price ? { priceSource: 'price_file' as const, priceLabel: 'по прайсу: ДВ CPL (строка 5)', priceStale: false, kbPriceId: 5 } : {}) });
    let current = { ...draft, id: 54, items: [item(0, null), item(1, null), item(2, null)], needsManager: [0, 1, 2].map((i) => ({ request_index: i, reason: 'цена не задана' })) };
    const calls: string[] = [];
    const { self } = fakeSelf('lcard', {
      'GET /widget/v1/kp/draft': () => {
        calls.push('draft');
        return { draft: current, job: null };
      },
      // Задания по прайсу выполняются мгновенно: к первому опросу ни queued, ни running уже нет.
      'GET /widget/v1/kp/research': () => {
        calls.push('research');
        return { draftId: 54, pending: false, positions: [0, 1, 2].map((i) => ({ requestIndex: i, job: null, research: null })) };
      },
      'POST /widget/v1/kp/research': () => {
        calls.push('post');
        current = { ...current, items: [item(0, 23_900), item(1, 23_900), item(2, 23_900)], needsManager: [] };
        return { queued: [0, 1, 2] };
      },
    });
    const cbs = createCallbacks(self, 'https://opt.test.ru');
    await act(async () => cbs.render!());
    await flush();
    await expand();
    expect(priceInputs().map((i) => i.value)).toEqual(['', '', '']);
    expect(button('Собрать документ')?.disabled).toBe(true);
    calls.length = 0;
    await clickIn('Найти цены');
    await flush();
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    // POST → один GET research (поиск уже завершён) → GET draft: цены на месте, итог и кнопка сборки доступны без F5.
    expect(calls).toEqual(['post', 'research', 'draft']);
    expect(priceInputs().map((i) => i.value)).toEqual(['23900', '23900', '23900']);
    expect(badges().map((b) => b[1])).toEqual(['по прайсу: ДВ CPL (строка 5)', 'по прайсу: ДВ CPL (строка 5)', 'по прайсу: ДВ CPL (строка 5)']);
    expect(plainText()).toContain('Итого с НДС 71 700 ₽');
    expect(button('Собрать документ')?.disabled).toBe(false);
    expect(document.querySelector('.opt-kp-counters')?.textContent).toBe('позиций 3вопросов 0без цены 0');
  });

  it('опросник (KP-AGENT-V2, п. 5): счётчики и блокировка сборки; порядок — блокирующие, не блокирующие, отвеченные; цена из интернета с источниками — медиана или своя цена; доставка с суммой; «Спросить у клиента» — текст для менеджера', async () => {
    const web = { query: 'Лиственница 2П 1400×2700', researchedAt: '2026-10-19T10:00:00Z', min: 84_000, median: 86_000, max: 90_000, count: 3, factorySources: 1, spreadPct: 7, enough: true, excludedSites: ['dveri-c.ru'], sources: [{ url: 'https://fabrika-l.ru/p3', seller: 'fabrika-l.ru', price: 90_000, unitPrice: 90_000, foundAt: '2026-10-19T10:00:00Z', manufacturer: true, site: 'фабрика; по комментарию: «Двери из массива лиственницы»' }, { url: 'https://dveri-a.ru/p1', seller: 'dveri-a.ru', price: 84_000, unitPrice: 84_000, foundAt: '2026-10-19T10:00:00Z', manufacturer: false, site: null }] };
    const door = { request_index: 0, page_id: null, name: 'Дверь двупольная лиственница', size: '1400×2700 мм', qty: 2, price: null, lead_time: '', discount: 0, category: 'door' as const, priceLabel: 'цены из интернета — выбор менеджера', priceOutcome: 'not_priced' as const, web, gostProfile: { gost: '475-2016', kind: 'ДВ', leaves: 2, unequal: false, opening: null, fill: 'Г', threshold: null, strength: null, fire: null, heightMm: 2700, widthMm: 1400, basis: null, material: 'wood', cover: null, brand: null }, gostDesignation: null };
    const handle = { request_index: 1, page_id: null, name: 'Ручка дверная', size: '', qty: 2, price: 1250, lead_time: '', discount: 0, category: 'hardware' as const, priceSource: 'manager' as const, priceLabel: 'введена менеджером', priceOutcome: 'priced' as const };
    const webQ = { key: 'web_price:дверь двупольная лиственница|1400×2700 мм', type: 'web_price', blocking: true, title: 'Цена из интернета', text: '«Дверь двупольная лиственница», 1400×2700 мм: цены интернета 84 000 ₽ – 90 000 ₽, медиана 86 000 ₽ (3 источн.). Итоговая цена?', requestIndexes: [0], options: [{ id: 'median', label: 'Медиана 86 000 ₽', price: 86_000 }, { id: 'min', label: 'Минимум 84 000 ₽', price: 84_000 }, { id: 'max', label: 'Максимум 90 000 ₽', price: 90_000 }, { id: 'no_price', label: 'Оставить без цены («уточнить у менеджера» в КП)' }], customPrice: true, web, askClient: null, answer: null };
    const incQ = { key: 'incomplete:дверь двупольная лиственница|1400×2700 мм', type: 'incomplete', blocking: false, title: 'Неполная позиция', text: '«Дверь двупольная лиственница», 1400×2700 мм: не указано — открывание.', requestIndexes: [0], options: [], fields: [{ name: 'opening', label: 'Открывание', value: null }], askClient: 'Добрый день! Уточните, пожалуйста, по позиции «Дверь двупольная лиственница» (1400×2700 мм): открывание.', answer: null };
    const deliveryQ = { key: 'delivery', type: 'delivery', blocking: true, title: 'Доставка', text: 'Доставка по адресу: г. Москва, ул. Строителей, 1 — сумма или самовывоз?', requestIndexes: [], options: [{ id: 'delivery', label: 'Доставка (адрес и сумма)' }, { id: 'pickup', label: 'Самовывоз' }], fields: [{ name: 'address', label: 'Адрес', value: 'г. Москва, ул. Строителей, 1' }, { name: 'sum', label: 'Сумма доставки с НДС, ₽', value: null }], askClient: null, answer: null };
    const handleQ = { key: 'enter_price:ручка дверная|', type: 'enter_price', blocking: true, title: 'Введите цену', text: '«Ручка дверная»: цены нет ни в прайсе, ни в интернете.', requestIndexes: [1], options: [{ id: 'no_price', label: 'Оставить без цены («уточнить у менеджера» в КП)' }], customPrice: true, askClient: null, answer: { option: 'custom', price: 1250, at: '2026-10-19T10:00:00Z', by: 1 } };
    let current: Record<string, unknown> = { ...draft, id: 81, items: [door, handle], needsManager: [], survey: [handleQ, incQ, webQ, deliveryQ], counters: { positions: 2, open: 3, blocking: 2, unpriced: 1 }, delivery: null, priceValidity: '30 календарных дней', vatRate: 22 };
    const answers: unknown[] = [];
    const { self } = fakeSelf('lcard', {
      'GET /widget/v1/kp/draft': () => ({ draft: current, job: null }),
      'POST /widget/v1/kp/draft/81/answer': (data?: string) => {
        const b = JSON.parse(data ?? '{}') as { key: string; option?: string; price?: number; fields?: Record<string, string> };
        answers.push(b);
        const survey = (current.survey as { key: string }[]).map((q) => (q.key === b.key ? { ...q, answer: { option: b.option ?? 'custom', price: b.price ?? (b.option === 'median' ? 86_000 : null), fields: b.fields, at: '2026-10-19T10:05:00Z', by: 1 } } : q));
        const items = b.key === webQ.key ? [{ ...door, price: b.price ?? 86_000, priceSource: b.price ? 'manager' : 'web_confirmed', priceLabel: b.price ? 'введена менеджером' : 'из интернета (3 источн.), выбрал менеджер', priceOutcome: 'priced' }, handle] : (current.items as unknown[]);
        const delivery = b.key === 'delivery' ? { mode: b.option, address: b.fields?.address ?? null, sum: Number(b.fields?.sum) || null } : current.delivery;
        const open = survey.filter((q) => !(q as { answer: unknown }).answer);
        current = { ...current, survey, items, delivery, counters: { positions: 2, open: open.length, blocking: open.filter((q) => (q as unknown as { blocking: boolean }).blocking).length, unpriced: b.key === webQ.key ? 0 : 1 } };
        return { draft: current };
      },
    });
    const cbs = createCallbacks(self, 'https://opt.test.ru');
    await act(async () => cbs.render!());
    await flush();
    // Узкая колонка: «вопросов 3 (блокируют 2)» красным, сборка заблокирована с причиной.
    expect(document.querySelector('.opt-kp-counters')?.textContent).toBe('позиций 2вопросов 3 (блокируют 2)без цены 1');
    expect(document.querySelector('.opt-kp-counter-block')).not.toBeNull();
    expect(button('Собрать документ')?.disabled).toBe(true);
    expect(button('Собрать документ')?.title).toBe('Ответьте на вопросы опросника, которые блокируют КП: 2');
    expect(document.body.textContent).toContain('Документ не собирается: Ответьте на вопросы опросника, которые блокируют КП: 2.');
    await expand();
    expect([...document.querySelectorAll('.opt-kp-tab')].map((t) => t.textContent)[1]).toBe('Опросник (3)');
    // ГОСТ-профиль серой строкой; метки цены: интернет ждёт выбора, ручная цена.
    expect(document.querySelector('.opt-kp-row-gost')?.textContent).toBe('ГОСТ 475-2016 · ДВ · 2 створки · Г · 2700×1400');
    expect(badges()).toEqual([['pending', 'цены из интернета — выберите в опроснике'], ['manager', 'введена менеджером']]);
    expect(plainText()).toContain('цены из интернета 84 000 ₽ – 90 000 ₽ — выберите в опроснике');
    // Порядок карточек: блокирующие (красные), не блокирующие (жёлтые), отвеченные (серые).
    const cards = () => [...document.querySelectorAll('.opt-kp-panel .opt-kp-q')].map((c) => [c.className.replace('opt-kp-q opt-kp-q-', ''), c.querySelector('.opt-kp-q-title')?.textContent]);
    expect(cards()).toEqual([['block', 'Цена из интернета'], ['block', 'Доставка'], ['warn', 'Неполная позиция'], ['done', 'Введите цену']]);
    const panel = document.querySelector('.opt-kp-panel')!;
    expect(panel.textContent?.replace(/\u00a0/g, ' ')).toContain('Ответ: своя цена · 1 250 ₽');
    // Источники интернета: фабрика первой, «выбран по комментарию», исключённый сайт.
    const webCard = panel.querySelector('.opt-kp-q')!;
    expect(webCard.textContent?.replace(/\u00a0/g, ' ')).toContain('84 000 ₽ · медиана 86 000 ₽ · 90 000 ₽ — источников 3, с фабрики 1');
    await act(async () => ([...webCard.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Источники')) as HTMLButtonElement).click());
    expect([...webCard.querySelectorAll('.opt-kp-q-sources li')].map((l) => l.textContent?.replace(/\u00a0/g, ' '))).toEqual(['fabrika-l.ru — 90 000 ₽ · фабрика · выбран: фабрика; по комментарию: «Двери из массива лиственницы»', 'dveri-a.ru — 84 000 ₽', 'Не использовались (по комментарию «… нет»): dveri-c.ru']);
    // «Ответить» — только после выбора варианта; медиана → web_confirmed.
    const answerBtn = () => [...webCard.querySelectorAll('button')].find((b) => b.textContent === 'Ответить') as HTMLButtonElement;
    expect(answerBtn().disabled).toBe(true);
    await act(async () => (webCard.querySelector('input[value="median"]') as HTMLInputElement).click());
    expect(answerBtn().disabled).toBe(false);
    await act(async () => answerBtn().click());
    await flush();
    expect(answers[0]).toEqual({ key: webQ.key, option: 'median' });
    expect(badges()[0]).toEqual(['web', 'из интернета (3 источн.), выбрал менеджер']);
    expect(cards().map((c) => c[0])).toEqual(['block', 'warn', 'done', 'done']);
    // Доставка: вариант «доставка» с адресом и суммой.
    const delivery = [...document.querySelectorAll('.opt-kp-panel .opt-kp-q')].find((c) => c.querySelector('.opt-kp-q-title')?.textContent === 'Доставка')!;
    await act(async () => (delivery.querySelector('input[value="delivery"]') as HTMLInputElement).click());
    const sum = [...delivery.querySelectorAll('.opt-kp-field')].find((f) => f.textContent?.startsWith('Сумма'))!.querySelector('input')!;
    await setInput(sum, '4500');
    await act(async () => ([...delivery.querySelectorAll('button')].find((b) => b.textContent === 'Ответить') as HTMLButtonElement).click());
    await flush();
    expect(answers[1]).toEqual({ key: 'delivery', option: 'delivery', fields: { address: 'г. Москва, ул. Строителей, 1', sum: '4500' } });
    expect(document.querySelector('.opt-kp-row-delivery')?.textContent?.replace(/\u00a0/g, ' ')).toBe('Доставкаг. Москва, ул. Строителей, 11 усл.4 500 ₽4 500 ₽');
    // Итог: 86 000 × 2 + 1 250 × 2 + 4 500 = 179 000, НДС из суммы.
    expect(plainText()).toContain('Итого с НДС 179 000 ₽ · в т.ч. НДС 22 % — 32 279 ₽');
    expect(plainText()).toContain('Срок действия цены: 30 календарных дней');
    // «Спросить у клиента» — готовый текст, клиенту агент не пишет.
    const inc = [...document.querySelectorAll('.opt-kp-panel .opt-kp-q')].find((c) => c.querySelector('.opt-kp-q-title')?.textContent === 'Неполная позиция')!;
    await act(async () => ([...inc.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Спросить у клиента')) as HTMLButtonElement).click());
    expect((inc.querySelector('.opt-kp-q-client-text') as HTMLTextAreaElement).value).toBe('Добрый день! Уточните, пожалуйста, по позиции «Дверь двупольная лиственница» (1400×2700 мм): открывание.');
    // Блокирующих не осталось — сборка доступна (неполная позиция не блокирует).
    expect(button('Собрать документ')?.disabled).toBe(false);
    // Вкладка «Опросник» — тот же список; своя цена отправляется числом.
    await tab('Опросник');
    expect(document.querySelectorAll('.opt-kp-modal-body .opt-kp-q')).toHaveLength(4);
  });

  it('KB-COMPONENT-DOOR-GROUP в опроснике: «к какой двери» — один вопрос на группу, ответ — ко всем строкам группы; у строки «изменить дверь» меняет только её', async () => {
    const doorLine = (i: number, name: string, size: string, qty: number, price: number, productId: string) => ({ request_index: i, page_id: null, name, size, qty, price, lead_time: '', discount: 0, category: 'door' as const, priceSource: 'price_file' as const, priceLabel: `по прайсу: ${name}`, productId });
    const options = [{ requestIndex: 0, productId: 'INT-002', model: 'ДПГ усиленная', size: '800×2000 мм', qty: 5 }, { requestIndex: 1, productId: 'INT-013', model: 'ДПГ CPL', size: '910×2100 мм', qty: 3 }];
    const q = (text: string) => ({ kind: 'component_door' as const, text, reason: 'many' as const, group: 'коробка|сэндвич|телескоп', groupTitle: 'Коробка ТЕЛЕСКОП, сэндвич', options });
    type L = Record<string, unknown> & { request_index: number };
    const box = (i: number, size: string, qty: number): L => ({ request_index: i, page_id: null, name: `Коробка ТЕЛЕСКОП, сэндвич ${size}`, size: '', qty, price: null, lead_time: '', discount: 0, category: 'component', priceSource: 'price_file', priceLabel: 'вопрос: к какой двери', priceOutcome: 'question', question: q(`К какой двери считать «Коробка ТЕЛЕСКОП, сэндвич ${size}, ${qty} шт»?`) });
    const doors = [doorLine(0, 'ДПГ усиленная ПВХ', '800×2000 мм', 5, 6800, 'INT-002'), doorLine(1, 'ДПГ CPL', '910×2100 мм', 3, 23_900, 'INT-013')];
    let items: L[] = [...doors, box(2, '74×2150', 20), box(3, '74×2400', 10), box(4, '92×2150', 7)];
    const doorQ = { key: 'component_door:коробка|сэндвич|телескоп', type: 'component_door', blocking: true, title: 'Комплектующие — к какой двери', text: 'К какой двери считать «Коробка ТЕЛЕСКОП, сэндвич» (строк 3, 37 шт)?', requestIndexes: [2, 3, 4], options: [{ id: '0', label: 'INT-002 · ДПГ усиленная · 800×2000 мм · 5 шт' }, { id: '1', label: 'INT-013 · ДПГ CPL · 910×2100 мм · 3 шт' }], askClient: null, answer: null };
    let survey: unknown[] = [doorQ];
    const view = () => ({ ...draft, id: 66, items, needsManager: [], survey, counters: { positions: 5, open: survey.length, blocking: survey.length, unpriced: items.filter((l) => l.price === null && l.priceOutcome !== 'included').length }, delivery: { mode: 'pickup', address: null, sum: null } });
    const priced = (l: L, door: number, by: 'group' | 'line', price: number | null, label: string): L => ({ ...l, price, priceOutcome: price ? 'priced' : 'included', question: null, componentDoor: door, componentDoorBy: by, componentDoorGroup: by === 'group' ? 'коробка|сэндвич|телескоп' : null, priceLabel: label });
    const posted: unknown[] = [];
    const { self } = fakeSelf('lcard', {
      'GET /widget/v1/kp/draft': () => ({ draft: view(), job: null }),
      // Ответ «к какой двери» через опросник: сервер передаёт его в component-door для группы.
      'POST /widget/v1/kp/draft/66/answer': (data?: string) => {
        const b = JSON.parse(data ?? '{}') as { key: string; option: string };
        posted.push(b);
        items = items.map((l) => (l.category === 'component' ? priced(l, Number(b.option), 'group', 1910, 'по двери INT-002, ДПГ усиленная') : l));
        survey = [];
        return { draft: view(), applied: 3 };
      },
      'POST /widget/v1/kp/draft/66/component-door': (data?: string) => {
        const b = JSON.parse(data ?? '{}') as { requestIndex: number; doorRequestIndex: number };
        posted.push(b);
        items = items.map((l) => (l.request_index === b.requestIndex ? priced(l, b.doorRequestIndex, 'line', null, 'по двери INT-013, ДПГ CPL') : l));
        return { draft: view() };
      },
    });
    const cbs = createCallbacks(self, 'https://opt.test.ru');
    await act(async () => cbs.render!());
    await flush();
    expect(button('Собрать документ')?.disabled).toBe(true);
    await expand();
    // Один вопрос на группу — в опроснике; у строк — ссылка на него.
    const card = document.querySelector('.opt-kp-panel .opt-kp-q')!;
    expect(card.textContent).toContain('К какой двери считать «Коробка ТЕЛЕСКОП, сэндвич» (строк 3, 37 шт)?');
    expect([...card.querySelectorAll('.opt-kp-q-option')].map((o) => o.textContent)).toEqual(['INT-002 · ДПГ усиленная · 800×2000 мм · 5 шт', 'INT-013 · ДПГ CPL · 910×2100 мм · 3 шт']);
    expect(document.querySelectorAll('.opt-kp-question-ref')).toHaveLength(3);
    await act(async () => (card.querySelector('input[value="0"]') as HTMLInputElement).click());
    await act(async () => ([...card.querySelectorAll('button')].find((b) => b.textContent === 'Ответить') as HTMLButtonElement).click());
    await flush();
    expect(posted).toEqual([{ key: 'component_door:коробка|сэндвич|телескоп', option: '0' }]);
    expect(badges().filter((b) => b[1] === 'по двери INT-002, ДПГ усиленная')).toHaveLength(3);
    expect(plainText().match(/дверь: поз\. 1 — по ответу на группу/g)).toHaveLength(3);
    expect(document.querySelector('.opt-kp-row-delivery')?.textContent).toContain('самовывоз — строки в КП нет');
    expect(modalButton('Собрать документ')?.disabled).toBe(false);
    // «Изменить дверь» у второй строки → INT-013: только эта строка.
    await act(async () => ([...document.querySelectorAll('.opt-kp-door-change')][1] as HTMLButtonElement).click());
    await flush();
    const lineOptions = [...document.querySelectorAll('.opt-kp-door-line-option')];
    expect(lineOptions.map((b) => b.textContent?.replace(/\u00a0/g, ' '))).toEqual(['INT-002 · ДПГ усиленная ПВХ · 800 × 2000 мм · 5 шт', 'INT-013 · ДПГ CPL · 910 × 2100 мм · 3 шт']);
    await act(async () => (lineOptions[1] as HTMLButtonElement).click());
    await flush();
    expect(posted[1]).toEqual({ requestIndex: 3, doorRequestIndex: 1 });
    expect(plainText()).toContain('дверь: поз. 2 — выбрана для этой строки');
    expect(plainText().match(/дверь: поз\. 1 — по ответу на группу/g)).toHaveLength(2);
    // KB-DOOR-MATCH-2, п. 5: коробка входит в цену блока INT-013 — в поле цены подсказка, не 0.
    expect([...document.querySelectorAll<HTMLInputElement>('input[placeholder="в цене блока"]')].map((i) => i.value)).toEqual(['']);
  });

  it('подписи и цвет источника цены: прайс, «цена устарела», прежний веб-поиск — «в КП не идёт»; полное название, обозначение по прайсу, комплектация, комплектация по ТЗ и ГОСТ-обозначение под ним', async () => {
    const kbDraft = { ...draft, items: [
      { request_index: 0, page_id: null, name: 'Дверной блок деревянный внутренний глухой однопольный распашной без порога, с доводчиком, внутренним механическим замком с ключом снаружи и изнутри, облицовка CPL светло-серый', size: '800×2000 мм', qty: 10, price: 3450, lead_time: '', discount: 0, priceSource: 'price_file', priceLabel: 'по базе: прайс Текона.xlsx (01.10.2026)', priceStale: false, kbPriceId: 5, priceModel: 'ДВ CPL 0,2 мм', priceAbbr: 'ДВ 1Рп Г ПрБ', equipment: 'коробка, 3 петли, уплотнитель, замок, ручки, доводчик', tzEquipment: 'раздел «15. Базовая комплектация»: доводчик, противосъёмные штыри', gostProfile: { gost: '475-2016', kind: 'ДВ', leaves: 1, unequal: false, opening: 'right', fill: 'Г', threshold: 'ПрБ', strength: null, fire: null, heightMm: 2000, widthMm: 800, basis: 'frame', material: 'wood', cover: 'CPL', brand: null }, gostDesignation: 'ДВ 1Рп 20×8 Г ПрБ ГОСТ 475-2016' },
      { request_index: 1, page_id: null, name: 'Турин', size: '800×2000 мм', qty: 3, price: 8000, lead_time: '', discount: 0, priceSource: 'research', priceLabel: 'по рынку (01.08.2026)', market: { median: 8000, min: 7800, max: 8200, count: 3, unit: 'piece', researchId: 9, researchedAt: '2026-08-01T10:00:00Z' } },
      { request_index: 2, page_id: null, name: 'ДПО сота', size: '800×2000 мм', qty: 1, price: 4100, lead_time: '', discount: 0, priceSource: 'price_file', priceLabel: 'по прайсу: ДПО сота (строка 4)', priceStale: true },
    ], needsManager: [{ request_index: 2, reason: 'цена устарела: актуальна на 01.01.2026, срок 90 дн.' }] };
    const posted: unknown[] = [];
    const { self } = fakeSelf('lcard', {
      'GET /widget/v1/kp/draft': { draft: kbDraft, job: null },
      'GET /widget/v1/kp/research': { draftId: 7, pending: false, positions: [{ requestIndex: 0, job: null, research: null }, { requestIndex: 1, job: null, research: null }, { requestIndex: 2, job: null, research: null }] },
      'POST /widget/v1/kp/research': (data?: string) => {
        posted.push(JSON.parse(data ?? '{}'));
        return { queued: [0] };
      },
    });
    const cbs = createCallbacks(self, 'https://opt.test.ru');
    await act(async () => cbs.render!());
    await flush();
    await expand();
    expect(badges()).toEqual([['price', 'по базе: прайс Текона.xlsx (01.10.2026)'], ['stale', 'прежний поиск — в КП не идёт'], ['price', 'по прайсу: ДПО сота (строка 4)']]);
    expect(document.querySelectorAll('.opt-kp-table .opt-kp-stale')).toHaveLength(1);
    expect(document.body.textContent).toContain('цена прежнего поиска — в КП не идёт');
    const first = document.querySelector('.opt-kp-row')!;
    expect(first.querySelector('.opt-kp-row-name')?.textContent).toBe('Дверной блок деревянный внутренний глухой однопольный распашной без порога, с доводчиком, внутренним механическим замком с ключом снаружи и изнутри, облицовка CPL светло-серый');
    expect(first.querySelector('.opt-kp-row-gost')?.textContent).toBe('ГОСТ 475-2016 · ДВ · 1 створка · правая · Г · ПрБ · 2000×800 (по коробке) · по ГОСТ: ДВ 1Рп 20×8 Г ПрБ ГОСТ 475-2016');
    expect(first.querySelector('.opt-kp-row-model')?.textContent).toBe('Обозначение по прайсу: ДВ CPL 0,2 мм (ДВ 1Рп Г ПрБ)');
    expect(first.querySelector('.opt-kp-row-equipment')?.textContent).toBe('Комплектация: коробка, 3 петли, уплотнитель, замок, ручки, доводчик');
    // KP-DOCX-APPENDIX: комплектация из ТЗ клиента — своей строкой.
    expect(first.querySelector('.opt-kp-row-tz')?.textContent).toBe('Комплектация по ТЗ: раздел «15. Базовая комплектация»: доводчик, противосъёмные штыри');
    expect(document.querySelectorAll('.opt-kp-row-tz')).toHaveLength(1);
    const buttons = [...document.querySelectorAll('button')].filter((b) => b.textContent === 'Найти цену');
    expect(buttons).toHaveLength(3);
    await act(async () => buttons[0]!.click());
    await flush();
    expect(posted).toEqual([{ draftId: 7, requestIndexes: [0] }]);
  });

  it('вкладка «База знаний» в окне КП: вопрос → POST /kb/answer с leadId, ответ и источники; «Журнал» — события этой сделки', async () => {
    const posted: unknown[] = [];
    const { self, calls } = fakeSelf('lcard', {
      'GET /widget/v1/kp/draft': { draft, job: null },
      'GET /widget/v1/journal': { items: [{ id: 1, leadId: 555, kind: 'note', summary: 'Опросник: «Доставка» (КП) — самовывоз', details: {}, costRub: 0, createdAt: '2026-10-19T10:00:00Z' }] },
      'POST /widget/v1/kb/answer': (data?: string) => {
        posted.push(JSON.parse(data ?? '{}'));
        return { question: 'какая скидка от 50 полотен', answer: 'Скидка опт от 50 полотен — 12 % [1].', sources: [{ n: 1, chunkId: 10, sourceId: 1, label: 'заметка «Скидки» (15.10.2026)', excerpt: 'Скидка опт от 50 полотен — 12 %' }], reason: null, cost: { inputTokens: 400, outputTokens: 30, usd: 0.0012 }, provider: 'openai', model: 'gpt-5.5', ms: 900 };
      },
    });
    const cbs = createCallbacks(self, 'https://opt.test.ru');
    await act(async () => cbs.render!());
    await flush();
    await expand();
    await tab('База знаний');
    expect(button('Ответить из базы')?.disabled).toBe(true);
    await setInput(document.querySelector('.opt-kb-answer-input'), 'какая скидка от 50 полотен');
    expect(button('Ответить из базы')?.disabled).toBe(false);
    await click('Ответить из базы');
    await flush();
    expect(posted).toEqual([{ question: 'какая скидка от 50 полотен', leadId: 555 }]);
    expect(document.body.textContent).toContain('Скидка опт от 50 полотен — 12 % [1].');
    expect(document.body.textContent).toContain('[1] заметка «Скидки» (15.10.2026): Скидка опт от 50 полотен — 12 %');
    expect(document.body.textContent).toContain('gpt-5.5, $0.0012, 900 мс');
    await tab('Журнал');
    await flush();
    expect(calls.some((c) => c.url.includes('/widget/v1/journal?leadId=555'))).toBe(true);
    expect(document.body.textContent).toContain('Опросник: «Доставка» (КП) — самовывоз');
  });

  it('KP-LETTER-SCOPE: письмо задаёт объём — строка «По письму: 3 из 18», у позиции «Из письма: …»; «Ещё в проекте: N поз.» свёрнуто, «добавить» — POST project-item', async () => {
    const line = (i: number, mark: string, size: string) => ({ request_index: i, page_id: null, name: 'Дверь наружная металлическая остеклённая', size, qty: 1, price: null, lead_time: '', discount: 0, category: 'door' as const, mark, letterSpec: 'Каркас металлический, филёнка дуб/ламинация под дуб' });
    let current: Record<string, unknown> = {
      ...draft, id: 74, items: [line(0, 'ДНО1', '1010×2070 мм'), line(1, 'ДНО2', '1310×2070 мм'), line(2, 'ДНО3', '910×2070 мм')], needsManager: [],
      scope: { by: 'marks', selected: 3, project: 18, missing: [] },
      projectRest: [{ raw: 'ДН-1 Дверь наружная металлическая глухая', name: 'Дверь наружная металлическая глухая', width_mm: 1010, height_mm: 2070, qty: 2, mark: 'ДН1', sourceFiles: ['28. Ведомость дверей.наружные.pdf', '21.План заполнения проемов.pdf'] }, { raw: 'Д1 Дверь внутренняя', name: 'Дверь внутренняя', width_mm: 800, height_mm: null, qty: 1, mark: 'Д1', sourceFiles: ['21.План заполнения проемов.pdf'] }],
    };
    const posted: unknown[] = [];
    const { self } = fakeSelf('lcard', {
      'GET /widget/v1/kp/draft': () => ({ draft: current, job: null }),
      'POST /widget/v1/kp/draft/74/project-item': (data?: string) => {
        posted.push(JSON.parse(data ?? '{}'));
        const rest = current.projectRest as { name: string; width_mm: number; height_mm: number; qty: number; mark: string }[];
        const it = rest[0]!;
        current = { ...current, items: [...(current.items as unknown[]), { ...line(3, it.mark, '1010×2070 мм'), name: it.name, qty: it.qty, letterSpec: null }], projectRest: rest.slice(1), scope: { by: 'marks', selected: 4, project: 18, missing: [] } };
        return { draft: current, requestIndex: 3 };
      },
    });
    const cbs = createCallbacks(self, 'https://opt.test.ru');
    await act(async () => cbs.render!());
    await flush();
    await expand();
    expect(document.querySelector('.opt-kp-scope')?.textContent).toBe('По письму: в КП 3 поз. из 18 в проекте (марки из письма)');
    expect([...document.querySelectorAll('.opt-kp-row-letter')].map((x) => x.textContent)).toEqual(Array(3).fill('Из письма: Каркас металлический, филёнка дуб/ламинация под дуб'));
    // Свёрнуто: только строка; по клику — строки проекта с размером, количеством и файлами.
    expect(document.querySelectorAll('.opt-kp-project-row')).toHaveLength(0);
    await click('Ещё в проекте: 2 поз. ›');
    const rows = [...document.querySelectorAll('.opt-kp-project-row')];
    expect(rows.map((r) => r.textContent?.replace(/\u00a0/g, ' '))).toEqual(['Дверь наружная металлическая глухая · 1010 × 2070 мм · 2 шт · 28. Ведомость дверей.наружные.pdf, 21.План заполнения проемов.pdfдобавить', 'Дверь внутренняя · 800 × — мм · 1 шт · 21.План заполнения проемов.pdfдобавить']);
    await act(async () => (rows[0]!.querySelector('button') as HTMLButtonElement).click());
    await flush();
    expect(posted).toEqual([{ index: 0 }]);
    expect(document.querySelector('.opt-kp-scope')?.textContent).toBe('По письму: в КП 4 поз. из 18 в проекте (марки из письма)');
    expect(document.querySelectorAll('.opt-kp-table .opt-kp-row:not(.opt-kp-row-delivery)')).toHaveLength(4);
    expect(document.body.textContent).toContain('Ещё в проекте: 1 поз.');
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
    const { self, calls } = fakeSelf('lcard', {
      'GET /widget/v1/kp/draft': () => ({ draft: current, job: null }),
      'PUT /widget/v1/kp/draft/7': (data?: string) => {
        current = { ...current, items: JSON.parse(data ?? '{}').items };
        return { draft: current };
      },
      'POST /widget/v1/kp/build': () => {
        current = { ...current, status: 'built', kpNo: 'КП-2026-1', hasDocx: true, hasPdf: true };
        return { draft: current, pdf: true, attached: ['KP-КП-2026-1.pdf'] };
      },
      'GET /widget/v1/kp/file/link': () => ({ url: 'https://opt.test.ru/kp/file?draftId=7&kind=pdf&t=abc', filename: 'KP-КП-2026-1.pdf', expiresAt: '2026-10-16T10:10:00Z' }),
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
    await expand();
    await setInput(priceInputs()[0]!, '14900');
    expect(modalButton('Собрать документ')?.disabled).toBe(true);
    await clickIn('Сохранить правки');
    await flush();
    expect(document.querySelector('.opt-kp-modal-foot .opt-kp-total')?.textContent?.replace(/\u00a0/g, ' ')).toBe('Итого с НДС 163 900 ₽ · в т.ч. НДС 22 % — 29 556 ₽');
    await clickIn('Собрать документ');
    await flush();
    expect(document.querySelector('.opt-kp-modal .opt-kp-title')?.textContent).toBe('КП КП-2026-1');
    expect(document.querySelector('.opt-kp-narrow .opt-kp-sub')?.textContent).toBe('КП-2026-1');
    expect(document.querySelector('.opt-kp-badge')?.textContent).toBe('Документ собран');
    expect(document.body.textContent).toContain('Документ собран (DOCX и PDF) — файлы в карточке сделки');
    // Скачивание (KP-DOWNLOAD): кнопки в колонке и в окне, клик берёт подписанную ссылку и открывает её как вложение.
    expect(button('Скачать PDF')).toBeDefined();
    expect(button('Скачать DOCX')).toBeDefined();
    const clicked: string[] = [];
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      clicked.push(`${this.getAttribute('download')} ← ${this.href}`);
    };
    try {
      await click('Скачать PDF');
      await flush();
    } finally {
      HTMLAnchorElement.prototype.click = origClick;
    }
    expect(calls.some((c) => c.method === 'GET' && c.url.endsWith('/widget/v1/kp/file/link?draftId=7&kind=pdf'))).toBe(true);
    expect(clicked).toEqual(['KP-КП-2026-1.pdf ← https://opt.test.ru/kp/file?draftId=7&kind=pdf&t=abc']);
    await clickIn('Отправить клиенту');
    await flush();
    // Окно письма — слоем внутри окна КП (а не в колонке amoCRM под ним); Esc закрывает только письмо.
    const layer = () => document.querySelector('.opt-kp-modal .opt-kp-send-layer');
    expect(layer()?.textContent).toContain('Письмо с КП');
    expect(document.querySelector('.opt-kp-narrow')?.textContent).not.toContain('Письмо с КП');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(layer()).toBeNull();
    expect(modal()).not.toBeNull();
    await clickIn('Отправить клиенту');
    await flush();
    expect(layer()?.textContent).toContain('Вложение: KP-КП-2026-1.pdf (117 КБ)');
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
    expect(document.querySelector('.opt-kp-badge')?.textContent).toBe('Отправлено');
    expect(document.body.textContent).toContain('Отправлено 12.10.2026.');
    expect(document.getElementById('ai-door-opt-styles')).toBeNull(); // в тестах define __STYLES__ нет — тег не вставляется
  });
});

describe('виджет «Агент опт»: настройки', () => {
  const settings = {
    model: { provider: 'openai', model: 'gpt-5.5', fallbackModel: 'gpt-5.1', fallbackProvider: null, effort: 'low', maxTokens: 4096 },
    vision: { provider: 'tesseract', photosToClaude: false, maxFilesPerDay: 100 },
    mail: { imapHost: 'imap.yandex.ru', imapPort: 993, imapSecure: true, smtpHost: '', smtpPort: 465, smtpSecure: true, username: '', fromName: 'РФ-Двери', fromAddress: '', cc: '', subject: 'Коммерческое предложение {kpNo}', text: 'Здравствуйте!', signature: '' },
    billing: { usdRubRate: 90, pricing: {} },
  };

  it('вкладки КП, База знаний, Модель, Письмо, Журнал; письмо сохраняется вместе с паролем', async () => {
    const saved: string[] = [];
    const { self } = fakeSelf('settings', {
      'GET /widget/v1/kp/settings': { constants: { vatRate: 22, priceCoefficient: 1, manufacturerCoefficients: { 'Профиль Дорс': 0.9 }, autoResearch: false, researchCacheDays: 7, maxPositionsPerRun: 30 }, certsDir: null, numbering: { prefix: 'КП', year: null, counter: 0 }, template: { exists: false, name: null, md5: null, updatedAt: null } },
      'PUT /widget/v1/kp/settings': (data?: string) => {
        saved.push(data ?? '');
        return { ok: true };
      },
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
    // Фраза о ценах редактируется в константах КП; вкладка «База знаний» — новая база опта (RFD-AI-AGENT-OPT-KB), не пять справочников 12.10.2026.
    expect(document.body.textContent).toContain('Фраза о ценах');
    expect(document.body.textContent).toContain('Домены производителей');
    expect([...document.querySelectorAll('button')].map((b) => b.textContent)).toContain('База знаний');
    // Настройки цен: переключатель автопоиска и лимит; настроек веб-поиска (коэффициенты, кэш, лимиты) нет — KB-WEB-ROWS.
    expect(document.body.textContent).toContain('Искать цены автоматически при сборке черновика');
    for (const gone of ['Коэффициенты по производителям', 'Общий коэффициент', 'Срок кэша', 'Вызовов веб-поиска', 'Дневной лимит веб-поиска', 'Не брать цены из базы знаний']) expect(document.body.textContent).not.toContain(gone);
    const auto = [...document.querySelectorAll('input[type=checkbox]')][0] as HTMLInputElement;
    await act(async () => auto.click());
    await click('Сохранить');
    await flush();
    expect(JSON.parse(saved.at(-1)!)).toMatchObject({ constants: { autoResearch: true, maxPositionsPerRun: 30 } });
    saved.length = 0;
    await click('Модель');
    await flush();
    expect(document.body.textContent).toContain('Сохранён ключ sk-…ab12');
    expect(document.body.textContent).toContain('GPT-5.5 · $1.25/$10 за 1M');
    await click('Письмо');
    await flush();
    // IMAP для чтения заявки по кнопке: значения Яндекса по умолчанию.
    expect(document.body.textContent).toContain('IMAP-сервер');
    expect([...document.querySelectorAll('input')].some((i) => i.value === 'imap.yandex.ru')).toBe(true);
    const inputs = [...document.querySelectorAll('input')];
    await setInput(inputs.find((i) => i.value === '')!, 'smtp.yandex.ru');
    await setInput(document.querySelector('input[type=password]'), 'secret');
    await click('Сохранить');
    await flush();
    expect(saved).toHaveLength(2);
    expect(JSON.parse(saved[0]!).mail).toMatchObject({ smtpHost: 'smtp.yandex.ru', smtpPort: 465, imapHost: 'imap.yandex.ru', imapPort: 993, imapSecure: true });
    expect(JSON.parse(saved[1]!)).toEqual({ password: 'secret' });
    expect(document.body.textContent).toContain('Сохранено (версия 2)');
    await click('Журнал сборок');
    await flush();
    expect(document.body.textContent).toContain('КП КП-2026-1 отправлено на ivanov@romashka.ru');
  });
});

describe('виджет «Агент опт»: вкладка «База знаний» (RFD-AI-AGENT-OPT-KB, этап 1)', () => {
  const src = (over: Record<string, unknown>) => ({ id: 1, kind: 'text', title: 'Скидка опт от 50 полотен — 12 %', original: null, mime: 'text/plain', status: 'indexed', sizeBytes: 51, chunks: 1, embeddedChunks: 1, refreshDays: null, nextRefreshAt: null, error: null, createdAt: '2026-10-15T10:00:00Z', updatedAt: '2026-10-15T10:00:00Z', indexedAt: '2026-10-15T10:00:05Z', crawl: false, parentId: null, httpStatus: null, job: null, ...over });

  it('список с объёмом, добавление текста → «в очереди», переиндексация, фрагменты, поиск, удаление с подтверждением', async () => {
    let sources: Record<string, unknown>[] = [];
    const posted: { url: string; data: unknown }[] = [];
    const { self, calls } = fakeSelf('settings', {
      'GET /widget/v1/kb/sources': () => ({ sources, usage: { sources: sources.length, bytes: 51 * sources.length, chunks: sources.length, limits: { bytes: 500 * 1024 * 1024, chunks: 20000 } } }),
      'POST /widget/v1/kb/sources/text': (data?: string) => {
        posted.push({ url: 'text', data: JSON.parse(data ?? '{}') });
        sources = [src({ status: 'new', chunks: 0, embeddedChunks: 0, indexedAt: null, job: { state: 'queued' } })];
        return { source: sources[0] };
      },
      'POST /widget/v1/kb/sources/url': (data?: string) => {
        posted.push({ url: 'url', data: JSON.parse(data ?? '{}') });
        sources = [src({ id: 2, kind: 'url', title: 'Цены на двери', original: 'https://rf-dveri.ru/ceny/', mime: 'text/html', status: 'indexed', chunks: 3, embeddedChunks: 3, refreshDays: 30, nextRefreshAt: '2026-11-14T10:00:00Z', crawl: true, httpStatus: 200 })];
        return { source: sources[0], existed: false };
      },
      'POST /widget/v1/kb/sources/1/reindex': () => {
        sources = [src({ status: 'new', job: { state: 'running' } })];
        return { source: sources[0] };
      },
      'GET /widget/v1/kb/sources/1/chunks': { source: src({}), chunks: [{ id: 10, sourceId: 1, position: 0, text: 'Скидка опт от 50 полотен — 12 %', meta: {}, hasEmbedding: true }] },
      'GET /widget/v1/kb/search': { query: 'скидка опт', hits: [{ chunkId: 10, sourceId: 1, position: 0, text: 'Скидка опт от 50 полотен — 12 %', meta: {}, score: 0.03, matched: ['vector', 'text'], source: { title: 'Скидка опт от 50 полотен — 12 %', kind: 'text', original: null, indexedAt: '2026-10-15T10:00:05Z' } }], model: 'text-embedding-3-small', tokens: 4, costUsd: 0.00000008, ms: 12 },
      'DELETE /widget/v1/kb/sources/1': () => {
        sources = [];
        return { ok: true };
      },
      'GET /widget/v1/kb/prices': { items: [{ id: 3, sourceId: 2, model: 'ДПГ сота', modelKey: 'дпг сота', factory: 'Текона', unit: 'шт', baseSize: '800×2000', widthMm: 800, heightMm: 2000, price: 3450, vat: 'included', validAt: '2026-10-01T00:00:00Z', confidence: 70, origin: 'price_list', nonstandard: {}, url: null, note: null, createdAt: '2026-10-15T10:00:00Z', sourceTitle: 'прайс Текона.xlsx', sourceKind: 'file' }], total: 1 },
      'POST /widget/v1/kb/prices': (data?: string) => {
        posted.push({ url: 'price', data: JSON.parse(data ?? '{}') });
        return { price: {} };
      },
      'GET /widget/v1/kb/prices/export': { filename: 'kb-prices-2026-10-15.xlsx', rows: 1, contentBase64: Buffer.from('PK').toString('base64') },
      'GET /widget/v1/kb/aliases': { aliases: [{ id: 1, alias: 'ДПГ + УПД (сота)', canonical: 'ДПГ сота', productId: null, sourceId: null }], total: 1, offset: 0, limit: 50, groups: [{ sourceId: 0, title: 'Добавлены вручную', count: 1 }], all: 1 },
      'POST /widget/v1/kb/aliases': (data?: string) => {
        posted.push({ url: 'aliases', data: JSON.parse(data ?? '{}') });
        return { added: 1, aliases: [] };
      },
    });
    document.body.innerHTML = '<div id="work-area-opt_agent"></div>';
    const cbs = createCallbacks(self, 'https://opt.test.ru');
    await act(async () => cbs.advancedSettings!());
    await flush();
    await click('База знаний');
    await flush();
    expect(document.body.textContent).toContain('Источников пока нет');
    expect(document.body.textContent).toContain('Занято: 1 КБ из 500.0 МБ');
    // Текст менеджера: кнопка активна только с содержимым; после отправки — источник в очереди.
    expect(button('Добавить текст')?.disabled).toBe(true);
    await setInput(document.querySelector('textarea:not(.opt-kb-url-comment):not(.opt-kb-site-comment)')!, 'Скидка опт от 50 полотен — 12 %');
    expect(button('Добавить текст')?.disabled).toBe(false);
    await click('Добавить текст');
    await flush();
    expect(posted).toEqual([{ url: 'text', data: { title: '', content: 'Скидка опт от 50 полотен — 12 %' } }]);
    expect(document.body.textContent).toContain('Текст добавлен, индексируется');
    expect(document.body.textContent).toContain('в очереди…');
    expect(button('Переиндексировать')?.disabled).toBe(true);
    // Воркер закончил — опрос списка приносит indexed.
    sources = [src({})];
    await act(async () => new Promise((r) => setTimeout(r, 3100)));
    await flush();
    expect(document.body.textContent).toContain('проиндексирован');
    expect(document.body.textContent).toContain('текст · 1 КБ · фрагментов 1 · добавлен 15.10.2026 · индекс 15.10.2026');
    await click('Фрагменты');
    await flush();
    expect(document.body.textContent).toContain('#1');
    await click('Переиндексировать');
    await flush();
    expect(document.body.textContent).toContain('индексируется…');
    sources = [src({})];
    // Поиск: пять лучших фрагментов с источником и способом совпадения.
    await setInput([...document.querySelectorAll('input')].find((i) => i.placeholder === 'скидка опт')!, 'скидка опт');
    await click('Найти');
    await flush();
    expect(document.body.textContent).toContain('Найдено 1 · эмбеддинг text-embedding-3-small, 4 токенов · 12 мс');
    expect(document.body.textContent).toContain('текст: Скидка опт от 50 полотен — 12 % · смысл+текст');
    expect(calls.some((c) => c.url.includes('/widget/v1/kb/search?q=%D1%81%D0%BA%D0%B8%D0%B4%D0%BA%D0%B0%20%D0%BE%D0%BF%D1%82&limit=5'))).toBe(true);
    // Удаление — только после подтверждения.
    window.confirm = () => false;
    await click('Удалить');
    await flush();
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    window.confirm = () => true;
    await click('Удалить');
    await flush();
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => new URL(c.url).pathname)).toEqual(['/widget/v1/kb/sources/1']);
    expect(document.body.textContent).toContain('Источников пока нет');
    // Ссылка (этап 2): адрес, период обновления и обход раздела уходят в тело запроса; в списке — период и следующая дата.
    expect(button('Добавить ссылку')?.disabled).toBe(true);
    await setInput([...document.querySelectorAll('input')].find((i) => i.placeholder === 'https://rf-dveri.ru/ceny/')!, 'https://rf-dveri.ru/ceny/');
    await setInput([...document.querySelectorAll('input[type=number]')][0]!, '14');
    await act(async () => ([...document.querySelectorAll('input[type=checkbox]')][0] as HTMLInputElement).click());
    // KP-AGENT-V2, п. 4а: под ссылкой — «Комментарий» (до 2000 знаков) и «Фабрика», уходят вместе со ссылкой.
    const urlComment = document.querySelector('.opt-kb-url-comment') as HTMLTextAreaElement;
    expect(urlComment.maxLength).toBe(2000);
    await setInput(urlComment, 'Межкомнатные CPL и ПВХ. Стальных нет');
    await act(async () => (document.querySelector('.opt-kb-url-factory') as HTMLInputElement).click());
    expect(button('Добавить ссылку')?.disabled).toBe(false);
    await click('Добавить ссылку');
    await flush();
    expect(posted.at(-1)).toEqual({ url: 'url', data: { url: 'https://rf-dveri.ru/ceny/', refreshDays: 14, crawl: true, comment: 'Межкомнатные CPL и ПВХ. Стальных нет', isFactory: true } });
    // Форма очищается.
    expect((document.querySelector('.opt-kb-url-comment') as HTMLTextAreaElement).value).toBe('');
    expect((document.querySelector('.opt-kb-url-factory') as HTMLInputElement).checked).toBe(false);
    expect(document.body.textContent).toContain('Ссылка добавлена, скачивается, раздел будет обойдён (до 50 страниц)');
    expect(document.body.textContent).toContain('ссылка · 1 КБ · фрагментов 3 · добавлен 15.10.2026 · индекс 15.10.2026 · обновление каждые 30 дн., следующее 14.11.2026 · раздел');
    expect(document.body.textContent).toContain('https://rf-dveri.ru/ceny/');
    // Цены (KB-PRICES-UI): по умолчанию только сводка; «Показать» раскрывает таблицу прайса без кнопки удаления; ручная запись, синонимы строками.
    expect(document.body.textContent).toContain('Цены (1)');
    expect(document.querySelector('.opt-kb-prices-summary')?.textContent).toBe('Прайс: прайс Текона.xlsx — 1 цена (01.10)  |  веб-цены: 0  |  правки менеджера: 0');
    expect(document.querySelector('.opt-kb-price')).toBeNull();
    await click('Показать');
    await flush();
    const priceRow = document.querySelector('.opt-kb-price')!;
    expect(priceRow.textContent?.replace(/\u00a0/g, ' ')).toBe('ДПГ сота · Текона800×20003 450 ₽с НДС01.10.2026прайс Текона.xlsx');
    expect(priceRow.querySelector('button')).toBeNull();
    // KB-WEB-ROWS: ручной записи цены в базу нет — в КП идут только цены прайса.
    expect(button('Добавить цену')).toBeUndefined();
    expect(document.body.textContent).toContain('В КП идут только цены прайса');
    // KB-ALIASES-UI: синонимы свёрнуты; «Показать» — группы по источникам, группа раскрывается по клику.
    expect(document.querySelector('.opt-kb-aliases-title')?.textContent).toBe('Синонимы (1)');
    await act(async () => (document.querySelector('.opt-kb-aliases button') as HTMLButtonElement).click());
    await flush();
    await act(async () => (document.querySelector('.opt-kb-alias-group-head') as HTMLButtonElement).click());
    await flush();
    expect(document.querySelector('.opt-kb-alias-table tbody')?.textContent).toBe('ДПГ + УПД (сота)ДПГ сота×');
    await setInput([...document.querySelectorAll('textarea')].find((t) => t.placeholder.startsWith('ДПГ сота ='))!, 'Турин = Turin');
    await click('Добавить синонимы');
    await flush();
    expect(posted.at(-1)).toEqual({ url: 'aliases', data: { lines: 'Турин = Turin' } });
    // Выгрузка в xlsx (этап 4): файл приходит base64 и скачивается ссылкой-blob.
    const created: string[] = [];
    URL.createObjectURL = () => 'blob:kb';
    URL.revokeObjectURL = () => undefined;
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      created.push(`${this.download}|${this.href}`);
    };
    await click('Выгрузить в xlsx');
    await flush();
    HTMLAnchorElement.prototype.click = origClick;
    expect(created).toEqual(['kb-prices-2026-10-15.xlsx|blob:kb']);
    expect(document.body.textContent).toContain('Выгружено записей: 1');
  });

  it('KB-PRICE-SHEETS-FIX, п. 3–4: у файла с вкладкой ID вместо разметки колонок — панель книги (счётчики файла и базы, ошибка импорта из журнала, «Импортировать заново»); ошибка видна в карточке сразу', async () => {
    const book = { doors: 30, estimates: 1, components: 44, hardware: 31, hardwareUnpriced: 9, sizes: 147, aliases: 79, comments: 30, dictionary: 243, skipped: ['Прайс по ГОСТ: Цветов, Итого комплект, руб неизвестные колонки — пропущены'] };
    let imp: Record<string, unknown> = { title: 'Межкомнатные двери', updated: false, was: 0, imported: 0, removed: 0, added: 0, at: '2026-10-19T07:00:00Z', book: null, error: 'Подбор: не найдена шапка с колонкой ID' };
    let counts: Record<string, number> | null = null;
    const posted: unknown[] = [];
    const { self } = fakeSelf('settings', {
      'GET /widget/v1/kb/sources': () => ({ sources: [src({ id: 2, kind: 'file', title: 'Межкомнатные двери.xlsx', original: 'Межкомнатные двери.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', prices: counts ? 105 : 0, priceKey: 'межкомнатные двери', priceTitle: 'Межкомнатные двери', priceImport: imp, counts })], usage: { sources: 1, bytes: 80789, chunks: 32, limits: { bytes: 500 * 1024 * 1024, chunks: 20000 } } }),
      'GET /widget/v1/kb/sources/2/prices/preview': () => ({ sheets: ['Прайс по ГОСТ', 'ID', 'Размеры', 'Подбор', 'Дополнения'], columns: [], mapping: { sheet: null, model: 0, price: 0, headerRow: null }, headerFound: true, sample: [], total: 30, skipped: 1, isPriceList: false, isPriceBook: true, book: { ...book, errors: [] }, priceImport: imp }),
      'POST /widget/v1/kb/sources/2/prices/import': (data?: string) => {
        posted.push(JSON.parse(data ?? '{}'));
        imp = { ...imp, error: null, book, imported: 105 };
        counts = { doors: 30, components: 44, hardware: 31, sizes: 147, aliases: 79, comments: 30, dictionary: 243 };
        return { imported: 105, skipped: 1, replaced: 0, book, counts };
      },
      'GET /widget/v1/kb/prices': { items: [], total: 0 },
      'GET /widget/v1/kb/aliases': { aliases: [] },
    });
    document.body.innerHTML = '<div id="work-area-opt_agent"></div>';
    const cbs = createCallbacks(self, 'https://opt.test.ru');
    await act(async () => cbs.advancedSettings!());
    await flush();
    await click('База знаний');
    await flush();
    const text = () => document.body.textContent ?? '';
    // Ошибка импорта — в карточке файла, без похода в журнал.
    expect(text()).toContain('прайс не импортирован: Подбор: не найдена шапка с колонкой ID; прежние данные прайса сохранены');
    await click('Цены из прайса');
    await flush();
    expect(text()).toContain('Многолистовой прайс · вкладки: Прайс по ГОСТ, ID, Размеры, Подбор, Дополнения');
    expect(text()).toContain('В файле: дверей 30 (сметных 1) · комплектующих 44 · фурнитуры 31 (без цены 9) · размеров 147 · синонимов 79 · комментариев 30 · словарь 243');
    expect(text()).toContain('В базе сейчас: прайс не импортирован');
    expect(text()).toContain('Импорт не выполнен: Подбор: не найдена шапка с колонкой ID');
    expect(button('Импортировать заново')).toBeTruthy();
    expect([...document.querySelectorAll('button')].some((b) => /^Импортировать \d+ цен/.test(b.textContent ?? ''))).toBe(false);
    expect(text()).not.toContain('По выбранным колонкам');
    await click('Импортировать заново');
    await flush();
    expect(posted).toEqual([{ mapping: {} }]);
    expect(text()).toContain('Прайс «Межкомнатные двери.xlsx» импортирован заново: дверей 30 (сметных 1), комплектующих 44, фурнитуры 31 (без цены 9), размеров 147, синонимов 79, комментариев 30');
    expect(text()).toContain('прайс «Межкомнатные двери»: дверей 30 · комплектующих 44 · фурнитуры 31 (без цены 9) · размеров 147 · синонимов 79 · комментариев 30 · словарь 243 · сметных 1');
  });

  it('раздел «Цены» (KB-PRICES-UI): сводка по прайсу, вебу и правкам; вкладки с числом строк, поиск по вводу, страницы по 20; удаление только у веб-цен и правок; обновление после удаления источника без перезагрузки', async () => {
    const price = (i: number, origin: 'price_list' | 'web' | 'manager', extra: Record<string, unknown> = {}) => ({ id: i, sourceId: origin === 'price_list' ? 2 : null, model: origin === 'price_list' ? `ДВ CPL ${i}` : origin === 'web' ? `Турин ${i}` : `Тоскана ${i}`, modelKey: '', factory: null, unit: 'шт', baseSize: '910×2100', widthMm: 910, heightMm: 2100, price: 20000 + i, vat: 'no_vat', validAt: i === 5 ? '2026-10-16T00:00:00Z' : '2026-10-10T00:00:00Z', confidence: 70, origin, nonstandard: {}, url: origin === 'web' ? 'https://dveri-a.ru/turin' : null, note: null, createdAt: '2026-10-16T10:00:00Z', sourceTitle: origin === 'price_list' ? '475-2016 CPL.xlsx' : null, sourceKind: origin === 'price_list' ? 'file' : null, ...extra });
    // KB-MULTIPRICE: два прайса-файла — «Межкомнатные» (28 строк, источник 2) и «Металлические» (3 строки, источник 3).
    const inner = (i: number) => ({ ...price(i, 'price_list'), priceKey: 'прайс межкомнатные двери гост', priceTitle: 'Межкомнатные' });
    const metal = (i: number) => ({ ...price(i, 'price_list'), sourceId: 3, model: `ДМ ${i}`, sourceTitle: 'Прайс_металлические_двери_ГОСТ.xlsx', priceKey: 'прайс металлические двери гост', priceTitle: 'Металлические', validAt: '2026-10-16T00:00:00Z' });
    let items = [...Array.from({ length: 28 }, (_, i) => inner(i + 1)), ...Array.from({ length: 3 }, (_, i) => metal(300 + i)), ...Array.from({ length: 16 }, (_, i) => price(100 + i, 'web')), price(200, 'manager')];
    let sources: Record<string, unknown>[] = [{ id: 2, kind: 'file', title: '475-2016 CPL.xlsx', original: '475-2016 CPL.xlsx', mime: null, status: 'indexed', sizeBytes: 20000, chunks: 3, embeddedChunks: 3, refreshDays: null, nextRefreshAt: null, error: null, createdAt: '2026-10-16T09:00:00Z', updatedAt: '2026-10-16T09:00:00Z', indexedAt: '2026-10-16T09:00:05Z', crawl: false, parentId: null, httpStatus: null, job: null, prices: 28, priceKey: 'прайс межкомнатные двери гост', priceTitle: 'Межкомнатные', priceImport: { title: 'Межкомнатные', updated: true, was: 54, imported: 28, removed: 30, added: 4, at: '2026-10-16T09:00:05Z' } }];
    const { self, calls } = fakeSelf('settings', {
      'GET /widget/v1/status': status,
      'GET /widget/v1/settings': { version: 1, settings: {} },
      'GET /widget/v1/kb/sources': () => ({ sources, usage: { sources: sources.length, bytes: 20000, chunks: 3, limits: { bytes: 500 * 1024 * 1024, chunks: 20000 } } }),
      'GET /widget/v1/kb/prices': () => ({ items, total: items.length }),
      'DELETE /widget/v1/kb/prices/100': () => {
        items = items.filter((p) => p.id !== 100);
        return { ok: true };
      },
      'DELETE /widget/v1/kb/sources/2': () => {
        sources = [];
        items = items.filter((p) => p.origin !== 'price_list' || p.sourceId !== 2);
        return { ok: true };
      },
      'GET /widget/v1/kb/aliases': { aliases: [] },
    });
    document.body.innerHTML = '<div id="work-area-opt_agent"></div>';
    const cbs = createCallbacks(self, 'https://opt.test.ru');
    await act(async () => cbs.advancedSettings!());
    await flush();
    await click('База знаний');
    await flush();
    const summary = () => document.querySelector('.opt-kb-prices-summary')?.textContent;
    // KB-MULTIPRICE: сводка по прайсам-файлам с числом цен и датой; в карточке файла — итог обновления.
    expect(summary()).toBe('Прайсы: Межкомнатные — 28 цен (16.10) · Металлические — 3 цены (16.10)  |  веб-цены: 16  |  правки менеджера: 1 (в КП не используются)');
    expect(document.querySelector('.opt-kb-prices-table')).toBeNull();
    expect(document.body.textContent).toContain('прайс «Межкомнатные»: цен 28 · обновлён: было 54, стало 28; удалено 30, добавлено 4');
    await click('Показать');
    await flush();
    const tabs = () => [...document.querySelectorAll('.opt-kb-prices-tab')].map((b) => b.textContent);
    expect(tabs()).toEqual(['Прайс (31)', 'Веб (16)', 'Правки (1)']);
    const rowsShown = () => document.querySelectorAll('.opt-kb-price').length;
    expect(rowsShown()).toBe(20);
    expect(document.querySelector('.opt-kb-prices-pager')?.textContent).toBe('←1–20 из 31→');
    expect([...document.querySelectorAll('.opt-kb-price button')]).toHaveLength(0);
    // Фильтр по файлу: «Металлические» → 3 строки; «все прайсы» → снова 31.
    const listSelect = () => document.querySelector('.opt-kb-prices-list') as HTMLSelectElement;
    expect([...listSelect().options].map((o) => o.textContent)).toEqual(['все прайсы', 'Межкомнатные (28)', 'Металлические (3)']);
    await act(async () => {
      listSelect().value = 'прайс металлические двери гост';
      listSelect().dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(rowsShown()).toBe(3);
    expect(document.querySelector('.opt-kb-price')?.textContent).toContain('ДМ 300');
    await act(async () => {
      listSelect().value = '';
      listSelect().dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(rowsShown()).toBe(20);
    await click('→');
    await flush();
    expect(rowsShown()).toBe(11);
    expect(document.querySelector('.opt-kb-prices-pager')?.textContent).toBe('←21–31 из 31→');
    expect(document.querySelector('.opt-kb-price')?.textContent).toContain('ДВ CPL 21');
    // Поиск по вводу: фильтр внутри вкладки, страница сбрасывается.
    await setInput([...document.querySelectorAll('input')].find((i) => i.placeholder === 'поиск по модели')!, 'cpl 1');
    expect(rowsShown()).toBe(11);
    expect(document.querySelector('.opt-kb-prices-pager')).toBeNull();
    await setInput([...document.querySelectorAll('input')].find((i) => i.placeholder === 'поиск по модели')!, '');
    // Вкладка «Веб»: удаление есть, строка с сайтом источника.
    await click('Веб (16)');
    await flush();
    expect(rowsShown()).toBe(16);
    expect(document.querySelector('.opt-kb-price')?.textContent).toContain('dveri-a.ru');
    expect([...document.querySelectorAll('.opt-kb-price button')]).toHaveLength(16);
    window.confirm = () => true;
    await act(async () => (document.querySelector('.opt-kb-price button') as HTMLButtonElement).click());
    await flush();
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => new URL(c.url).pathname)).toEqual(['/widget/v1/kb/prices/100']);
    expect(tabs()).toEqual(['Прайс (31)', 'Веб (15)', 'Правки (1)']);
    expect(summary()).toContain('веб-цены: 15');
    // Удаление файла «Межкомнатные» уносит только его цены: «Металлические» остаются (KB-MULTIPRICE); сводка и вкладки обновляются без перезагрузки.
    await click('Удалить');
    await flush();
    expect(summary()).toBe('Прайс: Металлические — 3 цены (16.10)  |  веб-цены: 15  |  правки менеджера: 1 (в КП не используются)');
    expect(tabs()).toEqual(['Прайс (3)', 'Веб (15)', 'Правки (1)']);
    expect(document.querySelector('.opt-kb-prices-table')).not.toBeNull();
    await click('Правки (1)');
    await flush();
    expect(document.querySelector('.opt-kb-price')?.textContent).toContain('Тоскана 200');
    await click('Скрыть');
    await flush();
    expect(document.querySelector('.opt-kb-prices-table')).toBeNull();
  });
});

describe('виджет «Агент опт»: сайты и кандидаты в прайс (KP-AGENT-V2, п. 4а, 4.4)', () => {
  it('у сайта — комментарий до 2000 знаков и «фабрика» (PUT /kb/sources/:id/site); выгрузка сайтов xlsx; кандидаты в прайс — список, выгрузка, удаление', async () => {
    let site = { id: 5, kind: 'url', title: 'aqua-door.ru', original: 'https://aqua-door.ru', mime: 'text/html', status: 'indexed', sizeBytes: 2000, chunks: 2, embeddedChunks: 2, refreshDays: 30, nextRefreshAt: null, error: null, createdAt: '2026-10-15T10:00:00Z', updatedAt: '2026-10-15T10:00:00Z', indexedAt: '2026-10-15T10:00:05Z', crawl: false, parentId: null, httpStatus: 200, job: null, comment: 'Только межкомнатные' as string | null, isFactory: false };
    const page = { ...site, id: 6, title: 'aqua-door.ru/catalog', parentId: 5 };
    let candidates = [{ id: 1, leadId: 89813, draftId: 69, model: 'Аква 01 ПГ + УПД', size: '600×2000 мм', price: 14_453, source: 'web_confirmed', url: 'https://aqua-door.ru/p/1', note: null, createdAt: '2026-10-19T10:00:00Z' }];
    const put: unknown[] = [];
    const downloads: string[] = [];
    const { self } = fakeSelf('settings', {
      'GET /widget/v1/kb/sources': () => ({ sources: [site, page], usage: { sources: 2, bytes: 4000, chunks: 4, limits: { bytes: 500 * 1024 * 1024, chunks: 20000 } } }),
      'PUT /widget/v1/kb/sources/5/site': (data?: string) => {
        put.push(JSON.parse(data ?? '{}'));
        site = { ...site, ...JSON.parse(data ?? '{}') };
        return { source: site };
      },
      'GET /widget/v1/kb/sites/export': { filename: 'kb-sites-2026-10-19.xlsx', rows: 1, contentBase64: Buffer.from('PK').toString('base64') },
      'GET /widget/v1/kb/candidates': () => ({ items: candidates }),
      'GET /widget/v1/kb/candidates/export': { filename: 'kb-candidates-2026-10-19.xlsx', rows: 1, contentBase64: Buffer.from('PK').toString('base64') },
      'DELETE /widget/v1/kb/candidates/1': () => {
        candidates = [];
        return { ok: true };
      },
      'GET /widget/v1/kb/prices': { items: [], total: 0 },
      'GET /widget/v1/kb/aliases': { aliases: [] },
    });
    document.body.innerHTML = '<div id="work-area-opt_agent"></div>';
    const cbs = createCallbacks(self, 'https://opt.test.ru');
    await act(async () => cbs.advancedSettings!());
    await flush();
    await click('База знаний');
    await flush();
    // Комментарий и «фабрика» — только у сайта, не у страницы раздела; сохранённое значение — в полях карточки.
    expect(document.querySelectorAll('.opt-kb-site')).toHaveLength(1);
    expect(document.querySelector('.opt-kb-site')?.textContent).toContain('Комментарий');
    expect(document.querySelector('.opt-kb-site')?.textContent).toContain('Фабрика');
    expect((document.querySelector('.opt-kb-site-comment') as HTMLTextAreaElement).value).toBe('Только межкомнатные');
    const saveSite = () => [...document.querySelectorAll('.opt-kb-site button')].find((b) => b.textContent === 'Сохранить') as HTMLButtonElement;
    expect(saveSite().disabled).toBe(true);
    await setInput(document.querySelector('.opt-kb-site-comment'), 'ДПК Аква, межкомнатные. Стальных нет');
    await act(async () => (document.querySelector('.opt-kb-site-factory') as HTMLInputElement).click());
    expect((document.querySelector('.opt-kb-site-comment') as HTMLTextAreaElement).maxLength).toBe(2000);
    const origCreate = URL.createObjectURL;
    const origClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = () => 'blob:x';
    HTMLAnchorElement.prototype.click = function () {
      downloads.push(this.getAttribute('download') ?? '');
    };
    try {
      expect(saveSite().disabled).toBe(false);
      await act(async () => saveSite().click());
      await flush();
      expect(put).toEqual([{ comment: 'ДПК Аква, межкомнатные. Стальных нет', isFactory: true }]);
      expect(document.body.textContent).toContain('Сайт «aqua-door.ru»: комментарий и отметка «фабрика» сохранены');
      // После перечитывания списка — сохранённые значения в полях, «Сохранить» снова неактивна.
      expect((document.querySelector('.opt-kb-site-comment') as HTMLTextAreaElement).value).toBe('ДПК Аква, межкомнатные. Стальных нет');
      expect((document.querySelector('.opt-kb-site-factory') as HTMLInputElement).checked).toBe(true);
      expect(saveSite().disabled).toBe(true);
      await click('Выгрузить сайты (xlsx)');
      await flush();
      expect(document.body.textContent).toContain('Выгружено сайтов: 1');
      // Кандидаты в прайс: цена из интернета, выбранная менеджером, с источником.
      expect(document.querySelector('.opt-kb-candidate')!.textContent?.replace(/\u00a0/g, ' ')).toContain('Аква 01 ПГ + УПД, 600×2000 мм — 14 453 ₽');
      expect(document.querySelector('.opt-kb-candidate')!.textContent).toContain('из интернета, выбрал менеджер · сделка 89813');
      await click('Выгрузить xlsx');
      await flush();
      expect(downloads).toEqual(['kb-sites-2026-10-19.xlsx', 'kb-candidates-2026-10-19.xlsx']);
    } finally {
      URL.createObjectURL = origCreate;
      HTMLAnchorElement.prototype.click = origClick;
    }
    await act(async () => ([...document.querySelector('.opt-kb-candidate')!.querySelectorAll('button')].find((b) => b.textContent === 'Удалить') as HTMLButtonElement).click());
    await flush();
    expect(document.querySelectorAll('.opt-kb-candidate')).toHaveLength(0);
    expect(document.body.textContent).toContain('Кандидатов пока нет');
  });
});

describe('виджет «Агент опт»: наценка прайса (KB-MARKUP)', () => {
  it('в черновике — «фабрика · наценка · цена» у строки прайса; ручная цена — без неё; «Пересчитать» — POST recalc-markup', async () => {
    const line = (i: number, name: string, factory: number, price: number) => ({ request_index: i, page_id: null, name, size: '', qty: 1, price, lead_time: '', discount: 0, priceSource: 'price_file', priceLabel: 'по двери ONX-0001', markup: price === factory ? null : { factoryPrice: factory, pct: 20, price, sourceId: 3, priceKey: 'оникс прайс' } });
    let current = { ...draft, items: [line(0, 'Оникс Авангард', 16_400, 16_400), line(1, 'Коробка', 3125, 3125)], needsManager: [] };
    const posted: string[] = [];
    const { self } = fakeSelf('lcard', {
      'GET /widget/v1/kp/draft': () => ({ draft: current, job: null }),
      'POST /widget/v1/kp/draft/7/recalc-markup': () => {
        posted.push('recalc');
        current = { ...current, items: [line(0, 'Оникс Авангард', 16_400, 19_680), line(1, 'Коробка', 3125, 3750)] };
        return { draft: current, changed: 2, skipped: [] };
      },
    });
    const cbs = createCallbacks(self, 'https://opt.test.ru');
    await act(async () => cbs.render!());
    await flush();
    await expand();
    // Черновик собран при наценке 0 — подписи нет; наценку поменяли в «Базе знаний» — сам черновик не пересчитывается.
    expect(document.querySelectorAll('.opt-kp-row-markup')).toHaveLength(0);
    await clickIn('Пересчитать');
    await flush();
    expect(posted).toEqual(['recalc']);
    const marks = () => [...document.querySelectorAll('.opt-kp-row-markup')].map((x) => x.textContent?.replace(/\u00a0/g, ' '));
    expect(marks()).toEqual(['фабрика 16 400 ₽ · наценка 20 % · цена 19 680 ₽', 'фабрика 3 125 ₽ · наценка 20 % · цена 3 750 ₽']);
    expect(priceInputs().map((x) => x.value)).toEqual(['19680', '3750']);
    // Менеджер поменял цену — подпись наценки у строки пропадает (в КП — его цена).
    await setInput(priceInputs()[0]!, '20000');
    expect(marks()).toEqual(['фабрика 3 125 ₽ · наценка 20 % · цена 3 750 ₽']);
  });

  it('«База знаний»: у прайса — «Наценка, %» с подписью «Цены фабрики × (1 + N %)»; −50…300, шаг 0,1; «Сохранить» — PUT /kb/sources/:id/markup; у сайта поля нет', async () => {
    const base = { kind: 'file', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', status: 'indexed', sizeBytes: 2000, chunks: 2, embeddedChunks: 0, refreshDays: null, nextRefreshAt: null, error: null, createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-20T10:00:00Z', indexedAt: '2026-10-20T10:00:05Z', crawl: false, parentId: null, httpStatus: null, job: null };
    let onyx = { ...base, id: 3, title: 'Оникс прайс октябрь 2026.xlsx', original: 'Оникс прайс октябрь 2026.xlsx', prices: 6, priceKey: 'оникс прайс', priceTitle: 'Оникс', markupPct: 0 };
    const site = { ...base, id: 5, kind: 'url', title: 'onyx.ru', original: 'https://onyx.ru', mime: 'text/html', comment: null, isFactory: true, markupPct: 0, priceKey: null };
    const put: unknown[] = [];
    const { self } = fakeSelf('settings', {
      'GET /widget/v1/kb/sources': () => ({ sources: [onyx, site], usage: { sources: 2, bytes: 4000, chunks: 4, limits: { bytes: 500 * 1024 * 1024, chunks: 20000 } } }),
      'PUT /widget/v1/kb/sources/3/markup': (data?: string) => {
        put.push(JSON.parse(data ?? '{}'));
        onyx = { ...onyx, markupPct: JSON.parse(data ?? '{}').markupPct ?? 0 };
        return { source: onyx };
      },
      'GET /widget/v1/kb/sites/export': { filename: 'x.xlsx', rows: 0, contentBase64: '' },
      'GET /widget/v1/kb/candidates': { items: [] },
      'GET /widget/v1/kb/prices': { items: [], total: 0 },
      'GET /widget/v1/kb/aliases': { aliases: [] },
    });
    document.body.innerHTML = '<div id="work-area-opt_agent"></div>';
    const cbs = createCallbacks(self, 'https://opt.test.ru');
    await act(async () => cbs.advancedSettings!());
    await flush();
    await click('База знаний');
    await flush();
    expect(document.querySelectorAll('.opt-kb-markup')).toHaveLength(1);
    const box = () => document.querySelector('.opt-kb-markup')!;
    const save = () => [...box().querySelectorAll('button')].find((b) => b.textContent === 'Сохранить') as HTMLButtonElement;
    expect(box().textContent).toContain('Наценка, %');
    expect(box().textContent).toContain('Цены фабрики × (1 + 0 %) при расчёте КП');
    expect(save().disabled).toBe(true);
    await setInput(box().querySelector('input'), '301');
    expect(box().textContent).toContain('число от −50 до 300, шаг 0,1');
    expect(save().disabled).toBe(true);
    await setInput(box().querySelector('input'), '12,55');
    expect(save().disabled).toBe(true);
    await setInput(box().querySelector('input'), '20');
    expect(box().textContent).toContain('Цены фабрики × (1 + 20 %) при расчёте КП');
    await act(async () => save().click());
    await flush();
    expect(put).toEqual([{ markupPct: 20 }]);
    expect(document.body.textContent).toContain('Прайс «Оникс»: наценка 20 % сохранена — применяется к новым черновикам и по кнопке «Пересчитать»');
    expect((box().querySelector('input') as HTMLInputElement).value).toBe('20');
    expect(save().disabled).toBe(true);
    // Пусто — 0.
    await setInput(box().querySelector('input'), '');
    await act(async () => save().click());
    await flush();
    expect(put).toEqual([{ markupPct: 20 }, { markupPct: null }]);
  });
});
