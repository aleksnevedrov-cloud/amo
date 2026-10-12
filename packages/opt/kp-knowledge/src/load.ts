import { readFile } from 'node:fs/promises';
import type { ZodTypeAny } from 'zod';
import { CsvError, parseCsv, parseNumber } from './csv.ts';
import { KINDS, type KnowledgeKind } from './kinds.ts';
import { b2bSchema, COLUMNS, ROW_SCHEMAS, type ColumnSpec, type KnowledgeData } from './schemas.ts';

export interface LoadError {
  line: number;
  message: string;
}

export type LoadResult<K extends KnowledgeKind> = { ok: true; data: KnowledgeData[K]; rows: number } | { ok: false; errors: LoadError[] };

/** Разбор и валидация файла справочника. Ошибки — с номером строки файла, все сразу, а не по одной. */
export function loadKnowledge<K extends KnowledgeKind>(kind: K, text: string): LoadResult<K> {
  if (kind === 'b2b') return loadMarkdown(text) as LoadResult<K>;
  return loadCsv(kind as Exclude<KnowledgeKind, 'b2b'>, text) as LoadResult<K>;
}

/** Текст шаблона из templates/ — заказчик скачивает его из виджета. */
export async function templateText(kind: KnowledgeKind): Promise<string> {
  return readFile(new URL(`../templates/${KINDS[kind].template}`, import.meta.url), 'utf8');
}

function loadCsv(kind: Exclude<KnowledgeKind, 'b2b'>, text: string): LoadResult<typeof kind> {
  let table;
  try {
    table = parseCsv(text);
  } catch (err) {
    return err instanceof CsvError ? { ok: false, errors: [{ line: err.line, message: err.message }] } : { ok: false, errors: [{ line: 0, message: (err as Error).message }] };
  }
  const specs = COLUMNS[kind];
  const index = mapColumns(specs, table.header);
  const missing = specs.filter((s) => s.required && index[s.key] === undefined).map((s) => s.aliases[0]);
  if (missing.length) return { ok: false, errors: [{ line: 1, message: `нет обязательных колонок: ${missing.join(', ')}` }] };
  const errors: LoadError[] = [];
  const rows: unknown[] = [];
  const schema: ZodTypeAny = ROW_SCHEMAS[kind];
  for (const row of table.rows) {
    const raw: Record<string, unknown> = {};
    for (const s of specs) {
      const i = index[s.key];
      const v = i === undefined ? '' : (row.cells[i] ?? '');
      raw[s.key] = s.numeric ? (v.trim() === '' ? null : parseNumber(v)) : v;
      if (s.numeric && v.trim() !== '' && raw[s.key] === null) errors.push({ line: row.line, message: `колонка «${s.aliases[0]}»: не число: «${v}»` });
    }
    if (raw.priceRub === null) raw.priceRub = undefined;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const col = specs.find((s) => s.key === issue.path[0])?.aliases[0] ?? String(issue.path[0]);
        errors.push({ line: row.line, message: `колонка «${col}»: ${issue.message}` });
      }
    } else rows.push(parsed.data);
  }
  if (errors.length) return { ok: false, errors: dedupe(errors) };
  return { ok: true, data: rows as KnowledgeData[typeof kind], rows: rows.length };
}

function loadMarkdown(text: string): LoadResult<'b2b'> {
  const body = text.replace(/<!--[\s\S]*?-->/g, '');
  const sections: { title: string; text: string }[] = [];
  let current: { title: string; text: string } | null = null;
  for (const line of body.split(/\r\n|\r|\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      if (current) sections.push(current);
      current = { title: h[1] ?? '', text: '' };
    } else if (current) current.text += `${line}\n`;
  }
  if (current) sections.push(current);
  const parsed = b2bSchema.safeParse({ sections: sections.map((s) => ({ title: s.title, text: s.text.trim() })) });
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => ({ line: 0, message: i.path.length ? `раздел ${Number(i.path[1]) + 1}: ${i.message}` : i.message })) };
  }
  return { ok: true, data: parsed.data, rows: parsed.data.sections.length };
}

function mapColumns(specs: ColumnSpec[], header: string[]): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = {};
  for (const s of specs) {
    const i = header.findIndex((h) => s.aliases.includes(h.replace(/ё/g, 'е')) || s.aliases.includes(h));
    if (i >= 0) out[s.key] = i;
  }
  return out;
}

const dedupe = (xs: LoadError[]) => xs.filter((e, i) => xs.findIndex((o) => o.line === e.line && o.message === e.message) === i).slice(0, 50);
