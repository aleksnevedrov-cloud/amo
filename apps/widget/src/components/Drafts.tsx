import { useCallback } from 'react';
import type { WidgetApi } from '../api.ts';
import { SuggestionCard } from './Suggestions.tsx';
import { s } from './styles.ts';
import { useLoad } from './useLoad.ts';

/** Очередь черновиков режима «Полуавто» по всему аккаунту. */
export function Drafts({ api }: { api: WidgetApi }) {
  const load = useCallback(() => api.suggestions(), [api]);
  const [state, reload] = useLoad(load);
  if (state.status === 'loading') return <div style={s.muted}>Загрузка…</div>;
  if (state.status === 'error') return <div style={s.error}>{state.message}</div>;
  if (!state.data.items.length) return <div style={s.muted}>Черновиков на одобрение нет</div>;
  return (
    <div style={s.col}>
      {state.data.items.map((it) => (
        <SuggestionCard key={it.id} api={api} item={it} onDone={reload} showLead />
      ))}
    </div>
  );
}
