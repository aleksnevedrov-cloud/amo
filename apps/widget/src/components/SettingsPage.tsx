import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_PRICING } from '@ai-door/llm/pricing';
import type { Dictionaries, LlmKeys, Mode, ModelRef, ProviderId, Status, WidgetApi, WidgetSettings } from '../api.ts';
import { CatalogStatus } from './Catalog.tsx';
import { Field, linesToList, NumberInput } from './fields.tsx';
import { Drafts } from './Drafts.tsx';
import { EmailSettings } from './EmailSettings.tsx';
import { WazzupSettings } from './WazzupSettings.tsx';
import { Journal } from './Journal.tsx';
import { PricingEditor } from './PricingEditor.tsx';
import { Knowledge } from './Knowledge.tsx';
import { ModelTab } from './ModelSettings.tsx';
import { Analytics } from './Analytics.tsx';
import { Sandbox } from './Sandbox.tsx';
import { Versions } from './Versions.tsx';
import { ConnectionBadge, modeLabel, providerShort, providerVendor, rub } from './StatusBadge.tsx';
import { s } from './styles.ts';
import { errorMessage, useLoad } from './useLoad.ts';

const MODES: Mode[] = ['off', 'hints', 'semi', 'auto'];

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
  ['email', 'Почта'],
  ['wazzup', 'Wazzup'],
  ['catalog', 'Каталог'],
  ['pricing', 'Правила цен'],
  ['knowledge', 'База знаний'],
  ['limits', 'Лимиты'],
  ['drafts', 'Черновики'],
  ['sandbox', 'Песочница'],
  ['journal', 'Журнал'],
  ['analytics', 'Аналитика'],
  ['versions', 'Версии'],
] as const;
type Tab = (typeof TABS)[number][0];
const SETTINGS_TABS = new Set<Tab>(['status', 'behavior', 'model', 'where', 'handoff', 'email', 'catalog', 'limits']);

/**
 * Расширенные настройки виджета (раздел 11.1 ТЗ). Рисуется и на своей странице (advanced_settings),
 * и в модальном окне интеграции — тогда `fullPageUrl` даёт ссылку на полноэкранный вариант.
 */
export function SettingsPage({ api, fullPageUrl }: { api: WidgetApi; fullPageUrl?: string }) {
  const load = useCallback(async () => {
    const [status, { settings }] = await Promise.all([api.status(), api.settings()]);
    return { status, settings };
  }, [api]);
  const [state, reload] = useLoad(load);

  if (state.status === 'loading') return <div style={{ ...s.root, ...s.muted }}>Загрузка…</div>;
  if (state.status === 'error') return <div style={{ ...s.root, ...s.error }}>{state.message}</div>;
  return (
    <>
      {fullPageUrl && (
        <div style={{ ...s.root, ...s.small, ...s.muted, marginBottom: 8 }}>
          <a href={fullPageUrl} target="_blank" rel="noreferrer">
            Открыть настройки на всю страницу
          </a>
        </div>
      )}
      <SettingsForm api={api} status={state.data.status} initial={state.data.settings} onSaved={reload} />
    </>
  );
}

