import { useCallback, useEffect, useState } from 'react';
import { errorMessage, Field, s, useLoad } from '@core/widget-core';
import type { KpApi, ModelInfo, OptSettings, ProviderId } from '../api.ts';

const PROVIDERS: { id: ProviderId; label: string }[] = [
  { id: 'openai', label: 'OpenAI ChatGPT' },
  { id: 'anthropic', label: 'Anthropic Claude' },
];

const price = (m: ModelInfo) => (m.price ? ` · $${m.price.input}/$${m.price.output} за 1M` : '');

/**
 * Вкладка «Модель»: провайдер, ключ (проверяется у провайдера до сохранения), основная и резервная
 * модели из списка провайдера с ценой. Переопределений по воронкам и песочницы у опта нет.
 */
export function ModelSettings({ api }: { api: KpApi }) {
  const [all, setAll] = useState<OptSettings | null>(null);
  const [model, setModel] = useState<OptSettings['model'] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loadKeys = useCallback(() => api.llmKeys(), [api]);
  const [keys, reloadKeys] = useLoad(loadKeys);

  useEffect(() => {
    api
      .settings()
      .then((r) => {
        setAll(r.settings);
        setModel(r.settings.model);
      })
      .catch((e) => setMsg(errorMessage(e)));
  }, [api]);

  const save = async () => {
    if (!all || !model) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.saveSettings({ ...all, model });
      setAll(r.settings);
      setMsg(`Сохранено (версия ${r.version})`);
    } catch (e) {
      setMsg(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!model) return <div style={{ ...s.block, ...s.muted }}>{msg ?? 'Загрузка…'}</div>;
  const set = (patch: Partial<OptSettings['model']>) => setModel((m) => (m ? { ...m, ...patch } : m));

  return (
    <div style={s.block}>
      <Field label="Провайдер">
        <select style={s.select} value={model.provider} onChange={(e) => set({ provider: e.target.value as ProviderId })}>
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </Field>
      {keys.status === 'ready' && <KeyField api={api} provider={model.provider} info={keys.data.keys[model.provider]} onChange={reloadKeys} />}
      <ModelPicker api={api} provider={model.provider} label="Модель" value={model.model} onChange={(v) => set({ model: v })} />
      <ModelPicker api={api} provider={model.fallbackProvider ?? model.provider} label="Резервная модель" hint="Пусто — без резерва" value={model.fallbackModel ?? ''} onChange={(v) => set({ fallbackModel: v || null })} />
      <Field label="Глубина рассуждений">
        <select style={s.select} value={model.effort} onChange={(e) => set({ effort: e.target.value as OptSettings['model']['effort'] })}>
          <option value="low">низкая</option>
          <option value="medium">средняя</option>
          <option value="high">высокая</option>
        </select>
      </Field>
      <button type="button" style={s.button} disabled={busy} onClick={() => void save()}>
        Сохранить
      </button>
      {msg && <div style={{ ...s.muted, marginTop: 8 }}>{msg}</div>}
    </div>
  );
}

/** Ключ провайдера: маска сохранённого, проверка, сохранение, удаление. Ключ обратно не показывается. */
function KeyField({ api, provider, info, onChange }: { api: KpApi; provider: ProviderId; info: { saved: boolean; mask: string | null; source: 'account' | 'server' | null } | undefined; onChange: () => void }) {
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (fn: () => Promise<string>) => {
    setMsg(null);
    try {
      setMsg(await fn());
    } catch (e) {
      setMsg(errorMessage(e));
    }
  };
  const status = info?.saved ? `Сохранён ключ ${info.mask}` : info?.source === 'server' ? 'Используется серверный ключ' : 'Ключа нет';
  return (
    <Field label="Ключ API" hint={status}>
      <div style={{ display: 'flex', gap: 8 }}>
        <input style={s.input} type="password" value={key} autoComplete="off" placeholder="sk-…" onChange={(e) => setKey(e.target.value)} />
        <button type="button" style={s.buttonGhost} disabled={!key} onClick={() => void run(async () => { const r = await api.testLlmKey(provider, key); return r.ok ? `Ключ работает, моделей: ${r.models.length}` : `Ключ не принят: ${r.error}`; })}>
          Проверить
        </button>
        <button type="button" style={s.buttonGhost} disabled={!key} onClick={() => void run(async () => { await api.saveLlmKey(provider, key); setKey(''); onChange(); return 'Ключ сохранён'; })}>
          Сохранить ключ
        </button>
        {info?.saved && (
          <button type="button" style={s.buttonGhost} onClick={() => void run(async () => { await api.removeLlmKey(provider); onChange(); return 'Ключ удалён'; })}>
            Удалить
          </button>
        )}
      </div>
      {msg && <div style={{ ...s.muted, ...s.small, marginTop: 4 }}>{msg}</div>}
    </Field>
  );
}

function ModelPicker({ api, provider, label, hint, value, onChange }: { api: KpApi; provider: ProviderId; label: string; hint?: string; value: string; onChange: (v: string) => void }) {
  const load = useCallback(() => api.models(provider), [api, provider]);
  const [state] = useLoad(load);
  const models = state.status === 'ready' ? state.data.models : [];
  const known = models.some((m) => m.id === value);
  return (
    <Field label={label} hint={hint ?? (state.status === 'ready' && state.data.noKey ? 'Список по тарифам: ключ не задан' : undefined)}>
      <select style={s.select} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {!known && value && <option value={value}>{value}</option>}
        {models.map((m) => (
          <option key={m.id} value={m.id}>{m.name ?? m.id}{price(m)}</option>
        ))}
      </select>
    </Field>
  );
}
