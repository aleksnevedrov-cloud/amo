import { useCallback } from 'react';
import type { WidgetApi } from '../api.ts';
import { modeLabel } from './StatusBadge.tsx';
import { s } from './styles.ts';
import { useLoad } from './useLoad.ts';

/** Панель в карточке сделки. Фаза 0: статус AI; блоки подсказок/товаров/расчётов — пустые. */
export function LeadPanel({ api, leadId }: { api: WidgetApi; leadId: number }) {
  const load = useCallback(() => api.leadPanel(leadId), [api, leadId]);
  const [state, reload] = useLoad(load);

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
  return (
    <div style={s.root}>
      <div style={s.block}>
        <div style={s.label}>Статус AI</div>
        <div>
          {modeLabel(p.ai.mode)}
          {p.ai.paused ? ' · на паузе' : ''}
        </div>
      </div>
      <Section title="Подсказки" empty="Подсказок пока нет" items={p.hints} />
      <Section title="Найденные товары" empty="Товары не подбирались" items={p.products} />
      <Section title="Расчёты" empty="Расчётов нет" items={p.calculations} />
      <Section title="Журнал" empty="Действий AI по сделке нет" items={p.log} />
    </div>
  );
}

function Section({ title, empty, items }: { title: string; empty: string; items: unknown[] }) {
  return (
    <div style={s.block}>
      <div style={s.label}>{title}</div>
      {items.length === 0 ? <div style={s.muted}>{empty}</div> : <div>{items.length}</div>}
    </div>
  );
}
