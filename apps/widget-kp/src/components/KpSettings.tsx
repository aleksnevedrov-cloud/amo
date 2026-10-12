import { useEffect, useState } from 'react';
import type { KpApi, KpSettingsInfo } from '../api.ts';
import { Field, s } from '@ai-door/widget-core';

type Constants = KpSettingsInfo['constants'];

/** Вкладка «КП»: постоянные части предложения, нумерация и файл-шаблон. */
export function KpSettings(props: { api: KpApi }) {
  const [data, setData] = useState<KpSettingsInfo | null>(null);
  const [c, setC] = useState<Constants>({});
  const [prefix, setPrefix] = useState('КП');
  const [counter, setCounter] = useState(0);
  const [certsDir, setCertsDir] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    props.api
      .settings()
      .then((r) => {
        setData(r);
        setC(r.constants ?? {});
        setPrefix(r.numbering?.prefix ?? 'КП');
        setCounter(r.numbering?.counter ?? 0);
        setCertsDir(r.certsDir ?? '');
      })
      .catch((e: Error) => setMsg(`Не удалось загрузить: ${e.message}`));
  }, [props.api]);

  const set = (k: keyof Constants, v: string) =>
    setC((p) => ({ ...p, [k]: v === '' ? undefined : v }));

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await props.api.saveSettings({
        constants: c,
        certsDir: certsDir.trim() === '' ? null : certsDir.trim(),
        numbering: { prefix: prefix.trim() || 'КП', counter: Number(counter) || 0 },
      });
      setMsg('Сохранено');
    } catch (e) {
      setMsg(`Ошибка: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    setBusy(true);
    setMsg(null);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (const b of buf) bin += String.fromCharCode(b);
      const r = await props.api.uploadTemplate(file.name, btoa(bin));
      setMsg(`Шаблон загружен: ${file.name}, ${Math.round(r.size / 1024)} КБ`);
      setData((p) =>
        p
          ? {
              ...p,
              template: {
                exists: true,
                name: file.name,
                md5: r.md5,
                updatedAt: new Date().toISOString(),
              },
            }
          : p,
      );
    } catch (e) {
      setMsg(`Шаблон не принят: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const t = data?.template;

  return (
    <div style={s.block}>
      <div style={s.muted}>
        Вёрстка предложения живёт в файле-шаблоне: модель подставляет только значения.
      </div>

      <Field label="Шаблон КП (DOCX)" hint="Файл с плейсхолдерами. Старый шаблон заменяется.">
        <input
          type="file"
          accept=".docx"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
        <div style={{ ...s.muted, ...s.small, marginTop: 4 }}>
          {t?.exists
            ? `Загружен: ${t.name ?? 'kp.docx'}, md5 ${t.md5 ?? '—'}`
            : 'Шаблон ещё не загружен — сборка КП работать не будет'}
        </div>
      </Field>

      <Field label="Продавец">
        <input
          style={s.input}
          value={c.sellerName ?? ''}
          onChange={(e) => set('sellerName', e.target.value)}
        />
      </Field>

      <Field label="Реквизиты продавца" hint="Попадают в шапку предложения">
        <textarea
          style={{ ...s.input, minHeight: 80 }}
          value={c.sellerRequisites ?? ''}
          onChange={(e) => set('sellerRequisites', e.target.value)}
        />
      </Field>

      <Field label="Ставка НДС, %" hint="Берётся отсюда, в коде не зашита">
        <input
          style={s.input}
          type="number"
          value={c.vatRate ?? ''}
          onChange={(e) =>
            setC((p) => ({ ...p, vatRate: e.target.value === '' ? undefined : Number(e.target.value) }))
          }
        />
      </Field>

      <Field label="Срок действия КП, дней">
        <input
          style={s.input}
          type="number"
          value={c.validDays ?? ''}
          onChange={(e) =>
            setC((p) => ({
              ...p,
              validDays: e.target.value === '' ? undefined : Number(e.target.value),
            }))
          }
        />
      </Field>

      <Field label="Условия оплаты">
        <textarea
          style={{ ...s.input, minHeight: 60 }}
          value={c.paymentTerms ?? ''}
          onChange={(e) => set('paymentTerms', e.target.value)}
        />
      </Field>

      <Field label="Гарантия">
        <textarea
          style={{ ...s.input, minHeight: 60 }}
          value={c.warranty ?? ''}
          onChange={(e) => set('warranty', e.target.value)}
        />
      </Field>

      <Field label="Доставка">
        <textarea
          style={{ ...s.input, minHeight: 60 }}
          value={c.delivery ?? ''}
          onChange={(e) => set('delivery', e.target.value)}
        />
      </Field>

      <Field label="Сопроводительный текст письма" hint="Модель его не пишет — берётся как есть">
        <textarea
          style={{ ...s.input, minHeight: 80 }}
          value={c.coverLetter ?? ''}
          onChange={(e) => set('coverLetter', e.target.value)}
        />
      </Field>

      <Field label="Подпись">
        <input
          style={s.input}
          value={c.signature ?? ''}
          onChange={(e) => set('signature', e.target.value)}
        />
      </Field>

      <Field label="Номер КП" hint="Формат: префикс-год-номер. Счётчик сбрасывается в новом году.">
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            style={{ ...s.input, maxWidth: 120 }}
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
          />
          <input
            style={{ ...s.input, maxWidth: 120 }}
            type="number"
            value={counter}
            onChange={(e) => setCounter(Number(e.target.value))}
          />
        </div>
        <div style={{ ...s.muted, ...s.small, marginTop: 4 }}>
          Следующий номер: {prefix || 'КП'}-{data?.numbering?.year ?? new Date().getFullYear()}-
          {(Number(counter) || 0) + 1}
        </div>
      </Field>

      <Field label="Папка сертификатов" hint="PDF по фабрикам прикладываются к письму отдельными файлами">
        <input style={s.input} value={certsDir} onChange={(e) => setCertsDir(e.target.value)} />
      </Field>

      <button style={s.button} disabled={busy} onClick={() => void save()}>
        Сохранить
      </button>
      {msg && <div style={{ ...s.muted, marginTop: 8 }}>{msg}</div>}
    </div>
  );
}
