import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Db, JournalKind, JournalRepo } from '@core/db';
import type { OcrProvider } from '@core/docs';
import { chunkDocument } from './chunk.ts';
import type { EmbedderFor } from './embeddings.ts';
import { extractForKb, KB_FILE_EXTENSIONS, KB_MAX_FILE_BYTES, kbFormatOf } from './extract.ts';
import { KB_LIMIT_BYTES, KB_LIMIT_CHUNKS, KbRepo, type KbSource } from './repo.ts';
import { searchKb, type KbSearchResult } from './search.ts';

/**
 * Ядро базы знаний опта: БД ai_door_opt_kb, файлы на томе opt-kb-files, эмбеддинги по ключу аккаунта,
 * индексация и поиск. Используется opt-api (маршруты) и opt-worker (очередь kb-index).
 * Журнал — общий журнал опта (ai_journal в ai_door_opt): события kb_index и kb_search со стоимостью.
 */

/** Очередь индексации в Redis опта (база 1): одно задание на источник. */
export const KB_QUEUE = 'kb-index';
export const KB_INDEX_JOB = 'index';
export const kbIndexJobId = (accountId: number, sourceId: number) => `kb-${accountId}-${sourceId}`;

/** Типы событий журнала опта по базе знаний; в общий JournalKind (packages/core) не добавляются — ядро не меняем. */
export const KB_INDEX_KIND = 'kb_index' as JournalKind;
export const KB_SEARCH_KIND = 'kb_search' as JournalKind;

export interface KbIndexJob {
  accountId: number;
  sourceId: number;
  userId: number | null;
}

export interface KbIndexResult {
  sourceId: number;
  status: 'indexed' | 'error';
  chunks: number;
  embeddedChunks: number;
  tokens: number;
  usd: number;
  textChars: number;
  ms: number;
  error: string | null;
}

export interface KbCoreDeps {
  db: Db;
  filesRoot: string;
  embedderFor: EmbedderFor;
  /** OCR аккаунта по его настройке «Разбор файлов»; null — выключен. */
  ocrFor(accountId: number): Promise<OcrProvider | null>;
  journal: Pick<JournalRepo, 'add'>;
  /** Курс для cost_rub в журнале. */
  usdRubRate(accountId: number): Promise<number>;
}

export class KbLimitError extends Error {
  override name = 'KbLimitError';
}

export interface KbCore {
  db: Db;
  repo: KbRepo;
  filesRoot: string;
  embedderFor: EmbedderFor;
  /** Заметка менеджера: сохраняется файлом на томе и ждёт индексации (статус new). */
  addText(accountId: number, input: { title: string; content: string; userId: number | null }): Promise<number>;
  /** Файл из вкладки: проверка формата и лимитов, копия на томе, статус new. */
  addFile(accountId: number, input: { filename: string; mime: string | null; bytes: Uint8Array; userId: number | null }): Promise<number>;
  /** Источник снова в статус new; постановку в очередь делает вызывающий. */
  reindex(accountId: number, sourceId: number): Promise<KbSource>;
  /** Удаление источника, фрагментов и файла. */
  remove(accountId: number, sourceId: number): Promise<KbSource | null>;
  /** Индексация одного источника (задание очереди kb-index). */
  index(job: KbIndexJob): Promise<KbIndexResult>;
  /** Семантический поиск с записью стоимости в журнал. */
  search(accountId: number, query: string, opts?: { limit?: number; userId?: number | null; leadId?: number | null; silent?: boolean }): Promise<KbSearchResult>;
  close(): Promise<void>;
}

const safeName = (name: string) => name.replace(/[^0-9A-Za-zА-Яа-яЁё._-]+/g, '_').slice(0, 120) || 'file';

