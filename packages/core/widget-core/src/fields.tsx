import type { ReactNode } from 'react';
import { s } from './styles.ts';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label style={{ ...s.block, display: 'block' }}>
      <div style={s.label}>{label}</div>
      {children}
      {hint && <div style={{ ...s.muted, ...s.small, marginTop: 4 }}>{hint}</div>}
    </label>
  );
}

/** Список строк, по одной на строку. */
export const linesToList = (v: string) => v.split('\n').map((x) => x.trim()).filter(Boolean);

export function NumberInput({
  value,
  onChange,
  min,
  max,
  nullable,
  placeholder,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  nullable?: boolean;
  placeholder?: string;
}) {
  return (
    <input
      style={{ ...s.input, width: 200 }}
      type="number"
      min={min}
      max={max}
      placeholder={placeholder}
      value={value ?? ''}
      onChange={(e) => {
        const raw = e.target.value.trim();
        if (raw === '') return onChange(nullable ? null : (min ?? 0));
        onChange(Number(raw));
      }}
    />
  );
}
