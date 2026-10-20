import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, Field, s } from '@core/widget-core';
import type { KbBookCounts, KbChunkInfo, KbHitInfo, KbSourceInfo, KbUsageInfo, KpApi } from '../api.ts';
import { KbAnswer } from './KbAnswer.tsx';
import { AliasesSection, isXlsxSource, PriceImport, PricesSection } from './KbPrices.tsx';
import { CandidatesSection, COMMENT_MAX, isSite, SiteMeta, SitesSection } from './KbSites.tsx';

/**
 * Вкладка «База знаний» (RFD-AI-AGENT-OPT-KB, этап 1): файлы (pdf, docx, xlsx, csv, txt, md, jpg/png) и тексты
 * менеджера; список источников с действиями — переиндексировать, удалить, посмотреть фрагменты; строка поиска
 * для проверки, что агент найдёт. Ссылки (этап 2): страница сайта или файл по адресу, переиндексация по сроку,
 * обход раздела до 50 страниц. Цены и синонимы (этап 3): «Цены из прайса» у xlsx-источника, разделы «Цены» и «Синонимы».
 * Выгрузка цен в xlsx — этап 4.
 */
/** Строка итога импорта многолистового прайса (KB-PRICE-SHEETS) для сообщения после загрузки. */
function bookSummary(b: KbBookCounts): string {
  return `дверей ${b.doors}${b.estimates ? ` (сметных ${b.estimates})` : ''}, комплектующих ${b.components}, фурнитуры ${b.hardware}${b.hardwareUnpriced ? ` (без цены ${b.hardwareUnpriced})` : ''}, размеров ${b.sizes}, синонимов ${b.aliases}, комментариев ${b.comments}${b.dictionary ? `, словарь ${b.dictionary}` : ''}${b.skipped.length ? `; пропущено ${b.skipped.length} (см. журнал)` : ''}`;
}

const ACCEPT = '.pdf,.docx,.xlsx,.xlsm,.csv,.txt,.md,.jpg,.jpeg,.png,.webp';
const POLL_MS = 3000;
const KIND_LABEL: Record<KbSourceInfo['kind'], string> = { file: 'файл', url: 'ссылка', text: 'текст' };

