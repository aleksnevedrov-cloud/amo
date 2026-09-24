import { useCallback, useState } from 'react';
import type { JournalItem, WidgetApi } from '../api.ts';
import { dateTime, kindLabel, rub } from './StatusBadge.tsx';
import { s } from './styles.ts';
import { errorMessage } from './useLoad.ts';

const KINDS = ['', 'reply', 'handoff', 'blocked', 'pause', 'resume', 'skipped', 'error', 'import', 'sandbox'];

export function Journal({ api }: { api: WidgetApi }) {
  const [kind, setKind] = useState('');
  const [leadId, setLeadId] = useState('');
  const [items, setItems] = useState<JournalItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);

  const load = useCallback(
    async (append: boolean) => {
      setError(null);
      try {
        const before = append && items?.length ? items[items.length - 1]?.id : undefined;
        const lead = Number(leadId);
        const r = await api.journal({ kind: kind || undefined, leadId: lead > 0 ? lead : undefined, before, limit: 50 });
        setItems(append ? [...(items ?? []), ...r.items] : r.items);
        setMore(r.items.length === 50);
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [api, items, kind, leadId],
  );

  return (
    <div style={s.col}>
      <div style={s.row}>
        <select style={s.select} value={kind} onChange={(e) => setKind(e.target.value)}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k ? kindLabel(k) : 'Все действия'}
            </option>
          ))}
        </select>
        <input style={{ ...s.input, width: 160 }} placeholder="ID сделки" value={leadId} onChange={(e) => setLeadId(e.target.value)} />
        <button type="button" style={s.buttonGhost} onClick={() => load(false)}>
          Показать
        </button>
      </div>
      {error && <div style={s.error}>{error}</div>}
      {items && items.length === 0 && <div style={s.muted}>Записей нет</div>}
      {items?.map((e) => (
        <div key={e.id} style={{ ...s.block, ...s.small }}>
          <div style={s.row}>
            <span style={s.muted}>{dateTime(e.createdAt)}</span>
            <b>{kindLabel(e.kind)}</b>
            {e.leadId && <span style={s.muted}>сделка {e.leadId}</span>}
            {e.costRub > 0 && <span style={s.muted}>{rub(e.costRub)}</span>}
          </div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{e.summary}</div>
        </div>
      ))}
      {more && (
        <button type="button" style={s.buttonGhost} onClick={() => load(true)}>
          Ещё
        </button>
      )}
    </div>
  );
}
