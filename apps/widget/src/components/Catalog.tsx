import { useCallback, useState } from 'react';
import type { WidgetApi } from '../api.ts';
import { dateTime } from './StatusBadge.tsx';
import { s } from './styles.ts';
import { errorMessage, useLoad } from './useLoad.ts';

export function CatalogStatus({ api, hasFeed }: { api: WidgetApi; hasFeed: boolean }) {
  const load = useCallback(() => api.catalog(), [api]);
  const [state, reload] = useLoad(load);
  const [msg, setMsg] = useState<string | null>(null);

  const run = async () => {
    setMsg(null);
    try {
      await api.importCatalog();
      setMsg('Импорт запущен. Обновите статус через минуту.');
    } catch (err) {
      setMsg(errorMessage(err));
    }
  };

  return (
    <div style={s.block}>
      <div style={s.label}>Состояние каталога</div>
      {state.status === 'loading' && <div style={s.muted}>Загрузка…</div>}
      {state.status === 'error' && <div style={s.error}>{state.message}</div>}
      {state.status === 'ready' && (
        <div style={s.col}>
          <div>Товаров: {state.data.products}</div>
          {state.data.lastImport ? (
            <div>
              Последний импорт: {dateTime(state.data.lastImport.startedAt)} —{' '}
              {state.data.lastImport.status === 'ok' ? (
                <span style={s.badgeOk}>успешно, {state.data.lastImport.products} товаров</span>
              ) : state.data.lastImport.status === 'running' ? (
                <span style={s.badgeWarn}>идёт</span>
              ) : (
                <span style={s.badgeBad}>ошибка: {state.data.lastImport.error}</span>
              )}
            </div>
          ) : (
            <div style={s.muted}>Импорт ещё не выполнялся</div>
          )}
        </div>
      )}
      <div style={{ ...s.row, marginTop: 8 }}>
        <button type="button" style={s.buttonGhost} disabled={!hasFeed} onClick={run}>
          Обновить сейчас
        </button>
        <button type="button" style={s.buttonGhost} onClick={reload}>
          Обновить статус
        </button>
        {!hasFeed && <span style={s.muted}>Сначала сохраните адрес фида</span>}
        {msg && <span>{msg}</span>}
      </div>
    </div>
  );
}
