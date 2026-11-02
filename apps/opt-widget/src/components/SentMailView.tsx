import { useEffect, useState } from 'react';
import { errorMessage } from '@core/widget-core';
import type { KpApi, KpDraftInfo, SentMailInfo } from '../api.ts';

/** Дата и время по Москве: «21.10.2026, 10:48 МСК». */
export const moscow = (iso: string) => `${new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })} МСК`;

const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`);

/** Судьба копии в «Отправленные» словами. */
export function copyText(copy: SentMailInfo['copy']): string {
  if (copy.status === 'saved') return `сохранена в «${copy.folder ?? 'Отправленные'}»`;
  if (copy.status === 'failed') return `не сохранена: ${copy.error ?? 'причина неизвестна'}`;
  return 'неизвестно — письмо отправлено до сохранения копий';
}

/**
 * «Посмотреть письмо» (KP-SENT-COPY, п. 2.4): что и как ушло клиенту — от кого, кому, копия, тема, дата (МСК), текст,
 * вложение со ссылкой на скачивание, messageId, копия в «Отправленные». Для КП, отправленных до сохранения копий, — то, что
 * есть в журнале, с пометкой.
 */
export function SentMailView({ api, draft, onClose }: { api: KpApi; draft: KpDraftInfo; onClose: () => void }) {
  const [info, setInfo] = useState<SentMailInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.sentMail(draft.id).then(setInfo, (e) => setError(errorMessage(e)));
  }, [api, draft.id]);

  const download = async () => {
    if (!info?.attachmentKind) return;
    try {
      const { url, filename } = await api.fileLink(draft.id, info.attachmentKind);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.target = '_blank';
      a.rel = 'noreferrer';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  if (!info) return <div className="opt-muted">{error ?? 'Загружаю письмо…'}</div>;
  const row = (label: string, value: React.ReactNode, cls = '') => (
    <div className={`opt-kp-mail-row ${cls}`}>
      <span className="opt-kp-label">{label}</span>
      <span className="opt-kp-mail-value">{value ?? '—'}</span>
    </div>
  );
  return (
    <div className="opt-col opt-kp-sent-mail">
      <div className="opt-kp-head">
        <h3 className="opt-kp-title">Письмо с КП{info.kpNo ? ` ${info.kpNo}` : ''}</h3>
        <button type="button" className="opt-btn opt-icon" aria-label="Закрыть письмо" onClick={onClose}>
          ✕
        </button>
      </div>
      {info.legacy && <div className="opt-kp-mail-legacy">{info.note ?? 'письмо отправлено до сохранения копий'}: текст письма и копия не сохранялись, ниже — данные из журнала.</div>}
      {row('От кого', info.from)}
      {row('Кому', info.to)}
      {row('Копия', info.cc)}
      {row('Тема', info.subject)}
      {row('Дата', info.at ? moscow(info.at) : null)}
      {row(
        'Вложение',
        info.attachment ? (
          <>
            {info.attachmentKind ? (
              <button type="button" className="opt-link opt-kp-mail-attachment" onClick={() => void download()}>
                {info.attachment.name}
              </button>
            ) : (
              info.attachment.name
            )}
            {info.attachment.bytes ? ` · ${kb(info.attachment.bytes)}` : ''}
          </>
        ) : null,
      )}
      {row('Message-ID', info.messageId, 'opt-kp-mail-id')}
      {info.smtp && row('Ответ SMTP', `${info.smtp.response}${info.smtp.rejected.length ? ` · отклонены: ${info.smtp.rejected.join(', ')}` : ''}`)}
      {row('Копия в «Отправленные»', <span className={info.copy.status === 'failed' ? 'opt-kp-stale' : ''}>{copyText(info.copy)}</span>, 'opt-kp-mail-copy')}
      {info.text !== null && (
        <div className="opt-col">
          <span className="opt-kp-label">Текст письма</span>
          <div className="opt-kp-mail-text">{info.text}</div>
        </div>
      )}
      {error && <div className="opt-error">{error}</div>}
    </div>
  );
}
