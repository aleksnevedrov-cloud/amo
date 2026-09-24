import { useCallback, useState } from 'react';
import type { Mode, Status, WidgetApi, WidgetSettings } from '../api.ts';
import { ConnectionBadge, modeLabel } from './StatusBadge.tsx';
import { s } from './styles.ts';
import { errorMessage, useLoad } from './useLoad.ts';

const MODES: Mode[] = ['off', 'hints', 'semi', 'auto'];

/** Расширенные настройки. Фаза 0: раздел «Статус»; остальные разделы п. 11.1 — в своих фазах. */
export function SettingsPage({ api }: { api: WidgetApi }) {
  const load = useCallback(async () => {
    const [status, { settings }] = await Promise.all([api.status(), api.settings()]);
    return { status, settings };
  }, [api]);
  const [state, reload] = useLoad(load);

  if (state.status === 'loading') return <div style={{ ...s.root, ...s.muted }}>Загрузка…</div>;
  if (state.status === 'error') return <div style={{ ...s.root, ...s.error }}>{state.message}</div>;
  return <SettingsForm api={api} status={state.data.status} initial={state.data.settings} onSaved={reload} />;
}

function SettingsForm(props: { api: WidgetApi; status: Status; initial: WidgetSettings; onSaved: () => void }) {
  const [draft, setDraft] = useState(props.initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await props.api.saveSettings(draft);
      props.onSaved();
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      setError(status === 403 ? 'Изменять настройки может только администратор аккаунта.' : errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ ...s.root, maxWidth: 640 }}>
      <h2 style={{ fontSize: 20, margin: '0 0 12px' }}>Статус</h2>
      <div style={s.block}>
        <div style={s.label}>Интеграции</div>
        <div style={s.row}>
          <ConnectionBadge status={props.status} />
          <span style={s.muted}>LLM, фид каталога и STT подключаются в следующих фазах</span>
        </div>
      </div>
      <div style={s.block}>
        <label style={s.row}>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          />
          AI-агент включён
        </label>
      </div>
      <div style={s.block}>
        <div style={s.label}>Режим</div>
        <select
          style={s.select}
          value={draft.mode}
          onChange={(e) => setDraft({ ...draft, mode: e.target.value as Mode })}
        >
          {MODES.map((m) => (
            <option key={m} value={m}>
              {modeLabel(m)}
            </option>
          ))}
        </select>
      </div>
      <div style={{ ...s.row, marginTop: 16 }}>
        <button type="button" style={s.button} disabled={saving} onClick={save}>
          {saving ? 'Сохранение…' : 'Сохранить'}
        </button>
        {error && <span style={s.error}>{error}</span>}
      </div>
    </div>
  );
}
