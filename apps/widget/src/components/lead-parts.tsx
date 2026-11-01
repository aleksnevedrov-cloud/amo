import { useState, type ReactNode } from 'react';
import type { DocumentResult, LeadFile, LeadPanel as Panel, ModelRef, WidgetApi } from '../api.ts';
import { fileToBase64, insertIntoChat } from '../chat.ts';
import { Calculation } from './Calculation.tsx';
import { DOC_KIND, DocumentView } from './Documents.tsx';
import { ModelPicker } from './ModelSettings.tsx';
import { dateTime, kindLabel, modelLabel, rub } from './StatusBadge.tsx';

// Общие части узкой колонки и большого окна виджета «Агент розница» (RETAIL-WIDGET-WINDOW).

export const ACCEPT = '.pdf,.xlsx,.xlsm,.docx,.jpg,.jpeg,.png,.webp,.txt,.csv,.dwg,.dxf';

export type Dot = 'green' | 'yellow' | 'gray' | 'red' | 'blue';
export const DOT_COLOR: Record<Dot, string> = { green: '#61c100', yellow: '#e2a400', gray: '#a5abb0', red: '#d0342c', blue: '#087bbe' };

/** Цвет индикатора (раздел 11.4): красный — ошибка, серый — выключен, жёлтый — пауза, синий — AI готовит ответ, зелёный — активен. */
export function dotOf(problem: boolean, active: boolean, paused: boolean, working: boolean): Dot {
  if (problem) return 'red';
  if (!active) return 'gray';
  if (paused) return 'yellow';
  return working ? 'blue' : 'green';
}

export function pauseReasonText(r: string): string {
  if (r === 'manager_message') return 'Менеджер написал клиенту';
  if (r === 'status_without_ai') return 'Этап сделки без AI';
  if (r.startsWith('manual:')) return 'Поставлен на паузу вручную';
  if (r.startsWith('handoff:')) return 'Диалог передан менеджеру';
  return r;
}

/** Состояние панели, общее для колонки и окна: проблема, индикатор, активность. */
export function panelState(p: Panel, loadError: string | null) {
  const active = p.ai.enabled && p.ai.mode !== 'off';
  const health = p.health;
  const problem = loadError ?? (health && !health.llmConfigured ? 'Ключ провайдера не задан или недействителен — задайте во вкладке «Модель»' : health?.dailyLimitExhausted ? 'Дневной лимит ₽ исчерпан — AI не отвечает до конца суток' : null);
  const dot = dotOf(Boolean(problem), active, p.ai.paused, p.files?.some((f) => f.status === 'pending') ?? false);
  return { active, problem, dot };
}

export function ModeDot({ dot }: { dot: Dot }) {
  return <span className="ai-door-dot" style={{ background: DOT_COLOR[dot], ...(dot === 'blue' ? { animation: 'ai-door-pulse 1s infinite' } : {}) }} />;
}

