import { useCallback, useState } from 'react';
import type { Dictionaries, WidgetApi, WidgetSettings } from '../api.ts';
import { Field, linesToList, NumberInput } from './fields.tsx';
import { dateTime } from './StatusBadge.tsx';
import { s } from './styles.ts';
import { errorMessage, useLoad } from './useLoad.ts';

type Email = WidgetSettings['email'];

const PRESETS: Record<string, Partial<Email>> = {
  'Яндекс': { imapHost: 'imap.yandex.ru', imapPort: 993, imapSecure: true, smtpHost: 'smtp.yandex.ru', smtpPort: 465, smtpSecure: true },
  'Mail.ru': { imapHost: 'imap.mail.ru', imapPort: 993, imapSecure: true, smtpHost: 'smtp.mail.ru', smtpPort: 465, smtpSecure: true },
  Gmail: { imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true },
};

/** Вкладка «Почта»: подключение ящика по IMAP/SMTP. Поля ящика сохраняются общей кнопкой «Сохранить». */
export function EmailSettings(props: {
  api: WidgetApi;
  value: Email;
  onChange: (patch: Partial<Email>) => void;
  dict: Dictionaries | null;
  saved: boolean;
}) {
  const { api, value: e, onChange } = props;
  const load = useCallback(() => api.emailStatus(), [api]);
  const [status, reload] = useLoad(load);
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [test, setTest] = useState<{ imap: string; smtp: string; sentFolder: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (err) {
      const code = (err as { status?: number; responseJSON?: { error?: string } } | null)?.responseJSON?.error;
      setMsg(code === 'no_password' ? 'Сначала сохраните пароль.' : code === 'not_configured' ? 'Заполните и сохраните серверы и логин.' : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const statuses = props.dict?.pipelines.flatMap((p) => p.statuses.map((st) => ({ pipelineId: p.id, id: st.id, label: `${p.name} → ${st.name}` }))) ?? [];

  return (
    <>
      <Field label="Почта">
        <label style={s.row}>
          <input type="checkbox" checked={e.enabled} onChange={(ev) => onChange({ enabled: ev.target.checked })} />
          AI отвечает на письма клиентов
        </label>
      </Field>
      {status.status === 'ready' && (
        <Field label="Состояние">
          <div style={s.col}>
            <span style={status.data.hasPassword ? s.badgeOk : s.badgeWarn}>{status.data.hasPassword ? 'Пароль сохранён' : 'Пароль не задан'}</span>
            {status.data.folders.map((f) => (
              <span key={f.folder} style={s.small}>
                {f.folder}: {f.lastError ? <span style={s.error}>ошибка — {f.lastError}</span> : f.lastOkAt ? `проверено ${dateTime(f.lastOkAt)}` : 'ещё не опрашивалась'}
              </span>
            ))}
          </div>
        </Field>
      )}
      <Field label="Почтовый сервис">
        <div style={s.row}>
          {Object.entries(PRESETS).map(([name, preset]) => (
            <button key={name} type="button" style={s.buttonGhost} onClick={() => onChange(preset)}>
              {name}
            </button>
          ))}
        </div>
      </Field>
      <Field label="IMAP (входящие)">
        <div style={s.row}>
          <input style={{ ...s.input, width: 220 }} placeholder="imap.yandex.ru" value={e.imapHost} onChange={(ev) => onChange({ imapHost: ev.target.value.trim() })} />
          <NumberInput value={e.imapPort} min={1} onChange={(v) => onChange({ imapPort: v ?? 993 })} />
          <label style={{ ...s.row, ...s.small }}>
            <input type="checkbox" checked={e.imapSecure} onChange={(ev) => onChange({ imapSecure: ev.target.checked })} /> SSL
          </label>
        </div>
      </Field>
      <Field label="SMTP (исходящие)">
        <div style={s.row}>
          <input style={{ ...s.input, width: 220 }} placeholder="smtp.yandex.ru" value={e.smtpHost} onChange={(ev) => onChange({ smtpHost: ev.target.value.trim() })} />
          <NumberInput value={e.smtpPort} min={1} onChange={(v) => onChange({ smtpPort: v ?? 465 })} />
          <label style={{ ...s.row, ...s.small }}>
            <input type="checkbox" checked={e.smtpSecure} onChange={(ev) => onChange({ smtpSecure: ev.target.checked })} /> SSL
          </label>
        </div>
      </Field>
      <Field label="Логин (адрес ящика)">
        <input style={s.input} placeholder="shop@rf-dveri.ru" value={e.username} onChange={(ev) => onChange({ username: ev.target.value.trim() })} />
      </Field>
      <Field label="Пароль приложения" hint="Создаётся в настройках безопасности почты («пароль для приложений»). Хранится в зашифрованном виде и не показывается.">
        <div style={s.row}>
          <input style={{ ...s.input, width: 260 }} type="password" autoComplete="new-password" value={password} onChange={(ev) => setPassword(ev.target.value)} />
          <button
            type="button"
            style={s.buttonGhost}
            disabled={busy || !password}
            onClick={() =>
              act(async () => {
                await api.setEmailPassword(password);
                setPassword('');
                setMsg('Пароль сохранён.');
                reload();
              })
            }
          >
            Сохранить пароль
          </button>
        </div>
      </Field>
      <div style={{ ...s.row, ...s.block }}>
        <button
          type="button"
          style={s.buttonGhost}
          disabled={busy || !props.saved}
          onClick={() =>
            act(async () => {
              setTest(await api.testEmail());
            })
          }
        >
          Проверить подключение
        </button>
        {!props.saved && <span style={{ ...s.muted, ...s.small }}>Сначала сохраните настройки</span>}
        {msg && <span style={s.small}>{msg}</span>}
      </div>
      {test && (
        <div style={{ ...s.col, ...s.small }}>
          <span>Входящие (IMAP): {test.imap === 'ok' ? <span style={s.badgeOk}>подключено</span> : <span style={s.error}>{test.imap}</span>}</span>
          <span>Отправка (SMTP): {test.smtp === 'ok' ? <span style={s.badgeOk}>подключено</span> : <span style={s.error}>{test.smtp}</span>}</span>
          <span>Папка «Отправленные»: {test.sentFolder ?? 'не найдена — укажите вручную'}</span>
        </div>
      )}
      <Field label="Имя и адрес отправителя" hint="Адрес пустой — как логин.">
        <div style={s.row}>
          <input style={{ ...s.input, width: 220 }} value={e.fromName} onChange={(ev) => onChange({ fromName: ev.target.value })} />
          <input style={{ ...s.input, width: 260 }} placeholder="как логин" value={e.fromAddress} onChange={(ev) => onChange({ fromAddress: ev.target.value.trim() })} />
        </div>
      </Field>
      <Field label="Подпись">
        <textarea style={s.textarea} value={e.signature} onChange={(ev) => onChange({ signature: ev.target.value })} />
      </Field>
      <Field label="Папки" hint="«Отправленные» пустая — определить автоматически. Копии ответов AI сохраняются туда, чтобы их видели в почте и в amo.">
        <div style={s.row}>
          <input style={{ ...s.input, width: 180 }} value={e.inboxFolder} onChange={(ev) => onChange({ inboxFolder: ev.target.value })} />
          <input style={{ ...s.input, width: 180 }} placeholder="Отправленные" value={e.sentFolder} onChange={(ev) => onChange({ sentFolder: ev.target.value })} />
          <label style={{ ...s.row, ...s.small }}>
            <input type="checkbox" checked={e.saveToSent} onChange={(ev) => onChange({ saveToSent: ev.target.checked })} /> сохранять копии ответов
          </label>
        </div>
      </Field>
      <Field
        label="Письмо от адреса без сделки"
        hint="AI отвечает только клиентам в сделках. Заявки в «Неразобранном» сделкой не считаются — AI ответит, когда менеджер примет заявку."
      >
        <select style={s.select} value={e.unknownSender} onChange={(ev) => onChange({ unknownSender: ev.target.value as Email['unknownSender'] })}>
          <option value="wait_for_amo">Почта подключена к amo: ждать, пока появится сделка</option>
          <option value="skip">Не отвечать</option>
          <option value="create_lead">Создать контакт и сделку (почта не подключена к amo)</option>
        </select>
      </Field>
      {e.unknownSender === 'wait_for_amo' && (
        <Field label="Сколько ждать сделку, минут" hint="Если за это время менеджер не принял заявку, AI на это письмо не отвечает.">
          <NumberInput value={e.waitForAmoMin} min={1} max={240} onChange={(v) => onChange({ waitForAmoMin: v ?? 60 })} />
        </Field>
      )}
      {e.unknownSender === 'create_lead' && (
        <Field label="Этап для новых сделок из почты" hint="Пусто — первый этап основной воронки.">
          <select
            style={s.select}
            value={e.newLeadStatusId ?? ''}
            onChange={(ev) => {
              const st = statuses.find((x) => x.id === Number(ev.target.value));
              onChange({ newLeadStatusId: st?.id ?? null, newLeadPipelineId: st?.pipelineId ?? null });
            }}
          >
            <option value="">По умолчанию</option>
            {statuses.map((st) => (
              <option key={st.id} value={st.id}>
                {st.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Примечание с ответом AI в сделке" hint="Не нужно, если почта подключена к amo: ответ и так виден в переписке сделки.">
        <label style={s.row}>
          <input type="checkbox" checked={e.noteInLead} onChange={(ev) => onChange({ noteInLead: ev.target.checked })} />
          Дублировать ответ примечанием
        </label>
      </Field>
      <Field label="Не больше ответов AI на один адрес в сутки" hint="Защита от переписки с автоответчиками.">
        <NumberInput value={e.maxRepliesPerAddressPerDay} min={1} max={100} onChange={(v) => onChange({ maxRepliesPerAddressPerDay: v ?? 10 })} />
      </Field>
      <Field label="Не отвечать адресам и доменам" hint="Дополнительно к правилу «только клиентам в сделках», по одному на строку (supplier.ru, boss@rf-dveri.ru).">
        <textarea style={s.textarea} value={e.ignore.join('\n')} onChange={(ev) => onChange({ ignore: linesToList(ev.target.value) })} />
      </Field>
    </>
  );
}
