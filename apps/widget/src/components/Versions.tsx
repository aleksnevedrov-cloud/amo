import { useCallback, useState } from 'react';
import type { WidgetApi } from '../api.ts';
import { dateTime } from './StatusBadge.tsx';
import { s } from './styles.ts';
import { errorMessage, useLoad } from './useLoad.ts';

const SECTION: Record<string, string> = {
  enabled: 'Вкл/выкл',
  mode: 'Режим',
  behavior: 'Поведение',
  model: 'Модель',
  where: 'Где работает',
  handoff: 'Передача менеджеру',
  catalog: 'Каталог',
  limits: 'Лимиты',
  tasks: 'Задачи',
  hints: 'Подсказки',
  salesbot: 'Salesbot',
  email: 'Почта',
  stt: 'Голосовые',
  vision: 'Файлы и фото',
  billing: 'Курс',
};

/** Вкладка «Версии»: история изменений настроек с автором и откат (раздел 11.1 ТЗ). */
export function Versions({ api, isAdmin, onRestored }: { api: WidgetApi; isAdmin: boolean; onRestored: () => void }) {
  const load = useCallback(() => api.settingsHistory(), [api]);
  const [state, reload] = useLoad(load);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState<{ id: number; text: string } | null>(null);

  if (state.status === 'loading') return <div style={s.muted}>Загрузка…</div>;
  if (state.status === 'error') return <div style={s.error}>{state.message}</div>;
  const items = state.data.items;

  const show = async (id: number) => {
    try {
      const v = await api.settingsVersion(id);
      setOpen({ id, text: JSON.stringify({ behavior: v.settings.behavior, model: v.settings.model }, null, 2) });
    } catch (err) {
      setMsg(errorMessage(err));
    }
  };
  const restore = async (id: number) => {
    if (!window.confirm(`Вернуть настройки к версии #${id}? Текущие настройки сохранятся в истории.`)) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.restoreSettings(id);
      setMsg(`Настройки возвращены к версии #${id}.`);
      reload();
      onRestored();
    } catch (err) {
      setMsg(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={s.col}>
      <div style={{ ...s.muted, ...s.small }}>Каждое сохранение настроек — версия. Откат создаёт новую версию, история не теряется.</div>
      {msg && <div style={s.small}>{msg}</div>}
      {items.length === 0 && <div style={s.muted}>Изменений ещё не было</div>}
      {items.map((v, i) => (
        <div key={v.id} style={s.card}>
          <div style={{ ...s.row, justifyContent: 'space-between' }}>
            <span>
              <b>#{v.id}</b> · {dateTime(v.changedAt)} · пользователь {v.userId ?? '—'}
              {i === 0 && <span style={{ ...s.badgeOk, marginLeft: 6 }}>текущая</span>}
            </span>
            <span style={s.row}>
              <button type="button" style={s.buttonGhost} onClick={() => void show(v.id)}>
                Показать
              </button>
              {isAdmin && i > 0 && (
                <button type="button" style={s.buttonGhost} disabled={busy} onClick={() => void restore(v.id)}>
                  Откатить
                </button>
              )}
            </span>
          </div>
          <div style={{ ...s.small, ...s.muted }}>Изменено: {v.changed.length ? v.changed.map((c) => SECTION[c] ?? c).join(', ') : 'без изменений'}</div>
          {open?.id === v.id && <pre style={{ ...s.small, whiteSpace: 'pre-wrap', marginTop: 6 }}>{open.text}</pre>}
        </div>
      ))}
    </div>
  );
}