export function ErrorBlock({ text, at, onRetry }: { text: string; at: Date; onRetry: () => void }) {
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
export function Skeleton() {
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

export function FileStatus({ f }: { f: LeadFile }) {
  if (f.status === 'parsed') return <span className="ai-door-badge ai-door-badge-ok">✓ разобран{f.kind ? `: ${DOC_KIND[f.kind] ?? f.kind}` : ''}</span>;
  if (f.status === 'error') return <span className="ai-door-badge ai-door-badge-bad">ошибка разбора</span>;
  if (f.status === 'pending') return <span className="ai-door-badge ai-door-badge-warn">в обработке</span>;
  return <span className="ai-door-muted">не разобран</span>;
}

type Providers = NonNullable<Panel['llm']>['providers'];

/** «Провайдер · модель» с выпадающим списком — переопределение для этой сделки (раздел 3 ТЗ). */
export function LeadModel({ api, value, providers, busy, onChange }: { api: WidgetApi; value: NonNullable<Panel['llm']>; providers: Providers; busy: boolean; onChange: (m: ModelRef | null) => void }) {
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

export const clip = (text: string, lines: number) => {
  const parts = text.split('\n').filter((x) => x.trim());
  return parts.length > lines ? `${parts.slice(0, lines).join('\n')}\n…` : text;
};

export const productText = (pr: Panel['products'][number]) =>
  [pr.title, pr.price !== undefined && pr.price !== null ? rub(pr.price) : '', pr.available === true ? 'в наличии' : '', pr.url ?? ''].filter(Boolean).join(' — ');

export function calcText(c: Panel['calculations'][number]): string {
  const lines = c.lines.map((l, i) => `${i + 1}. ${l.name} — ${l.qty} ${l.unit} × ${l.price === null ? 'цена у менеджера' : rub(l.price)}${l.total === null ? '' : ` = ${rub(l.total)}`}`);
  return ['Расчёт:', ...lines, `Итого: ${rub(c.total)}${c.complete ? '' : ' (без позиций, цену которых уточнит менеджер)'}`].join('\n');
}

export async function sendToChat(text: string, onError: (m: string | null) => void) {
  const r = await insertIntoChat(text);
  onError(r === 'failed' ? 'Не удалось вставить в чат — скопируйте текст вручную.' : r === 'copied' ? 'Скопировано в буфер обмена — вставьте в чат.' : null);
}

export const docToFile = (d: { id: number; filename: string | null; kind: string; summary: string; openings: number; positions: number; createdAt: string }): LeadFile => ({
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

/** Карточка-раздел с заголовком и кнопкой справа. */
export function Card({ title, extra, children }: { title: ReactNode; extra?: ReactNode; children: ReactNode }) {
  return (
    <div className="ai-door-card">
      <div className="ai-door-row ai-door-row-tight">
        <span className="ai-door-sect" style={{ cursor: 'default' }}>
          {title}
        </span>
        {extra}
      </div>
      <div style={{ marginTop: 8 }}>{children}</div>
    </div>
  );
}

/** Найденные товары: название, id, наличие, цена, ссылка; limit — сколько показать. */
export function ProductList({ products, limit, onSend, wide }: { products: Panel['products']; limit?: number; onSend: (pr: Panel['products'][number]) => void; wide?: boolean }) {
  if (products.length === 0) return <div className="ai-door-empty">Товары не подбирались</div>;
  return (
    <div className="ai-door-col">
      {(limit ? products.slice(0, limit) : products).map((pr) => (
        <div key={pr.id} className="ai-door-product">
          {pr.picture ? <img src={pr.picture} alt="" /> : <span className="ai-door-thumb" />}
          <div className="ai-door-grow">
            <a href={pr.url ?? '#'} target="_blank" rel="noreferrer">
              {pr.title} ↗
            </a>
            <div className="ai-door-muted">
              {wide && <>id {pr.id} · </>}
              {pr.price !== undefined && pr.price !== null ? rub(pr.price) : wide ? 'цена не указана' : ''}
              {pr.available === true ? ' · в наличии' : pr.available === false ? ' · под заказ' : ''}
            </div>
            <button type="button" className="ai-door-btn ai-door-btn-green" style={{ marginTop: 4 }} onClick={() => onSend(pr)}>
              Отправить клиенту
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function CalcBlock({ calc, busy, onNote, onSend }: { calc: Panel['calculations'][number] | undefined; busy: boolean; onNote: (text: string) => void; onSend: (text: string) => void }) {
  if (!calc) return <div className="ai-door-empty">Расчётов нет</div>;
  return (
    <div className="ai-door-col">
      <Calculation c={calc} />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" className="ai-door-btn" disabled={busy} onClick={() => onNote(calcText(calc))}>
          В примечание
        </button>
        <button type="button" className="ai-door-btn ai-door-btn-green" onClick={() => onSend(calcText(calc))}>
          Отправить клиенту
        </button>
      </div>
    </div>
  );
}

/** Файлы клиента: список с «Разобрать», загрузка своего файла, результат разбора. */
export function FilesBlock({ api, leadId, files, busy, act }: { api: WidgetApi; leadId: number; files: LeadFile[]; busy: boolean; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [docResult, setDocResult] = useState<DocumentResult | null>(null);
  return (
    <div className="ai-door-col">
      <div>
        <label className="ai-door-btn ai-door-btn-green" style={{ cursor: busy ? 'progress' : 'pointer' }}>
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
      </div>
      {files.length === 0 ? (
        <div className="ai-door-empty">Файлов в чате нет. Разобрать файл вручную: замерный лист, фото, PDF, Excel, Word, DWG/DXF — кнопка «Загрузить».</div>
      ) : (
        files.map((f) => (
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
        ))
      )}
      {docResult && <DocumentView r={docResult} />}
    </div>
  );
}

export function TaskList({ tasks, limit }: { tasks: NonNullable<Panel['tasks']>; limit?: number }) {
  if (tasks.length === 0) return <div className="ai-door-empty">Задач AI по сделке нет</div>;
  const shown = limit ? tasks.slice(0, limit) : tasks;
  return (
    <div className="ai-door-col">
      {shown.map((t) => (
        <div key={t.id}>
          <b>{t.kind}</b> <span className="ai-door-muted">{dateTime(t.createdAt)}</span>
          <div className="ai-door-pre">{limit ? clip(t.text, 3) : t.text}</div>
        </div>
      ))}
      {limit && tasks.length > limit && <div className="ai-door-muted">…ещё {tasks.length - limit}</div>}
    </div>
  );
}

export function JournalList({ log }: { log: Panel['log'] }) {
  if (log.length === 0) return <div className="ai-door-empty">Действий AI по сделке нет</div>;
  return (
    <div className="ai-door-col">
      {log.map((e) => (
        <div key={e.id}>
          <span className="ai-door-muted">{dateTime(e.createdAt)}</span> <b>{kindLabel(e.kind)}</b>
          {e.model && <span className="ai-door-muted"> · {modelLabel(e.provider, e.model)}</span>}
          {e.fallbackUsed && <span className="ai-door-badge ai-door-badge-warn" style={{ marginLeft: 4 }}>fallback</span>}
          <div className="ai-door-pre">{e.summary.slice(0, 600)}</div>
        </div>
      ))}
    </div>
  );
}
