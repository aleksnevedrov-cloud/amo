import { useCallback, useState } from 'react';
import type { CalcResult, PricingRules, WidgetApi } from '../api.ts';
import { downloadBase64, fileToBase64 } from '../chat.ts';
import { Calculation } from './Calculation.tsx';
import { Field, NumberInput } from './fields.tsx';
import { s } from './styles.ts';
import { errorMessage, useLoad } from './useLoad.ts';

type Comp = PricingRules['components'][number];
type Svc = PricingRules['services'][number];

const UNITS: [Svc['unit'], string][] = [
  ['fixed', 'за заказ'],
  ['per_door', 'за дверь'],
  ['per_km', 'за км'],
  ['per_door_per_floor', 'за дверь за этаж'],
];

const numList = (v: string) => v.split(/[,;\s]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const seriesToText = (c: Comp) => c.prices.map((p) => `${p.series} = ${p.price}`).join('\n');
const textToSeries = (v: string) =>
  v
    .split('\n')
    .map((line) => line.split('='))
    .filter((p) => p.length === 2 && p[0]?.trim() && Number.isFinite(Number(p[1]?.trim())))
    .map(([series, price]) => ({ series: (series as string).trim(), price: Number((price as string).trim()) }));

export function PricingEditor({ api }: { api: WidgetApi }) {
  const load = useCallback(() => api.pricing(), [api]);
  const [state, reload] = useLoad(load);
  if (state.status === 'loading') return <div style={s.muted}>Загрузка…</div>;
  if (state.status === 'error') return <div style={s.error}>{state.message}</div>;
  return <Editor api={api} initial={state.data.rules} onSaved={reload} />;
}

function Editor({ api, initial, onSaved }: { api: WidgetApi; initial: PricingRules; onSaved: () => void }) {
  const [r, setR] = useState(initial);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(r) !== JSON.stringify(initial);
  const setComp = (i: number, patch: Partial<Comp>) => setR({ ...r, components: r.components.map((c, k) => (k === i ? { ...c, ...patch } : c)) });
  const setSvc = (i: number, patch: Partial<Svc>) => setR({ ...r, services: r.services.map((c, k) => (k === i ? { ...c, ...patch } : c)) });

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (err) {
      const e = err as { status?: number; responseJSON?: { problems?: string[] } } | null;
      setMsg(e?.responseJSON?.problems?.join('; ') ?? (e?.status === 400 ? 'Проверьте заполнение: коды латиницей, без повторов.' : errorMessage(err)));
    } finally {
      setBusy(false);
    }
  };

  const importFile = (file: File | undefined) =>
    file &&
    act(async () => {
      const res = await api.importPricing(await fileToBase64(file));
      setR(res.rules);
      setMsg('Файл загружен. Проверьте правила и нажмите «Сохранить».');
    });

  return (
    <div style={s.col}>
      <div style={{ ...s.muted, ...s.small }}>
        Правила, по которым агент считает комплект: полотно из каталога, коробки и наличники на дверь, доборы, услуги. Пока правил
        нет, агент не называет итоговую сумму и ставит менеджеру задачу на расчёт.
      </div>
      <div style={s.row}>
        <label style={{ ...s.buttonGhost, display: 'inline-flex', alignItems: 'center' }}>
          Загрузить XLSX
          <input type="file" accept=".xlsx" style={{ display: 'none' }} onChange={(e) => importFile(e.target.files?.[0])} />
        </label>
        <button type="button" style={s.buttonGhost} disabled={busy} onClick={() => act(async () => { const f = await api.exportPricing(); downloadBase64(f.file, f.name); })}>
          Скачать XLSX
        </button>
      </div>

      <Field label="Стандартные ширины полотна, мм">
        <input style={s.input} defaultValue={r.sizes.standardWidths.join(', ')} onBlur={(e) => setR({ ...r, sizes: { ...r.sizes, standardWidths: numList(e.target.value) } })} />
      </Field>
      <Field label="Стандартные высоты полотна, мм">
        <input style={s.input} defaultValue={r.sizes.standardHeights.join(', ')} onBlur={(e) => setR({ ...r, sizes: { ...r.sizes, standardHeights: numList(e.target.value) } })} />
      </Field>
      <Field label="Наценка за нестандартный размер, %" hint="Пусто — нестандартный размер считает менеджер.">
        <NumberInput nullable value={r.sizes.nonStandardMarkupPct} min={0} onChange={(v) => setR({ ...r, sizes: { ...r.sizes, nonStandardMarkupPct: v } })} />
      </Field>
      <Field label="Пояснение к расчёту для клиента">
        <input style={s.input} value={r.disclaimer} onChange={(e) => setR({ ...r, disclaimer: e.target.value })} />
      </Field>

      <div style={s.label}>Комплектующие</div>
      {r.components.map((c, i) => (
        <div key={i} style={{ ...s.card, ...s.col }}>
          <div style={s.row}>
            <input style={{ ...s.input, width: 110 }} placeholder="код" value={c.code} onChange={(e) => setComp(i, { code: e.target.value.trim() })} />
            <input style={{ ...s.input, flex: 1, width: 'auto' }} placeholder="Наименование" value={c.name} onChange={(e) => setComp(i, { name: e.target.value })} />
            <button type="button" style={s.buttonGhost} onClick={() => setR({ ...r, components: r.components.filter((_, k) => k !== i) })}>
              Удалить
            </button>
          </div>
          <div style={s.row}>
            <span style={s.small}>Шт. на дверь</span>
            <NumberInput value={c.qtyPerDoor} min={0} onChange={(v) => setComp(i, { qtyPerDoor: v ?? 0 })} />
            <label style={{ ...s.row, ...s.small }}>
              <input type="checkbox" checked={c.inKit} onChange={(e) => setComp(i, { inKit: e.target.checked })} /> в комплекте
            </label>
            <label style={{ ...s.row, ...s.small }}>
              <input type="checkbox" checked={c.roundUp} onChange={(e) => setComp(i, { roundUp: e.target.checked })} /> округлять вверх
            </label>
          </div>
          <div style={s.row}>
            <span style={s.small}>Цена по умолчанию</span>
            <NumberInput nullable value={c.defaultPrice} min={0} onChange={(v) => setComp(i, { defaultPrice: v })} />
          </div>
          <textarea
            style={{ ...s.textarea, minHeight: 60 }}
            placeholder={'Цены по сериям, по одной на строку:\nСтэфани = 1224\nЛаура = 1700'}
            defaultValue={seriesToText(c)}
            onBlur={(e) => setComp(i, { prices: textToSeries(e.target.value) })}
          />
        </div>
      ))}
      <button
        type="button"
        style={s.buttonGhost}
        onClick={() => setR({ ...r, components: [...r.components, { code: `item_${r.components.length + 1}`, name: '', qtyPerDoor: 0, inKit: true, roundUp: true, prices: [], defaultPrice: null }] })}
      >
        + Комплектующее
      </button>

      <div style={s.label}>Услуги</div>
      {r.services.map((v, i) => (
        <div key={i} style={{ ...s.row, ...s.card }}>
          <input style={{ ...s.input, width: 110 }} placeholder="код" value={v.code} onChange={(e) => setSvc(i, { code: e.target.value.trim() })} />
          <input style={{ ...s.input, flex: 1, width: 'auto' }} placeholder="Наименование" value={v.name} onChange={(e) => setSvc(i, { name: e.target.value })} />
          <select style={s.select} value={v.unit} onChange={(e) => setSvc(i, { unit: e.target.value as Svc['unit'] })}>
            {UNITS.map(([u, label]) => (
              <option key={u} value={u}>
                {label}
              </option>
            ))}
          </select>
          <NumberInput value={v.price} min={0} placeholder="цена" onChange={(x) => setSvc(i, { price: x ?? 0 })} />
          {v.unit === 'per_km' && <NumberInput value={v.basePrice} min={0} placeholder="база" onChange={(x) => setSvc(i, { basePrice: x ?? 0 })} />}
          <button type="button" style={s.buttonGhost} onClick={() => setR({ ...r, services: r.services.filter((_, k) => k !== i) })}>
            Удалить
          </button>
        </div>
      ))}
      <button type="button" style={s.buttonGhost} onClick={() => setR({ ...r, services: [...r.services, { code: `svc_${r.services.length + 1}`, name: '', unit: 'fixed', price: 0, basePrice: 0 }] })}>
        + Услуга
      </button>

      <div style={{ ...s.row, marginTop: 8 }}>
        <button type="button" style={s.button} disabled={busy || !dirty} onClick={() => act(async () => { await api.savePricing(r); setMsg('Сохранено.'); onSaved(); })}>
          Сохранить
        </button>
        {msg && <span style={s.small}>{msg}</span>}
      </div>

      <TestCalc api={api} rules={dirty ? r : undefined} />
    </div>
  );
}

