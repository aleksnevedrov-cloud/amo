import type { Dictionaries, WidgetSettings } from '../api.ts';
import { Field, s } from '@ai-door/widget-core';

type Sweep = WidgetSettings['taskSweep'];

/**
 * Где агенту разрешено ставить задачи (RFD-AI-AGENT-ZADACHI-ZAKRYTYE-SDELKI).
 * До 11.10.2026 эти значения правились только в таблице `widget_settings`, а вкладка
 * «Где работает» управляла лишь перепиской — из-за чего задачи уходили в чужие воронки.
 */
export function TaskScopeSettings({
  sweep,
  dict,
  onChange,
}: {
  sweep: Sweep;
  dict: Dictionaries | null;
  onChange: (patch: Partial<Sweep>) => void;
}) {
  const pipeline = dict?.pipelines.find((p) => p.id === sweep.pipelineId) ?? null;

  return (
    <>
      <Field
        label="Задачи менеджерам: воронка"
        hint="Агент ставит задачи только в этой воронке. Закрытые сделки («Успешно реализовано», «Закрыто и не реализовано») пропускаются всегда."
      >
        {dict ? (
          <select
            style={s.select}
            value={sweep.pipelineId ?? ''}
            onChange={(e) => onChange({ pipelineId: e.target.value ? Number(e.target.value) : null, statusIds: [] })}
          >
            <option value="">Во всех воронках</option>
            {dict.pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : (
          <div style={s.muted}>Загрузка воронок…</div>
        )}
      </Field>

      <Field label="Задачи менеджерам: этапы" hint="Без отметок — на всех этапах выбранной воронки.">
        {!pipeline ? (
          <div style={s.muted}>Сначала выберите воронку</div>
        ) : (
          <div style={s.col}>
            {pipeline.statuses.map((st) => (
              <label key={st.id} style={s.row}>
                <input
                  type="checkbox"
                  checked={sweep.statusIds.includes(st.id)}
                  onChange={(e) => {
                    const cur = new Set(sweep.statusIds);
                    if (e.target.checked) cur.add(st.id);
                    else cur.delete(st.id);
                    onChange({ statusIds: [...cur] });
                  }}
                />
                {st.name}
              </label>
            ))}
          </div>
        )}
      </Field>
    </>
  );
}
