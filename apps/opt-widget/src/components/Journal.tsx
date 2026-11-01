import { useCallback, useState } from 'react';
import { errorMessage, s, useLoad } from '@core/widget-core';
import type { KpApi } from '../api.ts';

const KINDS = [
  ['', 'Все события'],
  ['kp_draft', 'Черновики'],
  ['kp_build', 'Сборки'],
  ['kp_sent', 'Отправки'],
  ['kp_error', 'Ошибки'],
  ['mail_fetch', 'Почта'],
] as const;

const KIND_LABEL: Record<string, string> = { kp_draft: 'черновик', kp_build: 'сборка', kp_sent: 'отправлено', kp_error: 'ошибка', mail_fetch: 'почта', note: 'заметка', document: 'документ', error: 'ошибка' };

const dateTime = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Журнал сборок: что опт делал по сделкам и сколько это стоило. */
export function Journal({ api }: { api: KpApi }) {
  const [kind, setKind] = useState('');
  const load = useCallback(() => api.journal({ kind: kind || undefined, limit: 100 }), [api, kind]);
  const [state, reload] = useLoad(load);
  return (
    <div style={s.block}>
      <div style={{ ...s.row, marginBottom: 8 }}>
        <select style={s.select} value={kind} onChange={(e) => setKind(e.target.value)}>
          {KINDS.map(([id, label]) => (
            <option key={id} value={id}>{label}</option>
          ))}
        </select>
        <button type="button" style={s.buttonGhost} onClick={reload}>Обновить</button>
      </div>
      {state.status === 'loading' && <div style={s.muted}>Загрузка…</div>}
      {state.status === 'error' && <div style={s.error}>{state.message}</div>}
      {state.status === 'ready' && state.data.items.length === 0 && <div style={s.muted}>Событий нет</div>}
      {state.status === 'ready' && state.data.items.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <tbody>
            {state.data.items.map((it) => (
              <tr key={it.id}>
                <td style={td}>{dateTime(it.createdAt)}</td>
                <td style={td}>{it.leadId ? `сделка ${it.leadId}` : '—'}</td>
                <td style={td}>{KIND_LABEL[it.kind] ?? it.kind}</td>
                <td style={td}>{it.summary}</td>
                <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>{it.costRub ? `${it.costRub.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const td = { padding: '4px 6px', borderBottom: '1px solid #f0f3f5', verticalAlign: 'top' } as const;

export { errorMessage };
