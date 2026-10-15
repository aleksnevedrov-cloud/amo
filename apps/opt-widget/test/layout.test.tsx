// @vitest-environment jsdom
// Раскладка блока «Агент опт — КП» в узкой колонке amoCRM (RFD-AI-AGENT-OPT-WIDGET-DESIGN-FIX): jsdom вёрстку не считает,
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

/** Разметка блока после отрисовки React-ом в jsdom. */
async function renderBlock(): Promise<string> {
  document.body.innerHTML = '';
  window.APP = { data: { current_card: { id: 30013995 } } };
  const self: AmoWidgetSelf = {
    get_settings: () => ({ widget_code: 'opt_agent' }),
    system: () => ({ area: 'lcard' }),
    i18n: () => '',
    render_template: ({ render }) => document.body.insertAdjacentHTML('beforeend', render),
    $authorizedAjax: async (opts) => (opts.url.includes('/kp/research') ? { draftId: 17, pending: false, positions: [{ requestIndex: 0, job: null, research: null }] } : { draft, job: null }),
  };
  const cbs = createCallbacks(self, 'https://opt.test.ru');
  await act(async () => cbs.render!());
  await act(async () => new Promise((r) => setTimeout(r, 20)));
  return document.body.innerHTML;
}

interface Measured {
  overflow: boolean;
  titles: { text: string; lines: number }[];
  labels: { text: string; lines: number }[];
  inputs: { placeholder: string; width: number; top: number; textFits: boolean }[];
  badges: { text: string; sameLineAsTitle: boolean }[];
  sizes: { title: number; text: number; button: number; input: number; badge: number };
  tile: number;
}

