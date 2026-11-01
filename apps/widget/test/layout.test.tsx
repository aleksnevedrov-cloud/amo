// @vitest-environment jsdom
// Раскладка «Агент розница» (RETAIL-WIDGET-WINDOW, п. 6.4): узкая колонка amoCRM и окно на 88 %. jsdom вёрстку не считает,
// поэтому разметка отрисовывается React-ом, а замер идёт в headless Chromium (тот же, что у Playwright) по file://-странице
// со styles.css. Поверх страницы — «шапка amo» (fixed, z-index 999): окно виджета должно быть над ней, кнопки — не перекрыты.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import type { AmoWidgetSelf } from '../src/amo.ts';
import { RETRY } from '../src/api.ts';
import { createCallbacks } from '../src/index.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHROME = process.env.CHROME_BIN ?? '/opt/pw-browsers/chromium';
const hasChrome = existsSync(CHROME);
// Запуск vitest из apps/widget: путь от корня пакета.
const css = readFileSync(join(process.cwd(), 'src/styles.css'), 'utf8');

const panel = {
  leadId: 29986849,
  isAdmin: true,
  ai: { enabled: true, mode: 'auto', paused: true, pauseReason: 'manager_message', pausedAt: null },
  llm: { provider: 'openai', model: 'gpt-5.5', fallback: null, override: null, providers: ['openai'], configured: true },
  health: { llmConfigured: true, dailyLimitExhausted: false, lastError: null },
  hints: [{ id: 3, leadId: 29986849, kind: 'hint', text: 'Предложите замер в субботу', status: 'pending', details: {}, createdAt: '2026-10-02T09:20:00Z', decidedAt: null, decidedBy: null }],
  products: [1, 2, 3, 4].map((i) => ({ type: 'product', id: String(1000 + i), title: `Валенсия ПГ ${i} эмаль белая с длинным названием`, url: 'https://rf-dveri.ru/v', price: 12900 + i, available: true, picture: null })),
  calculations: [{ lines: [{ name: 'Полотно Валенсия ПГ', article: '1', qty: 2, unit: 'шт.', price: 12900, total: 25800, basis: 'каталог' }], total: 25800, complete: true, missing: [], doorsCount: 2 }],
  files: [],
  tasks: [1, 2, 3].map((i) => ({ id: `t${i}`, kind: 'Перезвонить клиенту', text: `Юрист по рамкам — вопрос ${i}`, createdAt: '2026-10-02T09:00:00Z', source: 'handoff' })),
  summary: null,
  log: [],
  costRub: 4.6,
};
const dialog = {
  leadId: 29986849,
  items: [
    ...Array.from({ length: 12 }, (_, i) => ({ id: `w-${i}`, at: `2026-10-02T09:${String(i).padStart(2, '0')}:00Z`, who: i % 2 ? 'agent' : 'client', channel: 'whatsapp', channelLabel: 'WhatsApp', text: `Сообщение ${i}: Валенсия ПГ, размеры, сроки и доставка`, model: i % 2 ? 'gpt-5.5' : null, provider: 'openai' })),
    { id: 's-3', at: '2026-10-02T09:20:00Z', who: 'hint', channel: null, channelLabel: null, text: 'Предложите замер в субботу', notSent: true, suggestionId: 3 },
  ],
  send: { available: true, channel: 'whatsapp', channelLabel: 'WhatsApp', reason: null },
};

