import { useCallback, useState } from 'react';
import { errorMessage, Field, s, useLoad } from '@core/widget-core';
import type { ColumnMappingInfo, KbPriceInfo, KbSourceInfo, KpApi, PriceListPreviewInfo } from '../api.ts';

/**
 * Цены и синонимы базы знаний (RFD-AI-AGENT-OPT-KB, этап 3): предпросмотр и импорт цен из xlsx-прайса с выбором
 * колонок, список цен с поиском, ручная запись, синонимы названий («ДПГ сота = ДПГ + УПД (сота)»).
 */
const ORIGIN: Record<KbPriceInfo['origin'], string> = { price_list: 'прайс', web: 'веб-поиск', manager: 'менеджер', purchase: 'закупка' };
const VAT: Record<KbPriceInfo['vat'], string> = { included: 'с НДС', no_vat: 'без НДС', unknown: 'НДС ?' };
const date = (iso: string) => new Date(iso).toLocaleDateString('ru-RU');
const rub = (n: number) => `${n.toLocaleString('ru-RU')} ₽`;
const today = () => new Date().toISOString().slice(0, 10);

export function isXlsxSource(src: KbSourceInfo): boolean {
  return src.kind !== 'text' && (/\.(xlsx|xlsm)$/i.test(src.original ?? src.title) || /spreadsheetml/i.test(src.mime ?? ''));
}

/** Панель «Цены из прайса» под источником: сопоставление колонок, предпросмотр, параметры импорта. */
export function PriceImport({ api, src, onDone }: { api: KpApi; src: KbSourceInfo; onDone: (msg: string) => void }) {
  const [mapping, setMapping] = useState<Partial<ColumnMappingInfo> | undefined>(undefined);
  const load = useCallback(() => api.kbPricePreview(src.id, mapping), [api, src.id, mapping]);
  const [state] = useLoad(load);
  const [factory, setFactory] = useState('');
  const [validAt, setValidAt] = useState(today());
  const [vat, setVat] = useState<KbPriceInfo['vat']>('included');
  const [heightPct, setHeightPct] = useState('');
  const [widthPct, setWidthPct] = useState('');
  const [doubleLeafPct, setDoubleLeafPct] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (state.status === 'loading') return <div style={{ ...s.muted, ...s.small, marginTop: 6 }}>Читаю прайс…</div>;
  if (state.status === 'error') return <div style={s.error}>{state.message}</div>;
  const p: PriceListPreviewInfo = state.data;
  const m = p.mapping;
  const setCol = (key: keyof ColumnMappingInfo, raw: string) => setMapping({ ...m, ...mapping, [key]: raw === '' ? null : key === 'sheet' ? raw : Number(raw) });
  const col = (key: Exclude<keyof ColumnMappingInfo, 'sheet' | 'headerRow'>, label: string, required = false) => (
    <label key={key} style={{ ...s.small, display: 'flex', alignItems: 'center', gap: 6 }}>
      {label}
      <select style={{ ...s.select, height: 28 }} value={m[key] === null ? '' : String(m[key])} onChange={(e) => setCol(key, e.target.value)}>
        {!required && <option value="">—</option>}
        {p.columns.map((c) => (
          <option key={c.index} value={c.index}>{c.header}</option>
        ))}
      </select>
    </label>
  );
  const num = (v: string) => (v.trim() === '' ? undefined : Number(v.replace(',', '.')));
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const nonstandard = { ...(num(heightPct) !== undefined ? { heightPct: num(heightPct) } : {}), ...(num(widthPct) !== undefined ? { widthPct: num(widthPct) } : {}), ...(num(doubleLeafPct) !== undefined ? { doubleLeafPct: num(doubleLeafPct) } : {}) };
      const r = await api.kbPriceImport(src.id, { mapping: m, ...(factory.trim() ? { factory: factory.trim() } : {}), validAt, vat, nonstandard });
      onDone(`Из прайса «${src.title}» импортировано цен: ${r.imported}${r.skipped ? `, пропущено строк ${r.skipped}` : ''}`);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ marginTop: 8, padding: 8, background: '#f6f8fa', borderRadius: 6 }}>
      <div style={{ ...s.small, ...s.muted, marginBottom: 6 }}>
        {p.headerFound ? 'Шапка найдена, колонки подобраны по названиям' : 'Шапка не найдена — колонки подобраны по содержимому'} · позиций с ценой {p.total}
        {p.skipped ? ` · без цены ${p.skipped}` : ''}
      </div>
      <div style={{ ...s.row, marginBottom: 6 }}>
        {p.sheets.length > 1 && (
          <label style={{ ...s.small, display: 'flex', alignItems: 'center', gap: 6 }}>
            Лист
            <select style={{ ...s.select, height: 28 }} value={m.sheet ?? ''} onChange={(e) => setMapping({ sheet: e.target.value })}>
              {p.sheets.map((x) => (
                <option key={x} value={x}>{x}</option>
              ))}
            </select>
          </label>
        )}
        {col('model', 'Модель', true)}
        {col('price', 'Цена', true)}
        {col('size', 'Размер')}
        {col('width', 'Ширина')}
        {col('height', 'Высота')}
        {col('factory', 'Фабрика')}
        {col('unit', 'Ед.')}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 6 }}>
        <tbody>
          {p.sample.slice(0, 8).map((x) => (
            <tr key={`${x.sheet}-${x.row}`}>
              <td style={td}>{x.model}</td>
              <td style={td}>{x.widthMm && x.heightMm ? `${x.widthMm}×${x.heightMm}` : '—'}</td>
              <td style={{ ...td, textAlign: 'right' }}>{rub(x.price)}</td>
              <td style={{ ...td, color: '#8A949F' }}>{x.factory ?? x.section ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ ...s.row, marginBottom: 6 }}>
        <input style={{ ...s.input, width: 160 }} placeholder="Фабрика (если нет колонки)" value={factory} onChange={(e) => setFactory(e.target.value)} />
        <label style={{ ...s.small, display: 'flex', alignItems: 'center', gap: 6 }}>
          Актуален на <input style={{ ...s.input, width: 140 }} type="date" value={validAt} onChange={(e) => setValidAt(e.target.value)} />
        </label>
        <select style={s.select} value={vat} onChange={(e) => setVat(e.target.value as KbPriceInfo['vat'])}>
          <option value="included">цены с НДС</option>
          <option value="no_vat">без НДС</option>
          <option value="unknown">НДС не указан</option>
        </select>
      </div>
      <div style={{ ...s.row, marginBottom: 6 }}>
        <span style={s.small}>Нестандарт, %:</span>
        <input style={{ ...s.input, width: 110 }} placeholder="высота" value={heightPct} onChange={(e) => setHeightPct(e.target.value)} />
        <input style={{ ...s.input, width: 110 }} placeholder="ширина" value={widthPct} onChange={(e) => setWidthPct(e.target.value)} />
        <input style={{ ...s.input, width: 110 }} placeholder="двупольная" value={doubleLeafPct} onChange={(e) => setDoubleLeafPct(e.target.value)} />
      </div>
      <button type="button" style={s.button} disabled={busy || !p.total} onClick={() => void run()}>
        Импортировать {p.total} цен
      </button>
      {err && <div style={s.error}>{err}</div>}
    </div>
  );
}