/** Страница с колонкой заданной ширины (как в amoCRM: отступы 8/10 px вокруг виджета) и замер в Chromium. */
function measure(html: string, columnPx: number): Measured {
  const dir = mkdtempSync(join(tmpdir(), 'opt-widget-layout-'));
  try {
    const page = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body style="margin:0">
<div id="col" style="width:${columnPx}px;padding:8px 10px;box-sizing:border-box;overflow:visible">${html}</div>
<script>
const lines = (el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
const col = document.getElementById('col');
const out = {
  overflow: col.scrollWidth > col.clientWidth,
  titles: [...document.querySelectorAll('.opt-kp-title')].map((t) => ({ text: t.textContent, lines: lines(t) })),
  labels: [...document.querySelectorAll('.opt-kp-field .opt-kp-label')].map((l) => ({ text: l.textContent, lines: lines(l) })),
  inputs: [...document.querySelectorAll('.opt-kp-field input')].map((i) => {
    const r = i.getBoundingClientRect();
    // Ширина текста плейсхолдера/значения в шрифте поля против ширины поля без отступов.
    const c = document.createElement('canvas').getContext('2d');
    const st = getComputedStyle(i);
    c.font = st.fontWeight + ' ' + st.fontSize + ' ' + st.fontFamily;
    const text = i.value || i.placeholder || '';
    const inner = r.width - parseFloat(st.paddingLeft) - parseFloat(st.paddingRight);
    return { placeholder: i.placeholder, width: r.width, top: r.top, textFits: c.measureText(text).width <= inner };
  }),
  badges: [...document.querySelectorAll('.opt-kp-badge')].map((b) => {
    const t = b.parentElement.querySelector('.opt-kp-title');
    return { text: b.textContent, sameLineAsTitle: Math.abs(b.getBoundingClientRect().top + b.getBoundingClientRect().height / 2 - (t.getBoundingClientRect().top + t.getBoundingClientRect().height / 2)) < 4 };
  }),
  sizes: {
    title: parseFloat(getComputedStyle(document.querySelector('.opt-kp-title')).fontSize),
    text: parseFloat(getComputedStyle(document.querySelector('.opt-kp-questions li')).fontSize),
    button: Math.round(document.querySelector('.opt-actions .opt-btn').getBoundingClientRect().height),
    input: Math.round(document.querySelector('.opt-kp-field input').getBoundingClientRect().height),
    badge: Math.round(document.querySelector('.opt-kp-badge').getBoundingClientRect().height),
  },
  tile: document.querySelector('.opt-kp-tile').getBoundingClientRect().width,
};
document.body.appendChild(Object.assign(document.createElement('pre'), { id: 'result', textContent: JSON.stringify(out) }));
</script></body></html>`;
    const file = join(dir, 'page.html');
    writeFileSync(file, page);
    const dom = execFileSync(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--window-size=${columnPx + 40},3000`, '--dump-dom', `file://${file}`], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /<pre id="result">([\s\S]*?)<\/pre>/.exec(dom);
    if (!m) throw new Error('Chromium не вернул результат замера');
    return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&')) as Measured;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('раскладка блока в колонке amoCRM', () => {
  it('«цена не задана» под размером не показывается — состояние видно в поле «Цена»', async () => {
    const html = await renderBlock();
    expect(html).not.toContain('цена не задана');
    expect(html).toContain('placeholder="Нет цены"');
  });

  it.skipIf(!hasChrome)('320, 340 и 400 px: заголовки и подписи в одну строку, бейдж в строке заголовка, «Количество» и «Скидка» в ряд, «Цена» ниже во всю ширину, «Нет цены» целиком, без прокрутки', async () => {
    const html = await renderBlock();
    for (const width of [320, 340, 400]) {
      const m = measure(html, width);
      expect(m.overflow, `${width}: прокрутка`).toBe(false);
      expect(m.titles.map((t) => t.text)).toEqual(['Черновик КП', 'Позиции КП', 'Уточнить у клиента', 'Ответ из базы знаний', 'Действия с КП']);
      expect(m.titles.map((t) => t.lines), `${width}: заголовки`).toEqual([1, 1, 1, 1, 1]);
      expect(m.badges.every((b) => b.sameLineAsTitle), `${width}: бейдж в строке заголовка`).toBe(true);
      expect(m.labels.map((l) => [l.text, l.lines]), `${width}: подписи`).toEqual([['Количество', 1], ['Цена', 1], ['Скидка', 1]]);
      const [qty, price, discount] = m.inputs;
      expect(m.inputs.every((i) => i.width >= 72), `${width}: поля ≥ 72 px: ${m.inputs.map((i) => Math.round(i.width))}`).toBe(true);
      expect(Math.abs(qty!.top - discount!.top), `${width}: количество и скидка в одной строке`).toBeLessThan(1);
      expect(price!.top, `${width}: цена второй строкой`).toBeGreaterThan(qty!.top + 20);
      expect(price!.width, `${width}: цена во всю ширину плитки`).toBeGreaterThan(m.tile - 30);
      expect(price!.textFits, `${width}: «Нет цены» обрезано`).toBe(true);
      // Масштаб как у розницы: заголовок 13 px, текст 12 px, кнопки 28 px, поля 24 px, бейдж 20 px.
      expect(m.sizes, `${width}: размеры`).toEqual({ title: 13, text: 12, button: 28, input: 24, badge: 20 });
    }
  }, 120_000);

  it.skipIf(!hasChrome)('500 и 550 px: плитка ≥ 420 — три поля в ряд, цена шире остальных', async () => {
    const html = await renderBlock();
    for (const width of [500, 550]) {
      const m = measure(html, width);
      expect(m.overflow, `${width}: прокрутка`).toBe(false);
      expect(m.tile, `${width}: плитка`).toBeGreaterThanOrEqual(420);
      const [qty, price, discount] = m.inputs;
      expect(Math.abs(qty!.top - price!.top), `${width}: ряд`).toBeLessThan(1);
      expect(Math.abs(qty!.top - discount!.top), `${width}: ряд`).toBeLessThan(1);
      expect(price!.width, `${width}: цена шире`).toBeGreaterThan(qty!.width * 1.8);
      expect(price!.textFits).toBe(true);
    }
  }, 60_000);
});