export function createKbCore(d: KbCoreDeps): KbCore {
  const repo = new KbRepo(d.db);
  const pathFor = (accountId: number, sourceId: number, name: string) => join(d.filesRoot, String(accountId), `${sourceId}-${safeName(name)}`);

  async function store(accountId: number, sourceId: number, name: string, bytes: Uint8Array): Promise<string> {
    const path = pathFor(accountId, sourceId, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    await repo.setFilePath(sourceId, path, bytes.byteLength);
    return path;
  }

  async function assertBytes(accountId: number, more: number) {
    const u = await repo.usage(accountId);
    if (u.bytes + more > KB_LIMIT_BYTES) throw new KbLimitError(`Лимит базы знаний 500 МБ исчерпан: занято ${(u.bytes / 1024 / 1024).toFixed(1)} МБ`);
  }

  const core: KbCore = {
    db: d.db,
    repo,
    filesRoot: d.filesRoot,
    embedderFor: d.embedderFor,

    async addText(accountId, input) {
      const content = input.content.trim();
      if (!content) throw new Error('Пустой текст');
      const bytes = new TextEncoder().encode(content);
      await assertBytes(accountId, bytes.byteLength);
      const title = input.title.trim() || content.split('\n')[0]?.slice(0, 80) || 'Заметка';
      const id = await repo.createSource({ accountId, kind: 'text', title, original: null, mime: 'text/plain', sizeBytes: bytes.byteLength, createdBy: input.userId });
      await store(accountId, id, 'text.txt', bytes);
      return id;
    },

    async addFile(accountId, input) {
      if (!input.bytes.byteLength) throw new Error('Пустой файл');
      if (input.bytes.byteLength > KB_MAX_FILE_BYTES) throw new Error('Файл больше 50 МБ');
      kbFormatOf(input.mime ?? '', input.filename);
      const ext = input.filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
      if (ext && !(KB_FILE_EXTENSIONS as readonly string[]).includes(ext)) throw new Error(`Расширение .${ext} не принимается: ${KB_FILE_EXTENSIONS.join(', ')}`);
      await assertBytes(accountId, input.bytes.byteLength);
      const id = await repo.createSource({ accountId, kind: 'file', title: input.filename, original: input.filename, mime: input.mime, sizeBytes: input.bytes.byteLength, createdBy: input.userId });
      await store(accountId, id, input.filename, input.bytes);
      return id;
    },

    async reindex(accountId, sourceId) {
      const s = await repo.get(accountId, sourceId);
      if (!s) throw new Error('Источник не найден');
      await repo.markNew(sourceId);
      return { ...s, status: 'new', error: null };
    },

    async remove(accountId, sourceId) {
      const s = await repo.remove(accountId, sourceId);
      if (s?.filePath) await rm(s.filePath, { force: true }).catch(() => undefined);
      return s;
    },

    async index(job) {
      const t0 = Date.now();
      const { accountId, sourceId } = job;
      const source = await repo.get(accountId, sourceId);
      if (!source) throw new Error(`источник ${sourceId} не найден`);
      try {
        const text = await textOf(source);
        const chunks = chunkDocument(text);
        if (!chunks.length) throw new Error('В источнике не найден текст');
        const u = await repo.usage(accountId);
        if (u.chunks - source.chunks + chunks.length > KB_LIMIT_CHUNKS) {
          throw new KbLimitError(`Лимит 20 000 фрагментов на аккаунт: в базе ${u.chunks - source.chunks}, источник даёт ещё ${chunks.length}`);
        }
        const embedder = await d.embedderFor(accountId);
        let vectors: (number[] | null)[] = chunks.map(() => null);
        let tokens = 0;
        let usd = 0;
        if (embedder) {
          const e = await embedder.embed(chunks.map((c) => c.text));
          vectors = chunks.map((_, i) => e.vectors[i] ?? null);
          tokens = e.tokens;
          usd = e.usd;
        }
        await repo.replaceChunks(accountId, sourceId, chunks.map((c, i) => ({ position: c.position, text: c.text, meta: c.meta, embedding: vectors[i] ?? null })));
        const embedded = vectors.filter(Boolean).length;
        await repo.markIndexed(sourceId, { chunks: chunks.length, embeddedChunks: embedded });
        const rate = await d.usdRubRate(accountId);
        const ms = Date.now() - t0;
        await d.journal.add({
          accountId,
          kind: KB_INDEX_KIND,
          summary: `База знаний: «${source.title}» проиндексирован — фрагментов ${chunks.length}${embedded ? `, эмбеддингов ${embedded}` : ', без эмбеддингов (нет ключа OpenAI — только полнотекстовый поиск)'}, ${(ms / 1000).toFixed(1)} с`,
          details: { sourceId, kind: source.kind, chunks: chunks.length, embedded, tokens, textChars: text.length, model: embedder?.model ?? null, userId: job.userId },
          inputTokens: tokens,
          costUsd: usd,
          costRub: usd * rate,
        });
        return { sourceId, status: 'indexed', chunks: chunks.length, embeddedChunks: embedded, tokens, usd, textChars: text.length, ms, error: null };
      } catch (err) {
        const message = (err as Error).message;
        await repo.markError(sourceId, message);
        await d.journal.add({ accountId, kind: KB_INDEX_KIND, summary: `База знаний: «${source.title}» не проиндексирован — ${message}`, details: { sourceId, kind: source.kind, status: 'error', userId: job.userId } }).catch(() => undefined);
        return { sourceId, status: 'error', chunks: 0, embeddedChunks: 0, tokens: 0, usd: 0, textChars: 0, ms: Date.now() - t0, error: message };
      }
    },

    async search(accountId, query, opts = {}) {
      const embedder = await d.embedderFor(accountId);
      const r = await searchKb(repo, embedder, accountId, query, { limit: opts.limit });
      if (!opts.silent) {
        const rate = r.usd ? await d.usdRubRate(accountId) : 0;
        await d.journal
          .add({
            accountId,
            leadId: opts.leadId ?? null,
            kind: KB_SEARCH_KIND,
            summary: `Поиск по базе знаний «${query.trim().slice(0, 120)}»: найдено ${r.hits.length}${r.model ? '' : ' (без эмбеддингов)'}`,
            details: { query: query.trim().slice(0, 500), hits: r.hits.map((h) => ({ sourceId: h.sourceId, chunkId: h.chunkId, score: Number(h.score.toFixed(4)) })), model: r.model, tokens: r.tokens, ms: r.ms, userId: opts.userId ?? null },
            inputTokens: r.tokens,
            costUsd: r.usd,
            costRub: r.usd * rate,
          })
          .catch(() => undefined);
      }
      return r;
    },

    async close() {
      await d.db.end();
    },
  };

  /** Текст источника: заметка — как есть; файл — извлечение с OCR аккаунта; ссылка — этап 2. */
  async function textOf(source: KbSource): Promise<string> {
    if (!source.filePath) throw new Error('У источника нет файла на томе — добавьте его заново');
    const bytes = new Uint8Array(await readFile(source.filePath));
    if (source.kind === 'text') return new TextDecoder('utf-8').decode(bytes);
    if (source.kind === 'file') {
      const r = await extractForKb(bytes, source.mime ?? '', source.original ?? source.title, { ocr: await d.ocrFor(source.accountId) });
      return r.text;
    }
    throw new Error('Источники-ссылки появятся на этапе 2');
  }

  return core;
}
