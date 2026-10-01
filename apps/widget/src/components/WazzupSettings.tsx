import { useCallback, useState } from 'react';
import type { WidgetApi } from '../api.ts';
import { Field } from './fields.tsx';
import { s } from './styles.ts';
import { errorMessage, useLoad } from './useLoad.ts';

const fmt = (v: string | null | undefined) => (v ? new Date(v).toLocaleString('ru-RU') : '—');

/** Вкладка «Wazzup»: ключ API, подписка на вебхуки сообщений, состояние. История переписки менеджеров попадает в контекст агента. */
export function WazzupSettings(props: { api: WidgetApi }) {
  const { api } = props;
  const load = useCallback(() => api.wazzupStatus(), [api]);
  const [status, reload] = useLoad(load);
  const [apiKey, setApiKey] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [channels, setChannels] = useState<{ id: string | null; transport: string | null; name: string | null; state: string | null }[] | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (err) {
      const code = (err as { responseJSON?: { error?: string } } | null)?.responseJSON?.error;
      setMsg(code === 'no_key' ? 'Сначала сохраните ключ API.' : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const d = status.status === 'ready' ? status.data : null;

  return (
    <>
      <Field label="Wazzup" hint="Агент будет видеть переписку менеджеров с клиентами в WhatsApp/Telegram — новые сообщения приходят через вебхуки Wazzup. Отправка ответов остаётся через Salesbot.">
        {d && (
          <div style={s.col}>
            <span style={d.hasKey ? s.badgeOk : s.badgeWarn}>{d.hasKey ? 'Ключ API сохранён' : 'Ключ API не задан'}</span>
            <span style={d.state.subscribedAt ? s.badgeOk : s.badgeWarn}>
              {d.state.subscribedAt ? `Подписка на вебхуки оформлена ${fmt(d.state.subscribedAt)}` : 'Подписки на вебхуки нет'}
            </span>
            <span style={s.small}>
              Сообщений всего: {d.stats.total} · за 24 ч: {d.stats.last24h} · телефонов: {d.stats.phones} · последнее событие: {fmt(d.state.lastEventAt)}
            </span>
            {d.state.lastError && <span style={s.badgeWarn}>Ошибка {fmt(d.state.lastErrorAt)}: {d.state.lastError}</span>}
            <span style={s.small}>Адрес для вебхуков: {d.webhookUri}</span>
          </div>
        )}
      </Field>

      <Field label="Ключ API Wazzup" hint="Кабинет Wazzup → «Интеграция с CRM» → вкладка «Дополнительно» → блок «Ключ API». Хранится в зашифрованном виде и не показывается.">
        <div style={s.row}>
          <input style={{ ...s.input, width: 320 }} type="password" autoComplete="new-password" value={apiKey} onChange={(ev) => setApiKey(ev.target.value)} />
          <button
            type="button"
            style={s.buttonGhost}
            disabled={busy || !apiKey}
            onClick={() =>
              act(async () => {
                await api.setWazzupKey(apiKey);
                setApiKey('');
                setMsg('Ключ сохранён.');
                reload();
              })
            }
          >
            Сохранить ключ
          </button>
        </div>
      </Field>

      <Field label="Проверка и подписка">
        <div style={s.row}>
          <button
            type="button"
            style={s.buttonGhost}
            disabled={busy}
            onClick={() =>
              act(async () => {
                const r = await api.testWazzup();
                if (!r.ok) { setMsg(`Ошибка: ${r.error ?? '?'}`); return; }
                setChannels(r.channels ?? []);
                setMsg(`Ключ работает, каналов: ${r.channels?.length ?? 0}`);
              })
            }
          >
            Проверить ключ
          </button>
          <button
            type="button"
            style={s.button}
            disabled={busy || !d?.hasKey}
            onClick={() =>
              act(async () => {
                const r = await api.subscribeWazzup();
                setMsg(r.ok ? 'Подписка оформлена — новые сообщения будут приходить на сервер.' : `Ошибка подписки: ${r.error ?? '?'}`);
                reload();
              })
            }
          >
            Подписаться на вебхуки
          </button>
          <button
            type="button"
            style={s.buttonGhost}
            disabled={busy || !d?.hasKey}
            onClick={() =>
              act(async () => {
                const r = await api.wazzupSubscription();
                setMsg(r.ok ? `На стороне Wazzup: ${JSON.stringify(r.current)}` : `Ошибка: ${r.error ?? '?'}`);
              })
            }
          >
            Что стоит в Wazzup
          </button>
        </div>
        {msg && <div style={{ ...s.small, marginTop: 6 }}>{msg}</div>}
        {channels && channels.length > 0 && (
          <ul style={{ ...s.small, margin: '6px 0 0 16px' }}>
            {channels.map((c) => (
              <li key={c.id ?? c.name ?? ''}>{c.transport ?? '?'} · {c.name ?? '?'} · {c.state ?? '?'}</li>
            ))}
          </ul>
        )}
      </Field>
    </>
  );
}
