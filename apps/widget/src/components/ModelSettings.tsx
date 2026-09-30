import { useCallback, useEffect, useMemo, useState } from 'react';
import { PROVIDER_LABELS, tariffModels } from '@ai-door/llm/pricing';
import type { Dictionaries, LlmKeys, ModelInfo, ModelRef, ProviderId, WidgetApi, WidgetSettings } from '../api.ts';
import { Field, NumberInput } from './fields.tsx';
import { PROVIDER_NAME, providerShort, usd } from './StatusBadge.tsx';
import { s } from './styles.ts';
import { errorMessage } from './useLoad.ts';

export const PROVIDERS: ProviderId[] = ['anthropic', 'openai'];
const CONSOLE: Record<ProviderId, string> = { anthropic: 'console.anthropic.com', openai: 'platform.openai.com' };
const PLACEHOLDER: Record<ProviderId, string> = { anthropic: 'sk-ant-…', openai: 'sk-…' };

type ModelSettings = WidgetSettings['model'];

/** Название модели с ценой и меткой изображений (раздел 4 ТЗ). */
export function modelOption(m: ModelInfo): string {
  const price = m.price ? ` · ${usd(m.price.input)} / ${usd(m.price.output)} за 1M` : '';
  const eyes = m.vision ? ' · видит изображения' : '';
  return `${m.name}${m.name === m.id ? '' : ` (${m.id})`}${price}${eyes}`;
}

/**
 * Списки моделей провайдеров: из API по сохранённому ключу (кэш 24 ч на бэкенде), без ключа или
 * на бэкенде 1.0.x — из таблицы тарифов. Загружаются один раз на провайдера, «Обновить список» — заново.
 */
export function useModelLists(api: WidgetApi, providers: ProviderId[]) {
  const [lists, setLists] = useState<Partial<Record<ProviderId, { models: ModelInfo[]; source: 'api' | 'tariff'; fetchedAt: string | null; error?: string }>>>({});
  const load = useCallback(
    async (provider: ProviderId, refresh = false) => {
      try {
        const r = await api.llmModels(provider, refresh);
        const models = r?.models?.length ? r.models : tariffModels(provider);
        setLists((l) => ({ ...l, [provider]: { models, source: r?.models?.length ? r.source : 'tariff', fetchedAt: r?.fetchedAt ?? null, ...(r?.error ? { error: r.error } : {}) } }));
      } catch (err) {
        const body = (err as { responseJSON?: { models?: ModelInfo[]; message?: string } } | null)?.responseJSON;
        setLists((l) => ({ ...l, [provider]: { models: body?.models?.length ? body.models : tariffModels(provider), source: 'tariff', fetchedAt: null, error: body?.message ?? errorMessage(err) } }));
      }
    },
    [api],
  );
  useEffect(() => {
    for (const p of providers) if (!lists[p]) void load(p);
  }, [providers, lists, load]);
  const models = useCallback((p: ProviderId) => lists[p]?.models ?? tariffModels(p), [lists]);
  return { lists, models, reload: load };
}

