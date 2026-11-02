// @vitest-environment jsdom
// KB-ALIASES-UI: блок синонимов в «Базе знаний» — свёрнут, группы по прайсам со счётчиками, по 50 строк с «Ещё 50»,
// поиск на бэкенде (совпавшие группы раскрыты), «Синоним → Модель (ID)» с обрезкой и подсказкой, высота не больше 400 px.
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AmoWidgetSelf } from '@core/widget-core';
import { createCallbacks } from '../src/index.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ONYX = 35;
const INNER = 12;
type Row = { id: number; alias: string; canonical: string; productId: string | null; sourceId: number | null };
/** «База» синонимов: Оникс — 8 154 (как после импорта), межкомнатные — 79, вручную — 1. */
const onyxRow = (i: number): Row => (i < 3 ? { id: i + 1, alias: `Авангард наборный шпон вариант ${i + 1}`, canonical: 'Оникс Авангард наборный шпон', productId: 'ONX-0001', sourceId: ONYX } : { id: i + 1, alias: `Оникс синоним ${String(i + 1).padStart(4, '0')}`, canonical: `Оникс Модель ${i % 40}`, productId: `ONX-${String((i % 40) + 2).padStart(4, '0')}`, sourceId: ONYX });
const ROWS: Row[] = [
  ...Array.from({ length: 8154 }, (_, i) => onyxRow(i)),
  ...Array.from({ length: 79 }, (_, i) => ({ id: 20_000 + i, alias: `ДПГ синоним ${i}`, canonical: 'ДПГ сота', productId: 'INT-005', sourceId: INNER })),
  { id: 30_000, alias: 'ДПГ + УПД (сота)', canonical: 'ДПГ сота', productId: null, sourceId: null },
];
const TITLES: Record<number, string> = { [ONYX]: 'Оникс.xlsx', [INNER]: 'Межкомнатные двери.xlsx', 0: 'Добавлены вручную' };
const norm = (x: string | null) => (x ?? '').toLowerCase().replace(/ё/g, 'е');

/** Бэкенд: GET /kb/aliases с source_id, q, offset, limit (≤ 50) и счётчиками — как в opt-api. */
function fakeSelf() {
  const calls: URL[] = [];
  const self: AmoWidgetSelf = {
    get_settings: () => ({ widget_code: 'opt_agent' }),
    system: () => ({ area: 'settings' }),
    i18n: () => '',
    render_template: () => undefined,
    $authorizedAjax: async (opts) => {
      const u = new URL(opts.url);
      if (u.pathname === '/widget/v1/kb/aliases') {
        calls.push(u);
        const q = norm(u.searchParams.get('q'));
        const hit = ROWS.filter((r) => !q || [r.alias, r.canonical, r.productId].some((x) => norm(x).includes(q)));
        const sid = u.searchParams.get('source_id');
        const own = sid === null ? hit : hit.filter((r) => (r.sourceId ?? 0) === Number(sid));
        const offset = Number(u.searchParams.get('offset') ?? 0);
        const limit = Math.min(Number(u.searchParams.get('limit') ?? 50), 50);
        const counts = new Map<number, number>();
        for (const r of hit) counts.set(r.sourceId ?? 0, (counts.get(r.sourceId ?? 0) ?? 0) + 1);
        return { aliases: own.slice(offset, offset + limit), total: own.length, offset, limit, groups: [...counts].map(([sourceId, count]) => ({ sourceId, title: TITLES[sourceId], count })), all: ROWS.length };
      }
      const key = `${opts.method} ${u.pathname}`;
      if (key === 'GET /widget/v1/kb/sources') return { sources: [], usage: { sources: 0, bytes: 0, chunks: 0, limits: { bytes: 500 * 1024 * 1024, chunks: 20000 } } };
      if (key === 'GET /widget/v1/kb/prices') return { items: [], total: 0 };
      if (key === 'GET /widget/v1/kb/candidates') return { items: [] };
      throw { status: 404, responseJSON: { message: `нет ответа для ${key}` } };
    },
  };
  return { self, calls };
}

const flush = (ms = 20) => act(async () => new Promise((r) => setTimeout(r, ms)));
const box = () => document.querySelector('.opt-kb-aliases')!;
const groupHeads = () => [...box().querySelectorAll<HTMLButtonElement>('.opt-kb-alias-group-head')];
const tableRows = (g: number) => [...(box().querySelectorAll('.opt-kb-alias-group')[g]?.querySelectorAll('tbody tr') ?? [])];
const clickText = (root: Element, text: string) =>
  act(async () => {
    const b = [...root.querySelectorAll('button')].find((x) => x.textContent?.trim() === text);
    if (!b) throw new Error(`Нет кнопки «${text}»`);
    b.click();
  });

