import { useCallback, useEffect, useRef, useState } from 'react';
import type { DialogItem, LeadDialog, LeadPanel as Panel, WidgetApi } from '../api.ts';
import { insertIntoChat } from '../chat.ts';
import { dateTime, modelLabel } from './StatusBadge.tsx';
import { errorMessage } from './useLoad.ts';

const POLL_MS = 20_000;
/** Набранный ответ не теряется, если окно закрыли (Esc, ✕) и открыли снова. */
const drafts = new Map<number, { text: string; suggestionId: number | null }>();

/**
 * Вкладка «Диалог» (RETAIL-WIDGET-WINDOW, п. 2–3): лента сообщений клиента, ответов агента и менеджера,
 * неотправленные подсказки (жёлтые) и поле ответа. «Отправить» — только по кнопке, в чат клиента через Wazzup
 * от имени менеджера; повторное нажатие заблокировано до ответа сервера. Если отправить нельзя (почта, Wazzup
 * не подключён) — причина и «Скопировать» / «Открыть чат».
 */
export function DialogTab({ api, leadId, panel, onChanged, onOpenChat }: { api: WidgetApi; leadId: number; panel: Panel; onChanged: () => void; onOpenChat: () => void }) {
  const [dialog, setDialog] = useState<LeadDialog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setTextState] = useState(drafts.get(leadId)?.text ?? '');
  const [fromSuggestion, setFromSuggestion] = useState<number | null>(drafts.get(leadId)?.suggestionId ?? null);
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const feed = useRef<HTMLDivElement>(null);
  const alive = useRef(true);

  const setText = (t: string, suggestionId: number | null = fromSuggestion) => {
    setTextState(t);
    setFromSuggestion(suggestionId);
    drafts.set(leadId, { text: t, suggestionId });
  };

  const load = useCallback(async () => {
    try {
      const d = await api.leadDialog(leadId);
      if (!alive.current) return;
      setDialog(d);
      setError(null);
    } catch (err) {
      if (alive.current) setError(errorMessage(err));
    }
  }, [api, leadId]);

  useEffect(() => {
    alive.current = true;
    void load();
    const t = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [load]);

  const count = dialog?.items.length ?? 0;
  useEffect(() => {
    const el = feed.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setMsg(null);
    try {
      const r = await api.sendReply(leadId, body);
      // Подсказка, взятая «В поле», ушла клиенту — больше не «не отправлена».
      if (fromSuggestion) await api.markUsed(fromSuggestion).catch(() => undefined);
      setText('', null);
      drafts.delete(leadId);
      setMsg({ ok: true, text: `Отправлено в ${r.channelLabel} от имени ${r.userName}.` });
      await load();
      onChanged();
    } catch (err) {
      setMsg({ ok: false, text: `Не отправлено: ${errorMessage(err)}` });
    } finally {
      setSending(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setMsg({ ok: true, text: 'Скопировано — вставьте в чат amo.' });
    } catch {
      setMsg({ ok: false, text: 'Не удалось скопировать — выделите текст вручную.' });
    }
  };

  const openChat = async () => {
    // Текст переносится в поле чата amo (или в буфер обмена), окно закрывается — отправляет менеджер в чате.
    if (text.trim()) {
      const r = await insertIntoChat(text);
      // Подсказка ушла в поле чата amo — как раньше «Вставить в чат»: помечается использованной.
      if (r !== 'failed' && fromSuggestion) await api.markUsed(fromSuggestion).catch(() => undefined);
      if (r !== 'failed') {
        setText('', null);
        drafts.delete(leadId);
      }
    } else document.querySelector<HTMLElement>('.feed-compose [contenteditable="true"], .feed-compose textarea, .js-feed-compose-input [contenteditable="true"]')?.focus();
    onOpenChat();
  };

  const decide = async (id: number, fn: () => Promise<unknown>) => {
    setBusyId(id);
    setMsg(null);
    try {
      await fn();
      await load();
      onChanged();
    } catch (err) {
      setMsg({ ok: false, text: (err as { status?: number } | null)?.status === 409 ? 'Уже обработано.' : errorMessage(err) });
    } finally {
      setBusyId(null);
    }
  };

  const send_ = dialog?.send;
  // Черновик режима «Полуавто», взятый «В поле»: можно одобрить с правкой — уйдёт ботом-отправщиком, как раньше.
  const draft = fromSuggestion ? panel.hints.find((h) => h.id === fromSuggestion && h.kind === 'draft' && h.status === 'pending') : undefined;
  const approveDraft = (d: NonNullable<typeof draft>) =>
    void decide(d.id, async () => {
      await api.approve(d.id, text.trim() && text !== d.text ? text : undefined);
      setText('', null);
      drafts.delete(leadId);
    });
  return (
    <div className="ai-door-dialog">
      <div className="ai-door-main-scroll" ref={feed}>
        {error && !dialog && (
          <div className="ai-door-card">
            <div className="ai-door-error">{error}</div>
            <button type="button" className="ai-door-btn" style={{ marginTop: 6 }} onClick={() => void load()}>
              Повторить
            </button>
          </div>
        )}
        {!dialog && !error && <div className="ai-door-empty">Загружаю переписку…</div>}
        {dialog && dialog.items.length === 0 && <div className="ai-door-empty">Переписки по сделке нет</div>}
        {dialog && dialog.items.length > 0 && (
          <div className="ai-door-feed">
            {dialog.items.map((it) => (
              <Message
                key={it.id}
                it={it}
                suggestion={it.suggestionId ? panel.hints.find((h) => h.id === it.suggestionId) : undefined}
                busy={busyId === it.suggestionId}
                onToField={() => setText(it.text, it.suggestionId ?? null)}
                onApprove={() => withId(it, (id) => void decide(id, () => api.approve(id)))}
                onReject={() => withId(it, (id) => void decide(id, () => api.reject(id)))}
              />
            ))}
          </div>
        )}
      </div>
      <div className="ai-door-composer">
        <textarea
          aria-label="Ответ клиенту"
          placeholder="Ответ клиенту от менеджера или правка подсказки…"
          maxLength={4000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl+Enter — то же, что кнопка. Esc закрывает окно, набранный текст сохраняется (drafts).
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && send_?.available) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="ai-door-actions">
          {send_?.available ? (
            <>
              <button type="button" className="ai-door-btn ai-door-btn-solid" disabled={sending || !text.trim()} onClick={() => void send()}>
                {sending ? 'Отправляю…' : 'Отправить'}
              </button>
              <span className="ai-door-muted">Уйдёт клиенту в {send_.channelLabel} от вашего имени. AI встанет на паузу, как при ответе менеджера в чате.</span>
            </>
          ) : (
            <>
              <button type="button" className="ai-door-btn" disabled={!text.trim()} onClick={() => void copy()}>
                Скопировать
              </button>
              <button type="button" className="ai-door-btn ai-door-btn-green" onClick={() => void openChat()}>
                Открыть чат
              </button>
              {send_ && <span className="ai-door-muted">{send_.reason}</span>}
            </>
          )}
          {draft && (
            <button type="button" className="ai-door-btn ai-door-btn-green" disabled={busyId === draft.id || !text.trim()} onClick={() => approveDraft(draft)}>
              Одобрить черновик
            </button>
          )}
          {msg && <span className={msg.ok ? 'ai-door-ok' : 'ai-door-error'}>{msg.text}</span>}
        </div>
      </div>
    </div>
  );
}

const withId = (it: DialogItem, fn: (id: number) => void) => {
  if (it.suggestionId) fn(it.suggestionId);
};

const WHO: Record<DialogItem['who'], string> = { client: 'Клиент', agent: 'Агент', manager: 'Менеджер', hint: 'Подсказка', system: 'Система' };

function Message({ it, suggestion, busy, onToField, onApprove, onReject }: { it: DialogItem; suggestion: Panel['hints'][number] | undefined; busy: boolean; onToField: () => void; onApprove: () => void; onReject: () => void }) {
  const isDraft = suggestion?.kind === 'draft';
  const who = it.who === 'hint' ? (isDraft ? 'Черновик ответа' : 'Подсказка менеджеру') : WHO[it.who];
  const meta = [
    who,
    it.who === 'client' ? it.channelLabel : null,
    it.who === 'agent' && it.model ? (it.provider ? modelLabel(it.provider, it.model) : it.model) : null,
    it.who === 'manager' ? (it.managerName ?? null) : null,
    it.notSent ? (isDraft ? 'не отправлен' : 'не отправлена') : null,
    dateTime(it.at),
  ].filter(Boolean);
  return (
    <div className={`ai-door-msg ai-door-msg-${it.who}`} title={it.channelLabel ? `Канал: ${it.channelLabel}` : undefined}>
      <div className="ai-door-msg-meta">{meta.join(' · ')}</div>
      <div className="ai-door-pre">{it.text}</div>
      {it.who === 'hint' && it.suggestionId && (
        <div className="ai-door-actions" style={{ marginTop: 6 }}>
          <button type="button" className="ai-door-btn" disabled={busy} onClick={onToField}>
            В поле
          </button>
          {isDraft && (
            <button type="button" className="ai-door-btn ai-door-btn-green" disabled={busy} onClick={onApprove} title="Черновик уйдёт клиенту ботом-отправщиком, как раньше">
              Одобрить
            </button>
          )}
          <button type="button" className="ai-door-btn" disabled={busy} onClick={onReject}>
            {isDraft ? 'Отклонить' : 'Скрыть'}
          </button>
        </div>
      )}
    </div>
  );
}