/** Выбор провайдера и модели (резервная модель, песочница, панель сделки). */
export function ModelPicker({
  api,
  value,
  onChange,
  providers,
  allowNone,
  noneLabel = 'Нет',
  style,
}: {
  api: WidgetApi;
  value: ModelRef | null;
  onChange: (v: ModelRef | null) => void;
  /** Провайдеры с ключом; пусто — все (списки из таблицы тарифов). */
  providers: ProviderId[];
  allowNone?: boolean;
  noneLabel?: string;
  style?: React.CSSProperties;
}) {
  const ids = providers.length ? providers : PROVIDERS;
  const { models } = useModelLists(api, ids);
  const options = ids.flatMap((p) => models(p).map((m) => ({ key: `${p}:${m.id}`, label: `${providerShort(p)} · ${modelOption(m)}` })));
  const current = value ? `${value.provider}:${value.model}` : '';
  if (value && !options.some((o) => o.key === current)) options.unshift({ key: current, label: `${providerShort(value.provider)} · ${value.model} (нет в списке провайдера)` });
  return (
    <select
      style={{ ...s.select, ...style }}
      value={current}
      onChange={(e) => {
        const [provider, ...rest] = e.target.value.split(':');
        onChange(e.target.value && provider ? { provider: provider as ProviderId, model: rest.join(':') } : null);
      }}
    >
      {allowNone && <option value="">{noneLabel}</option>}
      {options.map((o) => (
        <option key={o.key} value={o.key}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Вкладка «Модель» (раздел 6 ТЗ 1.1.0): провайдер, ключи, модель из API провайдера, резерв, параметры, переопределения. */
export function ModelTab({
  api,
  isAdmin,
  value,
  dict,
  onChange,
  onKeys,
  onCompare,
}: {
  api: WidgetApi;
  isAdmin: boolean;
  value: ModelSettings;
  dict: Dictionaries | null;
  onChange: (patch: Partial<ModelSettings>) => void;
  /** Какие провайдеры с ключом — форма блокирует «Сохранить» без ключа выбранного провайдера. */
  onKeys: (keys: LlmKeys | null, legacyConfigured: boolean) => void;
  onCompare: (models: ModelRef[]) => void;
}) {
  const provider = value.provider ?? 'anthropic';
  const other = PROVIDERS.find((p) => p !== provider) ?? 'openai';
  const [keys, setKeys] = useState<LlmKeys | null>(null);
  const [legacy, setLegacy] = useState<{ hasOwnKey: boolean; configured: boolean; source: string | null } | null>(null);
  const [showOther, setShowOther] = useState(false);

  const loadKeys = useCallback(async () => {
    const [st, k] = await Promise.allSettled([api.llmStatus(), api.llmKeys()]);
    const status = st.status === 'fulfilled' && st.value ? st.value : null;
    const list = k.status === 'fulfilled' && k.value && k.value.keys ? k.value : null;
    setLegacy(status);
    setKeys(list);
    onKeys(list, Boolean(status?.configured));
  }, [api, onKeys]);
  useEffect(() => void loadKeys(), [loadKeys]);

  const providersWithKey = useMemo<ProviderId[]>(() => (keys ? keys.providers : legacy?.configured ? ['anthropic'] : []), [keys, legacy]);
  const { lists, models, reload } = useModelLists(api, providersWithKey.includes(provider) ? providersWithKey : [...providersWithKey, provider]);
  const list = models(provider);
  const info = list.find((m) => m.id === value.model) ?? null;
  const fallbackRef: ModelRef | null = value.fallbackModel ? { provider: value.fallbackProvider ?? provider, model: value.fallbackModel } : null;

  const switchProvider = (p: ProviderId) => {
    if (p === provider) return;
    const next = value.defaults?.[p] ?? models(p)[0]?.id ?? '';
    onChange({
      provider: p,
      model: next,
      // Резерв «того же провайдера» привязываем к прежнему явно, чтобы модель осталась той же.
      ...(value.fallbackModel && !value.fallbackProvider ? { fallbackProvider: provider } : {}),
    });
  };
  const setModel = (id: string) => onChange({ model: id, defaults: { ...(value.defaults ?? { anthropic: null, openai: null }), [provider]: id } });
  const showTemperature = info ? info.temperature : true;
  const showEffort = info ? info.reasoning : true;
  const tMax = provider === 'openai' ? 2 : 1;
  const compareWith: ModelRef[] = [{ provider, model: value.model }, fallbackRef ?? (providersWithKey.includes(other) ? { provider: other, model: models(other)[0]?.id ?? '' } : { provider, model: list.find((m) => m.id !== value.model)?.id ?? value.model })];

  return (
    // Менеджеру вкладка доступна только на чтение: провайдера и модель меняет администратор аккаунта.
    <fieldset disabled={!isAdmin} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
      {!isAdmin && <div style={{ ...s.block, ...s.muted, ...s.small }}>Провайдера и модель меняет администратор аккаунта amoCRM. Здесь показаны текущие настройки.</div>}
      <Field label="Провайдер" hint="Смена провайдера действует со следующего сообщения клиента во всех сделках аккаунта, без перезапуска.">
        <select style={s.select} value={provider} onChange={(e) => switchProvider(e.target.value as ProviderId)}>
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABELS[p]}
            </option>
          ))}
        </select>
      </Field>
      <LlmKey api={api} provider={provider} isAdmin={isAdmin} keys={keys} legacy={legacy} onChanged={loadKeys} />
      <div style={{ ...s.block, paddingTop: 4 }}>
        <button type="button" style={{ ...s.tab, padding: '4px 0', color: '#4c8bf7' }} onClick={() => setShowOther((v) => !v)}>
          {showOther ? '▾' : '▸'} Ключ другого провайдера ({PROVIDER_NAME[other]}){keys?.keys[other]?.saved ? ` — сохранён ${keys.keys[other].mask ?? ''}` : ''}
        </button>
        {showOther && <LlmKey api={api} provider={other} isAdmin={isAdmin} keys={keys} legacy={legacy} onChanged={loadKeys} compact />}
      </div>
      <Field label="Модель" hint={lists[provider]?.source === 'api' ? `Список из API ${PROVIDER_NAME[provider]}${lists[provider]?.fetchedAt ? ` (обновлён ${new Date(lists[provider]?.fetchedAt ?? '').toLocaleString('ru-RU')})` : ''}.` : `Список из таблицы тарифов${lists[provider]?.error ? `: ${lists[provider]?.error}` : ' — сохраните ключ, чтобы получить модели из API провайдера'}.`}>
        <div style={s.row}>
          <select style={{ ...s.select, maxWidth: '100%' }} value={value.model} onChange={(e) => setModel(e.target.value)}>
            {!list.some((m) => m.id === value.model) && <option value={value.model}>{value.model} (нет в списке провайдера)</option>}
            {list.map((m) => (
              <option key={m.id} value={m.id}>
                {modelOption(m)}
              </option>
            ))}
          </select>
          <button type="button" style={s.buttonGhost} onClick={() => void reload(provider, true)}>
            Обновить список
          </button>
        </div>
      </Field>
      <Field label="Резервная модель при сбое" hint="Любая модель любого провайдера, у которого сохранён ключ. При недоступности основной ответ уходит через неё с отметкой «fallback» в журнале.">
        <ModelPicker
          api={api}
          value={fallbackRef}
          providers={providersWithKey.length ? providersWithKey : [provider]}
          allowNone
          onChange={(v) => onChange(v ? { fallbackModel: v.model, fallbackProvider: v.provider === provider ? null : v.provider } : { fallbackModel: null, fallbackProvider: null })}
        />
      </Field>
      {showEffort && (
        <Field label="Глубина рассуждений" hint="Выше — точнее на сложных вопросах, но дольше и дороже.">
          <select style={s.select} value={value.effort} onChange={(e) => onChange({ effort: e.target.value as ModelSettings['effort'] })}>
            <option value="low">Низкая (быстро)</option>
            <option value="medium">Средняя</option>
            <option value="high">Высокая</option>
          </select>
        </Field>
      )}
      {showTemperature && (
        <Field label="Температура" hint={`0 — предсказуемо, ${tMax} — разнообразно. Пусто — значение провайдера по умолчанию. Моделям без поддержки параметр не передаётся.`}>
          <NumberInput nullable value={value.temperature ?? null} min={0} max={tMax} onChange={(v) => onChange({ temperature: v === null ? null : Math.min(tMax, Math.max(0, v)) })} />
        </Field>
      )}
      <Field label="Лимит токенов на ответ" hint={info?.maxOutputTokens ? `Максимум у модели: ${info.maxOutputTokens.toLocaleString('ru-RU')}.` : undefined}>
        <NumberInput value={value.maxTokens} min={512} max={Math.min(16000, info?.maxOutputTokens ?? 16000)} onChange={(v) => onChange({ maxTokens: v ?? 4096 })} />
      </Field>
      <Overrides api={api} value={value} dict={dict} providers={providersWithKey.length ? providersWithKey : [provider]} onChange={onChange} />
      <Field label="Сравнить" hint="Один и тот же диалог на двух моделях рядом: ответы, инструменты, токены, стоимость, время.">
        <button type="button" style={s.buttonGhost} onClick={() => onCompare(compareWith)}>
          Сравнить в песочнице: {compareWith.map((m) => `${providerShort(m.provider)} ${m.model}`).join(' и ')}
        </button>
      </Field>
    </fieldset>
  );
}

/** Переопределение провайдера и модели для воронки и этапа (раздел 3 ТЗ: сделка > этап > воронка > глобально). */
function Overrides({ api, value, dict, providers, onChange }: { api: WidgetApi; value: ModelSettings; dict: Dictionaries | null; providers: ProviderId[]; onChange: (patch: Partial<ModelSettings>) => void }) {
  const ov = value.overrides ?? { pipelines: {}, statuses: {} };
  const set = (kind: 'pipelines' | 'statuses', id: number, ref: ModelRef | null) => {
    const next = Object.fromEntries(Object.entries(ov[kind]).filter(([k]) => k !== String(id)));
    if (ref) next[String(id)] = ref;
    onChange({ overrides: { ...ov, [kind]: next } });
  };
  if (!dict) return <Field label="Модель для воронок и этапов">{Object.keys(ov.pipelines).length + Object.keys(ov.statuses).length ? <div style={s.small}>Переопределений: {Object.keys(ov.pipelines).length + Object.keys(ov.statuses).length}. Загрузка воронок…</div> : <div style={s.muted}>Загрузка воронок…</div>}</Field>;
  return (
    <Field label="Модель для воронок и этапов" hint="Иерархия: сделка (в карточке) > этап > воронка > эта вкладка. «По умолчанию» — как настроено выше.">
      <div style={s.col}>
        {dict.pipelines.map((p) => (
          <div key={p.id} style={s.col}>
            <div style={s.row}>
              <span style={{ width: 220 }}>
                <b>{p.name}</b>
              </span>
              <ModelPicker api={api} value={ov.pipelines[String(p.id)] ?? null} providers={providers} allowNone noneLabel="По умолчанию" onChange={(v) => set('pipelines', p.id, v)} />
            </div>
            {p.statuses.map((st) => (
              <div key={st.id} style={{ ...s.row, paddingLeft: 16 }}>
                <span style={{ width: 204, ...s.small }}>{st.name}</span>
                <ModelPicker api={api} value={ov.statuses[String(st.id)] ?? null} providers={providers} allowNone noneLabel="По умолчанию" onChange={(v) => set('statuses', st.id, v)} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </Field>
  );
}

/** Ключ провайдера: ввод (только запись), проверка без расходов с меткой, сохранение (после проверки на сервере), удаление. */
function LlmKey({
  api,
  provider,
  isAdmin,
  keys,
  legacy,
  onChanged,
  compact,
}: {
  api: WidgetApi;
  provider: ProviderId;
  isAdmin: boolean;
  keys: LlmKeys | null;
  legacy: { hasOwnKey: boolean; configured: boolean; source: string | null } | null;
  onChanged: () => Promise<void>;
  compact?: boolean;
}) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [checked, setChecked] = useState<'ok' | 'bad' | null>(null);
  const k = keys?.keys[provider];
  // На бэкенде 1.0.x нет /llm/keys — статус только по Anthropic.
  const own = k ? k.saved : provider === 'anthropic' ? Boolean(legacy?.hasOwnKey) : false;
  const configured = k ? k.source !== null : provider === 'anthropic' ? Boolean(legacy?.configured) : false;
  const statusText = own
    ? `Используется ключ вашего аккаунта${k?.mask ? ` (${k.mask})` : ''}.`
    : configured
      ? 'Используется общий ключ сервера.'
      : `Ключа нет — AI не отвечает. Получите ключ на ${CONSOLE[provider]} и вставьте сюда.`;
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg(await fn());
      await onChanged();
    } catch (err) {
      const body = (err as { responseJSON?: { message?: string; error?: string } } | null)?.responseJSON;
      setMsg(body?.error === 'key_invalid' ? `Ключ не сохранён: ${body.message ?? 'не прошёл проверку'}` : errorMessage(err));
      if (body?.error === 'key_invalid') setChecked('bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Field label={`Ключ ${PROVIDER_NAME[provider]}`} hint={compact ? undefined : 'Ключ хранится зашифрованным, в интерфейс отдаётся только маска. Расход на модель идёт с вашего счёта у провайдера.'}>
      <div style={{ ...s.small, marginBottom: 6 }}>{statusText}</div>
      {isAdmin && (
        <div style={s.row}>
          <input
            style={{ ...s.input, width: 360 }}
            type="password"
            placeholder={PLACEHOLDER[provider]}
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setChecked(null);
            }}
            autoComplete="off"
          />
          <button
            type="button"
            style={s.buttonGhost}
            disabled={busy || key.trim().length < 20}
            onClick={() =>
              void run(async () => {
                const r = await api.testLlmKey(key.trim(), provider);
                setChecked(r.ok ? 'ok' : 'bad');
                return r.ok ? `Ключ работает, моделей доступно: ${r.models.length}.` : r.error;
              })
            }
          >
            Проверить
          </button>
          {checked && <span style={checked === 'ok' ? s.badgeOk : s.badgeBad}>{checked === 'ok' ? 'ключ действует' : 'ключ не принят'}</span>}
          <button
            type="button"
            style={s.button}
            disabled={busy || key.trim().length < 20}
            onClick={() =>
              void run(async () => {
                await api.setLlmKey(key.trim(), provider);
                setKey('');
                setChecked(null);
                return 'Ключ сохранён.';
              })
            }
          >
            Сохранить ключ
          </button>
          {own && (
            <button type="button" style={s.buttonGhost} disabled={busy} onClick={() => void run(async () => (await api.deleteLlmKey(provider), 'Ключ удалён.'))}>
              Удалить ключ
            </button>
          )}
        </div>
      )}
      {msg && <div style={s.small}>{msg}</div>}
    </Field>
  );
}
