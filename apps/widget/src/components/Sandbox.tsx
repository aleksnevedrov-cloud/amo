import { useState } from 'react';
import type { SandboxResult, WidgetApi, WidgetSettings } from '../api.ts';
import { rub } from './StatusBadge.tsx';
import { s } from './styles.ts';
import { errorMessage } from './useLoad.ts';

interface Turn {
  role: 'client' | 'ai';
  text: string;
  result?: SandboxResult;
}

/** Песочница: диалог с агентом на реальном каталоге, без записи в CRM и без отправки клиенту. */
export function Sandbox({ api, draft }: { api: WidgetApi; draft?: WidgetSettings }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const next: Turn[] = [...turns, { role: 'client', text }];
    setTurns(next);
    setInput('');
    setBusy(true);
    setError(null);
    try {
      const r = await api.sandbox(
        next.map((t) => ({ role: t.role, text: t.text })),
        draft,
      );
      const reply =
        r.kind === 'reply'
          ? (r.text ?? '')
          : r.kind === 'handoff'
            ? `${r.text ?? ''}\n[Передано менеджеру: ${r.handoff?.reason}]`
            : `[Ответ заблокирован: ${r.blockedReason}]`;
      setTurns([...next, { role: 'ai', text: reply, result: r }]);
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      setError(status === 503 ? 'Не задан ключ Anthropic API на сервере.' : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const total = turns.reduce((sum, t) => sum + (t.result?.cost.rub ?? 0), 0);
  return (
    <div style={s.col}>
      <div style={{ ...s.muted, ...s.small }}>
        Агент работает на вашем каталоге и базе знаний. CRM — тестовая сделка, клиенту ничего не отправляется. Стоимость
        запросов реальная и учитывается в расходе.
      </div>
      <div style={{ ...s.col, gap: 10, maxHeight: 520, overflowY: 'auto' }}>
        {turns.map((t, i) => (
          <div key={i} style={{ ...s.card, background: t.role === 'client' ? '#f5f7f9' : '#fff' }}>
            <div style={s.label}>{t.role === 'client' ? 'Клиент' : 'AI'}</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{t.text}</div>
            {t.result && <Trace r={t.result} />}
          </div>
        ))}
      </div>
      <textarea
        style={{ ...s.textarea, minHeight: 60 }}
        placeholder="Сообщение от имени клиента"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div style={s.row}>
        <button type="button" style={s.button} disabled={busy || !input.trim()} onClick={send}>
          {busy ? 'Агент думает…' : 'Отправить'}
        </button>
        <button type="button" style={s.buttonGhost} disabled={busy} onClick={() => setTurns([])}>
          Новый диалог
        </button>
        {total > 0 && <span style={{ ...s.muted, ...s.small }}>Стоимость диалога: {rub(total)}</span>}
        {error && <span style={s.error}>{error}</span>}
      </div>
    </div>
  );
}

function Trace({ r }: { r: SandboxResult }) {
  return (
    <details style={{ marginTop: 6, ...s.small }}>
      <summary style={{ cursor: 'pointer', color: '#4c8bf7' }}>
        Инструменты: {r.toolCalls.length} · источники: {r.sources.length} · {rub(r.cost.rub)} · {r.model}
      </summary>
      <div style={{ ...s.col, marginTop: 6 }}>
        {r.toolCalls.map((c, i) => (
          <div key={i}>
            <b>{c.specName}</b> {JSON.stringify(c.input)} —{' '}
            {c.ok ? (c.empty ? 'ничего не найдено' : 'ok') : <span style={s.error}>{c.error}</span>} ({c.durationMs} мс)
          </div>
        ))}
        {r.sources.map((src) => (
          <div key={`${src.type}-${src.id}`}>
            {src.type === 'product' ? 'Товар' : 'База знаний'}:{' '}
            {src.url ? (
              <a href={src.url} target="_blank" rel="noreferrer">
                {src.title}
              </a>
            ) : (
              src.title
            )}
            {src.date && <span style={s.muted}> ({src.date})</span>}
          </div>
        ))}
        {r.rejections.length > 0 && (
          <div style={s.error}>
            Пост-фильтр отклонял ответ {r.rejections.length} раз: {r.rejections.flat().map((v) => v.fragment).join(', ')}
          </div>
        )}
        {r.notes.length > 0 && <div>Примечания в сделку: {r.notes.join(' | ')}</div>}
        {r.handoff && <div>Резюме для менеджера: {r.handoff.summary}</div>}
      </div>
    </details>
  );
}
