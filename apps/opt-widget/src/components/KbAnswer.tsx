import { useState } from 'react';
import { errorMessage } from '@core/widget-core';
import type { KbAnswerInfo, KpApi } from '../api.ts';

/**
 * Вопрос покупателя → ответ из базы знаний (RFD-AI-AGENT-OPT-KB, этап 4): менеджер вводит вопрос
 * («какая скидка от 50 полотен»), агент отвечает только по фрагментам базы и показывает источники.
 * Используется в карточке сделки (блок КП) и во вкладке «База знаний».
 */
export function KbAnswer({ api, leadId, compact }: { api: KpApi; leadId?: number; compact?: boolean }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<KbAnswerInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ask = async () => {
    if (q.trim().length < 2) return;
    setBusy(true);
    setErr(null);
    try {
      setRes(await api.kbAnswer(q.trim(), leadId));
    } catch (e) {
      const status = (e as { status?: number } | null)?.status;
      setErr(status === 409 ? 'LLM не настроена: задайте ключ провайдера во вкладке «Модель»' : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`opt-kb-answer opt-col${compact ? ' opt-kb-answer-compact' : ''}`}>
      <div className="opt-row opt-row-tight">
        <input
          className="opt-kb-answer-input"
          placeholder="Вопрос покупателя, например: какая скидка от 50 полотен"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void ask();
          }}
        />
        <button type="button" className="opt-btn opt-btn-small" disabled={busy || q.trim().length < 2} onClick={() => void ask()}>
          {busy ? 'Ищу…' : 'Ответить из базы'}
        </button>
      </div>
      {err && <div className="opt-error">{err}</div>}
      {res && (
        <div className="opt-kb-answer-body opt-col">
          {res.answer ? <div className="opt-pre">{res.answer}</div> : <div className="opt-muted">В базе знаний ответа нет{res.reason ? ` — ${res.reason}` : ''}</div>}
          {res.sources.length > 0 && (
            <div className="opt-kb-answer-sources opt-col">
              {res.sources.map((s) => (
                <div key={s.n} className="opt-muted opt-meta">
                  [{s.n}] {s.label}: {s.excerpt}
                </div>
              ))}
            </div>
          )}
          <div className="opt-muted opt-meta">
            {res.model ? `${res.model}, ` : ''}${res.cost.usd.toFixed(4)}, {res.ms} мс
          </div>
        </div>
      )}
    </div>
  );
}
