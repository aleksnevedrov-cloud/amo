import { useState } from 'react';
import type { Suggestion, WidgetApi } from '../api.ts';
import { insertIntoChat } from '../chat.ts';
import { dateTime } from './StatusBadge.tsx';
import { s } from './styles.ts';
import { errorMessage } from './useLoad.ts';

/** Черновик на одобрение или подсказка менеджеру. */
export function SuggestionCard({ api, item, onDone, showLead }: { api: WidgetApi; item: Suggestion; onDone: () => void; showLead?: boolean }) {
  const [text, setText] = useState(item.text);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg(ok);
      onDone();
    } catch (err) {
      const code = (err as { status?: number; responseJSON?: { error?: string } } | null);
      setMsg(
        code?.responseJSON?.error === 'no_sender_bot'
          ? 'Не настроен бот-отправщик (Настройки → Где работает).'
          : code?.status === 409
            ? 'Уже обработано.'
            : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const insert = async () => {
    const r = await insertIntoChat(text);
    if (r === 'failed') return setMsg('Не удалось вставить — скопируйте текст вручную.');
    setMsg(r === 'inserted' ? 'Вставлено в чат.' : 'Скопировано в буфер обмена.');
    await run(() => api.markUsed(item.id));
  };

  return (
    <div style={{ ...s.card, ...s.col }}>
      <div style={{ ...s.row, ...s.small, ...s.muted }}>
        <b style={{ color: '#313942' }}>{item.kind === 'draft' ? 'Черновик ответа' : 'Подсказка'}</b>
        {showLead && <span>сделка {item.leadId}</span>}
        <span>{dateTime(item.createdAt)}</span>
      </div>
      <textarea style={{ ...s.textarea, minHeight: 70 }} value={text} onChange={(e) => setText(e.target.value)} />
      <div style={s.row}>
        {item.kind === 'draft' ? (
          <>
            <button type="button" style={s.button} disabled={busy || !text.trim()} onClick={() => run(() => api.approve(item.id, text !== item.text ? text : undefined), 'Отправляется клиенту.')}>
              Отправить
            </button>
            <button type="button" style={s.buttonGhost} disabled={busy} onClick={() => run(() => api.reject(item.id))}>
              Отклонить
            </button>
          </>
        ) : (
          <>
            <button type="button" style={s.button} disabled={busy} onClick={insert}>
              Вставить в чат
            </button>
            <button type="button" style={s.buttonGhost} disabled={busy} onClick={() => run(() => api.reject(item.id))}>
              Скрыть
            </button>
          </>
        )}
        {msg && <span style={s.small}>{msg}</span>}
      </div>
    </div>
  );
}
