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
import { defaultCategoryOfPriceKey } from './category.ts';
import { KbAliasesRepo, KbPricesRepo } from './prices.ts';
import { readKbSheetRows } from './extract.ts';
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
