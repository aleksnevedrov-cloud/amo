import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { errorMessage } from '@core/widget-core';
import type { DraftJob, KpApi, KpDraftInfo, KpDraftLine } from '../api.ts';
import { SendPreview } from './SendPreview.tsx';

/**
 * Блок «Агента опт» в карточке сделки. Единственный вход — кнопка «Собрать КП» (ТЗ 6.4):
 * задание уходит воркеру, блок опрашивает состояние; затем менеджер правит цены, собирает
 * документ и отправляет письмо из окна предпросмотра. Автосборки и автоотправки нет.
 */

const STATUS: Record<string, string> = { draft: 'черновик', built: 'документ собран', sent: 'отправлено', cancelled: 'отменено' };
const POLL_MS = 3000;

const rub = (n: number | null) => (n === null ? '—' : `${n.toLocaleString('ru-RU')} ₽`);
const date = (iso: string) => new Date(iso).toLocaleDateString('ru-RU');

/** Черновик, задание воркера и действия над ними; ответ сервера всегда заменяет локальное состояние. */
function useKpDraft(api: KpApi, leadId: number) {
  const [draft, setDraft] = useState<KpDraftInfo | null>(null);
  const [job, setJob] = useState<DraftJob>(null);
  const [lines, setLines] = useState<KpDraftLine[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const take = useCallback((d: KpDraftInfo | null) => {
    setDraft(d);
    setLines(d?.items ?? []);
    setDirty(false);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const r = await api.draft(leadId);
      if (!alive.current) return;
      setJob(r.job);
      // Пока задание в работе, старый черновик не трогаем, чтобы правки менеджера не пропали.
      if (!r.job || r.job.state === 'failed') take(r.draft);
    } catch (err) {
      if (alive.current) setError(errorMessage(err));
    }
  }, [api, leadId, take]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  // Опрос, пока воркер собирает черновик.
  const pending = job?.state === 'queued' || job?.state === 'running';
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [pending, refresh]);

  const act = async (fn: () => Promise<{ draft: KpDraftInfo | null } | { queued: true }>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (!alive.current) return;
      if ('draft' in r) take(r.draft);
      else await refresh();
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

  return { draft, job, lines, dirty, busy, error, pending, act, edit, take };
}

export function KpBlock({ api, leadId }: { api: KpApi; leadId: number }) {
  const { draft, job, lines, dirty, busy, error, pending, act, edit, take } = useKpDraft(api, leadId);
  const [preview, setPreview] = useState(false);
  const start = () => void act(() => api.makeDraft(leadId));

  const total = lines.reduce((sum, l) => sum + (l.price === null ? 0 : l.price * l.qty * (1 - l.discount / 100)), 0);
  const ready = lines.length > 0 && lines.every((l) => l.price !== null);

  // Корень .opt-root: переменные макета, ширина колонки виджетов (~280 px), перенос длинных строк.
  if (!draft) {
    return (
      <div className="opt-root">
      <div className="opt-col">
        {pending ? (
          <div className="opt-muted">{job?.state === 'queued' ? 'В очереди…' : 'Собираю черновик: читаю карточку, письма и файлы…'}</div>
        ) : (
          <div className="opt-empty">КП по этой сделке ещё не собирали</div>
        )}
        {job?.state === 'failed' && <div className="opt-error">Черновик не собран: {job.error}</div>}
        {error && <div className="opt-error">{error}</div>}
        <button type="button" className="opt-btn opt-btn-wide opt-btn-green" disabled={busy || pending} onClick={start}>
          Собрать КП
        </button>
      </div>
      </div>
    );
  }

  return (
    <div className="opt-root">
    <div className="opt-col">
      <div className="opt-row opt-row-tight">
        <span className="opt-muted">{draft.kpNo ?? 'номер будет при сборке документа'} · {STATUS[draft.status] ?? draft.status}</span>
      </div>
      {(draft.client.org || draft.client.fio) && <div className="opt-muted">Покупатель: {[draft.client.org, draft.client.fio].filter(Boolean).join(', ')}{draft.client.email ? ` · ${draft.client.email}` : ''}</div>}
      <SourceInfo draft={draft} />
      {pending && <div className="opt-muted">{job?.state === 'queued' ? 'Новый черновик в очереди…' : 'Собираю новый черновик…'}</div>}
      {job?.state === 'failed' && <div className="opt-error">Новый черновик не собран: {job.error}</div>}
      {error && <div className="opt-error">{error}</div>}

      {lines.length === 0 ? (
        <div className="opt-empty">Позиций не нашлось ни в файлах, ни в письме — добавьте их в карточку и соберите заново</div>
      ) : (
        <KpLinesTable lines={lines} needsManager={draft.needsManager} onEdit={edit} />
      )}
      {lines.length > 0 && <div className="opt-muted">Итого: {rub(Math.round(total))}</div>}
      {draft.questions.length > 0 && (
        <div className="opt-col">
          <span className="opt-muted">Уточнить у клиента:</span>
          {draft.questions.map((q) => (
            <div key={q}>— {q}</div>
          ))}
        </div>
      )}

      <KpActions
        draft={draft}
        busy={busy || pending}
        dirty={dirty}
        ready={ready}
        onDraft={start}
        onSave={() => void act(() => api.saveDraftItems(draft.id, lines))}
        onBuild={() => void act(() => api.buildDoc(draft.id))}
        onSend={() => setPreview(true)}
      />
      {preview && (
        <SendPreview
          api={api}
          draft={draft}
          onClose={() => setPreview(false)}
          onSent={(d) => {
            setPreview(false);
            take(d);
          }}
        />
      )}
    </div>
    </div>
  );
}

/** Откуда взят черновик: письмо, разобранные файлы, что пропущено и почему. */
function SourceInfo({ draft }: { draft: KpDraftInfo }) {
  const src = draft.source;
  if (!src) return null;
  const parts = [
    src.letterAt ? `письмо от ${date(src.letterAt)}` : 'письма в карточке нет',
    src.documents.length ? `разобрано файлов: ${src.documents.length}` : src.attachments.length ? 'файлы не разобраны' : 'файлов нет',
  ];
  const m = src.mail;
  return (
    <div className="opt-col">
      <div className="opt-muted">Источник: {parts.join(', ')}</div>
      {m?.status === 'found' && (
        <div className="opt-muted">
          Письмо прочитано из ящика{m.date ? ` (${date(m.date)})` : ''}: вложений {m.attachments}, в сделку загружено {m.uploaded.length}
        </div>
      )}
      {m?.status === 'not_found' && <div className="opt-error">Письмо в ящике не найдено (искали от {m.searchedFrom}) — черновик по карточке</div>}
      {m?.status === 'error' && <div className="opt-error">Ящик не прочитан: {m.error}</div>}
      {m?.skipped.map((f) => (
        <div key={`m-${f.name}`} className="opt-error">Вложение «{f.name}» пропущено: {f.reason}</div>
      ))}
      {src.skipped.map((f) => (
        <div key={f.name} className="opt-error">Файл «{f.name}» пропущен: {f.reason}</div>
      ))}
    </div>
  );
}

/** Таблица позиций: менеджер правит количество, цену и скидку; пометки «нужен менеджер» — под позицией. */
function KpLinesTable({ lines, needsManager, onEdit }: { lines: KpDraftLine[]; needsManager: KpDraftInfo['needsManager']; onEdit: (i: number, patch: Partial<KpDraftLine>) => void }) {
  const reasons = (i: number) => needsManager.filter((n) => n.request_index === i).map((n) => n.reason);
  return (
    <table className="opt-table">
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
            <tr key={`${l.request_index}-${i}`}>
              <td style={td}>
                <div>{l.name || '—'}</div>
                {l.size && <div className="opt-muted">{l.size}</div>}
                {why.length > 0 && <div className="opt-muted">{why.join('; ')}</div>}
              </td>
              <td style={td}>
                <input type="number" min={1} value={l.qty} style={input} onChange={(e) => onEdit(i, { qty: Math.max(1, Number(e.target.value) || 1) })} />
              </td>
              <td style={td}>
                <input type="number" min={0} value={l.price ?? ''} placeholder="нет цены" style={input} onChange={(e) => onEdit(i, { price: e.target.value === '' ? null : Number(e.target.value) })} />
              </td>
              <td style={td}>
                <input type="number" min={0} max={100} value={l.discount} style={input} onChange={(e) => onEdit(i, { discount: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Кнопки шагов: собрать заново → сохранить правки → собрать документ → отправить (окно предпросмотра). */
function KpActions({ draft, busy, dirty, ready, onDraft, onSave, onBuild, onSend }: { draft: KpDraftInfo; busy: boolean; dirty: boolean; ready: boolean; onDraft: () => void; onSave: () => void; onBuild: () => void; onSend: () => void }) {
  const canSend = (draft.status === 'built' || draft.status === 'sent') && !dirty;
  return (
    <>
      <div className="opt-actions">
        <button type="button" className="opt-btn" disabled={busy} onClick={onDraft} title="Прочитать карточку заново; правки в позициях будут потеряны">
          Собрать заново
        </button>
        <button type="button" className="opt-btn" disabled={busy || !dirty} onClick={onSave}>
          Сохранить правки
        </button>
        <button type="button" className="opt-btn opt-btn-green" disabled={busy || dirty || !ready} title={dirty ? 'Сначала сохраните правки' : !ready ? 'У каждой позиции должна быть цена' : 'Собрать DOCX и PDF по шаблону'} onClick={onBuild}>
          Собрать документ
        </button>
        <button type="button" className="opt-btn" disabled={busy || !canSend} title={canSend ? 'Открыть письмо перед отправкой' : 'Доступно после сборки документа'} onClick={onSend}>
          Отправить клиенту
        </button>
      </div>
      {draft.status === 'sent' && <div className="opt-muted">Отправлено{draft.sentAt ? ` ${date(draft.sentAt)}` : ''}.</div>}
      {draft.status === 'built' && <div className="opt-muted">Документ собран{draft.hasPdf ? ' (DOCX и PDF)' : ' (PDF не получился, есть DOCX)'} — файлы в карточке сделки.</div>}
      {!ready && draft.items.length > 0 && <div className="opt-muted">Сборка документа включится, когда у каждой позиции будет цена.</div>}
    </>
  );
}

const th: CSSProperties = { textAlign: 'left', padding: '4px 4px', borderBottom: '1px solid #e6eaed', fontWeight: 600 };
const td: CSSProperties = { padding: '4px 4px', borderBottom: '1px solid #f0f3f5', verticalAlign: 'top' };
const input: CSSProperties = { width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '2px 4px' };
