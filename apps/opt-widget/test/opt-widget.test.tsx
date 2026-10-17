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
    // Макет Figma: карточки черновик, позиции, вопросы, ответ из базы знаний (RFD-AI-AGENT-OPT-KB, этап 4), действия, примечание;
    // позиция — плитка с полями под названием, кнопки столбиком.
    expect(document.querySelectorAll('.opt-root.opt-kp')).toHaveLength(1);
    expect([...document.querySelectorAll('.opt-kp-card .opt-kp-title')].map((h) => h.textContent)).toEqual(['Черновик КП', 'Позиции КП', 'Уточнить у клиента', 'Ответ из базы знаний', 'Действия с КП']);
    expect(document.querySelectorAll('.opt-kp-card')).toHaveLength(6);
    const tile = document.querySelector('.opt-kp-tile')!;
    const tileHas = (sel: string, text: string) => tile.querySelector(sel)?.textContent === text;
    expect([...document.querySelectorAll('.opt-kp-badge')].map((b) => b.textContent)).toEqual(['Черновик', '1']);
    expect(document.querySelectorAll('.opt-kp-badge')[1]?.getAttribute('title')).toBe('1 позиция');
    expect(tileHas('.opt-kp-suffix > span', '%')).toBe(true);
    expect(tile.querySelector('.opt-kp-tile-name')?.textContent).toBe('Дверь ДПС 01');
    expect(tile.querySelector('.opt-kp-sub')?.textContent).toBe('2100 × 900 мм');
    // KP-NAME: без строки прайса под названием нет «по прайсу» и комплектации.
    expect(tile.querySelector('.opt-kp-tile-model')).toBeNull();
    expect(tile.querySelector('.opt-kp-tile-equipment')).toBeNull();
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
    // KB-COMPONENTS, п. 6: на кнопке прогресс «обработано / поставлено».
    const searching = [...document.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Ищу цены…'));
    expect(searching?.disabled).toBe(true);
    expect(searching?.textContent).toBe('Ищу цены… 0 / 1');
    // Работа: пометка «по замеру», поле цены с подсказкой «по замеру», без кнопки поиска.
    expect(document.querySelector('.opt-kp-tile-service .opt-kp-service-note')?.textContent).toContain('работы — по замеру');
    expect((document.querySelector('.opt-kp-tile-service input[placeholder="по замеру"]') as HTMLInputElement | null)?.value).toBe('');
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
    // Работа без цены не мешает сборке и не входит в итог (108 900 × 2 шт).
    expect(button('Собрать документ')?.disabled).toBe(false);
    expect(text().replace(/\u00a0/g, ' ')).toContain('Итого1 197 900 ₽');
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

  it('KP-WIDGET-REFRESH: поиск завершился мгновенно (цены из базы) — после POST research виджет перечитывает черновик и показывает цены без F5; правки во время поиска сбрасываются', async () => {
    const item = (i: number, price: number | null) => ({ request_index: i, page_id: null, name: `Дверной блок ${i + 1}`, size: '910×2100 мм', qty: 1, price, lead_time: '', discount: 0, ...(price ? { priceSource: 'kb' as const, priceLabel: 'по прайсу: ДВ CPL (строка 5)', priceStale: false, kbPriceId: 5 } : {}) });
    let current = { ...draft, id: 54, items: [item(0, null), item(1, null), item(2, null)], needsManager: [0, 1, 2].map((i) => ({ request_index: i, reason: 'цена не задана' })) };
    const calls: string[] = [];
    const { self } = fakeSelf('lcard', {
      'GET /widget/v1/kp/draft': () => {
        calls.push('draft');
        return { draft: current, job: null };
      },
      // Задания из базы знаний выполняются мгновенно: к первому опросу ни queued, ни running уже нет.
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
    const text = () => document.body.textContent?.replace(/\u00a0/g, ' ') ?? '';
    expect([...document.querySelectorAll<HTMLInputElement>('input[placeholder="Нет цены"]')].map((i) => i.value)).toEqual(['', '', '']);
    expect(button('Собрать документ')?.disabled).toBe(true);
    calls.length = 0;
    await click('Найти цены');
    await flush();
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    // POST → один GET research (поиск уже завершён) → GET draft: цены на месте, итог и кнопка сборки доступны без F5.
    expect(calls).toEqual(['post', 'research', 'draft']);
    expect([...document.querySelectorAll<HTMLInputElement>('input[placeholder="Нет цены"]')].map((i) => i.value)).toEqual(['23900', '23900', '23900']);
    expect(text()).toContain('Цена · по прайсу: ДВ CPL (строка 5)');
    expect(text()).toContain('Итого71 700 ₽');
    expect(button('Собрать документ')?.disabled).toBe(false);
    expect(button('Найти цены')?.disabled).toBe(false);
  });

  it('цена из базы знаний (этап 3): подпись источника в плитке, «цена устарела», кнопка «Искать в интернете» шлёт force', async () => {
    const kbDraft = { ...draft, items: [
      { request_index: 0, page_id: null, name: 'Дверной блок деревянный внутренний глухой однопольный распашной без порога, с доводчиком, внутренним механическим замком с ключом снаружи и изнутри, облицовка CPL светло-серый', size: '800×2000 мм', qty: 10, price: 3450, lead_time: '', discount: 0, priceSource: 'kb', priceLabel: 'по базе: прайс Текона.xlsx (01.10.2026)', priceStale: false, kbPriceId: 5, priceModel: 'ДВ CPL 0,2 мм', priceAbbr: 'ДВ 1Рп Г ПрБ', equipment: 'коробка, 3 петли, уплотнитель, замок, ручки, доводчик' },
      { request_index: 1, page_id: null, name: 'Турин', size: '800×2000 мм', qty: 3, price: 8000, lead_time: '', discount: 0, priceSource: 'research', priceLabel: 'по рынку (01.08.2026)', market: { median: 8000, min: 7800, max: 8200, count: 3, unit: 'piece', researchId: 9, researchedAt: '2026-08-01T10:00:00Z' } },
      { request_index: 2, page_id: null, name: 'ДПО сота', size: '800×2000 мм', qty: 1, price: 4100, lead_time: '', discount: 0, priceSource: 'kb', priceLabel: 'изменено менеджером', priceStale: true },
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
    const labels = [...document.querySelectorAll('.opt-kp-field-price .opt-kp-label')].map((l) => l.textContent);
    expect(labels).toEqual(['Цена · по базе: прайс Текона.xlsx (01.10.2026)', 'Цена · по рынку (01.08.2026) · цена устарела', 'Цена · изменено менеджером · цена устарела']);
    expect(document.body.textContent).toContain('из базы знаний: по базе: прайс Текона.xlsx (01.10.2026)');
    // KP-NAME: полное название без обрезания, под ним модель с покрытием из прайса и комплектация.
    const first = document.querySelector('.opt-kp-tile')!;
    expect(first.querySelector('.opt-kp-tile-name')?.textContent).toBe('Дверной блок деревянный внутренний глухой однопольный распашной без порога, с доводчиком, внутренним механическим замком с ключом снаружи и изнутри, облицовка CPL светло-серый');
    expect(first.querySelector('.opt-kp-tile-model')?.textContent).toBe('Обозначение по прайсу: ДВ CPL 0,2 мм (ДВ 1Рп Г ПрБ)');
    expect(first.querySelector('.opt-kp-tile-equipment')?.textContent).toBe('Комплектация: коробка, 3 петли, уплотнитель, замок, ручки, доводчик');
    const buttons = [...document.querySelectorAll('button')].filter((b) => b.textContent === 'Искать в интернете');
    expect(buttons).toHaveLength(2);
    await act(async () => buttons[0]!.click());
    await flush();
    expect(posted).toEqual([{ draftId: 7, requestIndexes: [0], force: true }]);
  });

  it('ответ из базы знаний в карточке сделки (этап 4): вопрос → POST /kb/answer с leadId, ответ и источники', async () => {
    const posted: unknown[] = [];
    const { self } = fakeSelf('lcard', {
      'GET /widget/v1/kp/draft': { draft, job: null },
      'POST /widget/v1/kb/answer': (data?: string) => {
        posted.push(JSON.parse(data ?? '{}'));
        return { question: 'какая скидка от 50 полотен', answer: 'Скидка опт от 50 полотен — 12 % [1].', sources: [{ n: 1, chunkId: 10, sourceId: 1, label: 'заметка «Скидки» (15.10.2026)', excerpt: 'Скидка опт от 50 полотен — 12 %' }], reason: null, cost: { inputTokens: 400, outputTokens: 30, usd: 0.0012 }, provider: 'openai', model: 'gpt-5.5', ms: 900 };
      },
    });
    const cbs = createCallbacks(self, 'https://opt.test.ru');
    await act(async () => cbs.render!());
    await flush();
    expect([...document.querySelectorAll('.opt-kp-card .opt-kp-title')].map((h) => h.textContent)).toContain('Ответ из базы знаний');
    expect(button('Ответить из базы')?.disabled).toBe(true);
    await setInput(document.querySelector('.opt-kb-answer-input'), 'какая скидка от 50 полотен');
    expect(button('Ответить из базы')?.disabled).toBe(false);
    await click('Ответить из базы');
    await flush();
    expect(posted).toEqual([{ question: 'какая скидка от 50 полотен', leadId: 555 }]);
    expect(document.body.textContent).toContain('Скидка опт от 50 полотен — 12 % [1].');
    expect(document.body.textContent).toContain('[1] заметка «Скидки» (15.10.2026): Скидка опт от 50 полотен — 12 %');
    expect(document.body.textContent).toContain('gpt-5.5, $0.0012, 900 мс');
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
    // Скачивание (KP-DOWNLOAD): кнопки рядом с бейджем, клик берёт подписанную ссылку и открывает её как вложение.
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
      'GET /widget/v1/kb/aliases': { aliases: [{ id: 1, alias: 'ДПГ + УПД (сота)', canonical: 'ДПГ сота' }] },
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
    await setInput([...document.querySelectorAll('textarea')][0]!, 'Скидка опт от 50 полотен — 12 %');
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
    expect(button('Добавить ссылку')?.disabled).toBe(false);
    await click('Добавить ссылку');
    await flush();
    expect(posted.at(-1)).toEqual({ url: 'url', data: { url: 'https://rf-dveri.ru/ceny/', refreshDays: 14, crawl: true } });
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
    const inputs = [...document.querySelectorAll('input')];
    await setInput(inputs.find((i) => i.placeholder === 'Модель')!, 'ДПО сота');
    await setInput(inputs.find((i) => i.placeholder === '800×2000')!, '800x2000');
    await setInput(inputs.find((i) => i.placeholder === 'цена, ₽')!, '4 100');
    await click('Добавить цену');
    await flush();
    expect(posted.at(-1)).toMatchObject({ url: 'price', data: { model: 'ДПО сота', widthMm: 800, heightMm: 2000, price: 4100, origin: 'manager' } });
    expect(document.body.textContent).toContain('Синонимы и артикулы (1)');
    expect(document.body.textContent).toContain('ДПГ + УПД (сота)= ДПГ сота');
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
    expect(summary()).toBe('Прайсы: Межкомнатные — 28 цен (16.10) · Металлические — 3 цены (16.10)  |  веб-цены: 16  |  правки менеджера: 1');
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
    expect(summary()).toBe('Прайс: Металлические — 3 цены (16.10)  |  веб-цены: 15  |  правки менеджера: 1');
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
