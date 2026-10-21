import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, Field, s } from '@core/widget-core';
import type { KbAliasGroup, KbAliasInfo, KpApi } from '../api.ts';

/** Строк на страницу группы — столько же отдаёт бэкенд за один запрос. */
export const ALIASES_PAGE = 50;
/** Пауза перед поиском, пока менеджер печатает. */
const SEARCH_DELAY_MS = 300;

type GroupRows = { items: KbAliasInfo[]; total: number; loading: boolean; error: string | null };

/**
 * Раздел «Синонимы» (KB-ALIASES-UI): после импорта прайса синонимов тысячи (Оникс — 8 154), поэтому блок свёрнут, синонимы
 * сгруппированы по прайсам, каждая группа грузится с бэкенда по 50 строк («Ещё 50»), поиск — на бэкенде (без регистра
 * и ё/е, по синониму, модели и ID). Высота блока — не больше 400 px, дальше прокрутка внутри. Добавление строкой
 * «каноническое = синоним» и удаление — как раньше.
 */
export function AliasesSection({ api }: { api: KpApi }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState<number | null>(null);
  const [groups, setGroups] = useState<KbAliasGroup[] | null>(null);
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [rows, setRows] = useState<Record<number, GroupRows>>({});
  const [lines, setLines] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  // Счётчики по прайсам (без строк): заголовок «Синонимы (N)» и список групп.
  const loadGroups = useCallback(
    async (search: string) => {
      const n = ++seq.current;
      try {
        const r = await api.kbAliases({ q: search, limit: 0 });
        if (n !== seq.current) return null;
        // Бэкенд до KB-ALIASES-UI счётчиков не отдаёт — тогда групп нет, заголовок без числа.
        setAll(r.all ?? null);
        setGroups(r.groups ?? []);
        setError(null);
        return r.groups ?? [];
      } catch (e) {
        if (n === seq.current) setError(errorMessage(e));
        return null;
      }
    },
    [api],
  );

  const loadRows = useCallback(
    async (sourceId: number, search: string, offset: number) => {
      setRows((m) => ({ ...m, [sourceId]: { items: offset ? (m[sourceId]?.items ?? []) : [], total: m[sourceId]?.total ?? 0, loading: true, error: null } }));
      try {
        const r = await api.kbAliases({ sourceId, q: search, offset, limit: ALIASES_PAGE });
        setRows((m) => ({ ...m, [sourceId]: { items: offset ? [...(m[sourceId]?.items ?? []), ...r.aliases] : r.aliases, total: r.total ?? r.aliases.length, loading: false, error: null } }));
      } catch (e) {
        setRows((m) => ({ ...m, [sourceId]: { items: m[sourceId]?.items ?? [], total: m[sourceId]?.total ?? 0, loading: false, error: errorMessage(e) } }));
      }
    },
    [api],
  );

  useEffect(() => {
    void loadGroups('');
  }, [loadGroups]);

  // Поиск: по паузе в наборе — счётчики заново; совпавшие группы раскрыты с первой страницей; пусто — всё свёрнуто.
  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => {
    if (!open) return;
    void (async () => {
      const gs = await loadGroups(q);
      if (!gs) return;
      setRows({});
      if (!q) return setExpanded({});
      setExpanded(Object.fromEntries(gs.map((g) => [g.sourceId, true])));
      for (const g of gs) void loadRows(g.sourceId, q, 0);
    })();
  }, [q, open, loadGroups, loadRows]);

  const toggleGroup = (sourceId: number) => {
    const next = !expanded[sourceId];
    setExpanded((m) => ({ ...m, [sourceId]: next }));
    if (next && !rows[sourceId]) void loadRows(sourceId, q, 0);
  };

  const refresh = async () => {
    const gs = await loadGroups(q);
    setRows({});
    for (const g of gs ?? []) if (expanded[g.sourceId]) void loadRows(g.sourceId, q, 0);
  };

  const add = async () => {
    try {
      const r = await api.kbAddAliases(lines);
      setMsg(`Добавлено синонимов: ${r.added}`);
      setLines('');
      await refresh();
    } catch (e) {
      setMsg(errorMessage(e));
    }
  };
  const remove = async (a: KbAliasInfo) => {
    try {
      await api.kbRemoveAlias(a.id);
      await refresh();
    } catch (e) {
      setMsg(errorMessage(e));
    }
  };

  return (
    <div className="opt-kb-aliases" style={{ marginTop: 16 }}>
      <div style={{ ...s.row, justifyContent: 'space-between' }}>
        <div style={{ ...s.label, marginBottom: 0 }} className="opt-kb-aliases-title">
          Синонимы{all !== null ? ` (${all.toLocaleString('ru-RU')})` : ''}
        </div>
        <button type="button" style={s.buttonGhost} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? 'Скрыть' : 'Показать'}
        </button>
      </div>
      {error && <div style={s.error}>{error}</div>}
      {open && (
        <div className="opt-kb-aliases-body" style={{ maxHeight: 400, overflowY: 'auto', marginTop: 6, paddingRight: 4 }}>
          <Field label="" hint="По строке на модель: сначала каноническое название, затем синонимы через «=». Пример: ДПГ сота = ДПГ + УПД (сота) = дверь глухая ламинированная сотовое заполнение">
            <textarea style={{ ...s.textarea, minHeight: 48 }} placeholder="ДПГ сота = ДПГ + УПД (сота) = дверь глухая ламинированная сотовое заполнение" value={lines} onChange={(e) => setLines(e.target.value)} />
            <button type="button" style={{ ...s.button, marginTop: 6 }} disabled={!lines.includes('=')} onClick={() => void add()}>
              Добавить синонимы
            </button>
          </Field>
          {msg && <div style={{ ...s.muted, ...s.small }}>{msg}</div>}
          <input className="opt-kb-aliases-search" style={{ ...s.input, width: '100%', boxSizing: 'border-box', margin: '6px 0' }} placeholder="Найти синоним или модель" aria-label="Найти синоним или модель" value={query} onChange={(e) => setQuery(e.target.value)} />
          {groups && groups.length === 0 && <div style={{ ...s.muted, ...s.small }}>{q ? `Ничего не найдено по «${q}»` : 'Синонимов нет'}</div>}
          {groups?.map((g) => (
            <AliasGroup key={g.sourceId} group={g} open={Boolean(expanded[g.sourceId])} rows={rows[g.sourceId]} onToggle={() => toggleGroup(g.sourceId)} onMore={() => void loadRows(g.sourceId, q, rows[g.sourceId]?.items.length ?? 0)} onRemove={(a) => void remove(a)} />
          ))}
        </div>
      )}
    </div>
  );
}