async function openKb() {
  document.body.innerHTML = '<div id="work-area-opt_agent"></div>';
  const fake = fakeSelf();
  const cbs = createCallbacks(fake.self, 'https://opt.test.ru');
  await act(async () => cbs.advancedSettings!());
  await flush();
  const tab = [...document.querySelectorAll('button')].find((b) => b.textContent === 'База знаний')!;
  await act(async () => tab.click());
  await flush();
  return fake;
}

beforeEach(() => {
  window.APP = { data: { current_card: { id: 555 } } };
});

describe('блок синонимов (KB-ALIASES-UI)', () => {
  it('свёрнут: «Синонимы (8 234)» и «Показать»; строки не загружаются', async () => {
    const { calls } = await openKb();
    expect(box().querySelector('.opt-kb-aliases-title')?.textContent?.replace(/\u00a0/g, ' ')).toBe('Синонимы (8 234)');
    expect(box().querySelector('.opt-kb-aliases-body')).toBeNull();
    expect(box().querySelectorAll('tbody tr')).toHaveLength(0);
    // Только счётчики: limit=0, ни одной строки.
    expect(calls.map((u) => u.searchParams.get('limit'))).toEqual(['0']);
  });

  it('«Показать» — группы по прайсам со счётчиками, свёрнуты; группа Оникса — 50 строк, «Ещё 50» — следующие; «Скрыть»', async () => {
    const { calls } = await openKb();
    await clickText(box(), 'Показать');
    await flush();
    expect(groupHeads().map((b) => b.textContent?.replace(/\u00a0/g, ' '))).toEqual(['▸ Оникс.xlsx — 8 154', '▸ Межкомнатные двери.xlsx — 79', '▸ Добавлены вручную — 1']);
    expect(box().querySelectorAll('tbody tr')).toHaveLength(0);
    await act(async () => groupHeads()[0]!.click());
    await flush();
    expect(tableRows(0)).toHaveLength(50);
    expect([...box().querySelectorAll('thead th')].map((t) => t.textContent)).toEqual(['Синоним', 'Модель (ID)', '']);
    // Синоним → Модель (ID); длинный текст — обрезка с подсказкой title.
    const first = tableRows(0)[0]!.querySelectorAll('td');
    expect([first[0]?.textContent, first[1]?.textContent]).toEqual(['Авангард наборный шпон вариант 1', 'Оникс Авангард наборный шпон (ONX-0001)']);
    expect(first[1]?.getAttribute('title')).toBe('Оникс Авангард наборный шпон (ONX-0001)');
    expect((first[1] as HTMLElement).style.textOverflow).toBe('ellipsis');
    await clickText(box(), 'Ещё 50');
    await flush();
    expect(tableRows(0)).toHaveLength(100);
    expect(tableRows(0)[50]?.querySelector('td')?.textContent).toBe('Оникс синоним 0051');
    // Запросы строк — по одной странице не больше 50.
    const pages = calls.filter((u) => u.searchParams.get('source_id') === String(ONYX));
    expect(pages.map((u) => [u.searchParams.get('offset'), u.searchParams.get('limit')])).toEqual([['0', '50'], ['50', '50']]);
    // Высота — не больше 400 px, дальше прокрутка внутри блока (размер считает Chromium в layout.test.tsx).
    const body = box().querySelector<HTMLElement>('.opt-kb-aliases-body')!;
    expect([body.style.maxHeight, body.style.overflowY]).toEqual(['400px', 'auto']);
    await clickText(box(), 'Скрыть');
    expect(box().querySelector('.opt-kb-aliases-body')).toBeNull();
  });

  it('поиск «авангард» (без регистра, ё = е): только синонимы ONX-0001, группа раскрыта, чужих групп нет; пусто — снова свёрнуто', async () => {
    const { calls } = await openKb();
    await clickText(box(), 'Показать');
    await flush();
    const input = box().querySelector<HTMLInputElement>('.opt-kb-aliases-search')!;
    expect(input.placeholder).toBe('Найти синоним или модель');
    const type = (v: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, v);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    await type('АвАнгард');
    await flush(400);
    expect(groupHeads().map((b) => b.textContent)).toEqual(['▾ Оникс.xlsx — 3']);
    expect(tableRows(0).map((r) => r.querySelectorAll('td')[1]?.textContent)).toEqual(Array(3).fill('Оникс Авангард наборный шпон (ONX-0001)'));
    expect(calls.at(-1)?.searchParams.get('q')).toBe('АвАнгард');
    await type('');
    await flush(400);
    expect(groupHeads()).toHaveLength(3);
    expect(groupHeads().every((b) => b.getAttribute('aria-expanded') === 'false')).toBe(true);
  });
});
