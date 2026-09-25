import { useCallback, useState } from 'react';
import type { DocumentResult, WidgetApi } from '../api.ts';
import { fileToBase64 } from '../chat.ts';
import { dateTime } from './StatusBadge.tsx';
import { s } from './styles.ts';
import { errorMessage, useLoad } from './useLoad.ts';

export const DOC_KIND: Record<string, string> = {
  measurement: 'Замерный лист',
  request: 'Запрос / спецификация',
  estimate: 'Смета / КП',
  catalog: 'Каталог',
  photo: 'Фото',
  other: 'Документ',
};

const FLAG: Record<string, string> = {
  fireproof: 'противопожарная — не ассортимент',
  steel: 'сталь/алюминий — под заказ',
  nonstandard_size: 'нестандарт',
  not_found: 'в каталоге не найдено',
};

const ACCEPT = '.pdf,.xlsx,.xlsm,.docx,.jpg,.jpeg,.png,.webp,.txt,.csv';
const size = (w: number | null, h: number | null) => (w || h ? `${w ?? '?'}×${h ?? '?'}` : '—');

/** Блок «Файлы» в карточке сделки: кнопка «Разобрать файл», результат, история разборов (фаза 3). */
export function Documents({ api, leadId }: { api: WidgetApi; leadId: number }) {
  const load = useCallback(() => api.leadDocuments(leadId), [api, leadId]);
  const [list, reload] = useLoad(load);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DocumentResult | null>(null);

  const analyze = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.analyzeDocument(leadId, { name: file.name, mime: file.type, file: await fileToBase64(file) });
      setResult(r);
      reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={s.block}>
      <div style={{ ...s.row, justifyContent: 'space-between' }}>
        <span style={s.label}>Файлы клиента</span>
        <label style={{ ...s.buttonGhost, cursor: busy ? 'progress' : 'pointer' }}>
          {busy ? 'Разбираю…' : 'Разобрать файл'}
          <input type="file" accept={ACCEPT} disabled={busy} style={{ display: 'none' }} onChange={(e) => void analyze(e.target.files?.[0])} />
        </label>
      </div>
      <div style={{ ...s.muted, ...s.small }}>Замерный лист, фото, PDF, Excel, Word — результат попадёт в примечание сделки и в память клиента.</div>
      {error && <div style={s.error}>{error}</div>}
      {result && <DocumentView r={result} />}
      {list.status === 'ready' && (list.data?.items?.length ?? 0) > 0 && (
        <div style={{ ...s.col, marginTop: 8 }}>
          {list.data.items.slice(0, 5).map((d) => (
            <div key={d.id} style={s.small}>
              <span style={s.muted}>{dateTime(d.createdAt)}</span> <b>{DOC_KIND[d.kind] ?? d.kind}</b> {d.filename ?? ''}
              {d.openings ? ` · проёмов: ${d.openings}` : ''}
              {d.positions ? ` · позиций: ${d.positions}` : ''}
              <div style={s.muted}>{d.summary}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function DocumentView({ r }: { r: DocumentResult }) {
  const d = r.data;
  return (
    <div style={{ ...s.card, marginTop: 8 }}>
      <div>
        <b>{DOC_KIND[d.kind] ?? d.kind}</b> — {d.title}
        {d.customer_type === 'b2b' && <span style={{ ...s.badgeWarn, marginLeft: 6 }}>юрлицо / тендер</span>}
      </div>
      <div style={{ marginTop: 4 }}>{d.summary}</div>
      {d.openings.length > 0 && (
        <table style={{ width: '100%', marginTop: 8, fontSize: 12, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={s.muted}>
              <th align="left">Проём</th>
              <th align="left">Ш×В, мм</th>
              <th align="left">Стена</th>
              <th align="left">Полотно</th>
              <th align="left">Шт.</th>
            </tr>
          </thead>
          <tbody>
            {d.openings.map((o, i) => {
              const k = r.kit?.lines[i];
              return (
                <tr key={i}>
                  <td>{[o.label, o.room].filter(Boolean).join(' ') || `№${i + 1}`}</td>
                  <td>{size(o.width_mm, o.height_mm)}</td>
                  <td>{o.wall_mm ?? '—'}</td>
                  <td>
                    {k?.leaf_width_mm ? `${k.leaf_width_mm}×${k.leaf_height_mm ?? '?'}` : '—'}
                    {k?.nonstandard && <span style={{ ...s.badgeWarn, marginLeft: 4 }}>нестандарт</span>}
                  </td>
                  <td>{o.qty ?? 1}{o.double ? ' (двуств.)' : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {r.kit && (
        <div style={{ ...s.small, marginTop: 6 }}>
          Комплект: полотен {r.kit.totals.doors}, коробок {r.kit.totals.boxes}, наличников {r.kit.totals.casings}, доборов {r.kit.totals.extensions}
        </div>
      )}
      {d.positions.length > 0 && (
        <div style={{ ...s.col, marginTop: 8, fontSize: 12 }}>
          {d.positions.map((p, i) => {
            const m = r.matches.find((x) => x.index === i);
            return (
              <div key={i}>
                {i + 1}. {p.name}
                {p.marking ? ` [${p.marking}]` : ''} {size(p.width_mm, p.height_mm)}
                {p.qty ? ` — ${p.qty} ${p.unit ?? 'шт.'}` : ''}
                {(m?.flags ?? []).map((f) => (
                  <span key={f} style={{ ...s.badgeWarn, marginLeft: 4 }}>
                    {FLAG[f] ?? f}
                  </span>
                ))}
                {m?.products.length ? (
                  <div style={s.muted}>
                    похоже:{' '}
                    {m.products.map((x) => (
                      <a key={x.id} href={x.url ?? '#'} target="_blank" rel="noreferrer" style={{ marginRight: 6 }}>
                        {x.name}
                        {x.price ? ` ${x.price} ₽` : ''}
                      </a>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      {d.photo && <div style={{ ...s.small, marginTop: 6 }}>Фото: {[d.photo.subject, d.photo.door_type, d.photo.color, d.photo.style, d.photo.note].filter(Boolean).join(', ')}</div>}
      {d.questions.length > 0 && (
        <div style={{ ...s.small, marginTop: 6 }}>
          Уточнить у клиента: {d.questions.join('; ')}
        </div>
      )}
      <div style={{ ...s.muted, ...s.small, marginTop: 6 }}>
        {r.noted ? 'Примечание добавлено в сделку. ' : ''}
        {r.ocr ? `Распознано: ${r.ocr === 'yandex' ? 'Yandex Vision' : r.ocr === 'tesseract' ? 'Tesseract (на сервере)' : r.ocr}. ` : ''}
        {r.piiRemoved ? `Персональных данных скрыто: ${r.piiRemoved}. ` : ''}
      </div>
    </div>
  );
}
