import type { CSSProperties } from 'react';

// Близко к стилям amoCRM: PT Sans, серые рамки, синие акценты.
export const s = {
  root: { fontFamily: '"PT Sans", Arial, sans-serif', fontSize: 14, color: '#313942', lineHeight: 1.4 },
  block: { padding: '12px 0', borderBottom: '1px solid #e8eaeb' },
  label: { color: '#92989b', fontSize: 12, marginBottom: 4 },
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  badgeOk: { display: 'inline-block', padding: '2px 8px', borderRadius: 3, background: '#e5f6e0', color: '#2c7a18' },
  badgeBad: { display: 'inline-block', padding: '2px 8px', borderRadius: 3, background: '#fde8e8', color: '#b02a2a' },
  muted: { color: '#92989b' },
  error: { color: '#b02a2a' },
  button: {
    height: 36,
    padding: '0 16px',
    border: '1px solid #4c8bf7',
    borderRadius: 3,
    background: '#4c8bf7',
    color: '#fff',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  select: { height: 36, padding: '0 8px', border: '1px solid #d4d5d8', borderRadius: 3, fontFamily: 'inherit' },
} satisfies Record<string, CSSProperties>;
