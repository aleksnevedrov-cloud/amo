// @vitest-environment jsdom
// KP-PARSE-RETRY: окно КП показывает, что с источниками заявки, — жёлтая пометка «Ящик не прочитан: причина, следующая
// попытка …» и «Проверить почту заново», «Файл "…" не разобран: причина» и «Разобрать заново», сводка по файлам вместо
// «позиций 0»; при пересборке без чтения ящика — почему ящик не читали.
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AmoWidgetSelf } from '@core/widget-core';
import { createCallbacks } from '../src/index.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Responder = unknown | ((data?: string) => unknown);

function fakeSelf(responses: Record<string, Responder>) {
  const calls: { url: string; method?: string; data?: string }[] = [];
  const self: AmoWidgetSelf = {
    get_settings: () => ({ widget_code: 'opt_agent' }),
    system: () => ({ area: 'lcard' }),
    i18n: () => '',
    render_template: ({ render }) => document.body.insertAdjacentHTML('beforeend', render),
    $authorizedAjax: async (opts) => {
      calls.push(opts);
      const key = `${opts.method} ${new URL(opts.url).pathname}`;
      const r = key === 'GET /widget/v1/kp/research' && responses[key] === undefined ? { draftId: 85, pending: false, positions: [] } : responses[key];
      if (r === undefined) throw { status: 404, responseJSON: { message: `нет ответа для ${key}` } };
      return typeof r === 'function' ? (r as (d?: string) => unknown)(opts.data) : r;
    },
  };
  return { self, calls };
}
const flush = () => act(async () => new Promise((r) => setTimeout(r, 20)));
const button = (label: string, root: ParentNode = document) => [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const click = (label: string, root: ParentNode = document) =>
  act(async () => {
    const b = button(label, root);
    if (!b) throw new Error(`Нет кнопки «${label}»`);
    b.click();
  });
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\u00a0/g, ' ') ?? '';

const MAIL_ERROR = 'ящик rf-dveri@yandex.ru временно не пускает (Command failed) — сервер отказал во входе, хотя пароль не отвергнут (частые входы или лишние соединения); следующая попытка не раньше 13:42 МСК';
const mail = (over: Record<string, unknown> = {}) => ({ status: 'error', searchedFrom: 'snab25@glavsistema.ru', date: null, attachments: 0, taken: [], uploaded: [], skipped: [], error: MAIL_ERROR, retryAt: '2026-10-21T10:42:00Z', ...over });
const draft = (source: Record<string, unknown>, items: unknown[] = []) => ({
  id: 85, leadId: 30029472, status: 'draft', kpNo: null, createdAt: '2026-10-21T10:00:00Z', builtAt: null, sentAt: null, hasDocx: false, hasPdf: false,
  client: { org: 'Главсистема', fio: '', email: 'snab25@glavsistema.ru', phone: '' }, requestItems: [], requiredBlocks: [], questions: [], items, needsManager: [],
  source: { from: 'snab25@glavsistema.ru', mails: 1, letterAt: '2026-10-21T09:00:00Z', attachments: [], documents: [], skipped: [], ...source },
});

beforeEach(() => {
  document.body.innerHTML = '';
  window.APP = { data: { current_card: { id: 30029472 } } };
});

