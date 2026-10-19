import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Db, JournalKind, JournalRepo } from '@core/db';
import type { OcrProvider } from '@core/docs';
import { chunkDocument } from './chunk.ts';
import type { EmbedderFor } from './embeddings.ts';
import { extractForKb, KB_FILE_EXTENSIONS, KB_MAX_FILE_BYTES, kbFormatOf } from './extract.ts';
import { createUrlFetcher, type UrlFetcher } from './fetch-url.ts';
import { htmlToKbText, sectionLinks } from './html.ts';
import { parsePublicUrl } from './safe-url.ts';
import { draftsToPrices, extractPrices, previewPriceList, type ColumnMapping, type ImportDefaults } from './price-list.ts';
import { priceListKeyOf, priceListTitleOf } from './price-key.ts';
import { defaultCategoryOfPriceKey, type ComponentKind } from './category.ts';
import { isPriceBook, parsePriceBook, type BookProduct, type PriceBook } from './price-book.ts';
import { featuresFromColumns, featuresOf, mergeFeatures } from './features.ts';
import { KbAliasesRepo, KbPricesRepo } from './prices.ts';
import { readKbSheetRows } from './extract.ts';
import { KB_LIMIT_BYTES, KB_LIMIT_CHUNKS, KbRepo, type KbSource, type PriceImportSummary } from './repo.ts';
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

/** Хуки задания индексации: постановка дочерних страниц раздела в очередь (обход до CRAWL_MAX_PAGES страниц). */
export interface KbIndexHooks {
  enqueue?: (job: KbIndexJob) => Promise<void>;
}

/** Период обновления ссылки по умолчанию, дни (ТЗ раздел 3). */
export const DEFAULT_URL_REFRESH_DAYS = 30;
/** Обход раздела: не больше страниц, включая саму страницу раздела. */
export const CRAWL_MAX_PAGES = 50;

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
  /** Цены, импортированные автоматически из xlsx-прайса (KB-PRICELIST, б); null — файл не прайс. */
  prices: number | null;
  /** Итог импорта прайса (KB-MULTIPRICE): обновление или новый прайс, было/стало/удалено/добавлено. */
  priceImport?: PriceImportResult | null;
}

/** Импорт прайса (кнопка «Импортировать» или автоматически после индексации xlsx). */
export interface PriceImportInput extends ImportDefaults {
  mapping?: Partial<ColumnMapping>;
  userId: number | null;
  /** Автоимпорт после индексации: без подтверждения менеджера, НДС по заголовку колонки. */
  auto?: boolean;
}

export interface PriceImportResult {
  imported: number;
  skipped: number;
  /** Сколько цен удалено перед вставкой: этого файла и файлов с тем же ключом прайса (KB-MULTIPRICE). */
  replaced: number;
  headerFound: boolean;
  /** Ключ и короткое название прайса; updated — файл с тем же ключом уже был (обновление, а не новый прайс). */
  priceKey: string;
  priceTitle: string;
  updated: boolean;
  was: number;
  removed: number;
  added: number;
  /** Многолистовой прайс: счётчики по вкладкам; error — импорт отменён (старые данные сохранены). */
  book?: PriceImportSummary['book'];
  error?: string;
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
  /** Скачивание по ссылке (в тестах подменяется); по умолчанию — с проверкой адреса и лимитом 50 МБ. */
  fetchUrl?: UrlFetcher;
}

export class KbLimitError extends Error {
  override name = 'KbLimitError';
}

