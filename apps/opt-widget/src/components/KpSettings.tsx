import { useEffect, useState } from 'react';
import { Field, s } from '@core/widget-core';
import type { KpApi, KpConstants, KpSettingsInfo } from '../api.ts';

/** Поля постоянных частей КП: один источник правды — таблица kp_settings, в коде только подписи. */
const CONSTANT_FIELDS: { key: keyof KpConstants; label: string; hint?: string; kind: 'input' | 'textarea' | 'number' | 'lines' | 'bool' | 'pairs' }[] = [
  { key: 'sellerName', label: 'Продавец', kind: 'input' },
  { key: 'sellerRequisites', label: 'Реквизиты продавца', hint: 'Попадают в шапку предложения', kind: 'textarea' },
  { key: 'vatRate', label: 'Ставка НДС, %', hint: 'Берётся отсюда, в коде не зашита', kind: 'number' },
  { key: 'validDays', label: 'Срок действия КП, дней', kind: 'number' },
  { key: 'paymentTerms', label: 'Условия оплаты', kind: 'textarea' },
  { key: 'warranty', label: 'Гарантия', kind: 'textarea' },
  { key: 'delivery', label: 'Доставка', kind: 'textarea' },
  { key: 'coverLetter', label: 'Сопроводительный текст письма', hint: 'Модель его не пишет — берётся как есть', kind: 'textarea' },
  { key: 'analogPriceTolerancePct', label: 'Допуск цены аналога, %', hint: 'Аналог по цене — не дальше этого от цены заявки; не больше 10', kind: 'number' },
  { key: 'manufacturerDomains', label: 'Домены производителей', hint: 'По одному в строке, без http и пути; источник с таким доменом всегда считается сайтом производителя. Пусто — вид источника определяет модель', kind: 'lines' },
  { key: 'priceNote', label: 'Фраза о ценах', hint: 'Печатается в каждом КП под итогом — плейсхолдер {{price_note}} в шаблоне; пусто — без фразы', kind: 'textarea' },
  // Цены позиций (KB-WEB-ROWS): только из прайсов базы знаний, веб-поиска нет.
  { key: 'autoResearch', label: 'Искать цены автоматически при сборке черновика', hint: 'Выключено — цены из прайса только по кнопке «Найти цены» в карточке сделки. Позиция без строки прайса — «уточнить у менеджера»', kind: 'bool' },
  { key: 'maxPositionsPerRun', label: 'Позиций за одно нажатие «Найти цены»', hint: 'Не больше 200', kind: 'number' },
  { key: 'signature', label: 'Подпись', kind: 'input' },
];

