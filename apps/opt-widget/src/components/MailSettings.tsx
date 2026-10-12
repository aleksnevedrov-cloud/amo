import { useEffect, useState } from 'react';
import { errorMessage, Field, s } from '@core/widget-core';
import type { KpApi, OptSettings } from '../api.ts';

type Mail = OptSettings['mail'];

const FIELDS: { key: keyof Mail; label: string; hint?: string; kind: 'input' | 'number' | 'textarea' | 'bool' }[] = [
  { key: 'smtpHost', label: 'SMTP-сервер', hint: 'Ящик, подключённый к amoCRM: письмо попадёт в переписку сделки из «Отправленных»', kind: 'input' },
  { key: 'smtpPort', label: 'Порт', kind: 'number' },
  { key: 'smtpSecure', label: 'SSL/TLS', kind: 'bool' },
  { key: 'username', label: 'Логин (адрес ящика)', kind: 'input' },
  { key: 'fromName', label: 'Имя отправителя', kind: 'input' },
  { key: 'fromAddress', label: 'Адрес отправителя', hint: 'Пусто — равен логину', kind: 'input' },
  { key: 'cc', label: 'Копия', hint: 'Адрес менеджера; пусто — без копии', kind: 'input' },
  { key: 'subject', label: 'Тема письма', hint: '{kpNo} — номер КП, {clientName} — покупатель', kind: 'input' },
  { key: 'text', label: 'Текст письма', hint: 'Правится в окне предпросмотра перед каждой отправкой', kind: 'textarea' },
  { key: 'signature', label: 'Подпись', kind: 'textarea' },
];

/** Вкладка «Письмо»: SMTP и шаблоны письма с КП (ТЗ 6.6). Пароль хранится отдельно и обратно не показывается. */
export function MailSettings({ api }: { api: KpApi }) {
  const [all, setAll] = useState<OptSettings | null>(null);
  const [mail, setMail] = useState<Mail | null>(null);
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .settings()
      .then((r) => {
        setAll(r.settings);
        setMail(r.settings.mail);
      })
      .catch((e) => setMsg(errorMessage(e)));
  }, [api]);

  const save = async () => {
    if (!all || !mail) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.saveSettings({ ...all, mail });
      setAll(r.settings);
      if (password) {
        await api.saveSmtpPassword(password);
        setPassword('');
      }
      setMsg(`Сохранено (версия ${r.version})`);
    } catch (e) {
      setMsg(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!mail) return <div style={{ ...s.block, ...s.muted }}>{msg ?? 'Загрузка…'}</div>;
  const set = <K extends keyof Mail>(key: K, value: Mail[K]) => setMail((m) => (m ? { ...m, [key]: value } : m));

  return (
    <div style={s.block}>
      {FIELDS.map(({ key, label, hint, kind }) => (
        <Field key={key} label={label} hint={hint}>
          {kind === 'bool' ? (
            <input type="checkbox" checked={Boolean(mail[key])} onChange={(e) => set(key, e.target.checked as Mail[typeof key])} />
          ) : kind === 'textarea' ? (
            <textarea style={{ ...s.input, minHeight: 80 }} value={String(mail[key])} onChange={(e) => set(key, e.target.value as Mail[typeof key])} />
          ) : (
            <input
              style={s.input}
              type={kind === 'number' ? 'number' : 'text'}
              value={String(mail[key])}
              onChange={(e) => set(key, (kind === 'number' ? Number(e.target.value) || 0 : e.target.value) as Mail[typeof key])}
            />
          )}
        </Field>
      ))}
      <Field label="Пароль SMTP" hint="Хранится зашифрованным; поле пустое — пароль не меняется">
        <input style={s.input} type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <button type="button" style={s.button} disabled={busy} onClick={() => void save()}>
        Сохранить
      </button>
      {msg && <div style={{ ...s.muted, marginTop: 8 }}>{msg}</div>}
    </div>
  );
}