export interface KbCore {
  db: Db;
  repo: KbRepo;
  /** Структурные цены и синонимы (этап 3). */
  prices: KbPricesRepo;
  aliases: KbAliasesRepo;
  filesRoot: string;
  embedderFor: EmbedderFor;
  /** Заметка менеджера: сохраняется файлом на томе и ждёт индексации (статус new). */
  addText(accountId: number, input: { title: string; content: string; userId: number | null }): Promise<number>;
  /** Файл из вкладки: проверка формата и лимитов, копия на томе, статус new. */
  addFile(accountId: number, input: { filename: string; mime: string | null; bytes: Uint8Array; userId: number | null }): Promise<number>;
  /** Цены из xlsx-источника в kb_prices: прежний прайс аккаунта заменяется целиком; null — источник не xlsx. */
  importPriceList(accountId: number, sourceId: number, input: PriceImportInput): Promise<PriceImportResult | null>;
  /**
   * Ссылка на страницу сайта или файл (pdf/xlsx по ссылке): проверка адреса, статус new; скачивание — в задании индексации.
   * Повторное добавление того же адреса — переиндексация существующего источника. crawl — обойти раздел (до 50 страниц).
   */
  addUrl(accountId: number, input: { url: string; refreshDays?: number | null; crawl?: boolean; userId: number | null }): Promise<{ id: number; existed: boolean }>;
  /** Ссылки с подошедшим сроком обновления → статус new и в очередь; возвращает, сколько поставлено. */
  refreshDue(enqueue: (job: KbIndexJob) => Promise<void>, limit?: number): Promise<number>;
  /** Источник снова в статус new; постановку в очередь делает вызывающий. */
  reindex(accountId: number, sourceId: number): Promise<KbSource>;
  /** Удаление источника, фрагментов и файла. */
  remove(accountId: number, sourceId: number): Promise<KbSource | null>;
  /** Индексация одного источника (задание очереди kb-index). */
  index(job: KbIndexJob, hooks?: KbIndexHooks): Promise<KbIndexResult>;
  /** Семантический поиск с записью стоимости в журнал. */
  search(accountId: number, query: string, opts?: { limit?: number; userId?: number | null; leadId?: number | null; silent?: boolean }): Promise<KbSearchResult>;
  close(): Promise<void>;
}

const safeName = (name: string) => name.replace(/[^0-9A-Za-zА-Яа-яЁё._-]+/g, '_').slice(0, 120) || 'file';

