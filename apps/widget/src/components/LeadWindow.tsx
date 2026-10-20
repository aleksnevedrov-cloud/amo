import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LeadFile, LeadPanel as Panel, Mode, WidgetApi } from '../api.ts';
import { DialogTab } from './DialogTab.tsx';
import { CalcBlock, Card, clip, FilesBlock, JournalList, LeadModel, ModeDot, panelState, pauseReasonText, productText, ProductList, sendToChat, TaskList } from './lead-parts.tsx';
import { dateTime, modeLabel, rub } from './StatusBadge.tsx';

export type WindowTab = 'dialog' | 'products' | 'files' | 'tasks' | 'journal';

/** Режимы в выпадающем списке окна; «Только подсказки» — если он уже выбран в настройках. */
const MODES: Mode[] = ['auto', 'semi', 'off'];

/**
 * Большое окно «Агент розница · сделка N» (RETAIL-WIDGET-WINDOW, п. 2): модальное окно 88 % поверх карточки amo,
 * шапка с режимом, моделью, расходом и действиями, вкладки слева и правая панель 360 px. Esc и ✕ закрывают окно.
 */
export function LeadWindow(props: {
  api: WidgetApi;
  leadId: number;
  panel: Panel;
  files: LeadFile[];
  problem: string | null;
  busy: boolean;
  loading: boolean;
  actionError: string | null;
  initialTab: WindowTab;
  settingsUrl?: string;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  refresh: () => void;
  onClose: () => void;
}) {
  const { api, leadId, panel: p, files, busy, act, onClose } = props;
  const [tab, setTab] = useState<WindowTab>(props.initialTab);
  const [note, setNote] = useState<string | null>(null);
  const { active, dot } = panelState(p, props.problem);
  const tasks = p.tasks ?? [];
  const calc = p.calculations[0];
  const admin = p.isAdmin === true;

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  const tabs: [WindowTab, string][] = [
    ['dialog', 'Диалог'],
    ['products', 'Товары и расчёт'],
    ['files', `Файлы клиента (${files.length})`],
    ['tasks', `Задачи AI (${tasks.length})`],
    ['journal', 'Журнал'],
  ];
  const toChat = (text: string) => void sendToChat(text, setNote);

  return createPortal(
    <div className="ai-door-root ai-door-overlay">
      <div className="ai-door-modal" role="dialog" aria-modal="true" aria-label={`Агент розница · сделка ${leadId}`}>
        <div className="ai-door-modal-head">
          <span className="ai-door-modal-title">Агент розница · сделка {leadId}</span>
          <span className="ai-door-mode" style={{ alignItems: 'center' }}>
            <ModeDot dot={dot} />
            {admin ? (
              <select className="ai-door-select" aria-label="Режим агента" value={p.ai.mode} disabled={busy} onChange={(e) => void act(() => api.setMode(e.target.value as Mode))}>
                {(MODES.includes(p.ai.mode) ? MODES : [...MODES, p.ai.mode]).map((m) => (
                  <option key={m} value={m}>
                    {modeLabel(m)}
                  </option>
                ))}
              </select>
            ) : (
              <span>{modeLabel(p.ai.mode)}</span>
            )}
            {p.ai.paused && <span className="ai-door-badge ai-door-badge-warn">на паузе{p.ai.pauseReason ? `: ${pauseReasonText(p.ai.pauseReason).toLowerCase()}` : ''}</span>}
          </span>
          {p.llm && p.isAdmin !== false && (
            <>
              <LeadModel api={api} value={p.llm} providers={p.llm.providers ?? []} busy={busy} onChange={(m) => void act(() => api.setLeadModel(leadId, m))} />
              <span className="ai-door-meta" title="Расход на LLM по этой сделке">{rub(p.costRub)} по сделке</span>
            </>
          )}
          <span className="ai-door-meta">Задач AI {tasks.length}</span>
          <span className="ai-door-modal-actions">
            {active && (
              <button type="button" className="ai-door-btn" disabled={busy} onClick={() => void act(() => (p.ai.paused ? api.resume(leadId) : api.pause(leadId)))}>
                {p.ai.paused ? 'Возврат AI' : 'Пауза'}
              </button>
            )}
            <button type="button" className="ai-door-btn ai-door-icon" title="Обновить" disabled={props.loading} onClick={props.refresh}>
              ⟳
            </button>
            {props.settingsUrl && (
              <a href={props.settingsUrl} target="_blank" rel="noreferrer" className="ai-door-btn ai-door-icon" title="Настройки виджета">
                ⚙
              </a>
            )}
            <button type="button" className="ai-door-btn ai-door-icon" title="Закрыть (Esc)" aria-label="Закрыть" onClick={onClose}>
              ✕
            </button>
          </span>
        </div>
        {(props.problem || props.actionError || note) && (
          <div className="ai-door-modal-alert">
            {props.problem && <span className="ai-door-error">{props.problem}</span>}
            {props.actionError && <span className="ai-door-error">{props.actionError}</span>}
            {note && <span className="ai-door-muted">{note}</span>}
          </div>
        )}
        <div className="ai-door-tabs" role="tablist">
          {tabs.map(([id, label]) => (
            <button key={id} type="button" role="tab" className="ai-door-tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="ai-door-split">
          <div className="ai-door-main">
            {tab === 'dialog' && <DialogTab api={api} leadId={leadId} panel={p} onChanged={props.refresh} onOpenChat={onClose} />}
            {tab === 'products' && (
              <div className="ai-door-main-scroll">
                <Card title={`Найденные товары${p.products.length ? ` (${p.products.length})` : ''}`}>
                  <ProductList products={p.products} wide onSend={(pr) => toChat(productText(pr))} />
                </Card>
                <Card title="Расчёт">
                  <CalcBlock calc={calc} busy={busy} onNote={(t) => void act(() => api.addLeadNote(leadId, t))} onSend={toChat} />
                </Card>
              </div>
            )}
            {tab === 'files' && (
              <div className="ai-door-main-scroll">
                <FilesBlock api={api} leadId={leadId} files={files} busy={busy} act={act} />
              </div>
            )}
            {tab === 'tasks' && (
              <div className="ai-door-main-scroll">
                <TaskList tasks={tasks} />
              </div>
            )}
            {tab === 'journal' && (
              <div className="ai-door-main-scroll">
                <Card
                  title="Журнал AI"
                  extra={
                    props.settingsUrl && (
                      <a href={props.settingsUrl} target="_blank" rel="noreferrer" className="ai-door-link">
                        Весь журнал
                      </a>
                    )
                  }
                >
                  <JournalList log={p.log} />
                </Card>
              </div>
            )}
          </div>
          <aside className="ai-door-side">
            <Card title={`Найденные товары${p.products.length ? ` (${p.products.length})` : ''}`}>
              <ProductList products={p.products} limit={3} onSend={(pr) => toChat(productText(pr))} />
              {p.products.length > 3 && (
                <button type="button" className="ai-door-link ai-door-plain" style={{ marginTop: 6 }} onClick={() => setTab('products')}>
                  Ещё {p.products.length - 3}
                </button>
              )}
            </Card>
            <Card title="Расчёт">
              {calc ? (
                <div className="ai-door-col">
                  <div className="ai-door-muted">
                    {calc.lines.length} поз.{calc.complete ? '' : ' · часть цен уточнит менеджер'}
                  </div>
                  <div>
                    Итого: <b>{rub(calc.total)}</b>
                  </div>
                  <button type="button" className="ai-door-link ai-door-plain" onClick={() => setTab('products')}>
                    Подробно
                  </button>
                </div>
              ) : (
                <div className="ai-door-empty">Расчётов нет</div>
              )}
            </Card>
            <Card
              title="Резюме диалога"
              extra={
                <button type="button" className="ai-door-btn ai-door-btn-green" disabled={busy} onClick={() => void act(() => api.summary(leadId))}>
                  {p.summary ? 'Обновить' : 'Создать резюме'}
                </button>
              }
            >
              {p.summary ? (
                <>
                  <div className="ai-door-pre">{clip(p.summary.text, 8)}</div>
                  <div className="ai-door-muted">{dateTime(p.summary.createdAt)}</div>
                </>
              ) : (
                <div className="ai-door-empty">Резюме ещё не создавалось</div>
              )}
            </Card>
            <Card title={`Задачи AI${tasks.length ? ` (${tasks.length})` : ''}`}>
              <TaskList tasks={tasks} limit={2} />
            </Card>
          </aside>
        </div>
      </div>
    </div>,
    document.body,
  );
}
