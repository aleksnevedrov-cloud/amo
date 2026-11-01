import { useEffect, useState } from 'react';
import { errorMessage } from '@core/widget-core';
import type { KpApi, KpDraftInfo, SendPreviewInfo } from '../api.ts';

/**
 * Окно предпросмотра (ТЗ 6.6): получатель, копия, тема и текст правятся, вложение — нет.
 * Кнопка активна только без препятствий; повторная отправка — по отдельному подтверждению.
 */
export function SendPreview({ api, draft, onSent, onClose }: { api: KpApi; draft: KpDraftInfo; onSent: (d: KpDraftInfo | null) => void; onClose: () => void }) {
  const [info, setInfo] = useState<SendPreviewInfo | null>(null);
  const [form, setForm] = useState({ to: '', cc: '', subject: '', text: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .sendPreview(draft.id)
      .then((r) => {
        setInfo(r);
        setForm({ to: r.to, cc: r.cc, subject: r.subject, text: r.text });
      })
      .catch((e) => setError(errorMessage(e)));
  }, [api, draft.id]);

  const send = async () => {
    if (info?.alreadySent && !window.confirm('Это КП уже отправлялось. Отправить повторно?')) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.send({ draftId: draft.id, ...form, resendConfirmed: Boolean(info?.alreadySent) });
      onSent(r.draft);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!info) return <div className="opt-muted">{error ?? 'Готовлю письмо…'}</div>;
  // Адрес менеджер мог поправить руками — проверяем его формат на месте, остальные препятствия пришли с сервера.
  const blockers = info.blockers.filter((b) => !b.startsWith('адрес получателя'));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.to.trim())) blockers.push('адрес получателя пустой или не похож на e-mail');

  return (
    <div className="opt-col opt-card">
      <div className="opt-title">Письмо с КП</div>
      <label className="opt-col">
        <span className="opt-muted">Кому</span>
        <input value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />
      </label>
      <label className="opt-col">
        <span className="opt-muted">Копия</span>
        <input value={form.cc} onChange={(e) => setForm({ ...form, cc: e.target.value })} />
      </label>
      <label className="opt-col">
        <span className="opt-muted">Тема</span>
        <input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
      </label>
      <label className="opt-col">
        <span className="opt-muted">Текст</span>
        <textarea rows={6} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} />
      </label>
      {info.signature && <div className="opt-muted">Подпись: {info.signature}</div>}
      <div className="opt-muted">Вложение: {info.attachment ? `${info.attachment.name}${info.attachment.bytes ? ` (${Math.round(info.attachment.bytes / 1024)} КБ)` : ''}` : 'нет'}</div>
      {info.warnings.map((w) => (
        <div key={w} className="opt-error">Внимание: {w}</div>
      ))}
      {blockers.map((b) => (
        <div key={b} className="opt-error">Нельзя отправить: {b}</div>
      ))}
      {error && <div className="opt-error">{error}</div>}
      <div className="opt-row">
        <button type="button" className="opt-btn opt-btn-green" disabled={busy || blockers.length > 0} onClick={() => void send()}>
          {busy ? 'Отправляю…' : info.alreadySent ? 'Отправить повторно' : 'Проверено, отправить'}
        </button>
        <button type="button" className="opt-btn" disabled={busy} onClick={onClose}>
          Отмена
        </button>
      </div>
    </div>
  );
}
