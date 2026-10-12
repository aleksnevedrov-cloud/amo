import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { DocumentResult, LeadFile, LeadPanel as Panel, ModelRef, WidgetApi } from '../api.ts';
import { fileToBase64, insertIntoChat } from '../chat.ts';
import { Calculation } from './Calculation.tsx';
import { DOC_KIND, DocumentView } from './Documents.tsx';
import { ModelPicker } from './ModelSettings.tsx';
import { dateTime, kindLabel, modeLabel, modelLabel, rub } from './StatusBadge.tsx';
import { SuggestionCard } from './Suggestions.tsx';
import { errorMessage } from './useLoad.ts';

/** Как часто панель перечитывает данные, пока карточка открыта (новые сообщения, действия AI). */
const POLL_MS = 20_000;
const COLLAPSE_KEY = 'ai-door-panel-collapsed';
const ACCEPT = '.pdf,.xlsx,.xlsm,.docx,.jpg,.jpeg,.png,.webp,.txt,.csv,.dwg,.dxf';

type Dot = 'green' | 'yellow' | 'gray' | 'red' | 'blue';
const DOT_COLOR: Record<Dot, string> = { green: '#61c100', yellow: '#e2a400', gray: '#a5abb0', red: '#d0342c', blue: '#087bbe' };

function readCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

/**
 * Панель в правой колонке карточки сделки (раздел 11 ТЗ 1.1.0): шапка с логотипом, карточка статуса
 * с моделью и расходом, ошибка, черновики, подсказки, товары, расчёт, файлы клиента, задачи AI,
 * резюме, журнал. Оформление — по макету Figma «Виджет AI РФ Двери», классы .ai-door-* из styles.css.
 */
