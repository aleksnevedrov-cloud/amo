import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { DocumentResult, LeadFile, LeadPanel as Panel, ModelRef, WidgetApi } from '../api.ts';
import { fileToBase64, insertIntoChat } from '../chat.ts';
import { Calculation } from './Calculation.tsx';
import { DOC_KIND, DocumentView } from './Documents.tsx';
import { ModelPicker } from './ModelSettings.tsx';
import { dateTime, kindLabel, modeLabel, modelLabel, rub } from './StatusBadge.tsx';
import { SuggestionCard } from './Suggestions.tsx';
import { s } from './styles.ts';
import { errorMessage } from './useLoad.ts';

/** Как часто панель перечитывает данные, пока карточка открыта (новые сообщения, действия AI). */
const POLL_MS = 20_000;
const COLLAPSE_KEY = 'ai-door-panel-collapsed';
const ACCEPT = '.pdf,.xlsx,.xlsm,.docx,.jpg,.jpeg,.png,.webp,.txt,.csv,.dwg,.dxf';

type Dot = 'green' | 'yellow' | 'gray' | 'red' | 'blue';
const DOT_COLOR: Record<Dot, string> = { green: '#2c9e3d', yellow: '#e2a400', gray: '#a5abb0', red: '#d0342c', blue: '#4c8bf7' };

const ghost = { ...s.buttonGhost, height: 28, padding: '0 10px', fontSize: 12 } as const;
const line = { minHeight: 32, display: 'flex', alignItems: 'center', ...s.muted, ...s.small } as const;

function readCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

/**
 * Панель в правой колонке карточки сделки (раздел 11 ТЗ 1.1.0): шапка, статус с моделью и расходом, ошибка,
 * черновики, подсказки, товары, расчёт, файлы клиента, задачи AI, резюме, журнал. Данные подгружаются без
 * блокировки карточки и обновляются автоматически.
 */