/** Вкладка «Настройки КП»: постоянные части предложения, нумерация и файл-шаблон. */
export function KpSettings(props: { api: KpApi }) {
  const [data, setData] = useState<KpSettingsInfo | null>(null);
  const [c, setC] = useState<KpConstants>({});
  const [prefix, setPrefix] = useState('КП');
  const [counter, setCounter] = useState(0);
  const [certsDir, setCertsDir] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    props.api
      .kpSettings()
      .then((r) => {
        setData(r);
        setC(r.constants ?? {});
        setPrefix(r.numbering?.prefix ?? 'КП');
        setCounter(r.numbering?.counter ?? 0);
        setCertsDir(r.certsDir ?? '');
      })
      .catch((e: Error) => setMsg(`Не удалось загрузить: ${e.message}`));
  }, [props.api]);

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg(await fn());
    } catch (e) {
      setMsg(`${label}: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run('Ошибка', async () => {
      await props.api.saveKpSettings({
        constants: c,
        certsDir: certsDir.trim() === '' ? null : certsDir.trim(),
        numbering: { prefix: prefix.trim() || 'КП', counter: Number(counter) || 0 },
      });
      return 'Сохранено';
    });

  const upload = (file: File) =>
    run('Шаблон не принят', async () => {
      const r = await props.api.uploadTemplate(file.name, await fileBase64(file));
      setData((p) => (p ? { ...p, template: { exists: true, name: file.name, md5: r.md5, updatedAt: new Date().toISOString() } } : p));
      return `Шаблон загружен: ${file.name}, ${Math.round(r.size / 1024)} КБ`;
    });

  return (
    <div style={s.block}>
      <div style={s.muted}>Вёрстка предложения живёт в файле-шаблоне: модель подставляет только значения.</div>
      <TemplateUpload template={data?.template} busy={busy} onUpload={(f) => void upload(f)} />
      <ConstantsForm value={c} onChange={(patch) => setC((p) => ({ ...p, ...patch }))} />
      <Field label="Номер КП" hint="Формат: префикс-год-номер. Счётчик сбрасывается в новом году.">
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={{ ...s.input, maxWidth: 120 }} value={prefix} onChange={(e) => setPrefix(e.target.value)} />
          <input style={{ ...s.input, maxWidth: 120 }} type="number" value={counter} onChange={(e) => setCounter(Number(e.target.value))} />
        </div>
        <div style={{ ...s.muted, ...s.small, marginTop: 4 }}>
          Следующий номер: {prefix || 'КП'}-{data?.numbering?.year ?? new Date().getFullYear()}-{(Number(counter) || 0) + 1}
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

function TemplateUpload({ template, busy, onUpload }: { template: KpSettingsInfo['template'] | undefined; busy: boolean; onUpload: (f: File) => void }) {
  return (
    <Field label="Шаблон КП (DOCX)" hint="Файл с плейсхолдерами. Старый шаблон заменяется.">
      <input
        type="file"
        accept=".docx"
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onUpload(f);
        }}
      />
      <div style={{ ...s.muted, ...s.small, marginTop: 4 }}>
        {template?.exists ? `Загружен: ${template.name ?? 'kp.docx'}, md5 ${template.md5 ?? '—'}` : 'Шаблон ещё не загружен — сборка КП работать не будет'}
      </div>
    </Field>
  );
}

function ConstantsForm({ value, onChange }: { value: KpConstants; onChange: (patch: KpConstants) => void }) {
  return (
    <>
      {CONSTANT_FIELDS.map(({ key, label, hint, kind }) => {
        const v = value[key];
        const text = v === undefined ? '' : Array.isArray(v) ? v.join('\n') : kind === 'pairs' ? pairsToText(v as Record<string, number>) : String(v);
        // Список (kind lines) — по одному значению в строке; пары (kind pairs) — «имя = число»; пустое не сохраняется.
        const set = (raw: string) =>
          onChange({ [key]: kind === 'lines' ? raw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : kind === 'pairs' ? textToPairs(raw) : raw === '' ? undefined : kind === 'number' ? Number(raw) : raw });
        if (kind === 'bool') {
          return (
            <Field key={key} label={label} hint={hint}>
              <input type="checkbox" checked={Boolean(v)} onChange={(e) => onChange({ [key]: e.target.checked })} />
            </Field>
          );
        }
        return (
          <Field key={key} label={label} hint={hint}>
            {kind === 'textarea' || kind === 'lines' || kind === 'pairs' ? (
              <textarea style={{ ...s.input, minHeight: key === 'sellerRequisites' || key === 'coverLetter' ? 80 : 60 }} value={text} onChange={(e) => set(e.target.value)} />
            ) : (
              <input style={s.input} type={kind === 'number' ? 'number' : 'text'} step={kind === 'number' ? 'any' : undefined} value={text} onChange={(e) => set(e.target.value)} />
            )}
          </Field>
        );
      })}
    </>
  );
}

/** Справочник «производитель → коэффициент» ↔ строки «имя = число»; кривые строки пропускаются. */
export function pairsToText(v: Record<string, number> | undefined): string {
  return Object.entries(v ?? {})
    .map(([k, n]) => `${k} = ${n}`)
    .join('\n');
}
export function textToPairs(raw: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(.+?)\s*[=:]\s*([0-9]+(?:[.,][0-9]+)?)\s*$/.exec(line);
    if (!m) continue;
    const n = Number(m[2]?.replace(',', '.'));
    if (m[1] && Number.isFinite(n) && n > 0) out[m[1]] = n;
  }
  return out;
}

/** Файл → base64 для JSON-тела: отдельная зависимость на multipart не нужна. */
async function fileBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin);
}