export function createKbCore(d: KbCoreDeps): KbCore {
  const repo = new KbRepo(d.db);
  const prices = new KbPricesRepo(d.db);
  const fetchUrl = d.fetchUrl ?? createUrlFetcher();
  const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
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
    prices,
    aliases: new KbAliasesRepo(d.db),
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

    async addUrl(accountId, input) {
      // Синтаксис и буквальные внутренние адреса — сразу; DNS и редиректы проверяет скачивание в задании.
      const url = parsePublicUrl(input.url).toString();
      const existing = await repo.findUrl(accountId, url);
      const refreshDays = input.refreshDays === undefined ? DEFAULT_URL_REFRESH_DAYS : input.refreshDays;
      if (existing) {
        await repo.setFetchInfo(existing.id, { httpStatus: existing.httpStatus, contentHash: existing.contentHash, mime: null, refreshDays });
        if (input.crawl && !existing.crawl) await d.db.query('UPDATE kb_sources SET crawl = true WHERE id = $1', [existing.id]);
        await repo.markNew(existing.id);
        return { id: existing.id, existed: true };
      }
      const id = await repo.createSource({ accountId, kind: 'url', title: url, original: url, sizeBytes: 0, refreshDays, createdBy: input.userId, crawl: Boolean(input.crawl) });
      return { id, existed: false };
    },

    async refreshDue(enqueue, limit = 20) {
      const due = await repo.takeDueForRefresh(limit);
      for (const s of due) await enqueue({ accountId: s.accountId, sourceId: s.id, userId: null });
      return due.length;
    },

    async reindex(accountId, sourceId) {
      const s = await repo.get(accountId, sourceId);
      if (!s) throw new Error('Источник не найден');
      await repo.markNew(sourceId);
      return { ...s, status: 'new', error: null };
    },

    /** Удаление источника: его цены уходят вместе с ним (kb_prices.source_id ON DELETE CASCADE, KB-PRICELIST а), сирот нет. */
    async remove(accountId, sourceId) {
      const s = await repo.remove(accountId, sourceId);
      if (s?.filePath) await rm(s.filePath, { force: true }).catch(() => undefined);
      return s;
    },

    async importPriceList(accountId, sourceId, input) {
      const source = await repo.get(accountId, sourceId);
      if (!source?.filePath) return null;
      if (!/\.(xlsx|xlsm)$/i.test(source.original ?? source.title) && !/spreadsheetml/i.test(source.mime ?? '')) return null;
      const bytes = new Uint8Array(await readFile(source.filePath));
      const allRows = await readKbSheetRows(bytes);
      // KB-PRICE-SHEETS: файл с вкладкой «ID» — многолистовой прайс, все вкладки одной транзакцией.
      if (isPriceBook(allRows)) return importPriceBook(accountId, sourceId, source, parsePriceBook(allRows), input);
      const preview = await previewPriceList(bytes, input.mapping ?? {});
      if (input.auto && !preview.isPriceList) return null;
      const { drafts, skipped } = extractPrices(await readKbSheetRows(bytes), preview.mapping);
      // Ключ прайса — по имени файла (KB-MULTIPRICE): заменяются цены только файлов с тем же ключом.
      const priceKey = priceListKeyOf(source.original ?? source.title);
      const priceTitle = priceListTitleOf(priceKey);
      if (!drafts.length) return { imported: 0, skipped, replaced: 0, headerFound: preview.headerFound, priceKey, priceTitle, updated: false, was: 0, removed: 0, added: 0 };
      // KB-COMPONENTS: строки без ключевых слов получают категорию по имени файла («Прайс_фурнитура…» → фурнитура).
      const defaults: ImportDefaults = { factory: input.factory ?? null, validAt: input.validAt, vat: input.vat ?? preview.vatHint, nonstandard: input.nonstandard, confidence: input.confidence, category: defaultCategoryOfPriceKey(priceKey) };
      const sameKey = await repo.byPriceKey(accountId, priceKey, sourceId);
      const r = await prices.replacePriceList(accountId, sourceId, draftsToPrices(drafts, defaults).map((x) => ({ ...x, createdBy: input.userId })), sameKey.map((x) => x.id));
      const updated = sameKey.length > 0 || (source.priceKey === priceKey && r.was > 0);
      await repo.setPriceInfo(sourceId, priceKey, { title: priceTitle, updated, was: r.was, imported: r.imported, removed: r.removed, added: r.added, at: new Date().toISOString() });
      const summary = updated
        ? `прайс «${priceTitle}» обновлён: было ${r.was}, стало ${r.imported}; удалено ${r.removed}, добавлено ${r.added}${sameKey.length ? ` (прежний файл: ${sameKey.map((x) => `«${x.title}»`).join(', ')})` : ''}`
        : `из прайса «${source.title}» импортировано цен ${r.imported}${input.auto ? ' автоматически' : ''} (прайс «${priceTitle}»)`;
      await d.journal.add({
        accountId,
        kind: KB_INDEX_KIND,
        summary: `База знаний: ${summary}${skipped ? `, пропущено строк ${skipped}` : ''}`,
        details: { sourceId, imported: r.imported, replaced: r.replaced, was: r.was, removed: r.removed, added: r.added, updated, priceKey, priceTitle, replacedSources: sameKey.map((x) => x.id), skipped, auto: Boolean(input.auto), factory: input.factory ?? null, validAt: input.validAt ?? null, vat: defaults.vat, mapping: preview.mapping, userId: input.userId, audit: 'kb_prices' },
      });
      return { imported: r.imported, skipped, replaced: r.replaced, headerFound: preview.headerFound, priceKey, priceTitle, updated, was: r.was, removed: r.removed, added: r.added };
    },

    async index(job, hooks = {}) {
      const t0 = Date.now();
      const { accountId, sourceId } = job;
      let source = await repo.get(accountId, sourceId);
      if (!source) throw new Error(`источник ${sourceId} не найден`);
      try {
        let crawlHtml: string | null = null;
        if (source.kind === 'url') {
          // Ссылка: скачиваем заново при каждой индексации; неизменённая страница (тот же хэш) эмбеддинги не пересчитывает.
          const got = await downloadUrl(source);
          crawlHtml = got.html;
          if (got.hash === source.contentHash && source.status !== 'error' && source.chunks > 0) {
            await repo.setFetchInfo(sourceId, { httpStatus: got.status, contentHash: got.hash, mime: got.mime });
            await repo.markIndexed(sourceId, { chunks: source.chunks, embeddedChunks: source.embeddedChunks, sizeBytes: got.size });
            await d.journal.add({ accountId, kind: KB_INDEX_KIND, summary: `База знаний: «${source.title}» без изменений — фрагментов ${source.chunks}, следующая проверка через ${source.refreshDays ?? DEFAULT_URL_REFRESH_DAYS} дн.`, details: { sourceId, kind: 'url', unchanged: true, httpStatus: got.status, userId: job.userId } });
            if (source.crawl && crawlHtml) await crawl(source, crawlHtml, hooks);
            return { sourceId, status: 'indexed', chunks: source.chunks, embeddedChunks: source.embeddedChunks, tokens: 0, usd: 0, textChars: 0, ms: Date.now() - t0, error: null, prices: null };
          }
          await repo.setFetchInfo(sourceId, { httpStatus: got.status, contentHash: got.hash, mime: got.mime });
          if (got.title && (source.title === source.original || !source.title)) await repo.setTitle(sourceId, got.title);
          source = (await repo.get(accountId, sourceId)) ?? source;
        }
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
        if (source.crawl && crawlHtml) await crawl(source, crawlHtml, hooks);
        // Загруженный xlsx с колонками модели и цены — прайс: цены импортируются сразу, без отдельного шага (KB-PRICELIST, б).
        let pricesImported: number | null = null;
        let priceImport: PriceImportResult | null = null;
        if (source.kind === 'file') {
          try {
            const imp = await this.importPriceList(accountId, sourceId, { userId: job.userId, auto: true });
            pricesImported = imp ? imp.imported : null;
            priceImport = imp;
          } catch (err) {
            await d.journal.add({ accountId, kind: KB_INDEX_KIND, summary: `База знаний: «${source.title}» проиндексирован, но цены из прайса не импортированы — ${(err as Error).message}`, details: { sourceId, kind: source.kind, status: 'prices_error', userId: job.userId } }).catch(() => undefined);
          }
        }
        return { sourceId, status: 'indexed', chunks: chunks.length, embeddedChunks: embedded, tokens, usd, textChars: text.length, ms, error: null, prices: pricesImported, priceImport };
      } catch (err) {
        const message = (err as Error).message;
        await repo.markError(sourceId, message);
        await d.journal.add({ accountId, kind: KB_INDEX_KIND, summary: `База знаний: «${source.title}» не проиндексирован — ${message}`, details: { sourceId, kind: source.kind, status: 'error', userId: job.userId } }).catch(() => undefined);
        return { sourceId, status: 'error', chunks: 0, embeddedChunks: 0, tokens: 0, usd: 0, textChars: 0, ms: Date.now() - t0, error: message, prices: null };
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

  /** Текст источника: заметка — как есть; файл и файл по ссылке — извлечение с OCR аккаунта; страница — текст уже сохранён при скачивании. */
  /**
   * Многолистовой прайс (KB-PRICE-SHEETS): карточки товаров по ID, компоненты по статусам, фурнитура по ID тарифа (сверка цен
   * с другими файлами), размеры, правило нестандарта, словарь, синонимы — одной транзакцией; ошибка на любой вкладке —
   * старые данные остаются, причина в журнале (лист, строка, колонка).
   */
  async function importPriceBook(accountId: number, sourceId: number, source: KbSource, book: PriceBook, input: PriceImportInput): Promise<PriceImportResult> {
    const priceKey = priceListKeyOf(source.original ?? source.title);
    const priceTitle = priceListTitleOf(priceKey);
    const empty: PriceImportResult = { imported: 0, skipped: book.skipped.length, replaced: 0, headerFound: true, priceKey, priceTitle, updated: false, was: 0, removed: 0, added: 0 };
    const fail = async (reason: string, errors: PriceBook['errors']) => {
      await d.journal.add({ accountId, kind: KB_INDEX_KIND, summary: `База знаний: прайс «${priceTitle}» («${source.title}») не импортирован — ${reason}; прежние данные прайса сохранены`, details: { sourceId, priceKey, status: 'book_error', errors, skipped: book.skipped, userId: input.userId, audit: 'kb_prices' } });
      // Причина — в карточку источника (виджет показывает «не импортирован: …»), строк у источника нет.
      await repo.setPriceInfo(sourceId, priceKey, { title: priceTitle, updated: false, was: 0, imported: 0, removed: 0, added: 0, at: new Date().toISOString(), book: null, error: reason });
      return { ...empty, error: reason };
    };
    if (book.errors.length) {
      const e = book.errors[0] as PriceBook['errors'][number];
      return fail(`${e.sheet}${e.row ? `, строка ${e.row}` : ''}${e.column ? `, колонка «${e.column}»` : ''}: ${e.message}${book.errors.length > 1 ? ` (и ещё ${book.errors.length - 1})` : ''}`, book.errors);
    }
    const sameKey = await repo.byPriceKey(accountId, priceKey, sourceId);
    const replaceIds = sameKey.map((x) => x.id);
    // Фурнитура: один тариф на аккаунт — расхождение цены с другим файлом (не того же ключа) — ошибка импорта.
    const foreign = (await prices.listByOrigin(accountId, 'price_list')).filter((r) => r.tariffId && r.sourceId !== sourceId && !replaceIds.includes(r.sourceId ?? -1));
    const conflicts = book.hardware.filter((h) => foreign.some((r) => r.tariffId === h.tariffId && (r.price !== (h.price ?? 0) || (h.price === null) !== (r.price === 0)))).map((h) => h.tariffId);
    if (conflicts.length) return fail(`вкладка «Дополнения»: цена тарифа ${conflicts.join(', ')} расходится с уже загруженным прайсом «${foreign.find((r) => conflicts.includes(r.tariffId ?? ''))?.priceTitle ?? ''}»`, conflicts.map((id) => ({ sheet: 'Дополнения', row: null, column: 'Цена', message: `тариф ${id}: цена расходится с другим файлом` })));
    const vat = input.vat ?? 'unknown';
    const validAt = input.validAt ?? new Date();
    const rows: Parameters<KbPricesRepo['replacePriceBook']>[3]['rows'] = [];
    const sizesByProduct = new Map<string, { widthMm: number; heightMm: number }[]>();
    for (const z of book.sizes) sizesByProduct.set(z.productId, [...(sizesByProduct.get(z.productId) ?? []), { widthMm: z.widthMm, heightMm: z.heightMm }]);
    const doorFeatures = (p: BookProduct) => mergeFeatures(featuresOf([p.model, p.abbr, p.typeText, p.equipment].filter(Boolean).join(' | ')), featuresFromColumns({ go: p.card.fill === 'solid' ? 'Г' : p.card.fill === 'glazed' ? 'О' : p.typeText, coating: p.coating, material: p.material, construction: p.construction, purpose: p.purpose, fire: p.fire }));
    let components = 0;
    let estimates = 0;
    for (const p of book.products) {
      const f = doorFeatures(p);
      const leaves = p.card.leafCount === 2 || p.card.geometry === 'pair' || p.card.geometry === 'overall_pair' || p.card.geometry === 'each_leaf' ? 2 : p.card.leafCount === 1 ? 1 : f.leaves;
      // Единица базы (вкладка ID) задаёт тип: block — дверной блок, leaf — полотно; иначе «ДПГ» в названии делало блок полотном (п. 7).
      const type = p.card.unit === 'block' || p.card.unit === 'leaf_pair' ? 'block' : p.card.unit === 'leaf' ? 'leaf' : f.type;
      const features = { ...f, type, leaves: leaves ?? null, fire: p.fire && /ei\s?-?\s?\d{2}/i.test(p.fire) ? f.fire : f.fire };
      const sizes = sizesByProduct.get(p.productId ?? '') ?? [];
      const family = p.family ?? (features.material === 'steel' ? 'steel' : features.material === 'aluminium' ? 'aluminium' : 'interior');
      const componentStatus: Partial<Record<ComponentKind, 'priced' | 'included' | 'not_priced'>> = {};
      for (const [kind, c] of Object.entries(p.components) as [ComponentKind, { status: 'priced' | 'included' | 'not_priced'; price: number | null }][]) componentStatus[kind] = c.status;
      const base = { factory: input.factory ?? null, unit: 'шт', vat, validAt, confidence: input.confidence, origin: 'price_list' as const, nonstandard: {}, abbr: p.abbr, description: [p.typeText, p.construction, p.purpose, p.fire].filter(Boolean).join('; ') || null, sourceRow: p.row, features, coating: p.coating, equipment: p.equipment, productId: p.productId, status: p.status, estimate: p.estimate, family: family as BookProduct['family'], componentStatus, card: p.card, note: `лист 1, строка ${p.row}${p.estimate ? '; сметная цена' : ''}` };
      if (p.estimate) estimates += 1;
      // Дверь: одна строка на ID товара без размера — размеры живут в kb_sizes, нестандарт считается по сетке модели (book-pricing).
      rows.push({ ...base, model: p.model, price: p.price as number, widthMm: null, heightMm: null, category: 'door', note: `${base.note}${sizes.length ? `; размеров в сетке: ${sizes.length}` : ''}` });
      // Компоненты со статусом priced — отдельные строки комплектующих к модели; included / not_priced — только статус в карточке двери.
      for (const [kind, c] of Object.entries(p.components) as [ComponentKind, { status: 'priced' | 'included' | 'not_priced'; price: number | null }][]) {
        if (c.status !== 'priced' || !c.price) continue;
        rows.push({ ...base, model: `${kind.charAt(0).toUpperCase()}${kind.slice(1)} (${p.model})`, price: c.price, widthMm: null, heightMm: null, category: 'component', componentKind: kind, equipment: null, description: `комплектующее к ${p.model}`, estimate: false, status: p.status === 'inactive' ? 'inactive' : 'active', card: null, componentStatus: null, note: `лист 1, строка ${p.row}, колонка «${kind}»` });
        components += 1;
      }
    }
    let hardwareUnpriced = 0;
    for (const h of book.hardware) {
      if (h.price === null) hardwareUnpriced += 1;
      rows.push({ model: h.name, factory: input.factory ?? null, unit: h.unit, widthMm: null, heightMm: null, price: h.price ?? 0, vat, validAt, confidence: input.confidence, origin: 'price_list', nonstandard: {}, note: `вкладка «Дополнения», строка ${h.row}${h.price === null ? '; цены нет' : ''}`, sourceRow: h.row, category: 'hardware', tariffId: h.tariffId, status: h.price === null ? 'estimate_only' : h.status, appliesTo: h.forModels === '*' ? [] : h.forModels, card: { unit: null, sizeBasis: null, geometry: null, fill: null, comment: null, gosts: [], leafCount: null, colors: [], baseIncludes: null, note: h.type, technical: null, quoteNotes: [], priceConditions: null, hardwareUnit: h.unit, includes: h.includes, clarify: h.clarify }, description: h.type });
    }
    const aliases = [
      ...book.products.flatMap((p) => (p.productId ? [...p.aliases, ...(p.abbr ? [p.abbr] : [])].map((a) => ({ productId: p.productId as string, canonical: p.model, alias: a })) : [])),
      ...book.hardware.flatMap((h) => h.aliases.map((a) => ({ productId: h.tariffId, canonical: h.name, alias: a }))),
    ];
    let r: Awaited<ReturnType<KbPricesRepo['replacePriceBook']>>;
    try {
      r = await prices.replacePriceBook(accountId, sourceId, priceKey, { rows, sizes: book.sizes, rule: book.rule, dictionary: book.dictionary, aliases }, replaceIds, input.userId);
    } catch (err) {
      return fail(`запись в базу: ${(err as Error).message}`, [{ sheet: '—', row: null, column: null, message: (err as Error).message }]);
    }
    const doors = book.products.length;
    const comments = book.products.filter((p) => p.card.comment).length;
    const updated = sameKey.length > 0 || (source.priceKey === priceKey && r.was > 0);
    const counts = { doors, components, hardware: book.hardware.length, hardwareUnpriced, estimates, sizes: r.sizes, aliases: r.aliases, comments, dictionary: r.dictionary, skipped: book.skipped.map((x) => `${x.sheet}${x.row ? `:${x.row}` : ''}${x.column ? ` [${x.column}]` : ''} — ${x.message}`) };
    await repo.setPriceInfo(sourceId, priceKey, { title: priceTitle, updated, was: r.was, imported: r.imported, removed: r.removed, added: r.added, at: new Date().toISOString(), book: counts });
    const summary = `прайс «${priceTitle}» (${doors} ID): цен дверей ${doors}${estimates ? ` (сметных ${estimates})` : ''}, комплектующих ${components}, фурнитуры ${book.hardware.length}${hardwareUnpriced ? ` (без цены ${hardwareUnpriced})` : ''}, размеров ${r.sizes}, синонимов ${r.aliases}, комментариев ${comments}, словарь ${r.dictionary}${updated ? `; прежние данные прайса заменены (было строк ${r.was})` : ''}${book.skipped.length ? `; пропущено: ${book.skipped.length}` : ''}`;
    await d.journal.add({ accountId, kind: KB_INDEX_KIND, summary: `База знаний: ${summary}`, details: { sourceId, priceKey, priceTitle, book: counts, replaced: r.replaced, was: r.was, removed: r.removed, added: r.added, updated, replacedSources: replaceIds, skipped: book.skipped, auto: Boolean(input.auto), userId: input.userId, audit: 'kb_prices' } });
    return { imported: r.imported, skipped: book.skipped.length, replaced: r.replaced, headerFound: true, priceKey, priceTitle, updated, was: r.was, removed: r.removed, added: r.added, book: counts };
  }

  async function textOf(source: KbSource): Promise<string> {
    if (!source.filePath) throw new Error('У источника нет файла на томе — добавьте его заново');
    const bytes = new Uint8Array(await readFile(source.filePath));
    if (source.kind === 'text' || source.mime === 'text/html') return new TextDecoder('utf-8').decode(bytes);
    const name = source.kind === 'url' ? new URL(source.original ?? '').pathname.split('/').pop() || 'page' : (source.original ?? source.title);
    const r = await extractForKb(bytes, source.mime ?? '', name, { ocr: await d.ocrFor(source.accountId) });
    return r.text;
  }

  /**
   * Скачивание ссылки: страница → основной текст (без меню и подвала) сохраняется как text/html-источник в .txt;
   * pdf/xlsx/docx по ссылке → байты сохраняются и разбираются как файл. Возвращает хэш содержимого для сравнения.
   */
  async function downloadUrl(source: KbSource): Promise<{ hash: string; status: number; mime: string; title: string | null; html: string | null; size: number }> {
    const got = await fetchUrl(source.original ?? '');
    const path = new URL(got.finalUrl).pathname;
    const looksHtml = got.mime === 'text/html' || got.mime === 'application/xhtml+xml' || (!got.mime && /^\s*</.test(new TextDecoder().decode(got.bytes.subarray(0, 64))));
    if (looksHtml) {
      const html = new TextDecoder('utf-8').decode(got.bytes);
      const { title, text } = htmlToKbText(html);
      if (text.length < 20) throw new Error('На странице не найден текст');
      // Заголовок страницы — первой строкой «# …», если извлечение его уже не поставило (h1 внутри основного блока).
      const bytes = new TextEncoder().encode(title && !text.startsWith('# ') ? `# ${title}\n\n${text}` : text);
      await store(source.accountId, source.id, 'page.txt', bytes);
      return { hash: sha(bytes), status: got.status, mime: 'text/html', title, html, size: bytes.byteLength };
    }
    const name = path.split('/').pop() || 'file';
    const format = kbFormatOf(got.mime, name);
    const mime = got.mime || (format === 'pdf' ? 'application/pdf' : format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/plain');
    await store(source.accountId, source.id, name, got.bytes);
    return { hash: sha(got.bytes), status: got.status, mime, title: name, html: null, size: got.bytes.byteLength };
  }

  /** Обход раздела: страницы раздела становятся источниками-детьми с тем же периодом обновления; уже добавленные пропускаются. */
  async function crawl(root: KbSource, html: string, hooks: KbIndexHooks): Promise<void> {
    const { rows } = await d.db.query<{ n: number }>('SELECT count(*)::int AS n FROM kb_sources WHERE parent_id = $1', [root.id]);
    let room = CRAWL_MAX_PAGES - 1 - (rows[0]?.n ?? 0);
    if (room <= 0) return;
    const links = sectionLinks(html, root.original ?? '', CRAWL_MAX_PAGES * 2);
    let added = 0;
    for (const link of links) {
      if (room <= 0) break;
      if (await repo.findUrl(root.accountId, link)) continue;
      try {
        parsePublicUrl(link);
      } catch {
        continue;
      }
      const id = await repo.createSource({ accountId: root.accountId, kind: 'url', title: link, original: link, refreshDays: root.refreshDays, createdBy: root.createdBy, parentId: root.id });
      room -= 1;
      added += 1;
      if (hooks.enqueue) await hooks.enqueue({ accountId: root.accountId, sourceId: id, userId: root.createdBy });
    }
    if (added) await d.journal.add({ accountId: root.accountId, kind: KB_INDEX_KIND, summary: `База знаний: обход раздела ${root.original} — добавлено страниц ${added} (ссылок на странице ${links.length})`, details: { sourceId: root.id, added, links: links.length, userId: root.createdBy } });
  }

  return core;
}
