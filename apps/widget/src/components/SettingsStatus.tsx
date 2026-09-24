import { useCallback } from 'react';
import type { WidgetApi } from '../api.ts';
import { ConnectionBadge, modeLabel } from './StatusBadge.tsx';
import { s } from './styles.ts';
import { useLoad } from './useLoad.ts';

/** Короткий статус в модальном окне настроек виджета. */
export function SettingsStatus({ api }: { api: WidgetApi }) {
  const load = useCallback(() => api.status(), [api]);
  const [state] = useLoad(load);
  if (state.status === 'loading') return <div style={{ ...s.root, ...s.muted }}>Проверка подключения…</div>;
  if (state.status === 'error') return <div style={{ ...s.root, ...s.error }}>{state.message}</div>;
  return (
    <div style={{ ...s.root, ...s.row }}>
      <ConnectionBadge status={state.data} />
      <span>Режим: {modeLabel(state.data.mode)}</span>
      <span style={s.muted}>Подробные настройки — в разделе «Настройки» → виджет.</span>
    </div>
  );
}
