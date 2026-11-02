// @vitest-environment jsdom
// Раскладка блока «Агент опт — КП» в узкой колонке amoCRM и окна КП на 88 % (KP-AGENT-V2, п. 6а): jsdom вёрстку не считает,
// поэтому разметка отрисовывается React-ом, а замер идёт в headless Chromium (тот же, что у Playwright) по file://-странице с styles.css.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import type { AmoWidgetSelf } from '@core/widget-core';
import { createCallbacks } from '../src/index.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHROME = process.env.CHROME_BIN ?? '/opt/pw-browsers/chromium';
const hasChrome = existsSync(CHROME);
// Запуск vitest из apps/opt-widget: путь от корня пакета.
const css = readFileSync(join(process.cwd(), 'src/styles.css'), 'utf8');

const draft = {
  id: 17, leadId: 30013995, status: 'draft', kpNo: null, createdAt: '2026-10-13T08:10:00Z', builtAt: null, sentAt: null, hasDocx: false, hasPdf: false,
  client: { org: 'ООО Стройоптпоставка', fio: '', email: 'stoptpostavka@yandex.ru', phone: '' },
  requestItems: [], requiredBlocks: [], questions: ['Нужна только дверь или комплект с коробкой, наличниками и фурнитурой?', 'Нужны услуги доставки и монтажа?'],
  items: [{ request_index: 0, page_id: null, name: 'Дверь межкомнатная двупольная из массива лиственницы', size: '1400×2700 мм', qty: 2, price: null, lead_time: '', discount: 0 }],
  needsManager: [{ request_index: 0, reason: 'цена не задана' }],
  source: { from: 'mailbox', mails: 1, letterAt: '2026-10-13T08:06:00Z', attachments: ['photo.jpg'], documents: [501], skipped: [], mail: { status: 'found', searchedFrom: 'stoptpostavka@yandex.ru', from: 'stoptpostavka@yandex.ru', fromName: null, subject: 'Запрос', date: '2026-10-13T08:06:00Z', folder: 'INBOX', matchedBy: 'address', attachments: 1, taken: ['photo.jpg'], uploaded: ['photo.jpg'], skipped: [], files: [{ name: 'photo.jpg', size: 1_300_000, inline: false, status: 'uploaded', reason: null }], error: null, retryAt: null, diag: null } },
};