export function LeadPanel({ api, leadId, assetsUrl, settingsUrl }: { api: WidgetApi; leadId: number; assetsUrl?: string; settingsUrl?: string }) {
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

  // Логотип РФ-Двери рисует сама шапка виджета amo (.ai-door-caption) — внутри панели он не дублируется.
  const head = (
    <div className="ai-door-row ai-door-row-tight">
      <span className="ai-door-title">
        {assetsUrl && <img src={`${assetsUrl}/logo_min.png`} alt="" />}
        AI-агент
      </span>
      <span style={{ display: 'flex', gap: 6, flex: 'none' }}>
        <button type="button" className="ai-door-btn ai-door-icon" title="Обновить" disabled={loading} onClick={() => void refresh()}>
          ⟳
        </button>
        {settingsUrl && (
          <a href={settingsUrl} target="_blank" rel="noreferrer" className="ai-door-btn ai-door-icon" title="Настройки виджета">
            ⚙
          </a>
        )}
      </span>
    </div>
  );

  if (!data && loadError) {
    return (
      <div className="ai-door-root">
          <div className="ai-door-card">
          {head}
          <div className="ai-door-divider" />
          <div className="ai-door-mode">
            <span className="ai-door-dot" style={{ background: DOT_COLOR.red }} />
            <span>Ошибка</span>
          </div>
        </div>
        <ErrorBlock text={loadError.message} at={loadError.at} onRetry={() => void refresh()} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="ai-door-root">
          <div className="ai-door-card">{head}</div>
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
    <div className="ai-door-root">

      {/* Карточка статуса: заголовок, режим, модель и расход по сделке */}
      <div className="ai-door-card">
        {head}
        <div className="ai-door-divider" />
        <div className="ai-door-row ai-door-row-tight ai-door-row-top">
          <span className="ai-door-mode">
            <span className="ai-door-dot" style={{ background: DOT_COLOR[dot], ...(dot === 'blue' ? { animation: 'ai-door-pulse 1s infinite' } : {}) }} />
            <span>
              {modeLabel(p.ai.mode)}
              {!p.ai.enabled && ' · выключен'}
              {p.ai.paused && <span className="ai-door-badge ai-door-badge-warn" style={{ marginLeft: 6 }}>на паузе</span>}
            </span>
          </span>
          {active && (
            <button type="button" className="ai-door-btn" disabled={busy} onClick={() => void act(() => (p.ai.paused ? api.resume(leadId) : api.pause(leadId)))}>
              {p.ai.paused ? 'Вернуть AI' : 'Пауза'}
            </button>
          )}
        </div>
        {p.ai.paused && p.ai.pauseReason && <div className="ai-door-muted" style={{ marginTop: 4 }}>{pauseReasonText(p.ai.pauseReason)}</div>}
        {/* Модель и расход по сделке — только администратору. Старый бэкенд поля isAdmin не отдаёт:
            тогда строка показывается как раньше, иначе она пропадала бы и у администратора. */}
        {p.llm && p.isAdmin !== false && (
          <div className="ai-door-row ai-door-row-tight" style={{ marginTop: 8 }}>
            <LeadModel api={api} leadId={leadId} value={p.llm} providers={providers} busy={busy} onChange={(m) => void act(() => api.setLeadModel(leadId, m))} />
            <span className="ai-door-meta" style={{ whiteSpace: 'nowrap', flex: 'none' }} title="Расход на LLM по этой сделке">
              {rub(p.costRub)} по сделке
            </span>
          </div>
        )}
        {actionError && <div className="ai-door-error" style={{ marginTop: 6 }}>{actionError}</div>}
      </div>

      {problem && <ErrorBlock text={problem} at={loadError?.at ?? (health?.lastError ? new Date(health.lastError.createdAt) : new Date())} onRetry={() => void refresh()} />}

      {/* Черновики на одобрение — режим «Полуавто» */}
      {drafts.length > 0 && (
        <div className="ai-door-card">
          <div className="ai-door-sect" style={{ marginBottom: 8 }}>Черновики на одобрение ({drafts.length})</div>
          <div className="ai-door-col">
            {drafts.map((h) => (
              <SuggestionCard key={h.id} api={api} item={h} onDone={() => void refresh(true)} />
            ))}
          </div>
        </div>
      )}

      {/* Подсказка менеджеру — пауза или «Только подсказки» */}
      {hints.length > 0 && (
        <div className="ai-door-card">
          <div className="ai-door-sect" style={{ marginBottom: 8 }}>Подсказка менеджеру</div>
          <div className="ai-door-col">
            {hints.map((h) => (
              <SuggestionCard key={h.id} api={api} item={h} onDone={() => void refresh(true)} />
            ))}
          </div>
        </div>
      )}

      <Block id="products" title={`Найденные товары${products.length ? ` (${products.length})` : ''}`} collapsed={collapsed} onToggle={toggle}>
        {products.length === 0 ? (
          <div className="ai-door-empty">Товары не подбирались</div>
        ) : (
          <div className="ai-door-col">
            {(showAll ? products.slice(0, 3) : products).map((pr) => (
              <div key={pr.id} className="ai-door-product">
                {pr.picture ? <img src={pr.picture} alt="" /> : <span className="ai-door-thumb" />}
                <div className="ai-door-grow">
                  <a href={pr.url ?? '#'} target="_blank" rel="noreferrer">
                    {pr.title} ↗
                  </a>
                  <div className="ai-door-muted">
                    {pr.price !== undefined && pr.price !== null ? rub(pr.price) : ''}
                    {pr.available === true ? ' · в наличии' : pr.available === false ? ' · под заказ' : ''}
                  </div>
                  <button type="button" className="ai-door-btn ai-door-btn-green" style={{ marginTop: 4 }} onClick={() => void sendToChat(productText(pr), setActionError)}>
                    Отправить клиенту
                  </button>
                </div>
              </div>
            ))}
            {products.length > 3 && (
              <button type="button" className="ai-door-link" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }} onClick={() => toggle('products_more')}>
                {showAll ? `Ещё ${products.length - 3}` : 'Свернуть'}
              </button>
            )}
          </div>
        )}
      </Block>

      <Block id="calc" title="Расчёт" collapsed={collapsed} onToggle={toggle}>
        {calc ? (
          <div className="ai-door-col">
            <Calculation c={calc} />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button type="button" className="ai-door-btn" disabled={busy} onClick={() => void act(() => api.addLeadNote(leadId, calcText(calc)))}>
                В примечание
              </button>
              <button type="button" className="ai-door-btn ai-door-btn-green" onClick={() => void sendToChat(calcText(calc), setActionError)}>
                Отправить клиенту
              </button>
            </div>
          </div>
        ) : (
          <div className="ai-door-empty">Расчётов нет</div>
        )}
      </Block>

      <Block
        id="files"
        title={`Файлы клиента${files.length ? ` (${files.length})` : ''}`}
        collapsed={collapsed}
        onToggle={toggle}
        extra={
          <label className="ai-door-btn ai-door-btn-green" style={{ cursor: busy ? 'progress' : 'pointer', flex: 'none' }}>
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
          <div className="ai-door-empty">Файлов в чате нет. Разобрать файл вручную: замерный лист, фото, PDF, Excel, Word, DWG/DXF — кнопка «Загрузить».</div>
        ) : (
          <div className="ai-door-col">
            {files.map((f) => (
              <div key={f.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <div className="ai-door-grow">
                  <b style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</b> <FileStatus f={f} />
                  {f.summary && <div className="ai-door-muted">{f.summary}</div>}
                  {f.openings ? <span className="ai-door-muted"> · проёмов: {f.openings}</span> : ''}
                  {f.positions ? <span className="ai-door-muted"> · позиций: {f.positions}</span> : ''}
                </div>
                {f.id > 0 && f.status !== 'parsed' && (
                  <button type="button" className="ai-door-btn" disabled={busy} onClick={() => void act(async () => setDocResult(await api.analyzeChatFile(leadId, f.id)))}>
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
          <div className="ai-door-col">
            {tasks.map((t) => (
              <div key={t.id}>
                <b>{t.kind}</b> <span className="ai-door-muted">{dateTime(t.createdAt)}</span>
                <div>{t.text}</div>
              </div>
            ))}
          </div>
        </Block>
      )}

      <div className="ai-door-card">
        <div className="ai-door-row ai-door-row-tight">
          <span className="ai-door-sect">Резюме диалога</span>
          <button type="button" className="ai-door-btn ai-door-btn-green" disabled={busy} onClick={() => void act(() => api.summary(leadId))}>
            {p.summary ? 'Обновить' : 'Создать резюме'}
          </button>
        </div>
        <div style={{ marginTop: 8 }}>
          {p.summary ? (
            <>
              <div className="ai-door-pre">{clip(p.summary.text, 5)}</div>
              <div className="ai-door-muted">{dateTime(p.summary.createdAt)}</div>
            </>
          ) : (
            <div className="ai-door-empty">Резюме ещё не создавалось</div>
          )}
        </div>
      </div>

      <div className="ai-door-card">
        <div className="ai-door-row ai-door-row-tight">
          <span className="ai-door-sect">Журнал AI</span>
          {settingsUrl && (
            <a href={settingsUrl} target="_blank" rel="noreferrer" className="ai-door-link">
              Весь журнал
            </a>
          )}
        </div>
        <div style={{ marginTop: 8 }}>
          {p.log.length === 0 ? (
            <div className="ai-door-empty">Действий AI по сделке нет</div>
          ) : (
            <div className="ai-door-col">
              {p.log.slice(0, 5).map((e) => (
                <div key={e.id}>
                  <span className="ai-door-muted">{dateTime(e.createdAt)}</span> <b>{kindLabel(e.kind)}</b>
                  {e.model && <span className="ai-door-muted"> · {modelLabel(e.provider, e.model)}</span>}
                  {e.fallbackUsed && <span className="ai-door-badge ai-door-badge-warn" style={{ marginLeft: 4 }}>fallback</span>}
                  <div className="ai-door-pre">{e.summary.slice(0, 300)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Block({ id, title, collapsed, onToggle, extra, children }: { id: string; title: string; collapsed: Record<string, boolean>; onToggle: (id: string) => void; extra?: ReactNode; children: ReactNode }) {
  const closed = Boolean(collapsed[id]);
  return (
    <div className="ai-door-card">
      <div className="ai-door-row ai-door-row-tight">
        <button type="button" className="ai-door-sect" onClick={() => onToggle(id)} aria-expanded={!closed}>
          {title} {closed ? '▸' : '▾'}
        </button>
        {extra}
      </div>
      {!closed && <div style={{ marginTop: 8 }}>{children}</div>}
    </div>
  );
}

function ErrorBlock({ text, at, onRetry }: { text: string; at: Date; onRetry: () => void }) {
  return (
    <div className="ai-door-card">
      <div className="ai-door-error">{text}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
        <span className="ai-door-muted">{at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
        <button type="button" className="ai-door-btn" onClick={onRetry}>
          Повторить
        </button>
      </div>
    </div>
  );
}

/** Скелетоны блоков: карточка amo открывается, данные подгружаются. */
function Skeleton() {
  const bar = (w: string) => <div className="ai-door-skel" style={{ width: w }} />;
  return (
    <div aria-busy="true">
      {[80, 60, 90, 50].map((w, i) => (
        <div className="ai-door-card" key={i}>
          {bar(`${w}%`)}
          {bar(`${w - 30}%`)}
        </div>
      ))}
    </div>
  );
}

function FileStatus({ f }: { f: LeadFile }) {
  if (f.status === 'parsed') return <span className="ai-door-badge ai-door-badge-ok">✓ разобран{f.kind ? `: ${DOC_KIND[f.kind] ?? f.kind}` : ''}</span>;
  if (f.status === 'error') return <span className="ai-door-badge ai-door-badge-bad">ошибка разбора</span>;
  if (f.status === 'pending') return <span className="ai-door-badge ai-door-badge-warn">в обработке</span>;
  return <span className="ai-door-muted">не разобран</span>;
}

/** «Провайдер · модель» с выпадающим списком — переопределение для этой сделки (раздел 3 ТЗ). */
function LeadModel({ api, leadId: _leadId, value, providers, busy, onChange }: { api: WidgetApi; leadId: number; value: NonNullable<Panel['llm']>; providers: Panel['llm'] extends infer T ? (T extends { providers: infer P } ? P : never) : never; busy: boolean; onChange: (m: ModelRef | null) => void }) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <button type="button" className="ai-door-model" title="Сменить модель для этой сделки" disabled={busy} onClick={() => setEditing(true)}>
        <span>{modelLabel(value.provider, value.model)}</span>
        {value.override && <span className="ai-door-badge ai-door-badge-warn">для сделки</span>}{' '}
        <span aria-hidden="true">▾</span>
      </button>
    );
  }
  return (
    <span style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
      <ModelPicker
        api={api}
        value={{ provider: value.provider, model: value.model }}
        providers={providers}
        allowNone
        noneLabel="По настройкам"
        style={{ height: 28, fontSize: 12, maxWidth: 180 }}
        onChange={(m) => {
          setEditing(false);
          onChange(m);
        }}
      />
      <button type="button" className="ai-door-btn ai-door-icon" onClick={() => setEditing(false)}>
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
