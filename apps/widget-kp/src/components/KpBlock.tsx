import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { errorMessage } from '@ai-door/widget-core';
import type { KpApi, KpDraftInfo, KpDraftLine } from '../api.ts';

/**
 * Блок «КП» в карточке сделки (тема RFD-AI-AGENT-KP, раздел 9 ТЗ).
 *
 * Порядок жёсткий: «Подготовить КП» → правки менеджера → «Собрать КП» → «Отправить».
 * Автоматической сборки и автоотправки нет: цифры в документ уходят только после того,
 * как менеджер их подтвердил.
 */

const STATUS: Record<string, string> = {
  draft: 'черновик',
  built: 'собрано',
  sent: 'отправлено',
  cancelled: 'отменено',
};

const rub = (n: number | null) => (n === null ? '—' : `${n.toLocaleString('ru-RU')} ₽`);

/** Черновик КП сделки и действия над ним; ответ сервера всегда заменяет локальное состояние. */
function useKpDraft(api: KpApi, leadId: number) {
  const [draft, setDraft] = useState<KpDraftInfo | null>(null);
  const [lines, setLines] = useState<KpDraftLine[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const take = (d: KpDraftInfo | null) => {
    setDraft(d);
    setLines(d?.items ?? []);
    setDirty(false);
  };

  useEffect(() => {
    alive.current = true;
    void api
      .draft(leadId)
      .then((r) => {
        if (alive.current) take(r.draft);
      })
      .catch(() => undefined);
    return () => {
      alive.current = false;
    };
  }, [api, leadId]);

  const act = async (fn: () => Promise<{ draft: KpDraftInfo | null }>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (alive.current) take(r.draft);
    } catch (err) {
      if (alive.current) setError(errorMessage(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const edit = (i: number, patch: Partial<KpDraftLine>) => {
    setLines((xs) => xs.map((l, k) => (k === i ? { ...l, ...patch } : l)));
    setDirty(true);
  };

  return { draft, lines, dirty, busy, error, act, edit };
}

export function KpBlock({ api, leadId }: { api: KpApi; leadId: number }) {
  const { draft, lines, dirty, busy, error, act, edit } = useKpDraft(api, leadId);
  const total = lines.reduce((sum, l) => sum + (l.price === null ? 0 : l.price * l.qty * (1 - l.discount / 100)), 0);
  const ready = lines.length > 0 && lines.every((l) => l.price !== null);

  if (!draft) {
    return (
      <div className="ai-door-col">
        <div className="ai-door-empty">КП по этой сделке ещё не готовили</div>
        {error && <div className="ai-door-error">{error}</div>}
        <button type="button" className="ai-door-btn" disabled={busy} onClick={() => void act(() => api.makeDraft(leadId))}>
          {busy ? 'Читаю письмо…' : 'Подготовить КП'}
        </button>
      </div>
    );
  }

  return (
    <div className="ai-door-col">
      <div className="ai-door-row ai-door-row-tight">
        <span className="ai-door-muted">
          {draft.kpNo ?? 'номер будет при сборке'} · {STATUS[draft.status] ?? draft.status}
        </span>
      </div>
      {draft.client.org || draft.client.fio ? (
        <div className="ai-door-muted">Покупатель: {[draft.client.org, draft.client.fio].filter(Boolean).join(', ')}</div>
      ) : null}
      {error && <div className="ai-door-error">{error}</div>}

      {lines.length === 0 ? (
        <div className="ai-door-empty">Позиций в письме не нашлось — добавьте их руками в amoCRM</div>
      ) : (
        <KpLinesTable lines={lines} needsManager={draft.needsManager} onEdit={edit} />
      )}
      {lines.length > 0 && <div className="ai-door-muted">Итого без НДС: {rub(Math.round(total))}</div>}

      {draft.questions.length > 0 && (
        <div className="ai-door-col">
          <span className="ai-door-muted">Уточнить у клиента:</span>
          {draft.questions.map((q) => (
            <div key={q}>— {q}</div>
          ))}
        </div>
      )}

      <KpActions
        draft={draft}
        busy={busy}
        dirty={dirty}
        ready={ready}
        onDraft={() => void act(() => api.makeDraft(leadId))}
        onSave={() => void act(() => api.saveDraftItems(draft.id, lines))}
        onBuild={() => void act(() => api.buildDoc(draft.id))}
        onSend={() => {
          if (window.confirm('Отправить КП клиенту письмом?')) void act(() => api.send(draft.id));
        }}
      />
    </div>
  );
}

/** Таблица позиций: менеджер правит количество, цену и скидку; причины «нужен менеджер» — под позицией. */
function KpLinesTable({
  lines,
  needsManager,
  onEdit,
}: {
  lines: KpDraftLine[];
  needsManager: KpDraftInfo['needsManager'];
  onEdit: (i: number, patch: Partial<KpDraftLine>) => void;
}) {
  const reasons = (i: number) => needsManager.filter((n) => n.request_index === i).map((n) => n.reason);
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr>
          <th style={th}>Позиция</th>
          <th style={{ ...th, width: 48 }}>Кол-во</th>
          <th style={{ ...th, width: 92 }}>Цена</th>
          <th style={{ ...th, width: 56 }}>Скидка</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l, i) => {
          const why = reasons(l.request_index);
          return (
            <tr key={`${l.request_index}-${l.page_id ?? i}`}>
              <td style={td}>
                <div>{l.name || '—'}</div>
                {l.size && <div className="ai-door-muted">{l.size}</div>}
                {l.lead_time && <div className="ai-door-muted">срок: {l.lead_time}</div>}
                {why.length > 0 && <div className="ai-door-error">{why.join('; ')}</div>}
              </td>
              <td style={td}>
                <input type="number" min={1} value={l.qty} style={input} onChange={(e) => onEdit(i, { qty: Math.max(1, Number(e.target.value) || 1) })} />
              </td>
              <td style={td}>
                <input
                  type="number"
                  min={0}
                  value={l.price ?? ''}
                  placeholder="нет цены"
                  style={input}
                  onChange={(e) => onEdit(i, { price: e.target.value === '' ? null : Number(e.target.value) })}
                />
              </td>
              <td style={td}>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={l.discount}
                  style={input}
                  onChange={(e) => onEdit(i, { discount: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })}
                />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Кнопки шагов и пояснения к состоянию черновика. */
function KpActions({
  draft,
  busy,
  dirty,
  ready,
  onDraft,
  onSave,
  onBuild,
  onSend,
}: {
  draft: KpDraftInfo;
  busy: boolean;
  dirty: boolean;
  ready: boolean;
  onDraft: () => void;
  onSave: () => void;
  onBuild: () => void;
  onSend: () => void;
}) {
  return (
    <>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" className="ai-door-btn" disabled={busy} onClick={onDraft}>
          Пересобрать черновик
        </button>
        <button type="button" className="ai-door-btn" disabled={busy || !dirty} onClick={onSave}>
          Сохранить правки
        </button>
        <button
          type="button"
          className="ai-door-btn ai-door-btn-green"
          disabled={busy || dirty || !ready}
          title={dirty ? 'Сначала сохраните правки' : !ready ? 'У каждой позиции должна быть цена' : 'Собрать документ по шаблону'}
          onClick={onBuild}
        >
          {busy ? 'Собираю…' : 'Собрать КП'}
        </button>
        <button
          type="button"
          className="ai-door-btn"
          disabled={busy || draft.status !== 'built'}
          title={draft.status === 'built' ? 'Отправить письмо с КП клиенту' : 'Доступно после сборки документа'}
          onClick={onSend}
        >
          {busy ? 'Отправляю…' : 'Отправить'}
        </button>
      </div>
      {draft.status === 'sent' && <div className="ai-door-muted">КП отправлено клиенту.</div>}
      {draft.status === 'built' && (
        <div className="ai-door-muted">Документ собран{draft.hasPdf ? ' (DOCX и PDF)' : ' (PDF не получился, есть DOCX)'} — файлы в карточке сделки.</div>
      )}
      {!ready && draft.items.length > 0 && <div className="ai-door-muted">Сборка включится, когда у каждой позиции будет цена.</div>}
    </>
  );
}

const th: CSSProperties = { textAlign: 'left', padding: '4px 4px', borderBottom: '1px solid #e6eaed', fontWeight: 600 };
const td: CSSProperties = { padding: '4px 4px', borderBottom: '1px solid #f0f3f5', verticalAlign: 'top' };
const input: CSSProperties = { width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '2px 4px' };
