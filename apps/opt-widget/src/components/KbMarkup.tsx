import { useEffect, useState } from 'react';
import { errorMessage, s } from '@core/widget-core';
import type { KbSourceInfo, KpApi } from '../api.ts';

/** KB-MARKUP: допустимая наценка, % — от −50 до 300, шаг 0,1; пусто — 0. */
export const MARKUP_MIN = -50;
export const MARKUP_MAX = 300;

const pctText = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 1 });

/** Текст поля → число: «20», «12,5», «−5»; пусто — 0; неверное — null. */
export function parseMarkup(text: string): number | null {
  const t = text.trim().replace(/\s/g, '').replace(',', '.').replace('−', '-');
  if (!t) return 0;
  if (!/^-?\d+(\.\d)?$/.test(t)) return null;
  const n = Number(t);
  return n >= MARKUP_MIN && n <= MARKUP_MAX ? n : null;
}

/**
 * Наценка прайса-источника в карточке «Базы знаний»: цены в базе остаются ценами фабрики, наценка применяется при расчёте
 * КП (новые черновики и «Пересчитать» в окне КП). «Сохранить» — запись в журнал «было → стало».
 */
export function PriceMarkup({ api, src, onSaved }: { api: KpApi; src: KbSourceInfo; onSaved: (msg: string) => void }) {
  const saved = src.markupPct ?? 0;
  const [text, setText] = useState(saved ? pctText(saved) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Список перечитан (сохранение, повторная загрузка прайса) — поле показывает сохранённое значение.
  useEffect(() => setText(saved ? pctText(saved) : ''), [saved]);
  const value = parseMarkup(text);
  const changed = value !== null && value !== saved;
  const save = async () => {
    if (value === null) return;
    setBusy(true);
    setErr(null);
    try {
      await api.kbSetMarkup(src.id, value === 0 ? null : value);
      onSaved(`Прайс «${src.priceTitle ?? src.title}»: наценка ${pctText(value)} % сохранена — применяется к новым черновикам и по кнопке «Пересчитать»`);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const shown = value ?? saved;
  return (
    <div className="opt-kb-markup" style={{ ...s.row, marginTop: 6, alignItems: 'center' }}>
      <label style={{ ...s.small, display: 'flex', alignItems: 'center', gap: 6 }}>
        Наценка, %
        <input
          className="opt-kb-markup-input"
          type="text"
          inputMode="decimal"
          aria-label="Наценка, %"
          placeholder="0"
          style={{ ...s.input, width: 80 }}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <button type="button" style={s.buttonGhost} disabled={busy || !changed} onClick={() => void save()}>
        Сохранить
      </button>
      <span style={{ ...s.small, ...s.muted }}>Цены фабрики × (1 + {pctText(shown)} %) при расчёте КП</span>
      {value === null && <span style={{ ...s.small, ...s.error }}>число от −50 до 300, шаг 0,1</span>}
      {err && <span style={{ ...s.small, ...s.error }}>{err}</span>}
    </div>
  );
}
