import { useCallback, useState } from 'react';
import { errorMessage, s, useLoad } from '@core/widget-core';
import type { ColumnMappingInfo, KbPriceInfo, KbSourceInfo, KpApi, PriceListPreviewInfo } from '../api.ts';

/**
 * Цены и синонимы базы знаний (RFD-AI-AGENT-OPT-KB, этап 3): предпросмотр и импорт цен из xlsx-прайса с выбором
 * колонок, список цен с поиском, ручная запись, синонимы названий («ДПГ сота = ДПГ + УПД (сота)»).
 */
const ORIGIN: Record<KbPriceInfo['origin'], string> = { price_list: 'прайс', web: 'веб-поиск', manager: 'менеджер', purchase: 'закупка' };
const VAT: Record<KbPriceInfo['vat'], string> = { included: 'с НДС', no_vat: 'без НДС', unknown: 'НДС ?' };
const date = (iso: string) => new Date(iso).toLocaleDateString('ru-RU');
/** KB-HW-NULL: тариф без цены — «нет цены», а не «0 ₽». */
const rub = (n: number | null) => (n === null ? 'нет цены' : `${n.toLocaleString('ru-RU')} ₽`);
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
  // KB-PRICE-SHEETS-FIX, п. 3: у файла с вкладкой ID ручная разметка колонок не нужна — статус книги, счётчики, ошибки, «Импортировать заново».
  if (p.isPriceBook && p.book) return <BookImport api={api} src={src} preview={p} onDone={onDone} />;
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
      onDone(`Из прайса «${src.title}» импортировано цен: ${r.imported}${r.replaced ? ` (прежний прайс заменён: удалено ${r.replaced})` : ''}${r.skipped ? `, пропущено строк ${r.skipped}` : ''}`);
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
        {src.prices ? ` · в базе сейчас ${src.prices}` : ''} · импорт заменит прежний прайс целиком
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
        {col('abbr', 'Сокращение')}
        {col('description', 'Назначение')}
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

/** Многолистовой прайс (KB-PRICE-SHEETS): что в файле, что в базе, ошибка импорта и кнопка «Импортировать заново». */
function BookImport({ api, src, preview, onDone }: { api: KpApi; src: KbSourceInfo; preview: PriceListPreviewInfo; onDone: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const b = preview.book as NonNullable<PriceListPreviewInfo['book']>;
  const imp = preview.priceImport ?? src.priceImport ?? null;
  const counts = src.counts ?? null;
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.kbPriceImport(src.id, { mapping: {} });
      const c = r.book;
      onDone(`Прайс «${src.title}» импортирован заново: дверей ${c?.doors ?? r.imported}${c?.estimates ? ` (сметных ${c.estimates})` : ''}, комплектующих ${c?.components ?? 0}, фурнитуры ${c?.hardware ?? 0}${c?.hardwareUnpriced ? ` (без цены ${c.hardwareUnpriced})` : ''}, размеров ${c?.sizes ?? 0}, синонимов ${c?.aliases ?? 0}, комментариев ${c?.comments ?? 0}`);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="opt-kb-book" style={{ marginTop: 8, padding: 8, background: '#f6f8fa', borderRadius: 6 }}>
      <div style={{ ...s.small, marginBottom: 4 }}>
        <b>Многолистовой прайс</b> · вкладки: {preview.sheets.join(', ')}
      </div>
      <div style={{ ...s.small, ...s.muted, marginBottom: 4 }} className="opt-kb-book-file">
        В файле: дверей {b.doors}{b.estimates ? ` (сметных ${b.estimates})` : ''} · комплектующих {b.components} · фурнитуры {b.hardware}{b.hardwareUnpriced ? ` (без цены ${b.hardwareUnpriced})` : ''} · размеров {b.sizes} · синонимов {b.aliases} · комментариев {b.comments}{b.dictionary ? ` · словарь ${b.dictionary}` : ''}
      </div>
      <div style={{ ...s.small, ...s.muted, marginBottom: 4 }} className="opt-kb-book-db">
        {counts ? `В базе сейчас: дверей ${counts.doors} · комплектующих ${counts.components} · фурнитуры ${counts.hardware} · размеров ${counts.sizes} · синонимов ${counts.aliases} · комментариев ${counts.comments}${imp?.at ? ` · импорт ${date(imp.at)}` : ''}` : 'В базе сейчас: прайс не импортирован'}
      </div>
      {imp?.error && <div style={s.error} className="opt-kb-book-error">Импорт не выполнен: {imp.error}; прежние данные прайса сохранены</div>}
      {b.errors.length > 0 && (
        <div style={s.error} className="opt-kb-book-errors">
          Файл сейчас не импортируется:
          {b.errors.map((e) => (
            <div key={e}>— {e}</div>
          ))}
        </div>
      )}
      {b.skipped.length > 0 && <div style={{ ...s.small, ...s.muted, marginBottom: 4 }}>Пропущено при разборе: {b.skipped.join('; ')}</div>}
      <button type="button" style={s.button} disabled={busy || b.errors.length > 0} onClick={() => void run()}>
        Импортировать заново
      </button>
      {err && <div style={s.error}>{err}</div>}
    </div>
  );
}