function SettingsForm(props: { api: WidgetApi; status: Status; initial: WidgetSettings; onSaved: () => void }) {
  const { api, status } = props;
  const [tab, setTab] = useState<Tab>('status');
  const [draft, setDraft] = useState(props.initial);
  // Сохранённое состояние: после отката подтягивается без перемонтирования формы.
  const [base, setBase] = useState(props.initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dict, setDict] = useState<Dictionaries | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  // Ключи меняются на вкладке «Модель» — бейдж в «Статусе» и блокировка «Сохранить» обновляются без перезагрузки формы.
  const [llmOk, setLlmOk] = useState(status.llmConfigured);
  const [keys, setKeys] = useState<LlmKeys | null>(null);
  const [compare, setCompare] = useState<ModelRef[] | undefined>(undefined);
  const provider: ProviderId = draft.model?.provider ?? 'anthropic';
  const providersWithKey = keys ? keys.providers : status.llm?.providers ?? null;
  // Ключ выбранного провайдера не сохранён — «Сохранить» недоступна (раздел 3 ТЗ 1.1.0).
  const noKey = providersWithKey !== null && !providersWithKey.includes(provider) && provider !== (base.model?.provider ?? 'anthropic');
  const onKeys = useCallback((k: LlmKeys | null, legacyConfigured: boolean) => {
    setKeys(k);
    setLlmOk(k ? k.providers.includes(k.provider) : legacyConfigured);
  }, []);
  const onRestored = async () => {
    const { settings } = await api.settings();
    setBase(settings);
    setDraft(settings);
  };

  useEffect(() => {
    if ((tab === 'where' || tab === 'handoff' || tab === 'email' || tab === 'model') && !dict) api.dictionaries().then((d) => setDict(d ?? null), () => undefined);
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
      const code = (err as { status?: number; responseJSON?: { error?: string; message?: string } } | null)?.status;
      const body = (err as { responseJSON?: { error?: string; message?: string } } | null)?.responseJSON;
      setError(
        body?.error === 'no_key'
          ? (body.message ?? `Введите ключ ${providerShort(provider)}`)
          : code === 403
            ? 'Изменять настройки может только администратор аккаунта.'
            : code === 400
              ? 'Проверьте заполнение полей.'
              : errorMessage(err),
      );
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
              <span style={llmOk ? s.badgeOk : s.badgeBad}>
                {llmOk ? `LLM подключена: ${providerShort(provider)} · ${draft.model?.model ?? ''}` : `Нет ключа ${providerVendor(provider)} — задайте во вкладке «Модель»`}
              </span>
              {status.llm?.missingModels?.length ? <span style={s.badgeWarn}>Модель {status.llm.missingModels.join(', ')} не найдена у провайдера — выберите другую во вкладке «Модель»</span> : null}
              {status.llm?.lastError && <span style={s.badgeWarn} title={status.llm.lastError.summary}>Последний сбой LLM: {status.llm.lastError.summary.slice(0, 80)}</span>}
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
          {props.status.isAdmin && <PurgeAccount api={api} />}
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
        <ModelTab
          api={api}
          isAdmin={props.status.isAdmin}
          value={draft.model}
          dict={dict}
          onChange={(patch) => set('model', patch)}
          onKeys={onKeys}
          onCompare={(models) => {
            setCompare(models);
            setTab('sandbox');
          }}
        />
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
          <Field label="Файлы и фото клиентов" hint="Фото, сканы и PDF без текста распознаются в Yandex Vision (серверы в РФ); в Claude уходит только текст без контактов. Ключ задаётся на сервере.">
            <select style={s.select} value={draft.vision.provider} onChange={(e) => set('vision', { provider: e.target.value as WidgetSettings['vision']['provider'] })}>
              <option value="yandex">Yandex Vision (данные в РФ; без ключа — Tesseract)</option>
              <option value="tesseract">Tesseract на нашем сервере (бесплатно, хуже на рукописном, только картинки)</option>
              <option value="off">Не распознавать сканы и фото</option>
            </select>
            <label style={s.row}>
              <input type="checkbox" checked={draft.vision.autoParse} onChange={(e) => set('vision', { autoParse: e.target.checked })} />
              Разбирать вложения из чатов и писем автоматически
            </label>
            <label style={s.row}>
              <input type="checkbox" checked={draft.vision.photosToClaude} onChange={(e) => set('vision', { photosToClaude: e.target.checked })} />
              Фото двери или проёма без текста показывать Claude (описание модели и цвета)
            </label>
            <label style={s.row}>
              <input type="checkbox" checked={draft.vision.noteInLead} onChange={(e) => set('vision', { noteInLead: e.target.checked })} />
              Записывать разбор примечанием в сделку
            </label>
          </Field>
          <Field label="Лимит файлов в сутки" hint="Защита от лишнего расхода на распознавание.">
            <NumberInput value={draft.vision.maxFilesPerDay} min={1} max={1000} onChange={(v) => set('vision', { maxFilesPerDay: v ?? 100 })} />
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
          <Field label="Адреса фидов YML" hint="Выгрузки каталога UMI в формате YML (Яндекс.Маркет), по одному адресу в строке — например входные, межкомнатные, фурнитура. Все фиды сливаются в один каталог.">
            <textarea
              style={{ ...s.textarea, minHeight: 70 }}
              value={[draft.catalog.feedUrl, ...draft.catalog.feedUrls].filter(Boolean).join('\n')}
              placeholder={'https://www.rf-dveri.ru/admin/exchange/get_export/…/?as_file=0'}
              onChange={(e) => {
                const [first = '', ...rest] = linesToList(e.target.value);
                set('catalog', { feedUrl: first, feedUrls: rest });
              }}
            />
          </Field>
          <Field label="Обновлять каждые, часов">
            <NumberInput value={draft.catalog.importEveryHours} min={1} max={168} onChange={(v) => set('catalog', { importEveryHours: v ?? 24 })} />
          </Field>
          <CatalogStatus api={api} hasFeed={Boolean(base.catalog.feedUrl || base.catalog.feedUrls.length)} />
        </>
      )}

      {tab === 'email' && (
        <EmailSettings
          api={api}
          value={draft.email}
          dict={dict}
          saved={JSON.stringify(draft.email) === JSON.stringify(base.email)}
          onChange={(patch) => set('email', patch)}
        />
      )}
      {tab === 'wazzup' && <WazzupSettings api={api} />}
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
          <Field label="Валюта учёта">
            <select style={s.select} value={draft.billing.currency ?? 'rub'} onChange={(e) => set('billing', { currency: e.target.value as 'rub' | 'usd' })}>
              <option value="rub">₽ по курсу</option>
              <option value="usd">$</option>
            </select>
          </Field>
          <PricingTable value={draft.billing.pricing ?? {}} onChange={(pricing) => set('billing', { pricing })} />
        </>
      )}

      {tab === 'sandbox' && <Sandbox api={api} draft={dirty ? draft : undefined} compare={compare} providers={providersWithKey ?? undefined} />}
      {tab === 'journal' && <Journal api={api} />}
      {tab === 'analytics' && <Analytics api={api} />}
      {tab === 'versions' && <Versions api={api} isAdmin={props.status.isAdmin} onRestored={() => void onRestored()} />}

      {SETTINGS_TABS.has(tab) && (
        <div style={{ ...s.row, marginTop: 16 }}>
          <button type="button" style={s.button} disabled={saving || !dirty || noKey} onClick={save}>
            {saving ? 'Сохранение…' : 'Сохранить'}
          </button>
          {noKey && <span style={s.error}>Введите ключ {providerVendor(provider)} во вкладке «Модель»</span>}
          {dirty && !noKey && <span style={s.muted}>Есть несохранённые изменения. В песочнице проверяется черновик.</span>}
          {error && <span style={s.error}>{error}</span>}
        </div>
      )}
    </div>
  );
}