/** Разметка блока после отрисовки React-ом в jsdom; open — с окном КП («Развернуть ⤢», окно — порталом в body); send — и с окном письма. */
async function renderBlock(open = false, send = false): Promise<string> {
  document.body.innerHTML = '';
  window.APP = { data: { current_card: { id: 30013995 } } };
  const self: AmoWidgetSelf = {
    get_settings: () => ({ widget_code: 'opt_agent' }),
    system: () => ({ area: 'lcard' }),
    i18n: () => '',
    render_template: ({ render }) => document.body.insertAdjacentHTML('beforeend', render),
    $authorizedAjax: async (opts) =>
      opts.url.includes('/kp/research')
        ? { draftId: 17, pending: false, positions: [{ requestIndex: 0, job: null, research: null }] }
        : opts.url.includes('/kp/send/preview')
          ? { to: 'stoptpostavka@yandex.ru', cc: '', subject: 'Коммерческое предложение КП-2026-13', text: 'Здравствуйте!', signature: '', attachment: { name: 'KP-КП-2026-13.pdf', bytes: 120_000 }, blockers: [], warnings: [], alreadySent: false }
          : { draft: send ? { ...draft, status: 'built', kpNo: 'КП-2026-13', hasPdf: true, hasDocx: true, items: [{ ...draft.items[0], price: 23_900 }] } : draft, job: null },
  };
  const cbs = createCallbacks(self, 'https://opt.test.ru');
  await act(async () => cbs.render!());
  await act(async () => new Promise((r) => setTimeout(r, 20)));
  if (open) await act(async () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Развернуть ⤢')!.click());
  if (send) {
    await act(async () => ([...document.querySelectorAll('.opt-kp-modal button')].find((b) => b.textContent === 'Отправить клиенту') as HTMLButtonElement).click());
    await act(async () => new Promise((r) => setTimeout(r, 20)));
  }
  return document.body.innerHTML;
}

/** Страница со стилями виджета: колонка заданной ширины (как в amoCRM: отступы 8/10 px) и замер скриптом в Chromium. */
function measure<T>(html: string, columnPx: number, script: string, win = { w: columnPx + 40, h: 3000 }): T {
  const dir = mkdtempSync(join(tmpdir(), 'opt-widget-layout-'));
  try {
    const page = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body style="margin:0">
<div id="col" style="width:${columnPx}px;padding:8px 10px;box-sizing:border-box;overflow:visible">${html}</div>
<script>
const lines = (el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
const col = document.getElementById('col');
const out = (() => { ${script} })();
document.body.appendChild(Object.assign(document.createElement('pre'), { id: 'result', textContent: JSON.stringify(out) }));
</script></body></html>`;
    const file = join(dir, 'page.html');
    writeFileSync(file, page);
    const dom = execFileSync(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--window-size=${win.w},${win.h}`, '--dump-dom', `file://${file}`], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /<pre id="result">([\s\S]*?)<\/pre>/.exec(dom);
    if (!m) throw new Error('Chromium не вернул результат замера');
    return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&')) as T;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NARROW = `
  const narrow = document.querySelector('.opt-kp-narrow');
  const t = narrow.querySelector('.opt-kp-title');
  const b = narrow.querySelector('.opt-kp-badge');
  const mid = (el) => el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2;
  return {
    overflow: col.scrollWidth > col.clientWidth,
    title: { text: t.textContent, lines: lines(t) },
    badgeSameLine: Math.abs(mid(b) - mid(t)) < 4,
    counters: lines(narrow.querySelector('.opt-kp-counters')),
    buttons: [...narrow.querySelectorAll('.opt-actions .opt-btn')].map((x) => ({ text: x.textContent, h: Math.round(x.getBoundingClientRect().height), w: Math.round(x.getBoundingClientRect().width) })),
    card: Math.round(narrow.getBoundingClientRect().width),
    sizes: { title: parseFloat(getComputedStyle(t).fontSize), badge: Math.round(b.getBoundingClientRect().height) },
  };`;

const WINDOW = `
  const m = document.querySelector('.opt-kp-modal').getBoundingClientRect();
  const panel = document.querySelector('.opt-kp-panel').getBoundingClientRect();
  const main = document.querySelector('.opt-kp-main');
  const table = document.querySelector('.opt-kp-table').getBoundingClientRect();
  return {
    vw: window.innerWidth, vh: window.innerHeight,
    modal: { w: Math.round(m.width), h: Math.round(m.height), left: Math.round(m.left), top: Math.round(m.top) },
    panel: Math.round(panel.width),
    panelRight: panel.left > table.right - 1,
    tableFits: main.scrollWidth <= main.clientWidth + 1,
    tabs: [...document.querySelectorAll('.opt-kp-tab')].map((x) => { const st = getComputedStyle(x); return Math.round((x.getBoundingClientRect().height - parseFloat(st.paddingTop) - parseFloat(st.paddingBottom) - parseFloat(st.borderBottomWidth)) / parseFloat(st.lineHeight)); }),
    footer: Math.round(document.querySelector('.opt-kp-modal-foot').getBoundingClientRect().bottom),
  };`;

const SEND = `
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Проверено, отправить');
  const r = btn.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  const layer = document.querySelector('.opt-kp-send-layer').getBoundingClientRect();
  const m = document.querySelector('.opt-kp-modal').getBoundingClientRect();
  return { onTop: top === btn || btn.contains(top), visible: r.width > 0 && r.top >= 0 && r.bottom <= window.innerHeight, insideModal: layer.left >= m.left - 1 && layer.right <= m.right + 1 };`;

describe('раскладка блока в колонке amoCRM (KP-AGENT-V2, п. 6а)', () => {
  it('узкая колонка — сводка без таблицы и полей: «цена не задана» не показывается, «Развернуть ⤢» и «Собрать документ»', async () => {
    const html = await renderBlock();
    expect(html).not.toContain('цена не задана');
    expect(html).not.toContain('opt-kp-table');
    expect(html).toContain('Развернуть ⤢');
  });

  it.skipIf(!hasChrome)('320, 340, 400 и 550 px: заголовок в одну строку, бейдж в его строке, кнопки во всю ширину карточки, без прокрутки; ширину колонки виджет не меняет', async () => {
    const html = await renderBlock();
    for (const width of [320, 340, 400, 550]) {
      const m = measure<{ overflow: boolean; title: { text: string; lines: number }; badgeSameLine: boolean; counters: number; buttons: { text: string; h: number; w: number }[]; card: number; sizes: { title: number; badge: number } }>(html, width, NARROW);
      expect(m.overflow, `${width}: прокрутка`).toBe(false);
      expect(m.title, `${width}: заголовок`).toEqual({ text: 'Черновик КП', lines: 1 });
      expect(m.badgeSameLine, `${width}: бейдж в строке заголовка`).toBe(true);
      expect(m.counters, `${width}: счётчики`).toBeLessThanOrEqual(2);
      expect(m.buttons.map((b) => [b.text, b.h]), `${width}: кнопки`).toEqual([['Развернуть ⤢', 28], ['Собрать документ', 28]]);
      expect(m.buttons.every((b) => b.w >= m.card - 30), `${width}: кнопки во всю ширину`).toBe(true);
      // Колонка amoCRM: карточка не шире колонки за вычетом отступов.
      expect(m.card, `${width}: карточка`).toBeLessThanOrEqual(width - 20);
      expect(m.sizes, `${width}: размеры`).toEqual({ title: 13, badge: 20 });
    }
  }, 120_000);

  it.skipIf(!hasChrome)('окно КП — 88 % экрана по центру: опросник справа 360 px, таблица без прокрутки по ширине, вкладки в одну строку', async () => {
    const html = await renderBlock(true);
    for (const win of [{ w: 1440, h: 900 }, { w: 1280, h: 800 }]) {
      const m = measure<{ vw: number; vh: number; modal: { w: number; h: number; left: number; top: number }; panel: number; panelRight: boolean; tableFits: boolean; tabs: number[]; footer: number }>(html, 340, WINDOW, win);
      expect(Math.abs(m.modal.w - m.vw * 0.88), `${win.w}: ширина окна`).toBeLessThan(2);
      expect(Math.abs(m.modal.h - m.vh * 0.88), `${win.w}: высота окна`).toBeLessThan(2);
      expect(Math.abs(m.modal.left - (m.vw - m.modal.w) / 2), `${win.w}: по центру`).toBeLessThan(2);
      expect(m.panel, `${win.w}: опросник`).toBe(360);
      expect(m.panelRight, `${win.w}: опросник справа от таблицы`).toBe(true);
      expect(m.tableFits, `${win.w}: таблица по ширине`).toBe(true);
      expect(m.tabs, `${win.w}: вкладки`).toEqual([1, 1, 1, 1, 1]);
      expect(m.footer, `${win.w}: итог внутри окна`).toBeLessThanOrEqual(m.modal.top + m.modal.h + 1);
    }
  }, 60_000);

  it.skipIf(!hasChrome)('«Отправить клиенту» из окна КП: окно письма поверх окна на 88 %, кнопка «Проверено, отправить» видна и нажимается (не перекрыта)', async () => {
    const html = await renderBlock(true, true);
    expect(html).toContain('Проверено, отправить');
    const m = measure<{ onTop: boolean; visible: boolean; insideModal: boolean }>(html, 340, SEND, { w: 1440, h: 900 });
    expect(m).toEqual({ onTop: true, visible: true, insideModal: true });
  }, 60_000);
});

/**
 * KB-ALIASES-UI: «База знаний» с 8 154 синонимами Оникса. open — «Показать», раскрыть группу Оникса и «Ещё 50» (100 строк).
 * Бэкенд отдаёт по 50 строк и счётчики, как opt-api.
 */
async function renderAliases(open: boolean): Promise<string> {
  document.body.innerHTML = '<div id="work-area-opt_agent"></div>';
  const rows = Array.from({ length: 8154 }, (_, i) => ({ id: i + 1, alias: `Оникс Авангард наборный шпон — шпон, гр.1 — глухое, синоним с очень длинным названием № ${i + 1}`, canonical: 'Оникс Авангард наборный шпон — шпон, гр.1 — глухое', productId: 'ONX-0001', sourceId: 35 }));
  const self: AmoWidgetSelf = {
    get_settings: () => ({ widget_code: 'opt_agent' }),
    system: () => ({ area: 'settings' }),
    i18n: () => '',
    render_template: () => undefined,
    $authorizedAjax: async (opts) => {
      const u = new URL(opts.url);
      if (u.pathname === '/widget/v1/kb/aliases') {
        const offset = Number(u.searchParams.get('offset') ?? 0);
        const limit = Math.min(Number(u.searchParams.get('limit') ?? 50), 50);
        return { aliases: u.searchParams.get('source_id') ? rows.slice(offset, offset + limit) : [], total: rows.length, offset, limit, groups: [{ sourceId: 35, title: 'Оникс.xlsx', count: rows.length }], all: rows.length };
      }
      if (u.pathname === '/widget/v1/kb/sources') return { sources: [], usage: { sources: 0, bytes: 0, chunks: 0, limits: { bytes: 500 * 1024 * 1024, chunks: 20000 } } };
      if (u.pathname === '/widget/v1/kb/prices') return { items: [], total: 0 };
      if (u.pathname === '/widget/v1/kb/candidates') return { items: [] };
      throw { status: 404 };
    },
  };
  const cbs = createCallbacks(self, 'https://opt.test.ru');
  await act(async () => cbs.advancedSettings!());
  await act(async () => new Promise((r) => setTimeout(r, 20)));
  const btn = (root: ParentNode, text: string) => [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
  await act(async () => btn(document, 'База знаний').click());
  await act(async () => new Promise((r) => setTimeout(r, 20)));
  if (open) {
    const box = document.querySelector('.opt-kb-aliases')!;
    await act(async () => btn(box, 'Показать').click());
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    await act(async () => (box.querySelector('.opt-kb-alias-group-head') as HTMLButtonElement).click());
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    await act(async () => btn(box, 'Ещё 50').click());
    await act(async () => new Promise((r) => setTimeout(r, 20)));
  }
  return document.body.innerHTML;
}

const ALIASES = `
  const box = document.querySelector('.opt-kb-aliases');
  const body = box.querySelector('.opt-kb-aliases-body');
  const cell = box.querySelector('.opt-kb-alias-table tbody td');
  return {
    box: Math.round(box.getBoundingClientRect().height),
    body: body ? Math.round(body.getBoundingClientRect().height) : null,
    scrolls: body ? body.scrollHeight > body.clientHeight : null,
    rows: box.querySelectorAll('tbody tr').length,
    page: document.documentElement.scrollHeight,
    // Длинный синоним не переносится: одна строка, обрезка многоточием (полный текст — в title).
    truncated: cell ? getComputedStyle(cell).whiteSpace === 'nowrap' && getComputedStyle(cell).textOverflow === 'ellipsis' && cell.scrollWidth > cell.clientWidth : null,
    overflow: col.scrollWidth > col.clientWidth,
  };`;

describe('блок синонимов в «Базе знаний» (KB-ALIASES-UI)', () => {
  it.skipIf(!hasChrome)('8 154 синонима: свёрнутый блок — одна строка заголовка; раскрытый — не выше 400 px, 100 строк прокручиваются внутри, длинный текст в одну строку', async () => {
    type M = { box: number; body: number | null; scrolls: boolean | null; rows: number; page: number; truncated: boolean | null; overflow: boolean };
    const closed = measure<M>(await renderAliases(false), 900, ALIASES, { w: 1000, h: 1200 });
    expect(closed.body).toBeNull();
    expect(closed.box).toBeLessThanOrEqual(60);
    const open = measure<M>(await renderAliases(true), 900, ALIASES, { w: 1000, h: 1200 });
    expect(open.rows).toBe(100);
    expect(open.body).toBeLessThanOrEqual(400);
    expect(open.scrolls).toBe(true);
    expect(open.box).toBeLessThanOrEqual(460);
    expect(open.truncated).toBe(true);
    expect(open.overflow).toBe(false);
    // Страница растёт только на высоту блока, не на 100 строк.
    expect(open.page - closed.page).toBeLessThanOrEqual(420);
  }, 60_000);
});