function TestCalc({ api, rules }: { api: WidgetApi; rules?: PricingRules }) {
  const [productId, setProductId] = useState('');
  const [width, setWidth] = useState<number | null>(800);
  const [height, setHeight] = useState<number | null>(2000);
  const [qty, setQty] = useState<number | null>(1);
  const [services, setServices] = useState('');
  const [res, setRes] = useState<CalcResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setErr(null);
    try {
      const out = await api.testPricing({
        doors: [{ product_id: productId.trim(), width_mm: width ?? undefined, height_mm: height ?? undefined, qty: qty ?? 1 }],
        services: services.split(/[,\s]+/).filter(Boolean).map((code) => ({ code })),
        ...(rules ? { rules } : {}),
      });
      setRes(out.result);
    } catch (e) {
      setErr((e as { status?: number } | null)?.status === 404 ? 'Товар не найден в каталоге' : errorMessage(e));
    }
  };

  return (
    <div style={{ ...s.card, ...s.col, marginTop: 12 }}>
      <b>Тест расчёта</b>
      <div style={s.row}>
        <input style={{ ...s.input, width: 160 }} placeholder="ID или артикул двери" value={productId} onChange={(e) => setProductId(e.target.value)} />
        <NumberInput value={width} placeholder="ширина" onChange={setWidth} />
        <NumberInput value={height} placeholder="высота" onChange={setHeight} />
        <NumberInput value={qty} min={1} placeholder="шт." onChange={setQty} />
      </div>
      <input style={s.input} placeholder="Коды услуг через запятую" value={services} onChange={(e) => setServices(e.target.value)} />
      <div style={s.row}>
        <button type="button" style={s.buttonGhost} disabled={!productId.trim()} onClick={run}>
          Посчитать
        </button>
        {rules && <span style={{ ...s.muted, ...s.small }}>Считается по несохранённым правилам</span>}
        {err && <span style={s.error}>{err}</span>}
      </div>
      {res && <Calculation c={res} />}
    </div>
  );
}
