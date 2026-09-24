import { useCallback, useEffect, useState } from 'react';
import type { Dictionaries, Mode, Status, WidgetApi, WidgetSettings } from '../api.ts';
import { CatalogStatus } from './Catalog.tsx';
import { Field, linesToList, NumberInput } from './fields.tsx';
import { Drafts } from './Drafts.tsx';
import { Journal } from './Journal.tsx';
import { PricingEditor } from './PricingEditor.tsx';
import { Knowledge } from './Knowledge.tsx';
import { Sandbox } from './Sandbox.tsx';
import { ConnectionBadge, modeLabel, rub } from './StatusBadge.tsx';
import { s } from './styles.ts';
import { errorMessage, useLoad } from './useLoad.ts';

const MODES: Mode[] = ['off', 'hints', 'semi', 'auto'];
const MODELS = [
  { id: 'claude-opus-5', name: 'Claude Opus 5 (по умолчанию)' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5 (дешевле)' },
];

const TASK_KINDS = [
  ['callback', 'Перезвонить'],
  ['send_offer', 'Отправить КП / расчёт'],
  ['check_availability', 'Проверить наличие'],
  ['measure', 'Согласовать замер'],
  ['other', 'Другое'],
] as const;

const TABS = [
  ['status', 'Статус'],
  ['behavior', 'Поведение'],
  ['model', 'Модель'],
  ['where', 'Где работает'],
  ['handoff', 'Передача менеджеру'],
  ['catalog', 'Каталог'],
  ['pricing', 'Правила цен'],
  ['knowledge', 'База знаний'],
  ['limits', 'Лимиты'],
  ['drafts', 'Черновики'],
  ['sandbox', 'Песочница'],
  ['journal', 'Журнал'],
] as const;
type Tab = (typeof TABS)[number][0];
const SETTINGS_TABS = new Set<Tab>(['status', 'behavior', 'model', 'where', 'handoff', 'catalog', 'limits']);

/** Расширенные настройки виджета (раздел 11.1 ТЗ). */
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
  const { api, status } = props;
  const [tab, setTab] = useState<Tab>('status');
  const [draft, setDraft] = useState(props.initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dict, setDict] = useState<Dictionaries | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(props.initial);

  useEffect(() => {
    if ((tab === 'where' || tab === 'handoff') && !dict) api.dictionaries().then(setDict, () => undefined);
  }, [tab, dict, api]);

  const set = <K extends keyof WidgetSettings>(k: K, v: Partial<WidgetSettings[K]>) =>
    setDraft((d) => ({ ...d, [k]: typeof v === 'object' && v !== null ? { ...(d[k] as object), ...v } : v }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.saveSettings(draft);
      props.onSaved();
    } catch (err) {
      const code = (err as { status?: number } | null)?.status;
      setError(code === 403 ? 'Изменять настройки может только администратор аккаунта.' : code === 400 ? 'Проверьте заполнение полей.' : errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const statuses = dict?.pipelines.flatMap((p) => p.statuses.map((st) => ({ ...st, label: `${p.name} → ${st.name}` }))) ?? [];

  return (
    <div style={{ ...s.root, maxWidth: 820 }}>
      <div style={s.tabs}>
        {TABS.map(([id, name]) => (
          <button key={id} type="button" style={{ ...s.tab, ...(tab === id ? s.tabActive : {}) }} onClick={() => setTab(id)}>
            {name}
          </button>
        ))}
      </div>

      {tab === 'status' && (
        <>
          <Field label="Интеграции">
            <div style={s.row}>
              <ConnectionBadge status={status} />
              <span style={status.llmConfigured ? s.badgeOk : s.badgeBad}>
                {status.llmConfigured ? 'LLM подключена' : 'Не задан ключ LLM на сервере'}
              </span>
              <span style={status.catalog.products > 0 ? s.badgeOk : s.badgeWarn}>Каталог: {status.catalog.products} товаров</span>
            </div>
          </Field>
          <Field label="Расход на LLM">
            <div>
              Сегодня: {rub(status.spend.todayRub)}
              {status.dailyLimitRub !== null && ` из ${rub(status.dailyLimitRub)}`} · за месяц: {rub(status.spend.monthRub)}
            </div>
          </Field>
          <Field label="AI-агент">
            <label style={s.row}>
              <input type="checkbox" checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} />
              Включён
            </label>
          </Field>
          <Field label="Режим" hint="Автоматический — AI пишет клиенту сам. Полуавтоматический — AI готовит черновик, менеджер одобряет. Только подсказки — AI подсказывает менеджеру в карточке сделки.">
            <select style={s.select} value={draft.mode} onChange={(e) => set('mode', e.target.value as Mode)}>
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {modeLabel(m)}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}

      {tab === 'behavior' && (
        <>
          <Field label="Характер общения">
            <textarea style={s.textarea} value={draft.behavior.persona} onChange={(e) => set('behavior', { persona: e.target.value })} />
          </Field>
          <Field label="Правила магазина" hint="Дополнительные правила для агента, по одному на строку.">
            <textarea style={s.textarea} value={draft.behavior.rules} onChange={(e) => set('behavior', { rules: e.target.value })} />
          </Field>
          <Field label="Запрещённые темы" hint="По одной на строку. Ответ с такой темой не будет отправлен.">
            <textarea
              style={s.textarea}
              value={draft.behavior.forbiddenTopics.join('\n')}
              onChange={(e) => set('behavior', { forbiddenTopics: linesToList(e.target.value) })}
            />
          </Field>
          <Field label="Приветствие" hint="Необязательно. Используется в первом ответе клиенту.">
            <input style={s.input} value={draft.behavior.greeting} onChange={(e) => set('behavior', { greeting: e.target.value })} />
          </Field>
          <Field label="Фраза при передаче менеджеру">
            <input style={s.input} value={draft.behavior.handoffPhrase} onChange={(e) => set('behavior', { handoffPhrase: e.target.value })} />
          </Field>
        </>
      )}

      {tab === 'model' && (
        <>
          <Field label="Провайдер">
            <select style={s.select} value="anthropic" disabled>
              <option value="anthropic">Anthropic Claude</option>
            </select>
          </Field>
          <Field label="Модель">
            <select style={s.select} value={draft.model.model} onChange={(e) => set('model', { model: e.target.value })}>
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Резервная модель при сбое">
            <select
              style={s.select}
              value={draft.model.fallbackModel ?? ''}
              onChange={(e) => set('model', { fallbackModel: e.target.value || null })}
            >
              <option value="">Нет</option>
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Глубина рассуждений" hint="Выше — точнее на сложных вопросах, но дольше и дороже.">
            <select
              style={s.select}
              value={draft.model.effort}
              onChange={(e) => set('model', { effort: e.target.value as WidgetSettings['model']['effort'] })}
            >
              <option value="low">Низкая (быстро)</option>
              <option value="medium">Средняя</option>
              <option value="high">Высокая</option>
            </select>
          </Field>
          <Field label="Лимит токенов на ответ">
            <NumberInput value={draft.model.maxTokens} min={512} max={16000} onChange={(v) => set('model', { maxTokens: v ?? 4096 })} />
          </Field>
        </>
      )}

      {tab === 'where' && (
        <>
          <Field label="Воронки" hint="Без отметок — во всех воронках.">
            {dict ? (
              <div style={s.col}>
                {dict.pipelines.map((p) => (
                  <label key={p.id} style={s.row}>
                    <input
                      type="checkbox"
                      checked={draft.where.pipelineIds?.includes(p.id) ?? false}
                      onChange={(e) => {
                        const cur = new Set(draft.where.pipelineIds ?? []);
                        if (e.target.checked) cur.add(p.id);
                        else cur.delete(p.id);
                        set('where', { pipelineIds: cur.size ? [...cur] : null });
                      }}
                    />
                    {p.name}
                  </label>
                ))}
              </div>
            ) : (
              <div style={s.muted}>Загрузка воронок…</div>
            )}
          </Field>
          <Field label="Этапы без AI" hint="На этих этапах AI не пишет клиенту.">
            <div style={s.col}>
              {statuses.map((st) => (
                <label key={st.id} style={s.row}>
                  <input
                    type="checkbox"
                    checked={draft.where.disabledStatusIds.includes(st.id)}
                    onChange={(e) => {
                      const cur = new Set(draft.where.disabledStatusIds);
                      if (e.target.checked) cur.add(st.id);
                      else cur.delete(st.id);
                      set('where', { disabledStatusIds: [...cur] });
                    }}
                  />
                  {st.label}
                </label>
              ))}
            </div>
          </Field>
          <Field label="Рабочее время" hint="Круглосуточно, по решению заказчика.">
            <span>Круглосуточно</span>
          </Field>
          <Field label="Склейка сообщений, сек" hint="AI ждёт столько секунд новых сообщений клиента и отвечает на всю серию.">
            <NumberInput value={draft.where.batchWindowSec} min={0} max={120} onChange={(v) => set('where', { batchWindowSec: v ?? 8 })} />
          </Field>
          <Field label="Подсказки на паузе" hint="Когда менеджер ведёт диалог, AI готовит подсказки ответа в карточке сделки.">
            <label style={s.row}>
              <input type="checkbox" checked={draft.hints.whenPaused} onChange={(e) => set('hints', { whenPaused: e.target.checked })} />
              Готовить подсказки
            </label>
          </Field>
          <Field label="Бот-отправщик (ID бота Salesbot)" hint="Нужен для режима «Полуавто»: через него уходят одобренные черновики. См. инструкцию по установке.">
            <NumberInput nullable value={draft.salesbot.senderBotId} onChange={(v) => set('salesbot', { senderBotId: v })} />
          </Field>
          <Field label="Голосовые сообщения" hint="Ключ провайдера задаётся на сервере.">
            <select style={s.select} value={draft.stt.provider} onChange={(e) => set('stt', { provider: e.target.value as WidgetSettings['stt']['provider'] })}>
              <option value="off">Не расшифровывать</option>
              <option value="yandex">Yandex SpeechKit (данные в РФ)</option>
              <option value="openai">OpenAI Whisper</option>
            </select>
          </Field>
          <Field label="Имитация набора">
            <label style={s.row}>
              <input type="checkbox" checked={draft.where.typingDelay} onChange={(e) => set('where', { typingDelay: e.target.checked })} />
              Задержка ответа пропорционально длине
            </label>
          </Field>
        </>
      )}

      {tab === 'handoff' && (
        <>
          <Field label="Тип задачи менеджеру">
            <select style={s.select} value={draft.handoff.taskTypeId} onChange={(e) => set('handoff', { taskTypeId: Number(e.target.value) })}>
              {(dict?.taskTypes ?? [{ id: draft.handoff.taskTypeId, name: `Тип ${draft.handoff.taskTypeId}` }]).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Срок задачи, минут">
            <NumberInput value={draft.handoff.taskDeadlineMin} min={5} onChange={(v) => set('handoff', { taskDeadlineMin: v ?? 60 })} />
          </Field>
          <Field label="Ответственный (ID пользователя amo)" hint="Пусто — ответственный по сделке.">
            <NumberInput nullable value={draft.handoff.responsibleUserId} onChange={(v) => set('handoff', { responsibleUserId: v })} />
          </Field>
          <Field label="Перевести сделку на этап">
            <select
              style={s.select}
              value={draft.handoff.statusId ?? ''}
              onChange={(e) => set('handoff', { statusId: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">Не переводить</option>
              {statuses.map((st) => (
                <option key={st.id} value={st.id}>
                  {st.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Задачи, которые AI ставит сам" hint="Тип задачи amo и срок в минутах. Задача уходит ответственному по сделке.">
            <div style={s.col}>
              {TASK_KINDS.map(([kind, label]) => {
                const cur = draft.tasks[kind] ?? { taskTypeId: 1, deadlineMin: 60 };
                return (
                  <div key={kind} style={s.row}>
                    <span style={{ width: 170 }}>{label}</span>
                    <select style={s.select} value={cur.taskTypeId} onChange={(e) => setDraft((d) => ({ ...d, tasks: { ...d.tasks, [kind]: { ...cur, taskTypeId: Number(e.target.value) } } }))}>
                      {(dict?.taskTypes ?? [{ id: cur.taskTypeId, name: `Тип ${cur.taskTypeId}` }]).map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                    <NumberInput value={cur.deadlineMin} min={5} onChange={(v) => setDraft((d) => ({ ...d, tasks: { ...d.tasks, [kind]: { ...cur, deadlineMin: v ?? 60 } } }))} />
                  </div>
                );
              })}
            </div>
          </Field>
          <Field label="Когда AI передаёт диалог">
            <div style={{ ...s.small, ...s.muted }}>
              Менеджер написал клиенту · клиент просит человека, жалуется · скидка, нестандарт, юрлицо, опт, возврат, рекламация ·
              AI дважды подряд не нашёл ответа · ответ не прошёл проверку фактов · этап «без AI».
            </div>
          </Field>
        </>
      )}

      {tab === 'catalog' && (
        <>
          <Field label="Адрес фида YML" hint="Выгрузка каталога UMI в формате YML (Яндекс.Маркет).">
            <input style={s.input} value={draft.catalog.feedUrl} placeholder="https://rf-dveri.ru/…" onChange={(e) => set('catalog', { feedUrl: e.target.value.trim() })} />
          </Field>
          <Field label="Обновлять каждые, часов">
            <NumberInput value={draft.catalog.importEveryHours} min={1} max={168} onChange={(v) => set('catalog', { importEveryHours: v ?? 24 })} />
          </Field>
          <CatalogStatus api={api} hasFeed={Boolean(props.initial.catalog.feedUrl)} />
        </>
      )}

      {tab === 'knowledge' && <Knowledge api={api} />}
      {tab === 'pricing' && <PricingEditor api={api} />}
      {tab === 'drafts' && <Drafts api={api} />}

      {tab === 'limits' && (
        <>
          <Field label="Дневной лимит, ₽" hint="Пусто — без лимита.">
            <NumberInput nullable value={draft.limits.dailyRub} min={1} onChange={(v) => set('limits', { dailyRub: v })} />
          </Field>
          <Field label="При превышении дневного лимита">
            <select style={s.select} value={draft.limits.onExceed} onChange={(e) => set('limits', { onExceed: e.target.value as WidgetSettings['limits']['onExceed'] })}>
              <option value="stop">AI не отвечает до конца суток</option>
              <option value="hints">Только подсказки менеджеру</option>
              <option value="handoff">Передавать диалог менеджеру</option>
            </select>
          </Field>
          <Field label="Лимит ответов AI в одной сделке" hint="Пусто — без лимита. При достижении — передача менеджеру.">
            <NumberInput nullable value={draft.limits.maxAiMessagesPerLead} min={1} onChange={(v) => set('limits', { maxAiMessagesPerLead: v })} />
          </Field>
          <Field label="Курс доллара для учёта расходов, ₽">
            <NumberInput value={draft.billing.usdRubRate} min={1} onChange={(v) => set('billing', { usdRubRate: v ?? 90 })} />
          </Field>
        </>
      )}

      {tab === 'sandbox' && <Sandbox api={api} draft={dirty ? draft : undefined} />}
      {tab === 'journal' && <Journal api={api} />}

      {SETTINGS_TABS.has(tab) && (
        <div style={{ ...s.row, marginTop: 16 }}>
          <button type="button" style={s.button} disabled={saving || !dirty} onClick={save}>
            {saving ? 'Сохранение…' : 'Сохранить'}
          </button>
          {dirty && <span style={s.muted}>Есть несохранённые изменения. В песочнице проверяется черновик.</span>}
          {error && <span style={s.error}>{error}</span>}
        </div>
      )}
    </div>
  );
}
