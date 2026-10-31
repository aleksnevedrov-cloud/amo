import type { Dictionaries, WidgetSettings } from '../api.ts';
import { Field, NumberInput } from './fields.tsx';
import { s } from './styles.ts';

type R = WidgetSettings['reactivation'];
type ReasonCode = keyof R['texts'];

const REASONS: readonly (readonly [ReasonCode, string])[] = [
  ['price', 'Дорого'],
  ['stock', 'Не было в наличии'],
  ['changedMind', 'Передумал, отложил'],
  ['universal', 'Причина неизвестна (запасной)'],
];

/**
 * Догон клиента после отказа (RFD-AI-AGENT-REAKTIVATSIYA).
 * Два касания за неделю, затем агент молчит навсегда; ответ клиента разбирает догон,
 * сам агент на него не отвечает.
 */
export function ReactivationSettings({
  value,
  dict,
  onChange,
}: {
  value: R;
  dict: Dictionaries | null;
  onChange: (patch: Partial<R>) => void;
}) {
  const pipelineId = value.pipelineIds[0] ?? null;
  const pipeline = dict?.pipelines.find((p) => p.id === pipelineId) ?? null;
  const setText = (code: ReasonCode, which: 'first' | 'second', text: string) =>
    onChange({ texts: { ...value.texts, [code]: { ...value.texts[code], [which]: text } } });

  return (
    <>
      <Field
        label="Догонять клиентов после отказа"
        hint="Агент сам пишет клиенту, который ушёл в «Отказ»: два касания за неделю. Клиент ответил — агент замолкает: дальше менеджер или шаблон «Отказ»."
      >
        <label style={s.row}>
          <input type="checkbox" checked={value.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} />
          Включить догон
        </label>
      </Field>

      <Field label="Воронка" hint="Берём отказы только из этой воронки.">
        {dict ? (
          <select
            style={s.select}
            value={pipelineId ?? ''}
            onChange={(e) => onChange({ pipelineIds: e.target.value ? [Number(e.target.value)] : [], targetStatusId: null })}
          >
            <option value="">Не выбрана — догон не работает</option>
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

      <Field
        label="Этап «Заказ»"
        hint="Куда вернуть сделку, когда клиент проявил интерес или назвал срок: менеджеры отказы не видят, для них сделка закрыта. Не выбран — сделка останется в отказе, менеджер получит только задачу."
      >
        {!pipeline ? (
          <div style={s.muted}>Сначала выберите воронку</div>
        ) : (
          <select
            style={s.select}
            value={value.targetStatusId ?? ''}
            onChange={(e) => onChange({ targetStatusId: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">Не переводить</option>
            {pipeline.statuses.map((st) => (
              <option key={st.id} value={st.id}>
                {st.name}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field label="Минимальный бюджет сделки, ₽" hint="Сделки дешевле не догоняем.">
        <NumberInput value={value.minBudget} min={0} onChange={(v) => onChange({ minBudget: v ?? 0 })} />
      </Field>
      <Field label="Отказ не старше, дней" hint="Давние отказы не трогаем.">
        <NumberInput value={value.maxAgeDays} min={1} max={90} onChange={(v) => onChange({ maxAgeDays: v ?? 14 })} />
      </Field>
      <Field label="Первое касание — день от отказа">
        <NumberInput value={value.firstTouchDay} min={1} max={30} onChange={(v) => onChange({ firstTouchDay: v ?? 2 })} />
      </Field>
      <Field label="Второе касание — день от отказа" hint="После него агент не пишет никогда.">
        <NumberInput value={value.secondTouchDay} min={2} max={60} onChange={(v) => onChange({ secondTouchDay: v ?? 5 })} />
      </Field>
      <Field label="«Подумаю» без срока: напомнить через, дней" hint="Последнее касание. Если клиент назвал срок — вместо напоминания задача менеджеру.">
        <NumberInput value={value.remindDays} min={1} max={60} onChange={(v) => onChange({ remindDays: v ?? 7 })} />
      </Field>
      <Field label="Сделок за один проход">
        <NumberInput value={value.maxPerRun} min={1} max={100} onChange={(v) => onChange({ maxPerRun: v ?? 20 })} />
      </Field>
      <Field label="Дублировать письмом" hint="То же сообщение уходит на почту клиента.">
        <label style={s.row}>
          <input type="checkbox" checked={value.email} onChange={(e) => onChange({ email: e.target.checked })} />
          Отправлять и на почту
        </label>
      </Field>

      <Field
        label="Шаблон «Отказ»"
        hint="Уходит последним сообщением: когда клиент отказал повторно и когда причина отказа — «купил у конкурента» (тогда это единственное сообщение, продавать такому клиенту нечего). Ответ клиента сохраняется в сделку, агент на него не отвечает."
      >
        <textarea style={{ ...s.textarea, minHeight: 110 }} value={value.finalTemplate} onChange={(e) => onChange({ finalTemplate: e.target.value })} />
      </Field>

      <div style={s.muted}>
        Тексты касаний по причине отказа. Причину определяет анализ отказа; если она не опознана, берётся запасной набор.
        Причины «купил у конкурента» здесь нет: такому клиенту уходит только шаблон «Отказ» выше.
        Без конкретных цен и сроков — их срезает проверка фактов.
      </div>
      {REASONS.map(([code, label]) => (
        <div key={code} style={s.col}>
          <Field label={`${label}: касание 1`}>
            <textarea style={s.textarea} value={value.texts[code].first} onChange={(e) => setText(code, 'first', e.target.value)} />
          </Field>
          <Field label={`${label}: касание 2 (последнее)`}>
            <textarea style={s.textarea} value={value.texts[code].second} onChange={(e) => setText(code, 'second', e.target.value)} />
          </Field>
        </div>
      ))}
    </>
  );
}