/** Удаление всех данных аккаунта на сервере AI-агента (по запросу; чек-лист Маркетплейса). */
function PurgeAccount({ api }: { api: WidgetApi }) {
  const [msg, setMsg] = useState<string | null>(null);
  const purge = async () => {
    const typed = window.prompt('Будут удалены все данные AI-агента по этому аккаунту: настройки, переписка, память клиентов, журнал, разборы файлов. Это необратимо. Введите УДАЛИТЬ, чтобы подтвердить.');
    if (typed !== 'УДАЛИТЬ') return;
    try {
      await api.purgeAccount();
      setMsg('Данные удалены. Чтобы пользоваться AI-агентом снова, переустановите интеграцию.');
    } catch (err) {
      setMsg(errorMessage(err));
    }
  };
  return (
    <Field label="Данные аккаунта" hint="Удаление всех данных на сервере AI-агента по запросу владельца аккаунта.">
      <button type="button" style={s.buttonGhost} onClick={() => void purge()}>
        Удалить все данные
      </button>
      {msg && <div style={s.small}>{msg}</div>}
    </Field>
  );
}

/** Тарифы по моделям, $ за 1M токенов (раздел 5 ТЗ 1.1.0): таблица по умолчанию с правкой заказчика. */
function PricingTable({ value, onChange }: { value: Record<string, { input: number; output: number; cachedInput?: number }>; onChange: (v: Record<string, { input: number; output: number; cachedInput?: number }>) => void }) {
  const rows = (['anthropic', 'openai'] as const).flatMap((p) => Object.entries(DEFAULT_PRICING[p]).map(([id, t]) => ({ key: `${p}:${id}`, provider: p, id, name: t.name, input: t.input, output: t.output })));
  const cell = { padding: '2px 6px', borderBottom: '1px solid #e8eaeb' };
  const setPrice = (key: string, field: 'input' | 'output', v: number | null, def: { input: number; output: number }) => {
    const cur = value[key] ?? { input: def.input, output: def.output };
    const updated = { ...cur, [field]: v ?? 0 };
    const next = Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
    if (!(updated.input === def.input && updated.output === def.output)) next[key] = updated;
    onChange(next);
  };
  return (
    <Field label="Тарифы моделей, $ за 1 млн токенов" hint="Значения по умолчанию — из прайс-листов провайдеров; исправьте, если ваш тариф отличается. Стоимость в журнале и аналитике считается по этой таблице.">
      <table style={{ ...s.small, borderCollapse: 'collapse', width: '100%', maxWidth: 560 }}>
        <thead>
          <tr style={s.muted}>
            <th align="left" style={cell}>Модель</th>
            <th align="right" style={cell}>Вход</th>
            <th align="right" style={cell}>Выход</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const cur = value[r.key] ?? { input: r.input, output: r.output };
            const changed = Boolean(value[r.key]);
            return (
              <tr key={r.key}>
                <td style={cell}>
                  {providerShort(r.provider)} · {r.name} {changed && <span style={s.badgeWarn}>изменено</span>}
                </td>
                <td style={cell} align="right">
                  <input style={{ ...s.input, width: 90, height: 28 }} type="number" step="0.01" min={0} value={cur.input} onChange={(e) => setPrice(r.key, 'input', e.target.value === '' ? null : Number(e.target.value), r)} />
                </td>
                <td style={cell} align="right">
                  <input style={{ ...s.input, width: 90, height: 28 }} type="number" step="0.01" min={0} value={cur.output} onChange={(e) => setPrice(r.key, 'output', e.target.value === '' ? null : Number(e.target.value), r)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Field>
  );
}
