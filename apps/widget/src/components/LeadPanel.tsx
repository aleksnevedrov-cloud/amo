import { useCallback, useState } from 'react';
import type { WidgetApi } from '../api.ts';
import { Calculation } from './Calculation.tsx';
import { dateTime, kindLabel, modeLabel, rub } from './StatusBadge.tsx';
import { SuggestionCard } from './Suggestions.tsx';
import { s } from './styles.ts';
import { errorMessage, useLoad } from './useLoad.ts';

/** Панель в карточке сделки: статус AI, пауза/возврат, найденные товары, журнал по сделке. */
export function LeadPanel({ api, leadId }: { api: WidgetApi; leadId: number }) {
  const load = useCallback(() => api.leadPanel(leadId), [api, leadId]);
  const [state, reload] = useLoad(load);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  if (state.status === 'loading') return <div style={{ ...s.root, ...s.muted }}>Загрузка…</div>;
  if (state.status === 'error') {
    return (
      <div style={s.root}>
        <div style={s.error}>{state.message}</div>
        <button type="button" style={{ ...s.button, marginTop: 8 }} onClick={reload}>
          Повторить
        </button>
      </div>
    );
  }
  const p = state.data;
  const toggle = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await (p.ai.paused ? api.resume(leadId) : api.pause(leadId));
      reload();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const active = p.ai.enabled && p.ai.mode !== 'off';
  const makeSummary = async () => {
    setBusy(true);
    setActionError(null);
    try {
      setSummary((await api.summary(leadId)).text);
      reload();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={s.root}>
      <div style={s.block}>
        <div style={s.label}>Статус AI</div>
        <div style={{ ...s.row, justifyContent: 'space-between' }}>
          <span>
            {modeLabel(p.ai.mode)}
            {!p.ai.enabled && ' · выключен'}
            {p.ai.paused && <span style={{ ...s.badgeWarn, marginLeft: 6 }}>на паузе</span>}
          </span>
          {active && (
            <button type="button" style={s.buttonGhost} disabled={busy} onClick={toggle}>
              {p.ai.paused ? 'Вернуть AI' : 'Пауза'}
            </button>
          )}
        </div>
        {p.ai.paused && p.ai.pauseReason && <div style={{ ...s.muted, ...s.small }}>{pauseReasonText(p.ai.pauseReason)}</div>}
        {actionError && <div style={s.error}>{actionError}</div>}
      </div>
      {p.hints.length > 0 && (
        <div style={{ ...s.block, ...s.col }}>
          <div style={s.label}>Черновики и подсказки</div>
          {p.hints.map((h) => (
            <SuggestionCard key={h.id} api={api} item={h} onDone={reload} />
          ))}
        </div>
      )}
      <div style={s.block}>
        <div style={s.label}>Найденные товары</div>
        {p.products.length === 0 ? (
          <div style={s.muted}>Товары не подбирались</div>
        ) : (
          <div style={s.col}>
            {p.products.map((pr) => (
              <a key={pr.id} href={pr.url ?? '#'} target="_blank" rel="noreferrer">
                {pr.title}
              </a>
            ))}
          </div>
        )}
      </div>
      <div style={s.block}>
        <div style={s.label}>Расчёт</div>
        {p.calculations[0] ? <Calculation c={p.calculations[0]} /> : <div style={s.muted}>Расчётов нет</div>}
      </div>
      <div style={s.block}>
        <div style={{ ...s.row, justifyContent: 'space-between' }}>
          <span style={s.label}>Резюме диалога</span>
          <button type="button" style={s.buttonGhost} disabled={busy} onClick={makeSummary}>
            Резюме
          </button>
        </div>
        {summary && <div style={{ ...s.small, whiteSpace: 'pre-wrap' }}>{summary}</div>}
      </div>
      <div style={s.block}>
        <div style={{ ...s.row, justifyContent: 'space-between' }}>
          <span style={s.label}>Журнал AI</span>
          {p.costRub > 0 && <span style={{ ...s.muted, ...s.small }}>Расход: {rub(p.costRub)}</span>}
        </div>
        {p.log.length === 0 ? (
          <div style={s.muted}>Действий AI по сделке нет</div>
        ) : (
          <div style={s.col}>
            {p.log.slice(0, 10).map((e) => (
              <div key={e.id} style={s.small}>
                <span style={s.muted}>{dateTime(e.createdAt)}</span> <b>{kindLabel(e.kind)}</b>
                <div style={{ whiteSpace: 'pre-wrap' }}>{e.summary.slice(0, 300)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function pauseReasonText(r: string): string {
  if (r === 'manager_message') return 'Менеджер написал клиенту';
  if (r === 'status_without_ai') return 'Этап сделки без AI';
  if (r.startsWith('manual:')) return 'Поставлен на паузу вручную';
  if (r.startsWith('handoff:')) return 'Диалог передан менеджеру';
  return r;
}