/** Раздел «Цены»: поиск, список, ручная запись, удаление. */
export function PricesSection({ api }: { api: KpApi }) {
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const load = useCallback(() => api.kbPrices(applied), [api, applied]);
  const [state, reload] = useLoad(load);
  const [model, setModel] = useState('');
  const [size, setSize] = useState('');
  const [price, setPrice] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const add = async () => {
    const m = /(\d{3,4})\s*[×x*хХ]\s*(\d{3,4})/.exec(size);
    try {
      await api.kbAddPrice({ model: model.trim(), widthMm: m ? Math.min(Number(m[1]), Number(m[2])) : null, heightMm: m ? Math.max(Number(m[1]), Number(m[2])) : null, price: priceNumber(price), origin: 'manager', validAt: today() });
      setModel('');
      setSize('');
      setPrice('');
      setMsg('Цена записана (доверие 90)');
      reload();
    } catch (e) {
      setMsg(errorMessage(e));
    }
  };
  const remove = async (p: KbPriceInfo) => {
    if (!window.confirm(`Удалить цену «${p.model}${p.baseSize ? ` ${p.baseSize}` : ''}» — ${rub(p.price)}?`)) return;
    try {
      await api.kbRemovePrice(p.id);
      reload();
    } catch (e) {
      setMsg(errorMessage(e));
    }
  };
  return (
    <div style={{ marginTop: 16 }}>
      <div style={s.label}>Цены{state.status === 'ready' ? ` (${state.data.total})` : ''}</div>
      <div style={{ ...s.small, ...s.muted, marginBottom: 6 }}>Агент берёт цену отсюда до веб-поиска: точное совпадение модели и размера, иначе базовая цена × правила нестандарта. Прайс — доверие 70, веб-поиск — 40, правка менеджера — 90.</div>
      <div style={{ ...s.row, marginBottom: 6 }}>
        <input style={{ ...s.input, maxWidth: 260 }} placeholder="модель или фабрика" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setApplied(q.trim())} />
        <button type="button" style={s.buttonGhost} onClick={() => setApplied(q.trim())}>Найти</button>
      </div>
      <div style={{ ...s.row, marginBottom: 6 }}>
        <input style={{ ...s.input, maxWidth: 220 }} placeholder="Модель" value={model} onChange={(e) => setModel(e.target.value)} />
        <input style={{ ...s.input, maxWidth: 110 }} placeholder="800×2000" value={size} onChange={(e) => setSize(e.target.value)} />
        <input style={{ ...s.input, maxWidth: 110 }} placeholder="цена, ₽" value={price} onChange={(e) => setPrice(e.target.value)} />
        <button type="button" style={s.buttonGhost} disabled={!model.trim() || !priceNumber(price)} onClick={() => void add()}>Добавить цену</button>
      </div>
      {msg && <div style={{ ...s.muted, ...s.small, marginBottom: 6 }}>{msg}</div>}
      {state.status === 'loading' && <div style={s.muted}>Загрузка…</div>}
      {state.status === 'error' && <div style={s.error}>{state.message}</div>}
      {state.status === 'ready' && state.data.items.length === 0 && <div style={s.muted}>Цен пока нет — импортируйте xlsx-прайс кнопкой «Цены из прайса» у источника или добавьте руками</div>}
      {state.status === 'ready' && state.data.items.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <tbody>
            {state.data.items.map((p) => (
              <tr key={p.id} className="opt-kb-price">
                <td style={td}>{p.model}{p.factory ? <span style={{ color: '#8A949F' }}> · {p.factory}</span> : ''}</td>
                <td style={td}>{p.baseSize ?? '—'}</td>
                <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>{rub(p.price)}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{VAT[p.vat]}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{ORIGIN[p.origin]} · {p.confidence}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{date(p.validAt)}</td>
                <td style={{ ...td, color: '#8A949F' }}>{p.sourceTitle ?? p.url ?? p.note ?? ''}</td>
                <td style={td}>
                  <button type="button" style={{ ...s.buttonGhost, padding: '2px 8px' }} onClick={() => void remove(p)}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Раздел «Синонимы»: строки «каноническое = синоним = синоним», список, удаление. */
export function AliasesSection({ api }: { api: KpApi }) {
  const load = useCallback(() => api.kbAliases(), [api]);
  const [state, reload] = useLoad(load);
  const [lines, setLines] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const add = async () => {
    try {
      const r = await api.kbAddAliases(lines);
      setMsg(`Добавлено синонимов: ${r.added}`);
      setLines('');
      reload();
    } catch (e) {
      setMsg(errorMessage(e));
    }
  };
  return (
    <div style={{ marginTop: 16 }}>
      <div style={s.label}>Синонимы и артикулы{state.status === 'ready' ? ` (${state.data.aliases.length})` : ''}</div>
      <Field label="" hint="По строке на модель: сначала каноническое название, затем синонимы через «=». Пример: ДПГ сота = ДПГ + УПД (сота) = дверь глухая ламинированная сотовое заполнение">
        <textarea style={{ ...s.textarea, minHeight: 60 }} placeholder="ДПГ сота = ДПГ + УПД (сота) = дверь глухая ламинированная сотовое заполнение" value={lines} onChange={(e) => setLines(e.target.value)} />
        <button type="button" style={{ ...s.button, marginTop: 6 }} disabled={!lines.includes('=')} onClick={() => void add()}>Добавить синонимы</button>
      </Field>
      {msg && <div style={{ ...s.muted, ...s.small }}>{msg}</div>}
      {state.status === 'ready' && state.data.aliases.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <tbody>
            {state.data.aliases.map((a) => (
              <tr key={a.id}>
                <td style={td}>{a.alias}</td>
                <td style={{ ...td, color: '#8A949F' }}>= {a.canonical}</td>
                <td style={td}>
                  <button type="button" style={{ ...s.buttonGhost, padding: '2px 8px' }} onClick={() => void api.kbRemoveAlias(a.id).then(reload, (e) => setMsg(errorMessage(e)))}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** «4 100,50» → 4100.5; не число — 0. */
const priceNumber = (raw: string) => Number(raw.replace(/[\s\u00a0₽]/g, '').replace(',', '.')) || 0;

const td = { padding: '4px 6px', borderBottom: '1px solid #f0f3f5', verticalAlign: 'top' } as const;
