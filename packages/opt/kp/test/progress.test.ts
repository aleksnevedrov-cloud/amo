// RFD-AI-AGENT-OPT-DEAL-FILES-2, 2.5: ход сборки — шаги, файлы, страницы; выдача для виджета (прошло / осталось / зависание);
// длительности шагов для журнала.
import { describe, expect, it } from 'vitest';
import { DRAFT_STEPS, ProgressReporter, progressView, stepDurations, STUCK_AFTER_MS, type DraftProgress } from '../src/progress.ts';

describe('индикатор хода сборки (DEAL-FILES-2, 2.5)', () => {
  it('updateProgress на каждом шаге и странице: названия шагов, файл и страница в строке шага, статусы файлов, оценка и длительности', () => {
    let t = Date.parse('2026-11-03T16:21:06Z');
    const emitted: DraftProgress[] = [];
    const r = new ProgressReporter((p) => emitted.push(structuredClone(p)), () => t);
    r.step(1);
    t += 2000;
    r.step(2);
    t += 3000;
    r.files(['Двери наружные Данилково (4).pdf', 'Счет № 126.pdf']);
    r.file('Двери наружные Данилково (4).pdf', 'downloading');
    expect(r.state.step).toBe('Скачиваю файлы (1 из 2)');
    t += 1000;
    r.file('Двери наружные Данилково (4).pdf', 'parsing');
    expect(r.state.step).toBe('Разбираю позиции «Двери наружные Данилково (4).pdf»');
    for (let k = 1; k <= 3; k++) {
      t += 10_000;
      r.page(null, k, 6, false);
    }
    expect(r.state.step).toBe('Распознаю «Двери наружные Данилково (4).pdf», стр. 3 из 6');
    t += 10_000;
    r.page(null, 4, 6, true);
    expect(r.state.step).toBe('Модель читает чертёж «Двери наружные Данилково (4).pdf», стр. 4 из 6');
    expect(r.state.pagesDone).toBe(3);
    expect(r.state.pageMs).toBe(30_000);
    t += 15_000;
    r.file('Двери наружные Данилково (4).pdf', 'parsed', { positions: 7 });
    r.file('Счет № 126.pdf', 'downloading');
    t += 500;
    r.file('Счет № 126.pdf', 'parsing');
    t += 500;
    r.file('Счет № 126.pdf', 'own', { reason: 'наш документ (продавец ООО «РУС-ДВЕРИ»)' });
    expect(r.state.files).toEqual([{ name: 'Двери наружные Данилково (4).pdf', status: 'parsed', positions: 7 }, { name: 'Счет № 126.pdf', status: 'own', reason: 'наш документ (продавец ООО «РУС-ДВЕРИ»)' }]);
    expect(r.state.done).toBe(2);
    const view = progressView(r.state, t);
    expect(view).toMatchObject({ stepNo: 6, steps: 8, file: 'Счет № 126.pdf', done: 2, total: 2, elapsedSec: 62 });
    expect(view.etaMin).toBe(1);
    expect(view.stuck).toBe(false);
    t += 1000;
    r.done();
    expect(r.state.step).toBe('Готово');
    expect(progressView(r.state, t).etaMin).toBe(0);
    expect(progressView(r.state, t).fraction).toBe(1);
    expect(emitted.length).toBeGreaterThanOrEqual(12);
    const steps = stepDurations(r.state, t);
    expect(steps.map((s) => s.stepNo)).toEqual([1, 2, 3, 4, 5, 6, 8]);
    expect(steps.find((s) => s.stepNo === 1)?.ms).toBe(2000);
    expect(steps.find((s) => s.stepNo === 4)?.ms).toBe(30_000);
    expect(DRAFT_STEPS).toHaveLength(8);
  });

  it('до первой страницы оценка — null («около 1–5 минут»); 10 минут без нового шага — зависание; в очереди — доля 0', () => {
    let t = 1_000_000;
    const r = new ProgressReporter(() => undefined, () => t);
    r.step(1);
    expect(progressView(r.state, t + 5000)).toMatchObject({ etaMin: null, elapsedSec: 5, stuck: false, fraction: 0 });
    expect(progressView(r.state, t + STUCK_AFTER_MS + 1)).toMatchObject({ stuck: true });
    t += 1000;
    r.step(2);
    expect(progressView(r.state, t + STUCK_AFTER_MS - 1).stuck).toBe(false);
    expect(progressView(r.state, t).fraction).toBeCloseTo(1 / 8, 5);
  });
});