describe('окно КП: источники заявки (KP-PARSE-RETRY)', () => {
  it('ящик не прочитан и файл не разобран — пометки с причиной, сводка вместо «позиций 0», кнопки «Разобрать заново» и «Проверить почту заново»', async () => {
    const posted: unknown[] = [];
    const { self } = fakeSelf({
      'GET /widget/v1/kp/draft': {
        draft: draft({
          mail: mail(),
          attachments: ['Заявка № СИ14792.pdf', 'Карточка предприятия.pdf'],
          skipped: [{ name: 'Заявка № СИ14792.pdf', reason: 'Ответ модели не соответствует схеме: Invalid input; повторы и разбор по тексту не помогли', failed: true }],
          files: [
            { name: 'Заявка № СИ14792.pdf', status: 'failed', positions: 0, reason: 'Ответ модели не соответствует схеме: Invalid input; повторы и разбор по тексту не помогли' },
            { name: 'Карточка предприятия.pdf', status: 'skipped', positions: 0, reason: 'карточка / реквизиты предприятия — не заявка' },
            { name: 'image001.png', status: 'skipped', positions: 0, reason: 'картинка меньше 20 КБ (подпись)' },
          ],
        }),
        job: null,
      },
      'POST /widget/v1/kp/draft': (data?: string) => (posted.push(JSON.parse(data ?? '{}')), { queued: true }),
    });
    const cbs = createCallbacks(self, 'https://opt.test.ru');
    await act(async () => cbs.render!());
    await flush();
    // Узкая колонка: вместо «позиций 0» — сводка по файлам; пометки без кнопок.
    const narrow = document.querySelector('.opt-kp-narrow')!;
    expect(text(narrow.querySelector('.opt-kp-counter'))).toBe('позиций нет · файлов найдено 3, взято 1, разобрано 0, пропущено 2, не разобрано 1');
    expect(text(narrow.querySelector('.opt-kp-mail-failed'))).toBe(`Ящик не прочитан: ${MAIL_ERROR}`);
    expect(text(narrow.querySelector('.opt-kp-file-failed'))).toBe('Файл «Заявка № СИ14792.pdf» не разобран: Ответ модели не соответствует схеме: Invalid input; повторы и разбор по тексту не помогли');
    expect(button('Разобрать заново', narrow)).toBeUndefined();

    await click('Развернуть ⤢');
    const modal = document.querySelector('.opt-kp-modal')!;
    expect(text(modal.querySelector('.opt-kp-mail-failed'))).toContain('черновик собран по файлам и письму из сделки');
    // Время следующей попытки не повторяется, если сервер уже написал его в причине.
    expect(text(modal.querySelector('.opt-kp-mail-failed')).match(/следующая попытка/g)).toHaveLength(1);
    await click('Файлы: найдено 3, взято 1, разобрано 0, пропущено 2, не разобрано 1 ›', modal);
    expect([...modal.querySelectorAll('.opt-kp-files > div')].map(text)).toEqual([
      'Заявка № СИ14792.pdf — не разобран: Ответ модели не соответствует схеме: Invalid input; повторы и разбор по тексту не помогли',
      'Карточка предприятия.pdf — пропущен: карточка / реквизиты предприятия — не заявка',
      'image001.png — пропущен: картинка меньше 20 КБ (подпись)',
    ]);
    await click('Разобрать заново', modal);
    await flush();
    await click('Проверить почту заново', modal);
    await flush();
    expect(posted).toEqual([{ leadId: 30029472 }, { leadId: 30029472, checkMail: true }]);
  });

  it('пересборка без чтения ящика: позиции есть — счётчик позиций, пометка «ящик не читали» и «Проверить почту заново»', async () => {
    const item = (i: number) => ({ request_index: i, page_id: null, name: `Дверь ${i + 1}`, size: '800×2100 мм', qty: 1, price: null, lead_time: '', discount: 0, priceSource: null });
    const { self } = fakeSelf({
      'GET /widget/v1/kp/draft': {
        draft: draft(
          {
            mail: mail({ status: 'skipped', searchedFrom: '', error: 'в сделке уже есть файлы заявки (1) — ящик не читали; новое письмо — кнопка «Проверить почту заново»', retryAt: null }),
            files: [{ name: 'Заявка № СИ14792.pdf', status: 'parsed', positions: 6, reason: 'разобран со 2-й попытки' }],
            documents: [501],
          },
          [0, 1, 2, 3, 4, 5].map(item),
        ),
        job: null,
      },
    });
    const cbs = createCallbacks(self, 'https://opt.test.ru');
    await act(async () => cbs.render!());
    await flush();
    const narrow = document.querySelector('.opt-kp-narrow')!;
    expect(text(narrow.querySelector('.opt-kp-counter'))).toBe('позиций 6');
    expect(narrow.querySelector('.opt-kp-source-notes')).toBeNull();
    await click('Развернуть ⤢');
    const modal = document.querySelector('.opt-kp-modal')!;
    expect(modal.querySelector('.opt-kp-mail-failed')).toBeNull();
    expect(text(modal.querySelector('.opt-kp-source-notes .opt-kp-sub'))).toBe('Ящик не читали: файлы заявки уже в сделке.Проверить почту заново');
    await click('Файлы: найдено 1, взято 1, разобрано 1, пропущено 0 ›', modal);
    expect(text(modal.querySelector('.opt-kp-files > div'))).toBe('Заявка № СИ14792.pdf — разобран, 6 позиций (разобран со 2-й попытки)');
    await click('Письмо и файлы', modal);
    const summary = modal.querySelector('.opt-kp-mail-tab .opt-details-summary')!;
    expect(text(summary)).toBe('Письмо: из прошлой сборки (21.10.2026), ящик не читали ›');
    expect(summary.classList.contains('opt-details-warn')).toBe(false);
  });
});