export function LeadPanel({ api, leadId, logoUrl, settingsUrl }: { api: WidgetApi; leadId: number; logoUrl?: string; settingsUrl?: string }) {
  const [data, setData] = useState<Panel | null>(null);
  const [loadError, setLoadError] = useState<{ message: string; at: Date } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsed);
  const [docResult, setDocResult] = useState<DocumentResult | null>(null);
  const [docs, setDocs] = useState<LeadFile[] | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const p = await api.leadPanel(leadId);
        if (!alive.current) return;
        setData(p);
        setLoadError(null);
        // Бэкенд 1.0.x не отдаёт файлы — берём список разобранных документов.
        if (!p.files) {
          const d = await api.leadDocuments(leadId).catch(() => null);
          if (alive.current) setDocs(d?.items?.map(docToFile) ?? []);
        }
      } catch (err) {
        if (alive.current) setLoadError({ message: errorMessage(err), at: new Date() });
      } finally {
        if (alive.current) setLoading(false);
      }
    },
    [api, leadId],
  );

  useEffect(() => {
    alive.current = true;
    void refresh();
    const t = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void refresh(true);
    }, POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [refresh]);

  const toggle = (key: string) =>
    setCollapsed((c) => {
      const next = { ...c, [key]: !c[key] };
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        // приватный режим — состояние не запоминается
      }
      return next;
    });

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await refresh(true);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <div style={{ ...s.row, justifyContent: 'space-between', height: 40, borderBottom: '1px solid #e8eaeb', flexWrap: 'nowrap' }}>
      <span style={{ ...s.row, flexWrap: 'nowrap', fontWeight: 600 }}>
        {logoUrl && <img src={logoUrl} alt="" style={{ height: 20, width: 'auto' }} />}
        AI-агент
      </span>
      <span style={{ ...s.row, flexWrap: 'nowrap', gap: 4 }}>
        <button type="button" title="Обновить" style={ghost} disabled={loading} onClick={() => void refresh()}>
          ⟳
        </button>
        {settingsUrl && (
          <a href={settingsUrl} target="_blank" rel="noreferrer" title="Настройки виджета" style={{ ...ghost, display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>
            ⚙
          </a>
        )}
      </span>
    </div>
  );

  if (!data && loadError) {
    return (
      <div style={s.root}>
        {header}
        <StatusLine dot="red" text="Ошибка" />
        <ErrorBlock text={loadError.message} at={loadError.at} onRetry={() => void refresh()} />
      </div>
    );
  }
  if (!data) {
    return (
      <div style={s.root}>
        {header}
        <Skeleton />
      </div>
    );
  }

  const p = data;
  const active = p.ai.enabled && p.ai.mode !== 'off';
  const health = p.health;
  const problem = loadError?.message ?? (health && !health.llmConfigured ? 'Ключ провайдера не задан или недействителен — задайте во вкладке «Модель»' : health?.dailyLimitExhausted ? 'Дневной лимит ₽ исчерпан — AI не отвечает до конца суток' : null);
  const dot = dotOf(Boolean(problem), active, p.ai.paused, p.files?.some((f) => f.status === 'pending') ?? false);
  const drafts = p.hints.filter((h) => h.kind === 'draft');
  const hints = p.hints.filter((h) => h.kind === 'hint');
  const files = p.files ?? docs ?? [];
  const tasks = p.tasks ?? [];
  const products = p.products;
  const calc = p.calculations[0];
  const providers = p.llm?.providers ?? [];
  const showAll = !collapsed.products_more;

  return (
    <div style={s.root}>
      {header}

      {/* Статус */}
      <div style={s.block}>
        <div style={{ ...s.row, justifyContent: 'space-between', flexWrap: 'nowrap' }}>
          <span style={{ ...s.row, flexWrap: 'nowrap' }}>
            <span style={{ width: 10, height: 10, borderRadius: 5, background: DOT_COLOR[dot], display: 'inline-block', flex: 'none', ...(dot === 'blue' ? { animation: 'ai-door-pulse 1s infinite' } : {}) }} />
            <span>
              {modeLabel(p.ai.mode)}
              {!p.ai.enabled && ' · выключен'}
              {p.ai.paused && <span style={{ ...s.badgeWarn, marginLeft: 6 }}>на паузе</span>}
            </span>
          </span>
          {active && (
            <button type="button" style={ghost} disabled={busy} onClick={() => void act(() => (p.ai.paused ? api.resume(leadId) : api.pause(leadId)))}>
              {p.ai.paused ? 'Вернуть AI' : 'Пауза'}
            </button>
          )}
        </div>
        {p.ai.paused && p.ai.pauseReason && <div style={{ ...s.muted, ...s.small }}>{pauseReasonText(p.ai.pauseReason)}</div>}
        {p.llm && (
          <div style={{ ...s.row, justifyContent: 'space-between', marginTop: 6, flexWrap: 'nowrap' }}>
            <LeadModel api={api} leadId={leadId} value={p.llm} providers={providers} busy={busy} onChange={(m) => void act(() => api.setLeadModel(leadId, m))} />
            <span style={{ ...s.small, whiteSpace: 'nowrap' }} title="Расход на LLM по этой сделке">
              {rub(p.costRub)} по сделке
            </span>
          </div>
        )}
        {actionError && <div style={s.error}>{actionError}</div>}
      </div>

      {problem && <ErrorBlock text={problem} at={loadError?.at ?? (health?.lastError ? new Date(health.lastError.createdAt) : new Date())} onRetry={() => void refresh()} />}

      {/* Черновики на одобрение — режим «Полуавто» */}
      {drafts.length > 0 && (
        <div style={{ ...s.block, ...s.col }}>
          <div style={s.label}>Черновики на одобрение ({drafts.length})</div>
          {drafts.map((h) => (
            <SuggestionCard key={h.id} api={api} item={h} onDone={() => void refresh(true)} />
          ))}
        </div>
      )}

      {/* Подсказка менеджеру — пауза или «Только подсказки» */}
      {hints.length > 0 && (
        <div style={{ ...s.block, ...s.col }}>
          <div style={s.label}>Подсказка менеджеру</div>
          {hints.map((h) => (
            <SuggestionCard key={h.id} api={api} item={h} onDone={() => void refresh(true)} />
          ))}
        </div>
      )}

      <Block id="products" title={`Найденные товары${products.length ? ` (${products.length})` : ''}`} collapsed={collapsed} onToggle={toggle}>
        {products.length === 0 ? (
          <div style={line}>Товары не подбирались</div>
        ) : (
          <div style={s.col}>
            {(showAll ? products.slice(0, 3) : products).map((pr) => (
              <div key={pr.id} style={{ ...s.row, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                {pr.picture ? <img src={pr.picture} alt="" style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 3, flex: 'none' }} /> : <span style={{ width: 40, height: 40, background: '#f0f2f4', borderRadius: 3, flex: 'none' }} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <a href={pr.url ?? '#'} target="_blank" rel="noreferrer" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {pr.title} ↗
                  </a>
                  <div style={{ ...s.small, ...s.muted }}>
                    {pr.price !== undefined && pr.price !== null ? rub(pr.price) : ''}
                    {pr.available === true ? ' · в наличии' : pr.available === false ? ' · под заказ' : ''}
                  </div>
                </div>
                <button type="button" style={ghost} onClick={() => void sendToChat(productText(pr), setActionError)}>
                  Отправить клиенту
                </button>
              </div>
            ))}
            {products.length > 3 && (
              <button type="button" style={{ ...s.tab, padding: 0, color: '#4c8bf7', textAlign: 'left' }} onClick={() => toggle('products_more')}>
                {showAll ? `Ещё ${products.length - 3}` : 'Свернуть'}
              </button>
            )}
          </div>
        )}
      </Block>

      <Block id="calc" title="Расчёт" collapsed={collapsed} onToggle={toggle}>
        {calc ? (
          <div style={s.col}>
            <Calculation c={calc} />
            <div style={s.row}>
              <button type="button" style={ghost} disabled={busy} onClick={() => void act(() => api.addLeadNote(leadId, calcText(calc)))}>
                В примечание
              </button>
              <button type="button" style={ghost} onClick={() => void sendToChat(calcText(calc), setActionError)}>
                Отправить клиенту
              </button>
            </div>
          </div>
        ) : (
          <div style={line}>Расчётов нет</div>
        )}
      </Block>

      <Block
        id="files"
        title={`Файлы клиента${files.length ? ` (${files.length})` : ''}`}
        collapsed={collapsed}
        onToggle={toggle}
        extra={
          <label style={{ ...ghost, cursor: busy ? 'progress' : 'pointer', display: 'inline-flex', alignItems: 'center' }}>
            {busy ? 'Разбираю…' : 'Загрузить'}
            <input
              type="file"
              accept={ACCEPT}
              disabled={busy}
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setDocResult(null);
                void act(async () => setDocResult(await api.analyzeDocument(leadId, { name: file.name, mime: file.type, file: await fileToBase64(file) })));
              }}
            />
          </label>
        }
      >
        {files.length === 0 ? (
          <div style={line}>Файлов в чате нет. Разобрать файл вручную: замерный лист, фото, PDF, Excel, Word, DWG/DXF — кнопка «Загрузить».</div>
        ) : (
          <div style={s.col}>
            {files.map((f) => (
              <div key={f.id} style={{ ...s.row, flexWrap: 'nowrap', alignItems: 'flex-start', ...s.small }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</b> <FileStatus f={f} />
                  {f.summary && <div style={s.muted}>{f.summary}</div>}
                  {f.openings ? <span style={s.muted}> · проёмов: {f.openings}</span> : ''}
                  {f.positions ? <span style={s.muted}> · позиций: {f.positions}</span> : ''}
                </div>
                {f.id > 0 && f.status !== 'parsed' && (
                  <button type="button" style={ghost} disabled={busy} onClick={() => void act(async () => setDocResult(await api.analyzeChatFile(leadId, f.id)))}>
                    Разобрать
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {docResult && <DocumentView r={docResult} />}
      </Block>

      {tasks.length > 0 && (
        <Block id="tasks" title={`Задачи AI (${tasks.length})`} collapsed={collapsed} onToggle={toggle}>
          <div style={s.col}>
            {tasks.map((t) => (
              <div key={t.id} style={s.small}>
                <b>{t.kind}</b> <span style={s.muted}>{dateTime(t.createdAt)}</span>
                <div>{t.text}</div>
              </div>
            ))}
          </div>
        </Block>
      )}

      <div style={s.block}>
        <div style={{ ...s.row, justifyContent: 'space-between' }}>
          <span style={s.label}>Резюме диалога</span>
          <button type="button" style={ghost} disabled={busy} onClick={() => void act(() => api.summary(leadId))}>
            {p.summary ? 'Обновить' : 'Создать резюме'}
          </button>
        </div>
        {p.summary ? (
          <div style={s.small}>
            <div style={{ whiteSpace: 'pre-wrap' }}>{clip(p.summary.text, 5)}</div>
            <div style={s.muted}>{dateTime(p.summary.createdAt)}</div>
          </div>
        ) : (
          <div style={line}>Резюме ещё не создавалось</div>
        )}
      </div>

      <div style={s.block}>
        <div style={{ ...s.row, justifyContent: 'space-between' }}>
          <span style={s.label}>Журнал AI</span>
          {settingsUrl && (
            <a href={settingsUrl} target="_blank" rel="noreferrer" style={s.small}>
              Весь журнал
            </a>
          )}
        </div>
        {p.log.length === 0 ? (
          <div style={line}>Действий AI по сделке нет</div>
        ) : (
          <div style={s.col}>
            {p.log.slice(0, 5).map((e) => (
              <div key={e.id} style={s.small}>
                <span style={s.muted}>{dateTime(e.createdAt)}</span> <b>{kindLabel(e.kind)}</b>
                {e.model && <span style={s.muted}> · {modelLabel(e.provider, e.model)}</span>}
                {e.fallbackUsed && <span style={{ ...s.badgeWarn, marginLeft: 4 }}>fallback</span>}
                <div style={{ whiteSpace: 'pre-wrap' }}>{e.summary.slice(0, 300)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Block({ id, title, collapsed, onToggle, extra, children }: { id: string; title: string; collapsed: Record<string, boolean>; onToggle: (id: string) => void; extra?: ReactNode; children: ReactNode }) {
  const closed = Boolean(collapsed[id]);
  return (
    <div style={s.block}>
      <div style={{ ...s.row, justifyContent: 'space-between', flexWrap: 'nowrap' }}>
        <button type="button" style={{ ...s.tab, padding: 0, ...s.label, marginBottom: 0, cursor: 'pointer' }} onClick={() => onToggle(id)} aria-expanded={!closed}>
          {title} {closed ? '▸' : '▾'}
        </button>
        {extra}
      </div>
      {!closed && <div style={{ marginTop: 4 }}>{children}</div>}
    </div>
  );
}

function StatusLine({ dot, text }: { dot: Dot; text: string }) {
  return (
    <div style={{ ...s.block, ...s.row }}>
      <span style={{ width: 10, height: 10, borderRadius: 5, background: DOT_COLOR[dot], display: 'inline-block' }} />
      <span>{text}</span>
    </div>
  );
}

function ErrorBlock({ text, at, onRetry }: { text: string; at: Date; onRetry: () => void }) {
  return (
    <div style={{ ...s.block, ...s.col }}>
      <div style={s.error}>{text}</div>
      <div style={s.row}>
        <span style={{ ...s.muted, ...s.small }}>{at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
        <button type="button" style={ghost} onClick={onRetry}>
          Повторить
        </button>
      </div>
    </div>
  );
}

/** Скелетоны блоков: карточка amo открывается, данные подгружаются. */
function Skeleton() {
  const bar = (w: string) => <div style={{ height: 12, width: w, background: '#eef0f2', borderRadius: 3, margin: '8px 0' }} />;
  return (
    <div aria-busy="true">
      {[80, 60, 90, 50].map((w, i) => (
        <div key={i} style={s.block}>
          {bar(`${w}%`)}
          {bar(`${w - 30}%`)}
        </div>
      ))}
    </div>
  );
}

function FileStatus({ f }: { f: LeadFile }) {
  if (f.status === 'parsed') return <span style={s.badgeOk}>✓ разобран{f.kind ? `: ${DOC_KIND[f.kind] ?? f.kind}` : ''}</span>;
  if (f.status === 'error') return <span style={s.badgeBad}>ошибка разбора</span>;
  if (f.status === 'pending') return <span style={s.badgeWarn}>в обработке</span>;
  return <span style={s.muted}>не разобран</span>;
}

/** «Провайдер · модель» с выпадающим списком — переопределение для этой сделки (раздел 3 ТЗ). */
function LeadModel({ api, leadId: _leadId, value, providers, busy, onChange }: { api: WidgetApi; leadId: number; value: NonNullable<Panel['llm']>; providers: Panel['llm'] extends infer T ? (T extends { providers: infer P } ? P : never) : never; busy: boolean; onChange: (m: ModelRef | null) => void }) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <button type="button" style={{ ...s.tab, padding: 0, textAlign: 'left', ...s.small }} title="Сменить модель для этой сделки" disabled={busy} onClick={() => setEditing(true)}>
        {modelLabel(value.provider, value.model)} ▾{value.override && <span style={{ ...s.badgeWarn, marginLeft: 4 }}>для сделки</span>}
      </button>
    );
  }
  return (
    <span style={{ ...s.row, flexWrap: 'nowrap' }}>
      <ModelPicker
        api={api}
        value={{ provider: value.provider, model: value.model }}
        providers={providers}
        allowNone
        noneLabel="По настройкам"
        style={{ height: 28, fontSize: 12, maxWidth: 200 }}
        onChange={(m) => {
          setEditing(false);
          onChange(m);
        }}
      />
      <button type="button" style={ghost} onClick={() => setEditing(false)}>
        ✕
      </button>
    </span>
  );
}

/** Цвет индикатора (раздел 11.4): красный — ошибка, серый — выключен, жёлтый — пауза, синий — AI готовит ответ, зелёный — активен. */
function dotOf(problem: boolean, active: boolean, paused: boolean, working: boolean): Dot {
  if (problem) return 'red';
  if (!active) return 'gray';
  if (paused) return 'yellow';
  return working ? 'blue' : 'green';
}

function pauseReasonText(r: string): string {
  if (r === 'manager_message') return 'Менеджер написал клиенту';
  if (r === 'status_without_ai') return 'Этап сделки без AI';
  if (r.startsWith('manual:')) return 'Поставлен на паузу вручную';
  if (r.startsWith('handoff:')) return 'Диалог передан менеджеру';
  return r;
}

const clip = (text: string, lines: number) => {
  const parts = text.split('\n').filter((x) => x.trim());
  return parts.length > lines ? `${parts.slice(0, lines).join('\n')}\n…` : text;
};

const productText = (pr: Panel['products'][number]) =>
  [pr.title, pr.price !== undefined && pr.price !== null ? rub(pr.price) : '', pr.available === true ? 'в наличии' : '', pr.url ?? ''].filter(Boolean).join(' — ');

function calcText(c: Panel['calculations'][number]): string {
  const lines = c.lines.map((l, i) => `${i + 1}. ${l.name} — ${l.qty} ${l.unit} × ${l.price === null ? 'цена у менеджера' : rub(l.price)}${l.total === null ? '' : ` = ${rub(l.total)}`}`);
  return ['Расчёт:', ...lines, `Итого: ${rub(c.total)}${c.complete ? '' : ' (без позиций, цену которых уточнит менеджер)'}`].join('\n');
}

async function sendToChat(text: string, onError: (m: string | null) => void) {
  const r = await insertIntoChat(text);
  onError(r === 'failed' ? 'Не удалось вставить в чат — скопируйте текст вручную.' : r === 'copied' ? 'Скопировано в буфер обмена — вставьте в чат.' : null);
}

const docToFile = (d: { id: number; filename: string | null; kind: string; summary: string; openings: number; positions: number; createdAt: string }): LeadFile => ({
  id: -d.id,
  name: d.filename ?? 'файл',
  type: null,
  url: '',
  receivedAt: d.createdAt,
  status: 'parsed',
  documentId: d.id,
  kind: d.kind,
  summary: d.summary,
  openings: d.openings,
  positions: d.positions,
});
