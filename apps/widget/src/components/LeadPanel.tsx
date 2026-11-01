import { useCallback, useEffect, useRef, useState } from 'react';
import type { LeadFile, LeadPanel as Panel, WidgetApi } from '../api.ts';
import { docToFile, ErrorBlock, LeadModel, ModeDot, panelState, pauseReasonText, Skeleton } from './lead-parts.tsx';
import { LeadWindow, type WindowTab } from './LeadWindow.tsx';
import { modeLabel, rub } from './StatusBadge.tsx';
import { errorMessage } from './useLoad.ts';

/** Как часто панель перечитывает данные, пока карточка открыта (новые сообщения, действия AI). */
const POLL_MS = 20_000;

/**
 * Узкая колонка в правой части карточки сделки (RETAIL-WIDGET-WINDOW, п. 1): режим агента, модель и расход,
 * счётчики «Задач AI · Файлов · Товаров», «Пауза» / «Возврат AI» и «Развернуть ⤢». Всё остальное — в большом окне
 * (LeadWindow): диалог, товары и расчёт, файлы, задачи, журнал. Данные грузит колонка, окно получает их готовыми.
 */
export function LeadPanel({ api, leadId, assetsUrl, settingsUrl }: { api: WidgetApi; leadId: number; assetsUrl?: string; settingsUrl?: string }) {
  const [data, setData] = useState<Panel | null>(null);
  const [loadError, setLoadError] = useState<{ message: string; at: Date } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [docs, setDocs] = useState<LeadFile[] | null>(null);
  const [open, setOpen] = useState<WindowTab | null>(null);
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
            <ModeDot dot="red" />
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
  const { active, problem, dot } = panelState(p, loadError?.message ?? null);
  const files = p.files ?? docs ?? [];
  const tasks = p.tasks ?? [];
  const drafts = p.hints.filter((h) => h.kind === 'draft' && h.status === 'pending');

  return (
    <div className="ai-door-root">
      <div className="ai-door-card">
        {head}
        <div className="ai-door-divider" />
        <div className="ai-door-mode">
          <ModeDot dot={dot} />
          <span>
            {modeLabel(p.ai.mode)}
            {!p.ai.enabled && ' · выключен'}
            {p.ai.paused && <span className="ai-door-badge ai-door-badge-warn" style={{ marginLeft: 6 }}>на паузе</span>}
          </span>
        </div>
        {p.ai.paused && p.ai.pauseReason && <div className="ai-door-muted" style={{ marginTop: 4 }}>{pauseReasonText(p.ai.pauseReason)}</div>}
        {/* Модель и расход по сделке — только администратору. Старый бэкенд поля isAdmin не отдаёт:
            тогда строка показывается как раньше, иначе она пропадала бы и у администратора. */}
        {p.llm && p.isAdmin !== false && (
          <div className="ai-door-row ai-door-row-tight" style={{ marginTop: 8 }}>
            <LeadModel api={api} value={p.llm} providers={p.llm.providers ?? []} busy={busy} onChange={(m) => void act(() => api.setLeadModel(leadId, m))} />
            <span className="ai-door-meta" style={{ whiteSpace: 'nowrap', flex: 'none' }} title="Расход на LLM по этой сделке">
              {rub(p.costRub)} по сделке
            </span>
          </div>
        )}
        <div className="ai-door-muted ai-door-counters" style={{ marginTop: 8 }}>
          Задач AI {tasks.length} · Файлов {files.length} · Товаров {p.products.length}
        </div>
        {drafts.length > 0 && (
          <button type="button" className="ai-door-link ai-door-plain" style={{ marginTop: 6 }} onClick={() => setOpen('dialog')}>
            Черновик на одобрение ({drafts.length}) →
          </button>
        )}
        <div className="ai-door-actions" style={{ marginTop: 10 }}>
          {active && (
            <button type="button" className="ai-door-btn" disabled={busy} onClick={() => void act(() => (p.ai.paused ? api.resume(leadId) : api.pause(leadId)))}>
              {p.ai.paused ? 'Возврат AI' : 'Пауза'}
            </button>
          )}
          <button type="button" className="ai-door-btn ai-door-btn-green" onClick={() => setOpen('dialog')}>
            Развернуть ⤢
          </button>
        </div>
        {actionError && <div className="ai-door-error" style={{ marginTop: 6 }}>{actionError}</div>}
      </div>

      {problem && <ErrorBlock text={problem} at={loadError?.at ?? (p.health?.lastError ? new Date(p.health.lastError.createdAt) : new Date())} onRetry={() => void refresh()} />}

      {open && (
        <LeadWindow
          api={api}
          leadId={leadId}
          panel={p}
          files={files}
          problem={problem}
          busy={busy}
          loading={loading}
          actionError={actionError}
          initialTab={open}
          settingsUrl={settingsUrl}
          act={act}
          refresh={() => refresh()}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