function AliasGroup({ group, open, rows, onToggle, onMore, onRemove }: { group: KbAliasGroup; open: boolean; rows: GroupRows | undefined; onToggle: () => void; onMore: () => void; onRemove: (a: KbAliasInfo) => void }) {
  const left = rows ? rows.total - rows.items.length : 0;
  return (
    <div className="opt-kb-alias-group" style={{ borderTop: '1px solid #f0f3f5' }}>
      <button type="button" className="opt-kb-alias-group-head" aria-expanded={open} onClick={onToggle} style={{ display: 'flex', width: '100%', justifyContent: 'space-between', gap: 8, background: 'none', border: 0, padding: '6px 2px', cursor: 'pointer', font: 'inherit', fontSize: 13, textAlign: 'left' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={group.title}>
          {open ? '▾' : '▸'} {group.title} — {group.count.toLocaleString('ru-RU')}
        </span>
      </button>
      {open && (
        <div style={{ paddingBottom: 6 }}>
          {rows?.items.length ? (
            <table className="opt-kb-alias-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <th style={th}>Синоним</th>
                  <th style={th}>Модель (ID)</th>
                  <th style={{ ...th, width: 34 }} />
                </tr>
              </thead>
              <tbody>
                {rows.items.map((a) => {
                  const model = a.productId ? `${a.canonical} (${a.productId})` : a.canonical;
                  return (
                    <tr key={a.id}>
                      <td style={cell} title={a.alias}>{a.alias}</td>
                      <td style={{ ...cell, color: '#5f6b77' }} title={model}>{model}</td>
                      <td style={{ ...cell, overflow: 'visible' }}>
                        <button type="button" aria-label={`Удалить синоним «${a.alias}»`} style={{ ...s.buttonGhost, padding: '2px 8px', height: 24 }} onClick={() => onRemove(a)}>
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            !rows?.loading && <div style={{ ...s.muted, ...s.small }}>Нет строк</div>
          )}
          {rows?.loading && <div style={{ ...s.muted, ...s.small }}>Загружаю…</div>}
          {rows?.error && <div style={s.error}>{rows.error}</div>}
          {rows && !rows.loading && left > 0 && (
            <button type="button" style={{ ...s.buttonGhost, marginTop: 4 }} onClick={onMore}>
              Ещё {Math.min(ALIASES_PAGE, left)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const th = { padding: '4px 6px', borderBottom: '1px solid #dfe3e8', textAlign: 'left', color: '#8A949F', fontWeight: 500 } as const;
const cell = { padding: '4px 6px', borderBottom: '1px solid #f0f3f5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;
