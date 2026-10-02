import { useCallback, useState } from 'react';
import type { WidgetApi } from '../api.ts';
import { Field } from './fields.tsx';
import { s } from './styles.ts';
import { errorMessage, useLoad } from './useLoad.ts';

const STATUS: Record<string, string> = { queued: 'в очереди', pending: 'ждёт Wazzup', processing: 'готовится', done: 'загружена', failed: 'ошибка' };
const ERRORS: Record<string, string> = {
  no_key: 'Сначала сохраните ключ API.',
  dump_in_progress: 'Предыдущая выгрузка ещё не завершена.',
  period_too_long: 'Период не больше 92 дней.',
  bad_period: 'Проверьте даты периода.',
};
const day = (v: string) => new Date(v).toLocaleDateString('ru-RU', { timeZone: 'UTC' });
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** История переписки за период из выгрузки Wazzup (messages_dump). Заявку исполняет воркер, статус — в таблице. */
export function WazzupDumps(props: { api: WidgetApi }) {
  const { api } = props;
  const load = useCallback(() => api.wazzupDumps(), [api]);
  const [list, reload] = useLoad(load);
  const [from, setFrom] = useState(() => isoDay(new Date(Date.now() - 7 * 86_400_000)));
  const [to, setTo] = useState(() => isoDay(new Date()));
  const [channelId, setChannelId] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const order = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api.wazzupDump(`${from}T00:00:00.000Z`, `${to}T23:59:59.999Z`, channelId.trim() || undefined);
      setMsg('Выгрузка заказана. Статус в таблице обновляется раз в минуту.');
      reload();
    } catch (err) {
      const code = (err as { responseJSON?: { error?: string } } | null)?.responseJSON?.error;
      setMsg((code && ERRORS[code]) || errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const dumps = list.status === 'ready' ? list.data.dumps : [];
  return (
    <Field label="История за период" hint="Выгрузка из Wazzup за выбранные даты (GMT+0). Уже полученные по вебхукам сообщения не дублируются. Канал — id из списка «Проверить ключ»; пусто = все каналы.">
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} style={s.input} />
        <span>—</span>
        <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} style={s.input} />
        <input value={channelId} onChange={(e) => setChannelId(e.target.value)} placeholder="id канала (необязательно)" style={{ ...s.input, minWidth: 260 }} />
        <button type="button" style={s.button} disabled={busy || !from || !to} onClick={order}>
          Загрузить историю за период
        </button>
        <button type="button" style={s.buttonGhost} disabled={busy} onClick={() => reload()}>
          Обновить
        </button>
      </div>
      {msg && <div style={{ ...s.small, marginTop: 6 }}>{msg}</div>}
      {dumps.length > 0 && (
        <table style={{ ...s.small, marginTop: 8, borderCollapse: 'collapse' }}>
          <thead>
            <tr><th>Период</th><th>Канал</th><th>Статус</th><th>Строк</th><th>Новых</th><th>Пропущено</th><th>Колонки / ошибка</th></tr>
          </thead>
          <tbody>
            {dumps.map((d) => (
              <tr key={d.id}>
                <td>{day(d.startAt)} – {day(d.endAt)}</td>
                <td>{d.channelId ?? 'все'}</td>
                <td>{STATUS[d.status] ?? d.status}</td>
                <td>{d.rowsTotal}</td>
                <td>{d.inserted}</td>
                <td>{d.skipped}</td>
                <td style={{ maxWidth: 360, wordBreak: 'break-word' }}>{d.error ?? d.columns ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Field>
  );
}