const mb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`);
const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('ru-RU') : '—');

export function KnowledgeBase({ api }: { api: KpApi }) {
  const [sources, setSources] = useState<KbSourceInfo[] | null>(null);
  const [usage, setUsage] = useState<KbUsageInfo | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pricesKey, setPricesKey] = useState(0);
  const alive = useRef(true);

  const reload = useCallback(async () => {
    try {
      const r = await api.kbSources();
      if (!alive.current) return;
      setSources(r.sources);
      setUsage(r.usage);
    } catch (e) {
      if (alive.current) setMsg(errorMessage(e));
    }
  }, [api]);

  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
    };
  }, [reload]);

  // Пока есть источники в статусе new (в очереди или индексируются) — опрашиваем список.
  const pending = Boolean(sources?.some((x) => x.status === 'new'));
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(t);
  }, [pending, reload]);

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setMsg(null);
    try {
      const m = await fn();
      if (alive.current && m) setMsg(m);
      await reload();
      if (alive.current) setPricesKey((k) => k + 1);
    } catch (e) {
      if (alive.current) setMsg(errorMessage(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <div style={s.block}>
      <div style={{ ...s.muted, marginBottom: 8 }}>
        Агент использует базу при разборе заявок, подборе цен и ответах на вопросы покупателя. Файлы и тексты режутся на фрагменты до 1 500 символов; эмбеддинги считаются ключом OpenAI из вкладки «Модель».
      </div>
      {usage && <Usage usage={usage} />}
      <AddFile
        busy={busy}
        onAdd={(f) =>
          void run(async () => {
            const r = await api.kbAddFile(f.name, f.type, await fileBase64(f));
            // Прайс xlsx импортируется сразу (KB-PRICELIST, б): менеджеру не нужен отдельный шаг «Импортировать».
            const prices = r.source?.prices ?? 0;
            const imp = r.source?.priceImport ?? null;
            // KB-PRICE-SHEETS: многолистовой прайс — счётчики по вкладкам; ошибка на вкладке — импорт отменён, прежние данные прайса на месте.
            if (imp?.error) return `Файл «${f.name}» добавлен, но прайс «${imp.title}» не импортирован: ${imp.error}; прежние данные прайса сохранены`;
            if (imp?.book) return `Файл «${f.name}» добавлен: прайс «${imp.title}»${imp.updated ? ' обновлён' : ''}: ${bookSummary(imp.book)}`;
            // KB-MULTIPRICE: файл с тем же ключом прайса обновляет только свой прайс; другой ключ — новый прайс рядом.
            if (imp && imp.updated) return `Файл «${f.name}» добавлен: прайс «${imp.title}» обновлён: было ${imp.was}, стало ${imp.imported}; удалено ${imp.removed}, добавлено ${imp.added}`;
            return prices ? `Файл «${f.name}» добавлен: это прайс${imp ? ` «${imp.title}»` : ''}, импортировано цен ${prices}` : `Файл «${f.name}» добавлен, индексируется; если это прайс с колонками «модель» и «цена», цены импортируются автоматически`;
          })
        }
      />
      <AddUrl busy={busy} onAdd={(url, days, crawl, site) => void run(async () => {
        const r = await api.kbAddUrl(url, days, crawl, site);
        return r.existed ? 'Ссылка уже была в базе — поставлена на переиндексацию' : `Ссылка добавлена, скачивается${crawl ? ', раздел будет обойдён (до 50 страниц)' : ''}`;
      })} />
      <SitesSection
        api={api}
        busy={busy}
        onDone={(m) => {
          setMsg(m);
          void reload();
        }}
      />
      <AddText busy={busy} onAdd={(title, content) => void run(async () => (await api.kbAddText(title, content), 'Текст добавлен, индексируется'))} />
      <Search api={api} />
      <Field label="Вопрос покупателя" hint="Ответ только по фрагментам базы со ссылками на источники; так же агент отвечает на вопросы покупателя">
        <div className="opt-root">
          <KbAnswer api={api} />
        </div>
      </Field>
      {msg && <div style={{ ...s.muted, marginTop: 8 }}>{msg}</div>}
      <div style={{ ...s.label, marginTop: 16 }}>Источники{sources ? ` (${sources.length})` : ''}</div>
      {sources === null && <div style={s.muted}>Загрузка…</div>}
      {sources?.length === 0 && <div style={s.muted}>Источников пока нет — добавьте файл или текст</div>}
      {sources?.map((src) => (
        <SourceRow
          key={src.id}
          src={src}
          api={api}
          busy={busy}
          onPricesImported={(m) => {
            setMsg(m);
            setPricesKey((k) => k + 1);
            // KB-PRICE-SHEETS-FIX: счётчики и итог импорта в карточке файла — перечитать список источников.
            void reload();
          }}
          onSiteSaved={(m) => {
            setMsg(m);
            void reload();
          }}
          onReindex={() => void run(async () => (await api.kbReindex(src.id), null))}
          onRemove={() => {
            if (!window.confirm(`Удалить источник «${src.title}» и его фрагменты?`)) return;
            void run(async () => (await api.kbRemove(src.id), `Источник «${src.title}» удалён`));
          }}
        />
      ))}
      {/* Сводка и список цен перечитываются после загрузки/удаления источника и импорта прайса, без перезагрузки (KB-PRICES-UI, п. 4). */}
      <PricesSection api={api} version={pricesKey} />
      <AliasesSection api={api} />
      <CandidatesSection api={api} version={pricesKey} />
    </div>
  );
}

function Usage({ usage }: { usage: KbUsageInfo }) {
  return (
    <div style={{ ...s.small, ...s.muted, marginBottom: 8 }}>
      Занято: {mb(usage.bytes)} из {mb(usage.limits.bytes)} · фрагментов {usage.chunks.toLocaleString('ru-RU')} из {usage.limits.chunks.toLocaleString('ru-RU')} · источников {usage.sources}
    </div>
  );
}

function AddFile({ busy, onAdd }: { busy: boolean; onAdd: (f: File) => void }) {
  return (
    <Field label="Файл" hint="pdf, docx, xlsx, csv, txt, md, jpg/png (сканы — через распознавание из настроек КП); до 50 МБ. Из xlsx-прайсов цены извлекаются отдельно (этап 3)">
      <input
        type="file"
        accept={ACCEPT}
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onAdd(f);
          e.target.value = '';
        }}
      />
    </Field>
  );
}

function AddUrl({ busy, onAdd }: { busy: boolean; onAdd: (url: string, refreshDays: number, crawl: boolean, site: { comment: string | null; isFactory: boolean }) => void }) {
  const [url, setUrl] = useState('');
  const [days, setDays] = useState(30);
  const [crawl, setCrawl] = useState(false);
  // KP-AGENT-V2, п. 4а: что на сайте есть и чего нет («ДПК Аква», «Стальных нет») и «фабрика» — сохраняются вместе со ссылкой.
  const [comment, setComment] = useState('');
  const [factory, setFactory] = useState(false);
  const ok = /^https?:\/\/\S+\.\S+/i.test(url.trim());
  return (
    <Field label="Ссылка" hint="Адрес страницы сайта или файла (pdf/xlsx по ссылке). Берётся основной текст без меню и подвала; переиндексация по сроку, по умолчанию раз в 30 дней">
      <input style={{ ...s.input, marginBottom: 6 }} placeholder="https://rf-dveri.ru/ceny/" value={url} onChange={(e) => setUrl(e.target.value)} />
      <div style={{ ...s.row, marginBottom: 6 }}>
        <label style={{ ...s.small, display: 'flex', alignItems: 'center', gap: 6 }}>
          Обновлять каждые
          <input style={{ ...s.input, width: 70 }} type="number" min={0} max={365} value={days} onChange={(e) => setDays(Math.max(0, Math.min(365, Number(e.target.value) || 0)))} />
          дн. (0 — не обновлять)
        </label>
        <label style={{ ...s.small, display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={crawl} onChange={(e) => setCrawl(e.target.checked)} />
          обойти раздел (до 50 страниц)
        </label>
      </div>
      <label style={{ ...s.small, display: 'block', marginBottom: 2 }}>Комментарий</label>
      <textarea
        className="opt-kb-url-comment"
        style={{ ...s.input, width: '100%', minHeight: 48, boxSizing: 'border-box', marginBottom: 4 }}
        maxLength={COMMENT_MAX}
        placeholder="Что на сайте есть и чего нет: «ДПК Аква, межкомнатные», «Стальных нет» — по нему агент выбирает, где искать цену"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
      <div style={{ ...s.row, marginBottom: 6 }}>
        <label style={{ ...s.small, display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" className="opt-kb-url-factory" checked={factory} onChange={(e) => setFactory(e.target.checked)} />
          Фабрика (цены этого сайта — в первую очередь)
        </label>
        <span style={{ ...s.small, ...s.muted }}>{comment.length} / {COMMENT_MAX}</span>
      </div>
      <button
        type="button"
        style={s.button}
        disabled={busy || !ok}
        onClick={() => {
          onAdd(url.trim(), days, crawl, { comment: comment.trim() || null, isFactory: factory });
          setUrl('');
          setComment('');
          setFactory(false);
        }}
      >
        Добавить ссылку
      </button>
    </Field>
  );
}

function AddText({ busy, onAdd }: { busy: boolean; onAdd: (title: string, content: string) => void }) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  return (
    <Field label="Текст" hint="Заметка менеджера: правила, условия, скидки, описание моделей. Сохраняется как есть">
      <input style={{ ...s.input, marginBottom: 6 }} placeholder="Название (необязательно)" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea style={s.textarea} placeholder="Например: Скидка опт от 50 полотен — 12 %" value={content} onChange={(e) => setContent(e.target.value)} />
      <button
        type="button"
        style={{ ...s.button, marginTop: 6 }}
        disabled={busy || !content.trim()}
        onClick={() => {
          onAdd(title, content);
          setTitle('');
          setContent('');
        }}
      >
        Добавить текст
      </button>
    </Field>
  );
}

function Search({ api }: { api: KpApi }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<KbHitInfo[] | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const search = async () => {
    if (!q.trim()) return;
    setBusy(true);
    setInfo(null);
    try {
      const r = await api.kbSearch(q.trim());
      setHits(r.hits);
      setInfo(`Найдено ${r.hits.length}${r.model ? ` · эмбеддинг ${r.model}, ${r.tokens} токенов` : ' · без эмбеддингов (нет ключа OpenAI)'} · ${r.ms} мс`);
    } catch (e) {
      setInfo(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Field label="Проверить поиск" hint="Что найдёт агент по вопросу покупателя: пять лучших фрагментов с источником">
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          style={s.input}
          placeholder="скидка опт"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search();
          }}
        />
        <button type="button" style={s.buttonGhost} disabled={busy || !q.trim()} onClick={() => void search()}>
          Найти
        </button>
      </div>
      {info && <div style={{ ...s.muted, ...s.small, marginTop: 4 }}>{info}</div>}
      {hits?.map((h) => (
        <div key={h.chunkId} style={{ ...s.card, marginTop: 6 }}>
          <div style={{ ...s.small, ...s.muted }}>
            {h.source ? `${KIND_LABEL[h.source.kind]}: ${h.source.original ?? h.source.title}` : 'источник удалён'}
            {h.meta.page ? ` · стр. ${h.meta.page}` : ''}
            {h.meta.sheet ? ` · лист «${h.meta.sheet}»` : ''}
            {h.meta.heading ? ` · ${h.meta.heading}` : ''}
            {` · ${h.matched.map((m) => (m === 'vector' ? 'смысл' : 'текст')).join('+')}`}
          </div>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{h.text.length > 600 ? `${h.text.slice(0, 600)}…` : h.text}</div>
        </div>
      ))}
    </Field>
  );
}

function SourceRow({ src, api, busy, onReindex, onRemove, onPricesImported, onSiteSaved }: { src: KbSourceInfo; api: KpApi; busy: boolean; onReindex: () => void; onRemove: () => void; onPricesImported: (msg: string) => void; onSiteSaved?: (msg: string) => void }) {
  const [chunks, setChunks] = useState<KbChunkInfo[] | null>(null);
  const [open, setOpen] = useState(false);
  const [prices, setPrices] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toggle = async () => {
    if (open) return setOpen(false);
    setOpen(true);
    if (chunks) return;
    try {
      setChunks((await api.kbChunks(src.id)).chunks);
    } catch (e) {
      setErr(errorMessage(e));
    }
  };
  const status =
    src.status === 'indexed' ? <span style={s.badgeOk}>проиндексирован</span> : src.status === 'error' ? <span style={s.badgeBad}>ошибка</span> : <span style={s.badgeWarn}>{src.job?.state === 'running' ? 'индексируется…' : 'в очереди…'}</span>;
  return (
    <div style={{ ...s.card, marginTop: 6 }}>
      <div style={s.row}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>{src.title}</div>
          <div style={{ ...s.small, ...s.muted }}>
            {KIND_LABEL[src.kind]} · {mb(src.sizeBytes)} · фрагментов {src.chunks}
            {src.chunks > 0 && src.embeddedChunks === 0 ? ' (без эмбеддингов)' : ''} · добавлен {date(src.createdAt)}
            {src.indexedAt ? ` · индекс ${date(src.indexedAt)}` : ''}
            {src.kind === 'url' && src.refreshDays ? ` · обновление каждые ${src.refreshDays} дн.${src.nextRefreshAt ? `, следующее ${date(src.nextRefreshAt)}` : ''}` : ''}
            {src.kind === 'url' && !src.refreshDays ? ' · без обновления' : ''}
            {src.crawl ? ' · раздел' : ''}
            {src.parentId ? ' · страница раздела' : ''}
            {src.prices && !src.counts ? ` · прайс${src.priceTitle ? ` «${src.priceTitle}»` : ''}: цен ${src.prices}` : ''}
            {src.priceImport?.updated && !src.counts ? ` · обновлён: было ${src.priceImport.was}, стало ${src.priceImport.imported}; удалено ${src.priceImport.removed}, добавлено ${src.priceImport.added}` : ''}
          </div>
          {src.counts && (
            <div style={{ ...s.small, ...s.muted }} className="opt-kb-book-counts">
              прайс{src.priceTitle ? ` «${src.priceTitle}»` : ''}: дверей {src.counts.doors} · комплектующих {src.counts.components} · фурнитуры {src.counts.hardware}
              {src.priceImport?.book?.hardwareUnpriced ? ` (без цены ${src.priceImport.book.hardwareUnpriced})` : ''} · размеров {src.counts.sizes} · синонимов {src.counts.aliases} · комментариев {src.counts.comments}
              {src.counts.dictionary ? ` · словарь ${src.counts.dictionary}` : ''}
              {src.priceImport?.book?.estimates ? ` · сметных ${src.priceImport.book.estimates}` : ''}
              {src.priceImport?.updated ? ' · обновлён' : ''}
            </div>
          )}
          {src.priceImport?.error && <div style={s.error}>прайс не импортирован: {src.priceImport.error}; прежние данные прайса сохранены</div>}
          {src.kind === 'url' && src.original && src.original !== src.title && <div style={{ ...s.small, ...s.muted, wordBreak: 'break-all' }}>{src.original}</div>}
          {src.error && <div style={s.error}>{src.error}</div>}
        </div>
        {status}
      </div>
      {isSite(src) && <SiteMeta api={api} src={src} onSaved={(m) => onSiteSaved?.(m)} />}
      <div style={{ ...s.row, marginTop: 6 }}>
        <button type="button" style={s.buttonGhost} disabled={busy} onClick={() => void toggle()}>
          {open ? 'Скрыть фрагменты' : 'Фрагменты'}
        </button>
        <button type="button" style={s.buttonGhost} disabled={busy || src.status === 'new'} onClick={onReindex}>
          Переиндексировать
        </button>
        {isXlsxSource(src) && src.status === 'indexed' && (
          <button type="button" style={s.buttonGhost} disabled={busy} onClick={() => setPrices((v) => !v)}>
            {prices ? 'Скрыть прайс' : 'Цены из прайса'}
          </button>
        )}
        <button type="button" style={s.buttonGhost} disabled={busy} onClick={onRemove}>
          Удалить
        </button>
      </div>
      {prices && (
        <PriceImport
          api={api}
          src={src}
          onDone={(m) => {
            setPrices(false);
            onPricesImported(m);
          }}
        />
      )}
      {open && err && <div style={s.error}>{err}</div>}
      {open && chunks && chunks.length === 0 && <div style={{ ...s.muted, ...s.small }}>Фрагментов нет</div>}
      {open &&
        chunks?.map((c) => (
          <div key={c.id} style={{ ...s.small, marginTop: 6, padding: '6px 8px', background: '#f6f8fa', borderRadius: 6, whiteSpace: 'pre-wrap' }}>
            <span style={s.muted}>
              #{c.position + 1}
              {c.meta.page ? ` · стр. ${c.meta.page}` : ''}
              {c.meta.sheet ? ` · лист «${c.meta.sheet}»` : ''}
              {c.meta.heading ? ` · ${c.meta.heading}` : ''}
              {c.hasEmbedding ? '' : ' · без эмбеддинга'}
            </span>
            <div>{c.text}</div>
          </div>
        ))}
    </div>
  );
}

/** Файл → base64 для JSON-тела (как шаблон КП): отдельная зависимость на multipart не нужна. */
async function fileBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}