/** Разметка после отрисовки React-ом в jsdom; open — с окном («Развернуть ⤢», окно — порталом в body). */
async function render(open: boolean): Promise<string> {
  RETRY.delaysMs = [0, 0];
  document.body.innerHTML = '';
  window.APP = { data: { current_card: { id: 29986849 } } };
  const self: AmoWidgetSelf = {
    get_settings: () => ({ widget_code: 'ai_door' }),
    system: () => ({ area: 'lcard' }),
    i18n: () => '',
    render_template: ({ render: r }) => document.body.insertAdjacentHTML('beforeend', r),
    $authorizedAjax: async (opts) => (opts.url.includes('/dialog') ? dialog : panel),
  };
  const cbs = createCallbacks(self, 'https://ai.test.ru');
  await act(async () => void cbs.render!());
  await act(async () => new Promise((r) => setTimeout(r, 20)));
  if (open) {
    await act(async () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Развернуть ⤢')!.click());
    await act(async () => new Promise((r) => setTimeout(r, 20)));
  }
  const html = document.body.innerHTML;
  await act(async () => void cbs.destroy!());
  return html;
}

/** Страница со стилями виджета: колонка заданной ширины (отступы amo 8/10 px), «шапка amo» поверх и замер скриптом в Chromium. */
function measure<T>(html: string, columnPx: number, script: string, win = { w: columnPx + 40, h: 2000 }): T {
  const dir = mkdtempSync(join(tmpdir(), 'retail-widget-layout-'));
  try {
    const page = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body style="margin:0">
<div id="amo-top" style="position:fixed;top:0;left:0;right:0;height:56px;z-index:999;background:#1f2b38"></div>
<div id="col" style="width:${columnPx}px;padding:64px 10px 8px;box-sizing:border-box;overflow:visible">${html}</div>
<script>
const lines = (el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
const col = document.getElementById('col');
const free = (el) => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return r.width > 0 && r.bottom <= innerHeight && (top === el || el.contains(top)); };
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
  const card = document.querySelector('.ai-door-root .ai-door-card');
  return {
    overflow: col.scrollWidth > col.clientWidth,
    counters: lines(document.querySelector('.ai-door-counters')),
    buttons: [...card.querySelectorAll('.ai-door-actions .ai-door-btn')].map((b) => ({ text: b.textContent, free: free(b), h: Math.round(b.getBoundingClientRect().height) })),
  };`;

const WINDOW = `
  // Лента прокручена к последнему сообщению — как делает DialogTab после загрузки (в разметке jsdom прокрутки нет).
  const feed = document.querySelector('.ai-door-main-scroll');
  feed.scrollTop = feed.scrollHeight;
  const m = document.querySelector('.ai-door-modal').getBoundingClientRect();
  const side = document.querySelector('.ai-door-side').getBoundingClientRect();
  const main = document.querySelector('.ai-door-main').getBoundingClientRect();
  const composer = document.querySelector('.ai-door-composer').getBoundingClientRect();
  const btn = (t) => [...document.querySelectorAll('.ai-door-modal button')].find((b) => b.textContent === t);
  return {
    vw: innerWidth, vh: innerHeight,
    modal: { w: Math.round(m.width), h: Math.round(m.height), left: Math.round(m.left), top: Math.round(m.top) },
    side: Math.round(side.width),
    sideRight: side.left >= main.right - 1,
    tabs: [...document.querySelectorAll('.ai-door-tab')].map((x) => { const st = getComputedStyle(x); return Math.round((x.getBoundingClientRect().height - parseFloat(st.paddingTop) - parseFloat(st.paddingBottom) - parseFloat(st.borderBottomWidth)) / parseFloat(st.lineHeight)); }),
    composerInside: composer.bottom <= m.bottom + 1 && composer.top > m.top,
    free: Object.fromEntries(['Возврат AI', '⟳', '✕', 'Отправить', 'В поле', 'Создать резюме'].map((t) => [t, Boolean(btn(t)) && free(btn(t))])),
    hintYellow: getComputedStyle(document.querySelector('.ai-door-msg-hint')).backgroundColor,
    overAmo: document.elementFromPoint(m.left + 20, m.top + 10) !== document.getElementById('amo-top'),
  };`;

describe('раскладка «Агент розница» (RETAIL-WIDGET-WINDOW)', () => {
  it.skipIf(!hasChrome)('узкая колонка 280–340 px: без прокрутки, счётчики в строку-две, «Возврат AI» и «Развернуть ⤢» видны и не перекрыты', async () => {
    const html = await render(false);
    for (const width of [280, 300, 340]) {
      const m = measure<{ overflow: boolean; counters: number; buttons: { text: string; free: boolean; h: number }[] }>(html, width, NARROW);
      expect(m.overflow, `${width}: прокрутка`).toBe(false);
      expect(m.counters, `${width}: счётчики`).toBeLessThanOrEqual(2);
      expect(m.buttons.map((b) => [b.text, b.free]), `${width}: кнопки`).toEqual([['Возврат AI', true], ['Развернуть ⤢', true]]);
    }
  }, 120_000);

  it.skipIf(!hasChrome)('окно — 88 % по центру поверх amo: правая панель 360 px, вкладки в одну строку, поле ответа внутри окна, кнопки не перекрыты, подсказка жёлтая', async () => {
    const html = await render(true);
    for (const win of [{ w: 1440, h: 900 }, { w: 1280, h: 800 }]) {
      const m = measure<{ vw: number; vh: number; modal: { w: number; h: number; left: number; top: number }; side: number; sideRight: boolean; tabs: number[]; composerInside: boolean; free: Record<string, boolean>; hintYellow: string; overAmo: boolean }>(html, 300, WINDOW, win);
      expect(Math.abs(m.modal.w - m.vw * 0.88), `${win.w}: ширина окна`).toBeLessThan(2);
      expect(Math.abs(m.modal.h - m.vh * 0.88), `${win.w}: высота окна`).toBeLessThan(2);
      expect(Math.abs(m.modal.left - (m.vw - m.modal.w) / 2), `${win.w}: по центру`).toBeLessThan(2);
      expect(m.side, `${win.w}: правая панель`).toBe(360);
      expect(m.sideRight, `${win.w}: панель справа`).toBe(true);
      expect(m.tabs, `${win.w}: вкладки`).toEqual([1, 1, 1, 1, 1]);
      expect(m.composerInside, `${win.w}: поле ответа`).toBe(true);
      expect(m.free, `${win.w}: кнопки`).toEqual({ 'Возврат AI': true, '⟳': true, '✕': true, Отправить: true, 'В поле': true, 'Создать резюме': true });
      expect(m.hintYellow, `${win.w}: подсказка`).toBe('rgb(255, 248, 219)');
      expect(m.overAmo, `${win.w}: окно над шапкой amo`).toBe(true);
    }
  }, 60_000);
});
