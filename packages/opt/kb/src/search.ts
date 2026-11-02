import type { Embedder } from './embeddings.ts';
import type { KbRepo, KbSearchRow, KbSource } from './repo.ts';

/**
 * Семантический поиск по фрагментам (ТЗ раздел 4): вектор (эмбеддинг запроса) и полнотекстовый поиск
 * объединяются взвешенным RRF, top-K — ответ с подписью источника. Без ключа OpenAI работает только
 * полнотекстовая часть — результат тот же по форме.
 */
export interface KbHit {
  chunkId: number;
  sourceId: number;
  position: number;
  text: string;
  meta: KbSearchRow['meta'];
  score: number;
  /** Чем найден: вектор, текст или оба. */
  matched: ('vector' | 'text')[];
  source: { title: string; kind: KbSource['kind']; original: string | null; indexedAt: Date | null } | null;
}

export interface KbSearchResult {
  hits: KbHit[];
  /** Эмбеддинг запроса: токены и стоимость (0 — без ключа). */
  tokens: number;
  usd: number;
  model: string | null;
  ms: number;
}

const RRF_K = 60;

export function fuseRanks(vector: KbSearchRow[], text: RbRows, limit: number): { row: KbSearchRow; score: number; matched: KbHit['matched'] }[] {
  const acc = new Map<number, { row: KbSearchRow; score: number; matched: KbHit['matched'] }>();
  const take = (rows: KbSearchRow[], weight: number, kind: 'vector' | 'text') => {
    rows.forEach((row, i) => {
      const cur = acc.get(row.chunkId) ?? { row, score: 0, matched: [] };
      cur.score += weight / (RRF_K + i + 1);
      cur.matched.push(kind);
      acc.set(row.chunkId, cur);
    });
  };
  take(vector, 1, 'vector');
  take(text, 1, 'text');
  return [...acc.values()].sort((a, b) => b.score - a.score || a.row.chunkId - b.row.chunkId).slice(0, limit);
}
type RbRows = KbSearchRow[];

export async function searchKb(repo: KbRepo, embedder: Embedder | null, accountId: number, query: string, opts: { limit?: number; candidates?: number } = {}): Promise<KbSearchResult> {
  const t0 = Date.now();
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 50);
  const candidates = opts.candidates ?? Math.max(20, limit * 4);
  const q = query.trim();
  if (!q) return { hits: [], tokens: 0, usd: 0, model: null, ms: 0 };
  let vectorRows: KbSearchRow[] = [];
  let tokens = 0;
  let usd = 0;
  let model: string | null = null;
  if (embedder) {
    const e = await embedder.embed([q]);
    tokens = e.tokens;
    usd = e.usd;
    model = e.model;
    const v = e.vectors[0];
    if (v) vectorRows = await repo.searchVector(accountId, v, candidates);
  }
  const textRows = await repo.searchText(accountId, q, candidates);
  const fused = fuseRanks(vectorRows, textRows, limit);
  const sourceIds = [...new Set(fused.map((f) => f.row.sourceId))];
  const sources = new Map<number, KbSource>();
  for (const id of sourceIds) {
    const s = await repo.get(accountId, id);
    if (s) sources.set(id, s);
  }
  return {
    hits: fused.map(({ row, score, matched }) => {
      const s = sources.get(row.sourceId) ?? null;
      return { chunkId: row.chunkId, sourceId: row.sourceId, position: row.position, text: row.text, meta: row.meta, score, matched, source: s ? { title: s.title, kind: s.kind, original: s.original, indexedAt: s.indexedAt } : null };
    }),
    tokens,
    usd,
    model,
    ms: Date.now() - t0,
  };
}

/** Подпись источника для ответа покупателю и плитки: «прайс Текона (01.10.2026)», «rf-dveri.ru/…», «заметка менеджера». */
export function sourceLabel(s: Pick<KbSource, 'kind' | 'title' | 'original' | 'indexedAt'> | null): string {
  if (!s) return 'источник удалён';
  const date = s.indexedAt ? ` (${s.indexedAt.toLocaleDateString('ru-RU')})` : '';
  if (s.kind === 'url') return `${s.original ?? s.title}${date}`;
  if (s.kind === 'file') return `${s.title}${date}`;
  return `заметка «${s.title}»${date}`;
}
