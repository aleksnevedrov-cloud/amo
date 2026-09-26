import { useCallback, useState } from 'react';
import type { WidgetApi } from '../api.ts';
import { rub } from './StatusBadge.tsx';
import { s } from './styles.ts';
import { useLoad } from './useLoad.ts';

const PERIODS = [
  [7, '7 дней'],
  [30, '30 дней'],
  [90, '90 дней'],
] as const;

const REASON: Record<string, string> = {
  client_request: 'Просит человека',
  complaint: 'Жалоба',
  discount: 'Скидка',
  custom_order: 'Нестандарт',
  legal_entity: 'Юрлицо',
  wholesale: 'Опт',
  return: 'Возврат',
  no_answer: 'AI не нашёл ответа',
  other: 'Другое',
};

const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(0)} %`);

/** Вкладка «Аналитика» (раздел 11.1 ТЗ): диалоги, передачи, конверсия, стоимость; расход по месяцам. */
export function Analytics({ api }: { api: WidgetApi }) {
  const [days, setDays] = useState<number>(30);
  const load = useCallback(async () => {
    const [summary, billing] = await Promise.all([api.analytics(days), api.billing()]);
    return { summary, billing: billing.months };
  }, [api, days]);
  const [state] = useLoad(load);

  return (
    <div style={s.col}>
      <div style={s.row}>
        {PERIODS.map(([d, label]) => (
          <button key={d} type="button" style={{ ...s.tab, ...(days === d ? s.tabActive : {}) }} onClick={() => setDays(d)}>
            {label}
          </button>
        ))}
      </div>
      {state.status === 'loading' && <div style={s.muted}>Загрузка…</div>}
      {state.status === 'error' && <div style={s.error}>{state.message}</div>}
      {state.status === 'ready' && (
        <>
          <Tiles a={state.data.summary} />
          {state.data.summary.handoffReasons.length > 0 && (
            <div style={s.block}>
              <div style={s.label}>Почему передавали менеджеру</div>
              {state.data.summary.handoffReasons.map((r) => (
                <div key={r.reason} style={s.row}>
                  <span style={{ width: 200 }}>{REASON[r.reason] ?? r.reason}</span>
                  <b>{r.count}</b>
                </div>
              ))}
            </div>
          )}
          {state.data.summary.byDay.length > 0 && (
            <div style={s.block}>
              <div style={s.label}>По дням</div>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={s.muted}>
                    <th align="left">День</th>
                    <th align="right">Диалогов</th>
                    <th align="right">Ответов</th>
                    <th align="right">Передач</th>
                    <th align="right">Расход</th>
                  </tr>
                </thead>
                <tbody>
                  {state.data.summary.byDay.map((d) => (
                    <tr key={d.day}>
                      <td>{d.day}</td>
                      <td align="right">{d.dialogs}</td>
                      <td align="right">{d.replies}</td>
                      <td align="right">{d.handoffs}</td>
                      <td align="right">{rub(d.costRub)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={s.block}>
            <div style={s.label}>Расход по месяцам (учёт для биллинга)</div>
            {state.data.billing.length === 0 ? (
              <div style={s.muted}>Расходов пока нет</div>
            ) : (
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={s.muted}>
                    <th align="left">Месяц</th>
                    <th align="right">Диалогов</th>
                    <th align="right">Ответов</th>
                    <th align="right">Токены вход/выход</th>
                    <th align="right">Расход</th>
                  </tr>
                </thead>
                <tbody>
                  {state.data.billing.map((m) => (
                    <tr key={m.month}>
                      <td>{m.month}</td>
                      <td align="right">{m.dialogs}</td>
                      <td align="right">{m.replies}</td>
                      <td align="right">
                        {m.inputTokens.toLocaleString('ru-RU')} / {m.outputTokens.toLocaleString('ru-RU')}
                      </td>
                      <td align="right">{rub(m.costRub)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Tiles({ a }: { a: { dialogs: number; replies: number; handoffs: number; drafts: number; hints: number; documents: number; errors: number; costRub: number; avgCostPerDialogRub: number; outcomes: { tracked: number; advanced: number; won: number; lost: number; conversionPct: number | null } } }) {
  const tiles: [string, string, string?][] = [
    ['Диалогов с AI', String(a.dialogs)],
    ['Ответов клиентам', String(a.replies)],
    ['Передач менеджеру', String(a.handoffs), a.dialogs ? `${((a.handoffs / a.dialogs) * 100).toFixed(0)} % диалогов` : undefined],
    ['Конверсия', pct(a.outcomes.conversionPct), `${a.outcomes.advanced} из ${a.outcomes.tracked} сделок ушли вперёд · выиграно ${a.outcomes.won} · закрыто ${a.outcomes.lost}`],
    ['Расход', rub(a.costRub), `≈ ${rub(a.avgCostPerDialogRub)} за диалог`],
    ['Черновики / подсказки / файлы', `${a.drafts} / ${a.hints} / ${a.documents}`, a.errors ? `ошибок: ${a.errors}` : undefined],
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8 }}>
      {tiles.map(([label, value, hint]) => (
        <div key={label} style={s.card}>
          <div style={s.label}>{label}</div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>{value}</div>
          {hint && <div style={{ ...s.muted, ...s.small }}>{hint}</div>}
        </div>
      ))}
    </div>
  );
}
