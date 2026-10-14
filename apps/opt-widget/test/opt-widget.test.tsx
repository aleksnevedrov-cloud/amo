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
    // Карточка «Черновик КП» по макету: бейдж статуса, подпись про номер, покупатель меткой капсом (CSS), название, e-mail.
    expect(document.querySelector('.opt-kp-badge')?.textContent).toBe('Черновик');
    expect(document.body.textContent).toContain('Номер появится после сборки документа');
    expect(document.querySelector('.opt-kp-buyer')?.textContent).toBe('ПокупательООО Ромашка · Иванов Иванivanov@romashka.ru');
    // Ящик не настроен: строка-статус по письму из карточки; ошибки файлов — только в раскрытии, в черновике красных строк нет.
    expect(document.body.textContent).toContain('Письмо: 09.10.2026 (из карточки, ящик не настроен) ›');
    expect(document.body.textContent).not.toContain('big.pdf');
    expect(document.querySelectorAll('.opt-error')).toHaveLength(0);
    await click('Письмо: 09.10.2026 (из карточки, ящик не настроен) ›');
    expect(document.body.textContent).toContain('Разобрано файлов: 1 · писем в карточке: 1');
    expect(document.body.textContent).toContain('«big.pdf»: файл больше 20 МБ');
    expect(document.body.textContent).toContain('Дверь ДПС 01');
    expect(document.body.textContent).toContain('Сторона открывания?');
    expect(button('Собрать документ')?.disabled).toBe(true);
    expect(button('Отправить клиенту')?.disabled).toBe(true);
    // Макет Figma: 5 карточек (черновик, позиции, вопросы, действия, примечание), позиция — плитка с полями под названием, кнопки столбиком.
    expect(document.querySelectorAll('.opt-root.opt-kp')).toHaveLength(1);
    expect([...document.querySelectorAll('.opt-kp-card .opt-kp-title')].map((h) => h.textContent)).toEqual(['Черновик КП', 'Позиции КП', 'Уточнить у клиента', 'Действия с КП']);
    expect(document.querySelectorAll('.opt-kp-card')).toHaveLength(5);
    const tile = document.querySelector('.opt-kp-tile')!;
    const tileHas = (sel: string, text: string) => tile.querySelector(sel)?.textContent === text;
    expect([...document.querySelectorAll('.opt-kp-badge')].map((b) => b.textContent)).toEqual(['Черновик', '1']);
    expect(document.querySelectorAll('.opt-kp-badge')[1]?.getAttribute('title')).toBe('1 позиция');
    expect(tileHas('.opt-kp-suffix > span', '%')).toBe(true);
    expect(tile.querySelector('.opt-kp-tile-name')?.textContent).toBe('Дверь ДПС 01');
    expect(tile.querySelector('.opt-kp-sub')?.textContent).toBe('2100 × 900 мм');
    expect([...tile.querySelectorAll('.opt-kp-label')].map((l) => l.textContent)).toEqual(['Количество', 'Цена', 'Скидка']);
    expect([...document.querySelectorAll('.opt-kp-questions li')].map((l) => l.textContent)).toEqual(['Сторона открывания?']);
    const actions = [...document.querySelectorAll('.opt-kp-card')].find((c) => c.querySelector('.opt-kp-title')?.textContent === 'Действия с КП')!;
    expect([...actions.querySelectorAll('.opt-actions .opt-btn')].map((b) => b.textContent)).toEqual(['Собрать заново', 'Сохранить правки', 'Собрать документ', 'Отправить клиенту']);
    // Кнопка поиска цен — в карточке позиций (этап 6).
    expect(button('Найти цены')?.disabled).toBe(false);
    expect(button('Сохранить правки')?.disabled).toBe(true);
    expect(document.body.textContent).toContain('Документ можно отправить после сборки и проверки цены, состава комплекта и данных покупателя.');
    expect(document.querySelector('.opt-table')).toBeNull();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('раздел «Письмо»: строка-статус с датой по МСК и числом вложений, по клику — отправитель, тема, папка, вложения со статусом; e-mail покупателя не дублируется', async () => {
    const mailDraft = {
      ...draft,
      client: { org: '', fio: 'stoptpostavka@yandex.ru', email: 'StOptPostavka@yandex.ru', phone: '' },
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
    const text = () => document.body.textContent ?? '';
    // Дубль e-mail убран: имя контакта в amo — тот же адрес.
    expect(document.querySelector('.opt-kp-buyer')?.textContent).toBe('ПокупательStOptPostavka@yandex.ru');
    expect(text().match(/stoptpostavka@yandex\.ru/gi)).toHaveLength(1);
    // Свёрнуто: только строка-статус, 08:06 UTC = 11:06 МСК; служебных сведений и красных строк в черновике нет.
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
    expect(document.body.textContent).toContain('Письмо: не найдено ›');
    expect(document.querySelectorAll('.opt-error')).toHaveLength(0);
    await click('Письмо: не найдено ›');
    expect(document.body.textContent).toContain('Искали от ivanov@romashka.ru (и весь домен @romashka.ru), даты 2026-10-07 – 2026-10-12, тема «Запрос КП». Черновик собран по карточке.');
    expect(document.body.textContent).toContain('Папки (2):INBOX: в окне дат 12, от отправителя 0Spam: в окне дат 1, от отправителя 0');
    expect(document.body.textContent).toContain('Не смотрели: Sent, Drafts');
    expect(document.body.textContent).toContain('Spam: SEARCH по дате прерван по таймауту');
  });

  it('поиск цен (этап 6): «Найти цены» ставит задание, строка позиции показывает ход поиска, затем цену с пометкой и раскрытие «Источники»; «Искать заново» идёт мимо кэша', async () => {
    // Вторая строка — работа (XLSX-2): после товаров под заголовком «Работы и услуги», без размера и без кнопки поиска цены.
    const service = { request_index: 1, page_id: null, name: 'Врезка замка на производстве', size: '', qty: 21, price: null, lead_time: '', discount: 0, kind: 'service' as const };
    let current = { ...draft, items: [...draft.items, service], needsManager: [{ request_index: 0, reason: 'цена не задана' }, { request_index: 1, reason: 'цена не задана' }] };
    let stage: 'idle' | 'running' | 'done' = 'idle';
    const posts: string[] = [];
    const offers = [
      { url: 'https://woodwindows.ru/1', seller: 'Альянс', title: 'Дверь', price: 77_000, currency: 'RUB', unit: 'piece', vatStated: 'unknown', unitPrice: 107_800, accepted: true, reason: null, manufacturer: false, formula: '77 000 ₽ × (3,780 м² / 2,700 м²) = 107 800 ₽', notes: ['НДС по умолчанию (не указан на сайте)', 'аналог, пересчёт по площади с 1000×2700'], vatAssumed: true, areaScaled: true, sourceSize: '1000×2700', foundAt: '2026-10-14T08:00:00Z' },
      { url: 'https://fabrika-l.ru/p', seller: 'Фабрика Л', title: 'Дверь', price: 110_000, currency: 'RUB', unit: 'piece', vatStated: 'included', unitPrice: 110_000, accepted: true, reason: null, manufacturer: true, formula: null, notes: [], vatAssumed: false, areaScaled: false, sourceSize: null, foundAt: '2026-10-14T08:00:00Z' },
      { url: 'https://vinchelli.ru/1', seller: 'Винчелли', title: 'Дверь', price: 63_540, currency: 'RUB', unit: 'piece', vatStated: 'unknown', unitPrice: 63_540, accepted: false, reason: 'размер не указан', manufacturer: false, formula: null, notes: [], vatAssumed: true, areaScaled: false, sourceSize: null, foundAt: '2026-10-14T08:00:00Z' },
    ];
    const done = { id: 9, status: 'ok', query: 'дверь двухпольная лиственница 1400×2700 купить цена Москва', stats: { min: 107_800, max: 110_000, median: 108_900, count: 2, unit: 'piece' }, error: null, createdAt: '2026-10-14T08:06:00Z', webSearchCalls: 2, costUsd: 0.15, analog: null, offers };
    const { self } = fakeSelf('lcard', {
      'GET /widget/v1/kp/draft': () => ({ draft: current, job: null }),
      'GET /widget/v1/kp/research': () => ({ draftId: 7, pending: stage === 'running', positions: [{ requestIndex: 0, job: stage === 'running' ? { state: 'running' } : null, research: stage === 'done' ? done : null }] }),
      'POST /widget/v1/kp/research': (data?: string) => {
        posts.push(data ?? '');
        stage = 'running';
        return { queued: [0] };
      },
    });
    const cbs = createCallbacks(self, 'https://opt.test.ru');
    await act(async () => cbs.render!());
    await flush();
    const text = () => document.body.textContent ?? '';
    expect(button('Найти цены')?.disabled).toBe(false);
    expect(button('Найти цену')).toBeDefined();
    expect([...document.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Найти цену')).toHaveLength(1);
    expect([...document.querySelectorAll('.opt-kp-group')].map((g) => g.textContent)).toEqual(['Работы и услуги']);
    expect(document.querySelector('.opt-kp-tile-service')?.textContent).toContain('Врезка замка на производстве');
    await click('Найти цены');
    await flush();
    expect(JSON.parse(posts[0]!)).toEqual({ draftId: 7, requestIndexes: 'all', force: false });
    expect(text()).toContain('идёт поиск цены…');
    expect(button('Ищу цены…')?.disabled).toBe(true);
    // Воркер закончил: цена легла в черновик, следующий опрос приносит результат и перечитывает черновик.
    stage = 'done';
    current = { ...current, items: [{ ...current.items[0]!, price: 108_900, priceSource: 'analog', coefficient: 1, market: { median: 108_900, min: 107_800, max: 110_000, count: 2, unit: 'piece', researchId: 9, researchedAt: '2026-10-14T08:06:00Z' } }], needsManager: [{ request_index: 0, reason: 'ограничение расчёта: 2 источника' }, { request_index: 0, reason: 'аналог, пересчёт по площади с 1000×2700' }] } as unknown as typeof current;
    await act(async () => cbs.render!());
    await flush();
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(text()).toContain('найдено 2 источника · 14.10.2026 11:06 · Источники ›');
    expect(text()).toContain('ограничение расчёта: 2 источника; аналог, пересчёт по площади с 1000×2700');
    expect((document.querySelector('input[placeholder="Нет цены"]') as HTMLInputElement).value).toBe('108900');
    expect(text()).toContain('Цена · по аналогу');
    expect(text()).not.toContain('Винчелли');
    await click('найдено 2 источника · 14.10.2026 11:06 · Источники ›');
    expect(text().replace(/\u00a0/g, ' ')).toContain('Диапазон 107 800 ₽ – 110 000 ₽, медиана 108 900 ₽ за шт');
    const rows = [...document.querySelectorAll('.opt-kp-offer')].map((el) => [el.classList.contains('opt-muted'), el.textContent?.replace(/\u00a0/g, ' ')]);
    expect(rows[0]![0]).toBe(false);
    expect(rows[0]![1]).toContain('Альянс — 77 000 RUB/шт, 1000×2700 → 107 800 ₽ за шт');
    expect(rows[0]![1]).toContain('НДС не указан; НДС по умолчанию (не указан на сайте); аналог, пересчёт по площади с 1000×2700; 77 000 ₽ × (3,780 м² / 2,700 м²) = 107 800 ₽ · woodwindows.ru');
    expect(rows[1]![1]).toContain('★ Фабрика Л — 110 000 RUB/шт');
    expect(rows[2]).toEqual([true, expect.stringContaining('Винчелли — 63 540 RUB/шт — размер не указан')]);
    expect([...document.querySelectorAll('.opt-kp-offer a')].map((a) => a.getAttribute('href'))).toEqual(['https://woodwindows.ru/1', 'https://fabrika-l.ru/p', 'https://vinchelli.ru/1']);
    expect(text()).toContain('вызовов поиска 2, $0.150');
    // Все позиции с ценой — «Найти цены» ничего не ставит, а «Искать заново» у позиции идёт мимо кэша.
    await click('Искать заново');
    expect(JSON.parse(posts[1]!)).toEqual({ draftId: 7, requestIndexes: [0], force: true });
    // Правка цены руками помечает её как ручную.
    stage = 'done';
    await act(async () => cbs.render!());
    await flush();
    await setInput(document.querySelector('input[placeholder="Нет цены"]'), '100000');
    expect(text()).toContain('Цена · изменено менеджером');
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
    await setInput(document.querySelector('input[placeholder="Нет цены"]'), '14900');
    expect(button('Собрать документ')?.disabled).toBe(true);
    await click('Сохранить правки');
    await flush();
    expect(document.querySelector('.opt-kp-total')?.textContent?.replace(/\u00a0/g, ' ')).toBe('Итого163 900 ₽');
    await click('Собрать документ');
    await flush();
    expect(document.querySelector('.opt-kp-sub')?.textContent).toBe('КП-2026-1');
    expect(document.querySelector('.opt-kp-badge')?.textContent).toBe('Документ собран');
    expect(document.body.textContent).toContain('Документ собран (DOCX и PDF) — файлы в карточке сделки');
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

  it('вкладки КП, Модель, Письмо, Журнал; письмо сохраняется вместе с паролем', async () => {
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
    // Фраза о ценах редактируется в константах КП; вкладки «База знаний» нет (решение заказчика 12.10.2026).
    expect(document.body.textContent).toContain('Фраза о ценах');
    expect(document.body.textContent).toContain('Домены производителей');
    expect([...document.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('База знаний');
    // Настройки поиска цен (этап 6): переключатель автопоиска, коэффициенты (справочник строками «имя = число»), кэш, лимит.
    expect(document.body.textContent).toContain('Искать цены автоматически при сборке черновика');
    const pairs = [...document.querySelectorAll('textarea')].find((t) => t.value === 'Профиль Дорс = 0.9')!;
    await setInput(pairs, 'Профиль Дорс = 0.9\nБраво: 1,1\nмусор');
    const auto = [...document.querySelectorAll('input[type=checkbox]')][0] as HTMLInputElement;
    await act(async () => auto.click());
    await click('Сохранить');
    await flush();
    expect(JSON.parse(saved.at(-1)!)).toMatchObject({ constants: { priceCoefficient: 1, manufacturerCoefficients: { 'Профиль Дорс': 0.9, Браво: 1.1 }, autoResearch: true, researchCacheDays: 7, maxPositionsPerRun: 30 } });
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