/** Вкладки раздела «Цены» (RFD-AI-AGENT-OPT-KB-PRICES-UI): прайс — только чтение; веб-цены и правки менеджера можно удалять. */
type PriceTab = 'price_list' | 'web' | 'manager';
const TAB_OF: Record<KbPriceInfo['origin'], PriceTab> = { price_list: 'price_list', web: 'web', manager: 'manager', purchase: 'manager' };
const TAB_TITLE: Record<PriceTab, string> = { price_list: 'Прайс', web: 'Веб', manager: 'Правки' };
/** Строк на странице таблицы цен. */
export const PRICES_PAGE = 20;
const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
};

/** Прайс-файл в сводке (KB-MULTIPRICE): короткое название, число цен, дата актуальности. */
export interface PriceListSummary {
  key: string;
  title: string;
  sourceId: number | null;
  count: number;
  validAt: string | null;
}

/** Сводка по ценам: прайсы (по файлам), веб-цены, правки менеджера. */
export function pricesSummary(items: KbPriceInfo[]): { priceLists: PriceListSummary[]; priceList: { count: number }; web: number; manager: number } {
  const pl = items.filter((p) => p.origin === 'price_list');
  const lists = new Map<string, PriceListSummary>();
  for (const p of pl) {
    const key = p.priceKey || p.sourceTitle || String(p.sourceId ?? '');
    const cur = lists.get(key) ?? { key, title: p.priceTitle || p.sourceTitle || key, sourceId: p.sourceId, count: 0, validAt: null };
    cur.count += 1;
    if (cur.validAt === null || new Date(p.validAt) > new Date(cur.validAt)) cur.validAt = p.validAt;
    lists.set(key, cur);
  }
  const priceLists = [...lists.values()].sort((a, b) => a.title.localeCompare(b.title, 'ru'));
  return { priceLists, priceList: { count: pl.length }, web: items.filter((p) => p.origin === 'web').length, manager: items.filter((p) => TAB_OF[p.origin] === 'manager').length };
}

const dayMonth = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export function summaryText(sum: ReturnType<typeof pricesSummary>): string {
  const lists = sum.priceLists;
  const pl = lists.length
    ? `${lists.length === 1 ? 'Прайс' : 'Прайсы'}: ${lists.map((l) => `${l.title} — ${l.count} ${plural(l.count, 'цена', 'цены', 'цен')}${l.validAt ? ` (${dayMonth(l.validAt)})` : ''}`).join(' · ')}`
    : 'Прайс не загружен';
  return `${pl}  |  веб-цены: ${sum.web}  |  правки менеджера: ${sum.manager}${sum.web + sum.manager ? ' (в КП не используются)' : ''}`;
}

