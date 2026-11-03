import { useCallback, useEffect, useState } from 'react';
import type { CompareResult, EvalRun, ModelRef, ProviderId, SandboxResult, WidgetApi, WidgetSettings } from '../api.ts';
import { ModelPicker } from './ModelSettings.tsx';
import { dateTime, modelLabel, providerShort, rub, usd } from './StatusBadge.tsx';
import { s } from './styles.ts';
import { errorMessage } from './useLoad.ts';

interface Turn {
  role: 'client' | 'ai';
  text: string;
  result?: SandboxResult;
  /** Режим сравнения: ответы двух моделей рядом. */
  compare?: CompareResult;
}

const replyText = (r: Partial<SandboxResult>) =>
  r.kind === 'reply' ? (r.text ?? '') : r.kind === 'handoff' ? `${r.text ?? ''}\n[Передано менеджеру: ${r.handoff?.reason}]` : `[Ответ заблокирован: ${r.blockedReason}]`;

/** Песочница: диалог с агентом на реальном каталоге, без записи в CRM и без отправки клиенту; сравнение двух моделей; прогон eval. */
export function Sandbox({ api, draft, compare, providers = [] }: { api: WidgetApi; draft?: WidgetSettings; compare?: ModelRef[]; providers?: ProviderId[] }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'single' | 'compare'>(compare?.length ? 'compare' : 'single');
  const [models, setModels] = useState<ModelRef[]>(compare?.length ? compare : []);
  useEffect(() => {
    if (compare?.length) {
      setModels(compare);
      setMode('compare');
    }
  }, [compare]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const next: Turn[] = [...turns, { role: 'client', text }];
    setTurns(next);
    setInput('');
    setBusy(true);
    setError(null);
    try {
      const history = next.map((t) => ({ role: t.role, text: t.text }));
      if (mode === 'compare' && models.length >= 1) {
        const r = await api.sandboxCompare(history, models.slice(0, 2), draft);
        // В историю идёт ответ первой модели: дальше диалог продолжается на обеих от одного и того же контекста.
        const first = r.results[0];
        setTurns([...next, { role: 'ai', text: first && !first.error ? replyText(first) : '', compare: r.results }]);
      } else {
        const r = await api.sandbox(history, draft, undefined, phone.trim() || undefined);
        setTurns([...next, { role: 'ai', text: replyText(r), result: r }]);
      }
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      setError(status === 503 ? 'Не задан ключ провайдера LLM (вкладка «Модель»).' : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const total = turns.reduce((sum, t) => sum + (t.result?.cost.rub ?? 0) + (t.compare?.reduce((x, c) => x + (c.cost?.rub ?? 0), 0) ?? 0), 0);
  return (
    <div style={s.col}>
      <div style={{ ...s.muted, ...s.small }}>
        Агент работает на вашем каталоге и базе знаний. CRM — тестовая сделка, клиенту ничего не отправляется. Стоимость
        запросов реальная и учитывается в расходе.
      </div>
      <div style={s.row}>
        <label style={s.row}>
          <input type="checkbox" checked={mode === 'compare'} onChange={(e) => setMode(e.target.checked ? 'compare' : 'single')} />
          Сравнить две модели
        </label>
        {mode === 'compare' && (
          <>
            <ModelPicker api={api} value={models[0] ?? null} providers={providers} onChange={(v) => setModels((m) => [v ?? m[0], m[1]].filter((x): x is ModelRef => Boolean(x)))} />
            <span style={s.muted}>и</span>
            <ModelPicker api={api} value={models[1] ?? null} providers={providers} allowNone noneLabel="— вторая модель —" onChange={(v) => setModels((m) => [m[0], v].filter((x): x is ModelRef => Boolean(x)))} />
          </>
        )}
      </div>
      <div style={{ ...s.col, gap: 10, maxHeight: 520, overflowY: 'auto' }}>
        {turns.map((t, i) => (
          <div key={i} style={{ ...s.card, background: t.role === 'client' ? '#f5f7f9' : '#fff' }}>
            <div style={s.label}>{t.role === 'client' ? 'Клиент' : 'AI'}</div>
            {t.compare ? (
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${t.compare.length}, minmax(0, 1fr))`, gap: 10 }}>
                {t.compare.map((c, k) => (
                  <div key={k} style={{ ...s.card, background: '#fafbfc' }}>
                    <div style={{ ...s.label, color: '#313942' }}>
                      <b>{modelLabel(c.model.provider, c.model.model)}</b>
                    </div>
                    {c.error ? <div style={s.error}>{c.error}</div> : <div style={{ whiteSpace: 'pre-wrap' }}>{replyText(c)}</div>}
                    {!c.error && c.toolCalls && <Trace r={c as SandboxResult} open />}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ whiteSpace: 'pre-wrap' }}>{t.text}</div>
            )}
            {t.result && <Trace r={t.result} />}
          </div>
        ))}
      </div>
      <input
        style={{ ...s.input, width: 300, marginBottom: 6 }}
        placeholder="Телефон клиента — подтянуть переписку Wazzup (необязательно)"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
      />
      <textarea
        style={{ ...s.textarea, minHeight: 60 }}
        placeholder="Сообщение от имени клиента"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div style={s.row}>
        <button type="button" style={s.button} disabled={busy || !input.trim() || (mode === 'compare' && !models.length)} onClick={send}>
          {busy ? 'Агент думает…' : 'Отправить'}
        </button>
        <button type="button" style={s.buttonGhost} disabled={busy} onClick={() => setTurns([])}>
          Новый диалог
        </button>
        {total > 0 && <span style={{ ...s.muted, ...s.small }}>Стоимость диалога: {rub(total)}</span>}
        {error && <span style={s.error}>{error}</span>}
      </div>
      <EvalRunner api={api} providers={providers} preset={models} />
    </div>
  );
}

function Trace({ r, open }: { r: SandboxResult; open?: boolean }) {
  const tokens = `${r.cost.inputTokens.toLocaleString('ru-RU')} / ${r.cost.outputTokens.toLocaleString('ru-RU')} токенов`;
  const time = r.latencyMs !== undefined ? ` · ${(r.latencyMs / 1000).toFixed(1)} с` : '';
  return (
    <details open={open} style={{ marginTop: 6, ...s.small }}>
      <summary style={{ cursor: 'pointer', color: '#4c8bf7' }}>
        Инструменты: {r.toolCalls.length} · источники: {r.sources.length} · {tokens} · {rub(r.cost.rub)}{time} · {modelLabel(r.provider, r.model)}
        {r.fallbackUsed && <span style={{ ...s.badgeWarn, marginLeft: 6 }}>fallback</span>}
      </summary>
      <div style={{ ...s.col, marginTop: 6 }}>
        {r.toolCalls.map((c, i) => (
          <div key={i}>
            <b>{c.specName}</b> {JSON.stringify(c.input)} —{' '}
            {c.ok ? (c.empty ? 'ничего не найдено' : 'ok') : <span style={s.error}>{c.error}</span>} ({c.durationMs} мс)
          </div>
        ))}
        {r.sources.map((src) => (
          <div key={`${src.type}-${src.id}`}>
            {src.type === 'product' ? 'Товар' : 'База знаний'}:{' '}
            {src.url ? (
              <a href={src.url} target="_blank" rel="noreferrer">
                {src.title}
              </a>
            ) : (
              src.title
            )}
            {src.date && <span style={s.muted}> ({src.date})</span>}
          </div>
        ))}
        {r.rejections.length > 0 && (
          <div style={s.error}>
            Пост-фильтр отклонял ответ {r.rejections.length} раз: {r.rejections.flat().map((v) => v.fragment).join(', ')}
          </div>
        )}
        {r.notes.length > 0 && <div>Примечания в сделку: {r.notes.join(' | ')}</div>}
        {r.handoff && <div>Резюме для менеджера: {r.handoff.summary}</div>}
      </div>
    </details>
  );
}

/** «Прогнать eval на модели…» (раздел 7 ТЗ): итог по каждой модели — пройдено, выдуманные данные, передачи, средняя стоимость. */
function EvalRunner({ api, providers, preset }: { api: WidgetApi; providers: ProviderId[]; preset: ModelRef[] }) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelRef[]>([]);
  const [limit, setLimit] = useState<number | null>(null);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [current, setCurrent] = useState<EvalRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Модели, выбранные для сравнения в песочнице, подставляются и в прогон eval.
  useEffect(() => {
    if (preset.length) setModels(preset);
  }, [preset]);
  const loadRuns = useCallback(async () => {
    try {
      const r = await api.evalRuns();
      setRuns(r?.items ?? []);
    } catch {
      // Бэкенд 1.0.x — прогонов нет.
    }
  }, [api]);
  useEffect(() => {
    if (open) void loadRuns();
  }, [open, loadRuns]);
  useEffect(() => {
    if (!current || current.status !== 'running') return;
    const t = setInterval(async () => {
      try {
        const r = await api.evalRun(current.id);
        if (r) setCurrent(r);
        if (r && r.status !== 'running') void loadRuns();
      } catch {
        // повторим на следующем тике
      }
    }, 3000);
    return () => clearInterval(t);
  }, [api, current, loadRuns]);

  const start = async () => {
    setError(null);
    try {
      const { id } = await api.runEval(models.slice(0, 2), limit ? { limit } : {});
      setCurrent(await api.evalRun(id));
    } catch (err) {
      const body = (err as { responseJSON?: { error?: string } } | null)?.responseJSON;
      setError(body?.error === 'already_running' ? 'Прогон уже идёт.' : body?.error === 'no_key' ? 'Нет ключа выбранного провайдера.' : errorMessage(err));
    }
  };

  return (
    <div style={{ ...s.block, borderTop: '1px solid #e8eaeb' }}>
      <button type="button" style={{ ...s.tab, padding: '4px 0', color: '#4c8bf7' }} onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} Прогнать eval на модели…
      </button>
      {open && (
        <div style={{ ...s.col, marginTop: 6 }}>
          <div style={{ ...s.muted, ...s.small }}>
            Эталонные диалоги (раздел 14 ТЗ) на тестовом каталоге. Итог по модели: пройдено, выдуманные цены/наличие/сроки (должно быть 0), передача менеджеру, средняя стоимость диалога. Стоимость реальная.
          </div>
          <div style={s.row}>
            <ModelPicker api={api} value={models[0] ?? null} providers={providers} onChange={(v) => setModels((m) => [v ?? m[0], m[1]].filter((x): x is ModelRef => Boolean(x)))} />
            <ModelPicker api={api} value={models[1] ?? null} providers={providers} allowNone noneLabel="— вторая модель (необязательно) —" onChange={(v) => setModels((m) => [m[0], v].filter((x): x is ModelRef => Boolean(x)))} />
            <select style={s.select} value={limit ?? ''} onChange={(e) => setLimit(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Весь набор</option>
              <option value="5">Первые 5</option>
              <option value="10">Первые 10</option>
              <option value="20">Первые 20</option>
            </select>
            <button type="button" style={s.button} disabled={!models.length || current?.status === 'running'} onClick={() => void start()}>
              Прогнать eval
            </button>
            {error && <span style={s.error}>{error}</span>}
          </div>
          {current && <EvalRunView run={current} />}
          {runs.filter((r) => r.id !== current?.id).slice(0, 5).map((r) => (
            <div key={r.id} style={{ ...s.small, ...s.row }}>
              <span style={s.muted}>{dateTime(r.startedAt)}</span>
              <span>{r.models.map((m) => modelLabel(m.provider, m.model)).join(' и ')}</span>
              <span style={r.status === 'done' ? s.badgeOk : r.status === 'failed' ? s.badgeBad : s.badgeWarn}>{r.status === 'done' ? 'готово' : r.status === 'failed' ? 'ошибка' : `${r.progress.done}/${r.progress.total}`}</span>
              <button type="button" style={s.buttonGhost} onClick={() => void api.evalRun(r.id).then(setCurrent, () => undefined)}>
                Показать
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EvalRunView({ run }: { run: EvalRun }) {
  return (
    <div style={{ ...s.card, ...s.small }}>
      <div style={s.row}>
        <b>Прогон #{run.id}</b>
        <span style={s.muted}>{dateTime(run.startedAt)}</span>
        {run.status === 'running' && <span style={s.badgeWarn}>идёт: {run.progress.done} из {run.progress.total}</span>}
        {run.status === 'failed' && <span style={s.badgeBad}>ошибка: {run.error}</span>}
        {run.status === 'done' && <span style={s.badgeOk}>готово</span>}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 6 }}>
        <thead>
          <tr style={s.muted}>
            <th align="left">Модель</th>
            <th align="right">Пройдено</th>
            <th align="right">Выдумано</th>
            <th align="right">Передача менеджеру</th>
            <th align="right">Средняя стоимость</th>
            <th align="right">p95</th>
          </tr>
        </thead>
        <tbody>
          {(run.results ?? []).map((r, i) => (
            <tr key={i}>
              <td>{modelLabel(r.ref.provider, r.ref.model)}</td>
              <td align="right">{r.summary ? `${r.summary.passed}/${r.summary.total}` : '—'}</td>
              <td align="right" style={r.summary?.fabricated ? s.error : undefined}>{r.summary?.fabricated ?? '—'}</td>
              <td align="right">{r.summary ? `${r.summary.handoffOk}/${r.summary.handoffExpected}` : '—'}</td>
              <td align="right">{r.summary ? usd(r.summary.avgCostUsd) : '—'}</td>
              <td align="right">{r.summary ? `${(r.summary.p95LatencyMs / 1000).toFixed(1)} с` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(run.results ?? []).map((r, i) =>
        r.reports.filter((x) => !x.passed).length ? (
          <details key={i} style={{ marginTop: 6 }}>
            <summary style={{ cursor: 'pointer' }}>
              {providerShort(r.ref.provider)} {r.ref.model}: не пройдено {r.reports.filter((x) => !x.passed).length}
            </summary>
            {r.reports
              .filter((x) => !x.passed)
              .map((x) => (
                <div key={x.id}>
                  <b>{x.id}</b> [{x.final}] {x.failures.join('; ')}
                </div>
              ))}
          </details>
        ) : null,
      )}
    </div>
  );
}
