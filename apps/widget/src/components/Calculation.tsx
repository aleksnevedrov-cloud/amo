import type { CalcResult } from '../api.ts';
import { rub } from './StatusBadge.tsx';
import { s } from './styles.ts';

/** Черновик детализации — те же колонки, что в «Детализации сделки». */
export function Calculation({ c }: { c: CalcResult }) {
  const cell = { padding: '4px 6px', borderBottom: '1px solid #e8eaeb', textAlign: 'left' as const };
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', ...s.small }}>
        <thead>
          <tr style={s.muted}>
            <th style={cell}>Наименование</th>
            <th style={cell}>Кол-во</th>
            <th style={cell}>Цена</th>
            <th style={cell}>Итого</th>
          </tr>
        </thead>
        <tbody>
          {c.lines.map((l, i) => (
            <tr key={i} title={l.basis}>
              <td style={cell}>{l.name}</td>
              <td style={cell}>{l.qty}</td>
              <td style={cell}>{l.price === null ? <span style={s.error}>у менеджера</span> : rub(l.price)}</td>
              <td style={cell}>{l.total === null ? '—' : rub(l.total)}</td>
            </tr>
          ))}
          <tr>
            <td style={{ ...cell, fontWeight: 700 }} colSpan={3}>
              Итого{c.complete ? '' : ' (без позиций с ценой у менеджера)'}
            </td>
            <td style={{ ...cell, fontWeight: 700 }}>{rub(c.total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