/**
 * Раздел «Цены» (RFD-AI-AGENT-OPT-KB-PRICES-UI): по умолчанию одна строка-сводка; «Показать» раскрывает таблицу с
 * вкладками «Прайс / Веб / Правки», поиском по модели по вводу и страницами по 20 строк. Строки прайса — только чтение,
 * у веб-цен и правок — удаление. version — счётчик вкладки: растёт после загрузки/удаления источника, список перечитывается без перезагрузки.
 */
export function PricesSection({ api, version = 0 }: { api: KpApi; version?: number }) {
  const load = useCallback(() => api.kbPrices('', 1000), [api, version]);
  const [state, reload] = useLoad(load);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<PriceTab>('price_list');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  // Фильтр вкладки «Прайс» по файлу (KB-MULTIPRICE): '' — все прайсы.
  const [list, setList] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const remove = async (p: KbPriceInfo) => {
    if (!window.confirm(`Удалить цену «${p.model}${p.baseSize ? ` ${p.baseSize}` : ''}» — ${rub(p.price)}?`)) return;
    try {
      await api.kbRemovePrice(p.id);
      reload();
    } catch (e) {
      setMsg(errorMessage(e));
    }
  };
  const exportXlsx = async () => {
    try {
      const f = await api.kbPricesExport();
      downloadBase64(f.contentBase64, f.filename);
      setMsg(`Выгружено записей: ${f.rows}`);
    } catch (e) {
      setMsg(errorMessage(e));
    }
  };
  const items = state.status === 'ready' ? state.data.items : [];
  const sum = pricesSummary(items);
  const counts: Record<PriceTab, number> = { price_list: sum.priceList.count, web: sum.web, manager: sum.manager };
  const needle = q.trim().toLowerCase();
  const listKeyOf = (p: KbPriceInfo) => p.priceKey || p.sourceTitle || String(p.sourceId ?? '');
  const filtered = items.filter((p) => TAB_OF[p.origin] === tab && (tab !== 'price_list' || !list || listKeyOf(p) === list) && (!needle || p.model.toLowerCase().includes(needle) || (p.factory ?? '').toLowerCase().includes(needle)));
  const pages = Math.max(1, Math.ceil(filtered.length / PRICES_PAGE));
  const current = Math.min(page, pages - 1);
  const rows = filtered.slice(current * PRICES_PAGE, current * PRICES_PAGE + PRICES_PAGE);
  const pick = (t: PriceTab) => {
    setTab(t);
    setPage(0);
  };
  return (
    <div style={{ marginTop: 16 }} className="opt-kb-prices">
      <div style={{ ...s.row, justifyContent: 'space-between' }}>
        <div style={s.label}>Цены{state.status === 'ready' ? ` (${state.data.total})` : ''}</div>
        <div style={s.row}>
          <button type="button" style={s.buttonGhost} disabled={state.status !== 'ready'} onClick={() => setOpen((v) => !v)}>
            {open ? 'Скрыть' : 'Показать'}
          </button>
          <button type="button" style={s.buttonGhost} disabled={state.status !== 'ready' || state.data.total === 0} onClick={() => void exportXlsx()}>Выгрузить в xlsx</button>
        </div>
      </div>
      {state.status === 'loading' && <div style={s.muted}>Загрузка…</div>}
      {state.status === 'error' && <div style={s.error}>{state.message}</div>}
      {state.status === 'ready' && <div className="opt-kb-prices-summary" style={{ ...s.small, marginBottom: 6 }}>{summaryText(sum)}</div>}
      {msg && <div style={{ ...s.muted, ...s.small, marginBottom: 6 }}>{msg}</div>}
      {open && state.status === 'ready' && (
        <div className="opt-kb-prices-table">
          <div style={{ ...s.small, ...s.muted, marginBottom: 6 }}>В КП идут только цены прайса: точное совпадение модели и размера, иначе базовая цена × правила нестандарта; строки прайса нет — «уточнить у менеджера». Веб-цены и правки менеджера хранятся для справки, в КП не используются — их можно удалить.</div>
          <div style={{ ...s.row, marginBottom: 6 }}>
            {(['price_list', 'web', 'manager'] as PriceTab[]).map((t) => (
              <button key={t} type="button" className={`opt-kb-prices-tab${t === tab ? ' opt-kb-prices-tab-active' : ''}`} style={{ ...s.buttonGhost, ...(t === tab ? { fontWeight: 600, borderColor: '#1f6feb' } : {}) }} onClick={() => pick(t)}>
                {TAB_TITLE[t]} ({counts[t]})
              </button>
            ))}
            {tab === 'price_list' && sum.priceLists.length > 1 && (
              <select
                className="opt-kb-prices-list"
                style={{ ...s.input, maxWidth: 220 }}
                value={list}
                onChange={(e) => {
                  setList(e.target.value);
                  setPage(0);
                }}
              >
                <option value="">все прайсы</option>
                {sum.priceLists.map((l) => (
                  <option key={l.key} value={l.key}>{l.title} ({l.count})</option>
                ))}
              </select>
            )}
            <input
              style={{ ...s.input, maxWidth: 240 }}
              placeholder="поиск по модели"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(0);
              }}
            />
          </div>
          {filtered.length === 0 && <div style={s.muted}>{items.length === 0 ? 'Цен пока нет — загрузите xlsx-прайс во вкладке' : needle ? 'По запросу ничего не найдено' : tab === 'price_list' ? 'Прайс не загружен' : tab === 'web' ? 'Веб-цен ещё нет' : 'Правок менеджера нет'}</div>}
          {filtered.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={th}>Модель</th>
                  <th style={th}>Размер</th>
                  <th style={{ ...th, textAlign: 'right' }}>Цена</th>
                  <th style={th}>НДС</th>
                  <th style={th}>Дата</th>
                  <th style={th}>Источник</th>
                  <th style={th} />
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="opt-kb-price">
                    <td style={td}>{p.model}{p.factory ? <span style={{ color: '#8A949F' }}> · {p.factory}</span> : ''}</td>
                    <td style={td}>{p.baseSize ?? '—'}</td>
                    <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>{rub(p.price)}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{VAT[p.vat]}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{date(p.validAt)}</td>
                    <td style={{ ...td, color: '#8A949F' }}>{sourceOf(p)}</td>
                    <td style={td}>
                      {p.origin !== 'price_list' && (
                        <button type="button" style={{ ...s.buttonGhost, padding: '2px 8px' }} title="Удалить" onClick={() => void remove(p)}>×</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {filtered.length > PRICES_PAGE && (
            <div style={{ ...s.row, ...s.small, marginTop: 6, alignItems: 'center' }} className="opt-kb-prices-pager">
              <button type="button" style={{ ...s.buttonGhost, padding: '2px 8px' }} disabled={current === 0} onClick={() => setPage(current - 1)}>←</button>
              <span>{current * PRICES_PAGE + 1}–{Math.min(filtered.length, (current + 1) * PRICES_PAGE)} из {filtered.length}</span>
              <button type="button" style={{ ...s.buttonGhost, padding: '2px 8px' }} disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>→</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Колонка «Источник»: файл прайса, сайт веб-цены или примечание правки. */
function sourceOf(p: KbPriceInfo): string {
  if (p.sourceTitle) return p.sourceTitle;
  if (p.url) {
    try {
      return new URL(p.url).host;
    } catch {
      return p.url;
    }
  }
  return p.note ?? ORIGIN[p.origin];
}

const th = { padding: '4px 6px', borderBottom: '1px solid #dfe3e8', textAlign: 'left', color: '#8A949F', fontWeight: 500 } as const;

/** Скачивание файла из base64 (как у выгрузки прайса розницы): ссылка-blob, клик, отзыв адреса. */
export function downloadBase64(base64: string, name: string, mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** «4 100,50» → 4100.5; не число — 0. */

const td = { padding: '4px 6px', borderBottom: '1px solid #f0f3f5', verticalAlign: 'top' } as const;
