import { Component, useCallback, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { errorMessage } from '@core/widget-core';
import type { DraftJob, GostProfileInfo, KpAnswerBody, KpApi, KpDraftInfo, KpDraftLine, MailSourceInfo, ResearchPosition, ResearchState } from '../api.ts';
import { Journal } from './Journal.tsx';
import { KbAnswer } from './KbAnswer.tsx';
import { SendPreview } from './SendPreview.tsx';
import { SentMailView } from './SentMailView.tsx';
import { Survey } from './Survey.tsx';

/**
 * Блок «Агента опт» в карточке сделки (KP-AGENT-V2, п. 6а). Узкая правая колонка amoCRM — только сводка: счётчики (позиций,
 * открытых вопросов, из них блокирующих, без цены), «Развернуть ⤢» и «Собрать документ». Работа — в окне на 88 % экрана:
 * в шапке счётчики и кнопки, вкладки «Позиции · Опросник (N) · Письмо и файлы · База знаний · Журнал»; во вкладке «Позиции» —
 * таблица (серой строкой ГОСТ-профиль, цветная метка источника цены, последняя строка — доставка) и справа опросник 360 px;
 * внизу — итог с НДС, срок действия цены и почему документ не собирается. Автосборки и автоотправки нет.
 * Ширину правой колонки amoCRM виджет не меняет (вкладка карточки — см. отчёт KP-AGENT-V2).
 */

const STATUS: Record<string, string> = { draft: 'Черновик', built: 'Документ собран', sent: 'Отправлено', cancelled: 'Отменено' };
/** Склонение: 1 вложение, 2 вложения, 5 вложений; 1 позиция, 2 позиции, 5 позиций. */
const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  return `${n} ${m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many}`;
};
/** Размер по макету: «1400 × 2700 мм». */
const sizeLabel = (size: string) => size.replace(/\s*[×x]\s*/i, ' × ');
const POLL_MS = 3000;

/**
 * Ошибка рендера одного раздела не роняет весь блок (виджет 2.0.7 падал целиком на старых черновиках): раздел показывается
 * пометкой «<раздел>: нет данных», остальное работает. Ошибка — в консоль, как у общего ErrorBoundary.
 */
export class Section extends Component<{ name: string; children: ReactNode; inline?: boolean }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console -- единственный канал диагностики внутри amo
    console.error(`[ai-door] render error in «${this.props.name}»`, error, info.componentStack);
  }
  override render() {
    if (this.state.failed) return this.props.inline ? <span className="opt-kp-sub opt-kp-section-failed">{this.props.name}: нет данных</span> : <div className="opt-kp-note opt-kp-section-failed">{this.props.name}: нет данных</div>;
    return this.props.children;
  }
}

/** Черновик старого формата (12.10) или от старого сервера: массивы — хотя бы [], объекты — хотя бы {} / null, строки — ''. */
export function normalizeDraft(d: KpDraftInfo | null): KpDraftInfo | null {
  if (!d) return null;
  const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
  const client = (d.client && typeof d.client === 'object' ? d.client : {}) as Partial<KpDraftInfo['client']>;
  const src = d.source && typeof d.source === 'object' ? d.source : null;
  const mail = src?.mail && typeof src.mail === 'object' ? src.mail : undefined;
  return {
    ...d,
    client: { org: str(client.org), fio: str(client.fio), email: str(client.email), phone: str(client.phone) },
    requestItems: arr(d.requestItems),
    items: arr<KpDraftLine>(d.items)
      .filter((l) => l && typeof l === 'object')
      .map((l, i) => ({ ...l, request_index: Number(l.request_index ?? i) || 0, page_id: l.page_id ?? null, name: str(l.name), size: str(l.size), qty: Number(l.qty ?? 1) || 0, price: typeof l.price === 'number' ? l.price : null, lead_time: str(l.lead_time), discount: Number(l.discount ?? 0) || 0, quoteNotes: arr(l.quoteNotes) })),
    requiredBlocks: arr(d.requiredBlocks),
    questions: arr(d.questions),
    needsManager: arr(d.needsManager),
    source: src
      ? {
          ...src,
          attachments: arr(src.attachments),
          documents: arr(src.documents),
          skipped: arr(src.skipped),
          ...(Array.isArray(src.files) ? { files: src.files } : {}),
          ...(mail ? { mail: { ...mail, taken: arr(mail.taken), uploaded: arr(mail.uploaded), skipped: arr(mail.skipped), ...(Array.isArray(mail.files) ? { files: mail.files } : {}) } } : {}),
        }
      : null,
    survey: arr(d.survey),
    requirements: arr(d.requirements),
    photos: arr(d.photos),
    projectRest: arr(d.projectRest),
    letterText: typeof d.letterText === 'string' ? d.letterText : null,
    delivery: d.delivery && typeof d.delivery === 'object' ? d.delivery : null,
    scope: d.scope && typeof d.scope === 'object' ? { ...d.scope, missing: arr(d.scope.missing) } : null,
    priceValidity: typeof d.priceValidity === 'string' ? d.priceValidity : null,
  };
}

/** Работы (монтаж, врезка, доставка): по категории или старому kind — в итог не входят, цена не требуется (KB-COMPONENTS). */
export const isServiceLine = (l: Pick<KpDraftLine, 'kind' | 'category'>): boolean => l.category === 'service' || l.kind === 'service';

/** Источник цены строки — цветная метка в таблице: прайс, интернет (выбрал менеджер), менеджер, ждёт выбора, нет цены. */
export function priceSourceOf(l: KpDraftLine): { kind: 'price' | 'web' | 'manager' | 'pending' | 'none' | 'included' | 'stale'; label: string } {
  // KB-WEB-ROWS: цена прежнего веб-поиска — не из прайса, в КП не идёт.
  if (l.priceSource === 'research' || l.priceSource === 'analog') return { kind: 'stale', label: 'прежний поиск — в КП не идёт' };
  if (l.priceOutcome === 'included') return { kind: 'included', label: 'в цене блока' };
  if (l.price !== null && l.priceSource === 'manager') return { kind: 'manager', label: l.priceLabel && l.priceLabel !== 'изменено менеджером' ? l.priceLabel : 'изменено менеджером' };
  if (l.price !== null && l.priceSource === 'web_confirmed') return { kind: 'web', label: l.priceLabel ?? 'из интернета, выбрал менеджер' };
  if (l.price !== null) return { kind: 'price', label: l.priceLabel ?? 'по прайсу' };
  if (l.web) return { kind: 'pending', label: 'цены из интернета — выберите в опроснике' };
  return { kind: 'none', label: l.priceLabel && l.priceOutcome === 'not_priced' ? `${l.priceLabel} — уточнить у менеджера` : 'нет цены' };
}
/**
 * KB-MARKUP: «фабрика 16 400 ₽ · наценка 20 % · цена 19 680 ₽» — у строки с ценой прайса и наценкой источника, пока менеджер
 * цену не менял. Только в черновике: в письмо и файл КП идёт одна цена.
 */
export function markupOf(l: KpDraftLine): string | null {
  const m = l.markup;
  if (!m || l.price === null || l.price !== m.price || (l.priceSource !== 'price_file' && l.priceSource !== 'kb')) return null;
  const money = (n: number) => `${n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
  return `фабрика ${money(m.factoryPrice)} · наценка ${m.pct.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} % · цена ${money(m.price)}`;
}
function priceIsStale(l: KpDraftLine): boolean {
  return l.price !== null && Boolean(l.priceStale);
}

const rub = (n: number | null) => (n === null ? '—' : `${Math.round(n).toLocaleString('ru-RU')} ₽`);
const date = (iso: string) => new Date(iso).toLocaleDateString('ru-RU');
/** Дата и время по Москве: «13.10.2026 11:06». */
const dateTimeMsk = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' })} ${d.toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' })}`;
};
const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`);

/** ГОСТ-профиль серой строкой: «ГОСТ 475-2016 · ДМ · 1 створка · левая · Г · ПрБ · Мд1 · 2100×900 (по проёму)». */
export function profileText(p: GostProfileInfo | null | undefined): string {
  if (!p) return '';
  const leaves = p.leaves ? `${p.leaves} ${p.leaves === 1 ? 'створка' : 'створки'}${p.unequal ? ' (неравнопольная)' : ''}` : '';
  const size = p.heightMm && p.widthMm ? `${p.heightMm}×${p.widthMm}${p.basis === 'opening' ? ' (по проёму)' : p.basis === 'frame' ? ' (по коробке)' : ''}` : '';
  return [p.gost ? `ГОСТ ${p.gost}` : '', p.kind ?? '', leaves, p.opening === 'left' ? 'левая' : p.opening === 'right' ? 'правая' : '', p.fill ?? '', p.threshold ?? '', p.strength ?? '', p.fire ?? '', size, p.brand ? `бренд ${p.brand}` : ''].filter(Boolean).join(' · ');
}

/** Клик по ссылке скачивания: сервер отвечает Content-Disposition: attachment, браузер сохраняет файл. */
export function openDownload(url: string, filename: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noreferrer';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Черновик, задание воркера и действия над ними; ответ сервера всегда заменяет локальное состояние. */
function useKpDraft(api: KpApi, leadId: number) {
  const [draft, setDraft] = useState<KpDraftInfo | null>(null);
  const [job, setJob] = useState<DraftJob>(null);
  const [lines, setLines] = useState<KpDraftLine[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const take = useCallback((raw: KpDraftInfo | null) => {
    const d = normalizeDraft(raw);
    setDraft(d);
    setLines(d?.items ?? []);
    setDirty(false);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const r = await api.draft(leadId);
      if (!alive.current) return;
      setJob(r.job);
      // Пока задание в работе, старый черновик не трогаем, чтобы правки менеджера не пропали.
      if (!r.job || r.job.state === 'failed') take(r.draft);
    } catch (err) {
      if (alive.current) setError(errorMessage(err));
    }
  }, [api, leadId, take]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  // Опрос, пока воркер собирает черновик.
  const pending = job?.state === 'queued' || job?.state === 'running';
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [pending, refresh]);

  const act = async (fn: () => Promise<{ draft: KpDraftInfo | null } | { queued: true }>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (!alive.current) return;
      if ('draft' in r) take(r.draft);
      else await refresh();
    } catch (err) {
      if (alive.current) setError(errorMessage(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const edit = (i: number, patch: Partial<KpDraftLine>) => {
    // Цена, которую менеджер поменял руками, становится ручной (сервер делает то же при сохранении).
    setLines((xs) => xs.map((l, k) => (k === i ? { ...l, ...patch, ...('price' in patch && patch.price !== l.price && patch.price !== null ? { priceSource: 'manager' as const, priceLabel: 'изменено менеджером' } : {}) } : l)));
    setDirty(true);
  };

  // Поиск цен (RFD-AI-AGENT-OPT-PRICE, этап 6): состояние по позициям, опрос раз в 3 с, пока есть queued / running.
  const [research, setResearch] = useState<ResearchState | null>(null);
  const wasPending = useRef(false);
  // Прогресс «32 / 136» за одно нажатие «Найти цены» (KB-COMPONENTS, п. 6): сколько поставлено и сколько ещё в очереди/работе.
  const [runTotal, setRunTotal] = useState(0);
  const draftId = draft?.id ?? null;
  const loadResearch = useCallback(async () => {
    if (!draftId) return;
    try {
      const r = await api.researchState(draftId);
      if (!alive.current) return;
      setResearch(r);
      // Поиск закончился — цены легли в черновик: перечитываем его (KP-WIDGET-REFRESH). wasPending ставится и при постановке
      // задания, поэтому мгновенно завершённый поиск (все цены из базы) тоже перечитывает черновик; правки, сделанные во
      // время поиска, перекрываются свежим черновиком (dirty сбрасывается).
      if (!r.pending && wasPending.current) {
        wasPending.current = false;
        await refresh();
        setRunTotal(0);
      } else wasPending.current = r.pending;
    } catch (err) {
      if (alive.current) setError(errorMessage(err));
    }
  }, [api, draftId, refresh]);
  useEffect(() => {
    setResearch(null);
    void loadResearch();
  }, [loadResearch]);
  const researching = research?.pending ?? false;
  const inWork = research?.positions?.filter((p) => p.job?.state === 'queued' || p.job?.state === 'running').length ?? 0;
  const progress = runTotal > 0 && researching ? `${Math.max(0, runTotal - inWork)} / ${runTotal}` : null;
  useEffect(() => {
    if (!researching) return;
    const t = setInterval(() => void loadResearch(), POLL_MS);
    return () => clearInterval(t);
  }, [researching, loadResearch]);
  const findPrices = async (which: number[] | 'all') => {
    if (!draftId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.research(draftId, which);
      if (!alive.current) return;
      if (!r.queued.length && r.reason) setError(r.reason);
      // Задание поставлено: первый же опрос без queued/running означает «завершилось» — черновик перечитывается сразу.
      if (r.queued.length) wasPending.current = true;
      setRunTotal(r.queued.length);
      await loadResearch();
    } catch (err) {
      if (alive.current) setError(errorMessage(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return { draft, job, lines, dirty, busy, error, setError, pending, act, edit, take, research, researching, progress, findPrices };
}

type Counters = NonNullable<KpDraftInfo['counters']>;

/** Счётчики черновика: с сервера; у старого сервера — по строкам (вопросы — только «к какой двери»). */
function countersOf(draft: KpDraftInfo, goods: KpDraftLine[]): Counters {
  if (draft.counters) return draft.counters;
  const groups = questionGroups(goods).length;
  return { positions: goods.length, open: groups, blocking: groups, unpriced: goods.filter((l) => l.price === null && l.priceOutcome !== 'included').length };
}

/** Итог с НДС: товары (со скидкой) и доставка; НДС выделяется из суммы. */
function totalsOf(goods: KpDraftLine[], draft: KpDraftInfo) {
  const lines = goods.reduce((sum, l) => sum + (l.price === null || l.priceOutcome === 'included' ? 0 : l.price * l.qty * (1 - l.discount / 100)), 0);
  const delivery = draft.delivery?.mode === 'delivery' ? (draft.delivery.sum ?? 0) : 0;
  const total = Math.round((lines + delivery) * 100) / 100;
  const rate = draft.vatRate ?? 22;
  const vat = rate > 0 ? Math.round((total - total / (1 + rate / 100)) * 100) / 100 : 0;
  return { total, vat, rate };
}

function CountersRow({ c, draft }: { c: Counters; draft?: KpDraftInfo }) {
  const files = draft?.source?.files;
  return (
    <div className="opt-kp-counters">
      {c.positions === 0 && files ? (
        <span className="opt-kp-counter opt-kp-counter-warn">позиций нет · {filesLine(files)}</span>
      ) : (
        <span className="opt-kp-counter">позиций <b>{c.positions}</b></span>
      )}
      <span className={`opt-kp-counter${c.blocking ? ' opt-kp-counter-block' : c.open ? ' opt-kp-counter-warn' : ''}`}>
        вопросов <b>{c.open}</b>
        {c.blocking ? ` (блокируют ${c.blocking})` : ''}
      </span>
      <span className={`opt-kp-counter${c.unpriced ? ' opt-kp-counter-warn' : ''}`}>без цены <b>{c.unpriced}</b></span>
    </div>
  );
}

export function KpBlock({ api, leadId }: { api: KpApi; leadId: number }) {
  const k = useKpDraft(api, leadId);
  const { draft, job, lines, dirty, busy, error, setError, pending, act, take } = k;
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  // KP-SENT-COPY: «Посмотреть письмо» — слоем поверх окна КП, как окно отправки.
  const [mailView, setMailView] = useState(false);
  const start = () => void act(() => api.makeDraft(leadId));
  const checkMail = () => void act(() => api.makeDraft(leadId, { checkMail: true }));

  // Макет Figma «10 Агент опт — КП»: карточки с рамкой и радиусом 13 px на сером фоне. Шапку с логотипом рисует amoCRM (.opt-caption).
  if (!draft) {
    return (
      <div className="opt-root opt-kp">
        <section className="opt-kp-card opt-col">
          <div className="opt-kp-head">
            <h3 className="opt-kp-title">Черновик КП</h3>
          </div>
          {pending ? (
            <div className="opt-kp-note">{job?.state === 'queued' ? 'В очереди…' : 'Собираю черновик: читаю карточку, письма и файлы…'}</div>
          ) : (
            <div className="opt-kp-note">КП по этой сделке ещё не собирали</div>
          )}
          {job?.state === 'failed' && <div className="opt-error">Черновик не собран: {job.error}</div>}
          {error && <div className="opt-error">{error}</div>}
          <div className="opt-actions">
            <button type="button" className="opt-btn opt-btn-green" disabled={busy || pending} onClick={start}>
              Собрать КП
            </button>
          </div>
        </section>
      </div>
    );
  }

  // Работы в итог не входят и цены для сборки не требуют (KB-COMPONENTS, п. 5); исключённые в опроснике — не в КП.
  const goods = lines.filter((l) => !isServiceLine(l) && !l.excluded);
  const c = countersOf(draft, goods);
  const hasPrice = goods.some((l) => l.price !== null);
  const why = dirty ? 'Сначала сохраните правки' : c.blocking ? `Ответьте на вопросы опросника, которые блокируют КП: ${c.blocking}` : !hasPrice ? 'Ни у одной позиции нет цены' : null;
  const build = () => void act(() => api.buildDoc(draft.id));
  const download = async (kind: 'pdf' | 'docx') => {
    try {
      const { url, filename } = await api.fileLink(draft.id, kind);
      openDownload(url, filename);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const kpStatus = STATUS[draft.status] ?? draft.status;
  const sendPreview = (
    <SendPreview
      api={api}
      draft={draft}
      onClose={() => setPreview(false)}
      onSent={(d) => {
        setPreview(false);
        take(d);
      }}
    />
  );
  const layer = preview ? sendPreview : mailView ? <SentMailView api={api} draft={draft} onClose={() => setMailView(false)} /> : null;
  const closeLayer = () => {
    setPreview(false);
    setMailView(false);
  };
  const downloads = (draft.status === 'built' || draft.status === 'sent') && (draft.hasPdf || draft.hasDocx) && (
    <span className="opt-kp-downloads">
      {draft.hasPdf && (
        <button type="button" className="opt-btn opt-btn-small" disabled={busy} onClick={() => void download('pdf')} title="Скачать собранный PDF">
          Скачать PDF
        </button>
      )}
      {draft.hasDocx && (
        <button type="button" className="opt-btn opt-btn-small" disabled={busy} onClick={() => void download('docx')} title="Скачать собранный DOCX">
          Скачать DOCX
        </button>
      )}
    </span>
  );

  return (
    <div className="opt-root opt-kp">
      {/* Узкая колонка: сводка и два действия. */}
      <section className="opt-kp-card opt-kp-narrow">
        <div className="opt-kp-head">
          <h3 className="opt-kp-title">Черновик КП</h3>
          <span className={`opt-kp-badge${draft.status === 'draft' || draft.status === 'built' || draft.status === 'sent' ? ' opt-kp-badge-green' : ''}`}>{kpStatus}</span>
        </div>
        <div className="opt-kp-sub">{draft.kpNo ?? 'Номер появится после сборки документа'}</div>
        <Section name="Сводка">
          <CountersRow c={c} draft={draft} />
        </Section>
        {pending && <div className="opt-kp-sub">{job?.state === 'queued' ? 'Новый черновик в очереди…' : 'Собираю новый черновик…'}</div>}
        {job?.state === 'failed' && <div className="opt-error">Новый черновик не собран: {job.error}</div>}
        {error && !open && <div className="opt-error">{error}</div>}
        <div className="opt-actions">
          <button type="button" className="opt-btn opt-btn-green" onClick={() => setOpen(true)}>
            Развернуть ⤢
          </button>
          <button type="button" className="opt-btn" disabled={busy || pending || Boolean(why)} title={why ?? 'Собрать DOCX и PDF по шаблону'} onClick={build}>
            Собрать документ
          </button>
        </div>
        {downloads}
        <Section name="Письмо">
          <CopyFailed draft={draft} />
          <SourceNotes draft={draft} compact />
        </Section>
        <div className="opt-kp-note">
          <Section name="Примечание" inline>
            <KpNote draft={draft} why={why} />
          </Section>
        </div>
      </section>

      {open && (
        <KpWindow
          api={api}
          leadId={leadId}
          k={k}
          counters={c}
          goods={goods}
          why={why}
          kpStatus={kpStatus}
          downloads={downloads}
          onDraft={start}
          onCheckMail={checkMail}
          onBuild={build}
          onSend={() => {
            setMailView(false);
            setPreview(true);
          }}
          onShowMail={() => {
            setPreview(false);
            setMailView(true);
          }}
          onClose={() => setOpen(false)}
          // Окно письма — слоем поверх окна КП: отдельно (в колонке amoCRM) его закрывало окно на 88 %, «Отправить» было не нажать.
          sendLayer={layer}
          onSendClose={closeLayer}
        />
      )}

      {layer && !open && layer}
    </div>
  );
}

const TABS = [
  ['lines', 'Позиции'],
  ['survey', 'Опросник'],
  ['mail', 'Письмо и файлы'],
  ['kb', 'База знаний'],
  ['journal', 'Журнал'],
] as const;
type Tab = (typeof TABS)[number][0];

/**
 * Окно КП на 88 % экрана (п. 6а): шапка со счётчиками и кнопками, вкладки, итог внизу. Esc и ✕ — закрыть.
 * sendLayer — окно письма «Отправить клиенту» слоем поверх содержимого окна; Esc при нём закрывает только письмо.
 */
function KpWindow({ api, leadId, k, counters, goods, why, kpStatus, downloads, onDraft, onCheckMail, onBuild, onSend, onShowMail, onClose, sendLayer = null, onSendClose }: { api: KpApi; leadId: number; k: ReturnType<typeof useKpDraft>; counters: Counters; goods: KpDraftLine[]; why: string | null; kpStatus: string; downloads: React.ReactNode; onDraft: () => void; onCheckMail?: () => void; onBuild: () => void; onSend: () => void; onShowMail?: () => void; onClose: () => void; sendLayer?: React.ReactNode; onSendClose?: () => void }) {
  const { draft, lines, dirty, busy, error, pending, act, edit, research, researching, progress, findPrices } = k;
  const [tab, setTab] = useState<Tab>('lines');
  const sending = Boolean(sendLayer);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (sending) onSendClose?.();
      else onClose();
    };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose, onSendClose, sending]);
  if (!draft) return null;
  const locked = draft.status !== 'draft' || busy || pending || dirty;
  const survey = draft.survey ?? [];
  const answer = (body: KpAnswerBody) => void act(() => api.answer(draft.id, body));
  const { total, vat, rate } = totalsOf(goods, draft);
  const canSend = (draft.status === 'built' || draft.status === 'sent') && !dirty;
  return createPortal(
    <div className="opt-root opt-kp opt-kp-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="opt-kp-modal" role="dialog" aria-modal="true" aria-label="КП по сделке">
        <div className="opt-kp-modal-head">
          <div className="opt-kp-head">
            <h3 className="opt-kp-title">КП {draft.kpNo ?? '— черновик'}</h3>
            <span className="opt-kp-badge opt-kp-badge-green">{kpStatus}</span>
            <Section name="Сводка" inline>
              <CountersRow c={counters} draft={draft} />
            </Section>
          </div>
          <div className="opt-kp-modal-actions">
            {draft.status === 'draft' && (
              <button type="button" className="opt-btn" disabled={busy || pending || researching || dirty} title={dirty ? 'Сначала сохраните правки' : 'Цены по позициям без цены: прайс → интернет (выбор менеджера) → вопрос'} onClick={() => void findPrices('all')}>
                {researching ? `Ищу цены…${progress ? ` ${progress}` : ''}` : 'Найти цены'}
              </button>
            )}
            {draft.status === 'draft' && (
              <button type="button" className="opt-btn" disabled={busy || pending || researching || dirty} title={dirty ? 'Сначала сохраните правки' : 'Применить текущую наценку прайсов из «Базы знаний» к ценам из прайса; ручные цены и цены интернета не меняются'} onClick={() => void act(() => api.recalcMarkup(draft.id))}>
                Пересчитать
              </button>
            )}
            <button type="button" className="opt-btn" disabled={busy || !dirty} onClick={() => void act(() => api.saveDraftItems(draft.id, lines))}>
              Сохранить правки
            </button>
            <button type="button" className="opt-btn" disabled={busy || pending} onClick={onDraft} title="Прочитать карточку заново; файлы заявки, уже загруженные в сделку, — без чтения ящика; ответы опросника переносятся">
              Собрать заново
            </button>
            <button type="button" className="opt-btn opt-btn-green" disabled={busy || pending || Boolean(why)} title={why ?? 'Собрать DOCX и PDF по шаблону'} onClick={onBuild}>
              Собрать документ
            </button>
            <button type="button" className="opt-btn" disabled={busy || !canSend} title={canSend ? 'Открыть письмо перед отправкой' : 'Доступно после сборки документа'} onClick={onSend}>
              Отправить клиенту
            </button>
            {(draft.status === 'sent' || draft.sentAt) && onShowMail && (
              <button type="button" className="opt-btn" title="Что и как ушло клиенту: адреса, тема, текст, вложение, Message-ID, копия в «Отправленные»" onClick={onShowMail}>
                Посмотреть письмо
              </button>
            )}
            {downloads}
            <button type="button" className="opt-btn opt-icon opt-kp-close" aria-label="Закрыть" title="Закрыть (Esc)" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>
        <Section name="Письмо">
          <CopyFailed draft={draft} />
          <SourceNotes draft={draft} disabled={busy || pending} onRebuild={onDraft} onCheckMail={onCheckMail} />
        </Section>
        <div className="opt-kp-tabs" role="tablist">
          {TABS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={`opt-kp-tab${tab === id ? ' opt-kp-tab-active' : ''}`} onClick={() => setTab(id)}>
              {id === 'survey' ? `${label} (${counters.open})` : label}
            </button>
          ))}
        </div>
        {error && <div className="opt-error">{error}</div>}
        <div className="opt-kp-modal-body">
          {tab === 'lines' && (
            <div className="opt-kp-split">
              <div className="opt-kp-main">
                {draft.scope && (
                  <div className="opt-kp-sub opt-kp-scope">
                    По письму: в КП {draft.scope.selected} поз. из {draft.scope.project} в проекте{draft.scope.by === 'marks' ? ' (марки из письма)' : ' (номера позиций из письма)'}
                    {draft.scope.missing.length ? ` · в письме есть, во вложениях нет: ${draft.scope.missing.join(', ')}` : ''}
                  </div>
                )}
                <Section name="Позиции">
                  <KpTable lines={lines} draft={draft} research={research} locked={locked} onEdit={edit} onFind={(i) => void findPrices([i])} onDoor={(i, door) => void act(() => api.componentDoor(draft.id, i, door))} />
                </Section>
                <Section name="Ещё в проекте">
                  <ProjectRest draft={draft} locked={locked} onAdd={(i) => void act(() => api.addProjectItem(draft.id, i))} />
                </Section>
              </div>
              <aside className="opt-kp-panel">
                <div className="opt-kp-panel-title">Опросник ({counters.open})</div>
                <Section name="Опросник">
                  <Survey questions={survey} locked={locked} onAnswer={answer} />
                </Section>
              </aside>
            </div>
          )}
          {tab === 'survey' && (
            <Section name="Опросник">
              <Survey questions={survey} locked={locked} onAnswer={answer} />
            </Section>
          )}
          {tab === 'mail' && (
            <Section name="Письмо и файлы">
              <MailTab draft={draft} />
            </Section>
          )}
          {tab === 'kb' && <KbAnswer api={api} leadId={leadId} compact />}
          {tab === 'journal' && <Journal api={api} leadId={leadId} />}
        </div>
        <div className="opt-kp-modal-foot">
          <span className="opt-kp-total">
            Итого с НДС <b>{rub(total)}</b>
            {rate > 0 ? ` · в т.ч. НДС ${rate} % — ${rub(vat)}` : ' · НДС не облагается'}
          </span>
          <span className="opt-kp-sub">Срок действия цены: {draft.priceValidity ?? 'не задан — вопрос в опроснике'}</span>
          {why && <span className="opt-kp-why">Документ не собирается: {why}</span>}
        </div>
        {sendLayer && (
          <div className="opt-kp-send-layer" role="dialog" aria-modal="true" aria-label="Письмо с КП">
            <div className="opt-kp-send">{sendLayer}</div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** KP-SENT-COPY: письмо ушло, а копия в «Отправленные» не легла — жёлтая пометка с причиной. */
function CopyFailed({ draft }: { draft: KpDraftInfo }) {
  const copy = draft.sentMail?.copy;
  if (copy?.status !== 'failed') return null;
  return <div className="opt-kp-copy-failed">Копия в «Отправленные» не сохранена: {copy.error ?? 'причина неизвестна'}</div>;
}

/** Сводка по файлам: найдено, взято в разбор, разобрано, пропущено, не разобрано. */
function filesLine(files: NonNullable<NonNullable<KpDraftInfo['source']>['files']>): string {
  const n = (st: string) => files.filter((f) => f.status === st).length;
  const failed = n('failed');
  return `файлов найдено ${files.length}, взято ${n('parsed') + failed}, разобрано ${n('parsed')}, пропущено ${n('skipped')}${failed ? `, не разобрано ${failed}` : ''}`;
}

/** Причина сбоя ящика и время следующей попытки (если сервер не написал его в причине). */
function mailFailure(m: MailSourceInfo): string {
  const why = m.error ?? 'причина неизвестна';
  return m.retryAt && !why.includes('следующая попытка') ? `${why}, следующая попытка после ${dateTimeMsk(m.retryAt)}` : why;
}

/**
 * KP-PARSE-RETRY: что с источниками заявки — над вкладками окна КП (и коротко в узкой колонке):
 * жёлтая пометка «Ящик не прочитан: причина, следующая попытка …» и «Проверить почту заново»; «Файл "…" не разобран: причина»
 * и «Разобрать заново»; при пересборке без чтения ящика — почему ящик не читали; список файлов с причинами пропуска.
 */
function SourceNotes({ draft, compact = false, disabled = false, onRebuild, onCheckMail }: { draft: KpDraftInfo; compact?: boolean; disabled?: boolean; onRebuild?: () => void; onCheckMail?: () => void }) {
  const [open, setOpen] = useState(false);
  const src = draft.source;
  if (!src) return null;
  const m = src.mail;
  const failed = src.files ? src.files.filter((f) => f.status === 'failed') : (src.skipped ?? []).filter((f) => f.failed);
  const files = src.files ?? [];
  const mailError = m?.status === 'error';
  if (!mailError && !failed.length && !(m?.status === 'skipped' && !compact) && !(files.length && !compact)) return null;
  const canAct = draft.status === 'draft';
  return (
    <div className="opt-kp-source-notes opt-col">
      {mailError && (
        <div className="opt-kp-mail-failed">
          Ящик не прочитан: {mailFailure(m)}
          {!compact && ' — черновик собран по файлам и письму из сделки'}
          {!compact && onCheckMail && canAct && (
            <button type="button" className="opt-btn opt-btn-small" disabled={disabled} title="Собрать заново с чтением ящика" onClick={onCheckMail}>
              Проверить почту заново
            </button>
          )}
        </div>
      )}
      {failed.map((f) => (
        <div key={f.name} className="opt-kp-file-failed">
          Файл «{f.name}» не разобран: {f.reason}
          {!compact && onRebuild && canAct && (
            <button type="button" className="opt-btn opt-btn-small" disabled={disabled} title="Собрать черновик заново: файл разбирается ещё раз" onClick={onRebuild}>
              Разобрать заново
            </button>
          )}
        </div>
      ))}
      {!compact && m?.status === 'skipped' && (
        <div className="opt-kp-sub">
          Ящик не читали: файлы заявки уже в сделке.
          {onCheckMail && canAct && (
            <button type="button" className="opt-btn opt-btn-small" disabled={disabled} title="Собрать заново с чтением ящика: новое письмо и вложения" onClick={onCheckMail}>
              Проверить почту заново
            </button>
          )}
        </div>
      )}
      {!compact && files.length > 0 && (
        <div className="opt-col opt-details">
          <button type="button" className="opt-details-summary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            Файлы: {filesLine(files).replace(/^файлов /, '')} {open ? '⌄' : '›'}
          </button>
          {open && (
            <div className="opt-details-body opt-col opt-kp-files">
              {files.map((f) => (
                <div key={`${f.status}:${f.name}`} className={f.status === 'failed' ? 'opt-error' : f.status === 'skipped' ? 'opt-muted' : ''}>
                  {f.name} — {f.status === 'parsed' ? `разобран, ${plural(f.positions, 'позиция', 'позиции', 'позиций')}${f.reason ? ` (${f.reason})` : ''}` : f.status === 'skipped' ? `пропущен: ${f.reason ?? 'без причины'}` : `не разобран: ${f.reason ?? 'причина неизвестна'}`}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Вкладка «Письмо и файлы»: покупатель, письмо и вложения, текст письма, требования заявки, фото-образцы, что уточнить у клиента. */
function MailTab({ draft }: { draft: KpDraftInfo }) {
  return (
    <div className="opt-col opt-kp-mail-tab">
      <Buyer client={draft.client} />
      <MailSection draft={draft} />
      {draft.letterText && (
        <div className="opt-col">
          <span className="opt-kp-label">Текст письма</span>
          <div className="opt-pre opt-kp-letter">{draft.letterText}</div>
        </div>
      )}
      {(draft.requirements ?? []).length > 0 && (
        <div className="opt-col">
          <span className="opt-kp-label">Требования заявки</span>
          <ul className="opt-kp-questions">
            {(draft.requirements ?? []).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {(draft.photos ?? []).length > 0 && (
        <div className="opt-col">
          <span className="opt-kp-label">Фото-образцы</span>
          {(draft.photos ?? []).map((p) => (
            <div key={p.name} className="opt-kp-sub">
              {p.name}
              {p.ignored ? ' — игнорируется' : p.requestIndex !== null && p.requestIndex !== undefined ? ` — к позиции ${p.requestIndex + 1}` : ' — вопрос в опроснике'}
            </div>
          ))}
        </div>
      )}
      {(draft.questions ?? []).length > 0 && (
        <div className="opt-col">
          <span className="opt-kp-label">Уточнить у клиента</span>
          <ul className="opt-kp-questions">
            {(draft.questions ?? []).map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Покупатель по макету: метка капсом, название компании (и имя), e-mail; адрес не повторяется, если он уже стоит в названии или имени. */
function Buyer({ client }: { client: KpDraftInfo['client'] }) {
  const email = client.email.trim().toLowerCase();
  const parts = [client.org ?? '', client.fio ?? ''].map((x) => x.trim()).filter((x) => x && x.toLowerCase() !== email);
  const hasEmail = email && parts.some((x) => x.toLowerCase().includes(email));
  if (!parts.length && !email) return null;
  return (
    <div className="opt-kp-buyer">
      <div className="opt-kp-label">Покупатель</div>
      {parts.length > 0 ? <div className="opt-kp-name">{parts.join(' · ')}</div> : <div className="opt-kp-name">{client.email.trim()}</div>}
      {parts.length > 0 && email && !hasEmail && <div className="opt-kp-sub">{client.email.trim()}</div>}
    </div>
  );
}

/**
 * Раздел «Письмо» (RFD-AI-AGENT-OPT-MAIL-UI, вариант А): одна строка-статус, по клику — отправитель, тема,
 * папка, вложения со статусом, что пропущено и ошибки разбора. Данные — из payload черновика (те же, что в
 * событии mail_fetch журнала), новых запросов к почте виджет не делает. В черновике красных строк о письме нет.
 */
function MailSection({ draft }: { draft: KpDraftInfo }) {
  const [open, setOpen] = useState(false);
  const src = draft.source;
  if (!src) return null;
  const m = src.mail;
  const attachmentNames = new Set([...(m?.files?.map((f) => f.name) ?? []), ...(m?.taken ?? []), ...(m?.skipped.map((f) => f.name) ?? [])]);
  // Ошибки разбора: по вложениям письма — в раздел письма, по файлам карточки — отдельным списком там же.
  const parseErrors = (src.skipped ?? []).filter((f) => attachmentNames.has(f.name));
  const cardErrors = (src.skipped ?? []).filter((f) => !attachmentNames.has(f.name));
  const summary =
    m?.status === 'found'
      ? `Письмо: ${m.date ? dateTimeMsk(m.date) : 'дата неизвестна'} · ${m.attachments ? plural(m.attachments, 'вложение', 'вложения', 'вложений') : 'без вложений'}`
      : m?.status === 'not_found'
        ? 'Письмо: не найдено'
        : m?.status === 'partial'
          ? 'Письмо: не найдено, ящик просмотрен не полностью'
          : m?.status === 'error'
            ? 'Письмо: ящик не прочитан'
            : m?.status === 'skipped'
              ? `Письмо: из прошлой сборки${src.letterAt ? ` (${date(src.letterAt)})` : ''}, ящик не читали`
          : src.letterAt
            ? `Письмо: ${date(src.letterAt)} (из карточки, ящик не настроен)`
            : 'Письмо: в карточке нет';
  const warn = (m?.status !== 'found' && m?.status !== 'skipped') || (m.files ?? []).some((f) => f.status === 'not_uploaded' && f.reason) || parseErrors.length > 0 || cardErrors.length > 0;
  return (
    <div className="opt-col opt-details">
      <button type="button" className={`opt-details-summary${warn ? ' opt-details-warn' : ''}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {summary} {open ? '⌄' : '›'}
      </button>
      {open && (
        <div className="opt-details-body opt-col">
          {m?.status === 'found' && (
            <>
              <div>Отправитель: {[m.fromName, m.from ?? m.searchedFrom].filter(Boolean).join(' ')}{m.matchedBy === 'domain' ? ' (совпал только домен — проверьте письмо)' : ''}</div>
              {m.subject && <div>Тема: {m.subject}</div>}
              {m.folder && <div>Папка: {m.folder}</div>}
              <MailFiles m={m} parseErrors={parseErrors} />
            </>
          )}
          {(m?.status === 'not_found' || m?.status === 'partial') && <SearchDiag m={m} />}
          {m?.status === 'error' && (
            <div className="opt-error">Ящик не прочитан: {mailFailure(m)}</div>
          )}
          {m?.status === 'skipped' && <div className="opt-muted">{m.error}</div>}
          {!m && <div className="opt-muted">Ящик во вкладке «Письмо» не настроен — черновик по письму и файлам из карточки сделки.</div>}
          <div className="opt-muted">
            {(src.documents ?? []).length ? `Разобрано файлов: ${src.documents.length}` : (src.attachments ?? []).length ? 'Файлы не разобраны' : 'Файлов для разбора нет'}
            {src.mails ? ` · писем в карточке: ${src.mails}` : ''}
          </div>
          {cardErrors.length > 0 && (
            <div className="opt-col">
              <span className="opt-muted">Файлы карточки, которые не разобрались:</span>
              {cardErrors.map((f) => (
                <div key={f.name} className="opt-error">«{f.name}»: {f.reason}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Вложения письма: имя, размер, статус; у старых черновиков без files — по спискам taken/uploaded/skipped. */
function MailFiles({ m, parseErrors }: { m: MailSourceInfo; parseErrors: { name: string; reason: string }[] }) {
  const files =
    m.files ??
    [
      ...m.taken.map((name) => ({ name, size: 0, inline: false, status: m.uploaded.includes(name) ? ('uploaded' as const) : ('not_uploaded' as const), reason: m.skipped.find((x) => x.name === name)?.reason ?? null })),
      ...m.skipped.filter((x) => !m.taken.includes(x.name)).map((x) => ({ name: x.name, size: 0, inline: false, status: 'skipped' as const, reason: x.reason })),
    ];
  if (!files.length) return <div className="opt-muted">Вложений нет.</div>;
  const errorOf = (name: string) => parseErrors.find((e) => e.name === name)?.reason;
  return (
    <div className="opt-col">
      <span className="opt-muted">Вложения:</span>
      {files.map((f) => {
        const parseError = errorOf(f.name);
        const status = f.status === 'uploaded' ? 'загружено в сделку' : f.status === 'skipped' ? `пропущено: ${f.reason ?? 'без причины'}` : `не загружено: ${f.reason ?? 'причина не указана'}`;
        return (
          <div key={f.name} className={f.status === 'uploaded' ? '' : f.status === 'skipped' ? 'opt-muted' : 'opt-error'}>
            {f.name}
            {f.size ? ` (${kb(f.size)})` : ''} — {status}
            {parseError && <div className="opt-error">не разобрано: {parseError}</div>}
          </div>
        );
      })}
    </div>
  );
}

/** Письмо не найдено: критерии поиска и просмотренные папки из diag. */
function SearchDiag({ m }: { m: MailSourceInfo }) {
  const d = m.diag;
  return (
    <div className="opt-col">
      <div>Искали от {m.searchedFrom}{d?.criteria.domain ? ` (и весь домен @${d.criteria.domain})` : ''}{d ? `, даты ${d.criteria.since} – ${d.criteria.before}${d.criteria.windowSource === 'lead' ? ' (от создания сделки)' : d.criteria.windowSource === 'default' ? ' (последние 30 дней)' : ''}` : ''}{d?.criteria.subject ? `, тема «${d.criteria.subject}»` : ''}. Черновик собран по карточке.</div>
      {m.status === 'partial' && <div className="opt-error">{m.error}</div>}
      {d?.partial && d.partial.ranges.length > 0 && <div className="opt-muted">Просмотрено: {d.partial.ranges.join('; ')}</div>}
      {d && d.folders.length > 0 && (
        <div className="opt-col">
          <span className="opt-muted">Папки ({d.folders.length}):</span>
          {d.folders.map((f) => (
            <div key={f.path} className="opt-muted">{f.path}: в окне дат {f.inWindow}, от отправителя {f.bySender + (f.bySenderWithoutDate ?? 0)}</div>
          ))}
        </div>
      )}
      {d && d.skippedFolders.length > 0 && <div className="opt-muted">Не смотрели: {d.skippedFolders.join(', ')}</div>}
      {d?.errors.map((e) => (
        <div key={e} className="opt-error">{e}</div>
      ))}
    </div>
  );
}

/** Группа вопросов «к какой двери» (KB-COMPONENT-DOOR-GROUP): строки одного вида и исполнения без размера. */
interface QuestionGroup {
  key: string;
  title: string;
  lines: KpDraftLine[];
  qty: number;
  options: NonNullable<KpDraftLine['question']>['options'];
  reason: 'many' | 'none';
}

export function questionGroups(lines: KpDraftLine[]): QuestionGroup[] {
  const out = new Map<string, QuestionGroup>();
  for (const l of lines) {
    if (l.priceOutcome !== 'question' || !l.question) continue;
    const key = l.question.group ?? `line:${l.request_index}`;
    const g = out.get(key) ?? { key, title: l.question.groupTitle ?? l.name, lines: [], qty: 0, options: [], reason: l.question.reason };
    g.lines.push(l);
    g.qty += l.qty;
    for (const o of l.question.options) if (!g.options.some((x) => x.requestIndex === o.requestIndex)) g.options.push(o);
    if (l.question.reason === 'many') g.reason = 'many';
    out.set(key, g);
  }
  for (const g of out.values()) g.options.sort((a, b) => a.requestIndex - b.requestIndex);
  return [...out.values()];
}

const lineCategoryOf = (l: KpDraftLine) => l.category ?? (l.kind === 'service' ? 'service' : 'door');

/** Двери заявки для «изменить дверь»: ID прайса, название, размер, количество. */
function doorsOf(lines: KpDraftLine[]) {
  return lines.filter((l) => lineCategoryOf(l) === 'door').map((l) => ({ requestIndex: l.request_index, productId: l.productId ?? null, model: l.name, size: l.size, qty: l.qty }));
}

/** У строки комплектующего: какая дверь и откуда (группа / эта строка) и ссылка «изменить дверь» — выбор только для этой строки. */
function DoorChoice({ line, doors, locked, onDoor }: { line: KpDraftLine; doors: ReturnType<typeof doorsOf>; locked: boolean; onDoor: (doorRequestIndex: number) => void }) {
  const [open, setOpen] = useState(false);
  if (line.priceOutcome === 'question' || !doors.length) return null;
  const by = line.componentDoor !== null && line.componentDoor !== undefined ? (line.componentDoorBy === 'group' ? 'по ответу на группу' : 'выбрана для этой строки') : null;
  return (
    <div className="opt-kp-sub opt-kp-door-chosen">
      {by && <>дверь: поз. {(line.componentDoor as number) + 1} — {by} · </>}
      <button type="button" className="opt-link opt-kp-door-change" disabled={locked} onClick={() => setOpen((v) => !v)}>
        изменить дверь
      </button>
      {open && (
        <div className="opt-kp-question-options">
          {doors.map((d) => (
            <button key={d.requestIndex} type="button" className="opt-btn opt-btn-small opt-kp-door-line-option" disabled={locked} onClick={() => { setOpen(false); onDoor(d.requestIndex); }}>
              {d.productId ? `${d.productId} · ` : ''}{d.model}{d.size ? ` · ${sizeLabel(d.size)}` : ''} · {d.qty.toLocaleString('ru-RU')} шт
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Таблица позиций (п. 6а): №, позиция (название, серой строкой ГОСТ-профиль и обозначение по ГОСТ, комплектация, комплектация
 * по ТЗ, пометки), размер, количество, цена с НДС с цветной меткой источника, скидка, сумма. Работы — под заголовком, без цены;
 * последняя строка — доставка (сумма, самовывоз или «вопрос в опроснике»).
 */
function KpTable({ lines, draft, research, locked, onEdit, onFind, onDoor }: { lines: KpDraftLine[]; draft: KpDraftInfo; research: ResearchState | null; locked: boolean; onEdit: (i: number, patch: Partial<KpDraftLine>) => void; onFind: (requestIndex: number) => void; onDoor?: (requestIndex: number, doorRequestIndex: number) => void }) {
  // «Цена не задана» под позицией не показываем: это видно по метке «нет цены».
  const reasons = (i: number) => (draft.needsManager ?? []).filter((n) => n.request_index === i && n.reason !== 'цена не задана').map((n) => n.reason);
  if (!lines.length) return <div className="opt-kp-note">Позиций не нашлось ни в файлах, ни в письме — добавьте их в карточку и соберите заново</div>;
  const d = draft.delivery;
  let n = 0;
  return (
    <table className="opt-kp-table">
      <thead>
        <tr>
          <th className="opt-kp-col-n">№</th>
          <th>Позиция</th>
          <th className="opt-kp-col-size">Размер</th>
          <th className="opt-kp-col-qty">Кол-во</th>
          <th className="opt-kp-col-price">Цена с НДС</th>
          <th className="opt-kp-col-disc">Скидка, %</th>
          <th className="opt-kp-col-sum">Сумма</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l, i) => {
          const service = isServiceLine(l);
          const firstService = service && !lines.slice(0, i).some((x) => isServiceLine(x));
          const why = reasons(l.request_index);
          const pos = research?.positions?.find((p) => p.requestIndex === l.request_index) ?? null;
          const src = priceSourceOf(l);
          const gost = profileText(l.gostProfile);
          const sum = l.price === null || l.priceOutcome === 'included' || service || l.excluded ? null : l.price * l.qty * (1 - l.discount / 100);
          if (!service && !l.excluded) n += 1;
          return [
            firstService ? (
              <tr key={`g-${i}`} className="opt-kp-group-row">
                <td colSpan={7} className="opt-kp-group">Работы и услуги — по замеру, в таблицу и итог КП не входят</td>
              </tr>
            ) : null,
            <tr key={`${l.request_index}-${i}`} className={`opt-kp-row${service ? ' opt-kp-row-service' : ''}${l.excluded ? ' opt-kp-row-excluded' : ''}`}>
              <td className="opt-kp-col-n">{service || l.excluded ? '' : n}</td>
              <td className="opt-kp-col-name">
                <div className="opt-kp-row-name">{l.name || '—'}</div>
                {(gost || l.gostDesignation) && <div className="opt-kp-sub opt-kp-row-gost">{[gost, l.gostDesignation ? `по ГОСТ: ${l.gostDesignation}` : ''].filter(Boolean).join(' · ')}</div>}
                {l.priceModel && <div className="opt-kp-sub opt-kp-row-model">Обозначение по прайсу: {l.priceModel}{l.priceAbbr && !l.priceModel.toLowerCase().includes(l.priceAbbr.toLowerCase()) ? ` (${l.priceAbbr})` : ''}</div>}
                {l.equipment && <div className="opt-kp-sub opt-kp-row-equipment">Комплектация: {l.equipment}</div>}
                {l.tzEquipment && <div className="opt-kp-sub opt-kp-row-tz">Комплектация по ТЗ: {l.tzEquipment}</div>}
                {l.letterSpec && <div className="opt-kp-sub opt-kp-row-letter">Из письма: {l.letterSpec}</div>}
                {markupOf(l) && <div className="opt-kp-sub opt-kp-row-markup">{markupOf(l)}</div>}
                {l.excluded && <div className="opt-kp-sub opt-kp-stale">исключена в опроснике — в КП не идёт</div>}
                {l.priceOutcome === 'included' && <div className="opt-kp-sub opt-kp-outcome">входит в цену блока{l.includedIn ? ` (${l.includedIn})` : ''}: в КП — под дверью, не строкой</div>}
                {l.priceOutcome === 'estimate' && <div className="opt-kp-sub opt-kp-outcome">сметная цена — для сметы, уточнить у менеджера</div>}
                {l.priceOutcome === 'question' && l.question && <div className="opt-kp-sub opt-kp-outcome opt-kp-stale opt-kp-question-ref">вопрос «к какой двери» — в опроснике (группа «{l.question.groupTitle ?? l.name}»)</div>}
                {!service && lineCategoryOf(l) === 'component' && <DoorChoice line={l} doors={doorsOf(lines)} locked={locked || !onDoor} onDoor={(door) => onDoor?.(l.request_index, door)} />}
                {l.quoteNotes && l.quoteNotes.length > 0 && <div className="opt-kp-sub opt-kp-quote-notes">Примечание в КП: {l.quoteNotes.join(' ')}</div>}
                {why.length > 0 && <div className="opt-kp-sub opt-kp-row-why">{why.join('; ')}</div>}
                {!service && !l.excluded && <PriceState line={l} pos={pos} locked={locked} onFind={() => onFind(l.request_index)} />}
              </td>
              <td className="opt-kp-col-size">{l.size ? sizeLabel(l.size) : '—'}</td>
              <td className="opt-kp-col-qty">
                <input type="number" min={0.5} step="any" aria-label="Количество" value={l.qty} disabled={locked && draft.status !== 'draft'} onChange={(e) => onEdit(i, { qty: Math.max(0.5, Number(e.target.value) || 1) })} />
              </td>
              <td className="opt-kp-col-price">
                {service ? (
                  <span className="opt-kp-sub">по замеру</span>
                ) : (
                  <>
                    {/* KB-DOOR-MATCH-2, п. 5: «входит в цену блока» и «нет цены» — подсказкой в поле, не 0 ₽. */}
                    <input type="number" min={0} aria-label="Цена" value={l.priceOutcome === 'included' ? '' : (l.price ?? '')} placeholder={l.priceOutcome === 'included' ? 'в цене блока' : 'нет цены'} onChange={(e) => onEdit(i, { price: e.target.value === '' ? null : Number(e.target.value) })} />
                    <span className={`opt-kp-src opt-kp-src-${src.kind}`} title={src.label}>{src.label}</span>
                    {priceIsStale(l) && <span className="opt-kp-stale"> · цена устарела</span>}
                  </>
                )}
              </td>
              <td className="opt-kp-col-disc">
                {!service && <input type="number" min={0} max={100} aria-label="Скидка" value={l.discount} onChange={(e) => onEdit(i, { discount: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} />}
              </td>
              <td className="opt-kp-col-sum">{rub(sum)}</td>
            </tr>,
          ];
        })}
        <tr className="opt-kp-row opt-kp-row-delivery">
          <td className="opt-kp-col-n" />
          <td className="opt-kp-col-name">
            <div className="opt-kp-row-name">Доставка</div>
            <div className="opt-kp-sub">{d?.mode === 'pickup' ? 'самовывоз — строки в КП нет' : d?.mode === 'delivery' ? (d.address ?? 'адрес не указан') : 'не указана — вопрос в опроснике'}</div>
          </td>
          <td className="opt-kp-col-size" />
          <td className="opt-kp-col-qty">{d?.mode === 'delivery' ? '1 усл.' : ''}</td>
          <td className="opt-kp-col-price">{d?.mode === 'delivery' ? rub(d.sum) : '—'}</td>
          <td className="opt-kp-col-disc" />
          <td className="opt-kp-col-sum">{d?.mode === 'delivery' ? rub(d.sum) : '—'}</td>
        </tr>
      </tbody>
    </table>
  );
}

/** «Ещё в проекте» (KP-LETTER-SCOPE, п. 2): строки вложений, не названные в письме, — свёрнутым списком, «добавить» — в позиции. */
function ProjectRest({ draft, locked, onAdd }: { draft: KpDraftInfo; locked: boolean; onAdd: (index: number) => void }) {
  const [open, setOpen] = useState(false);
  const rest = draft.projectRest ?? [];
  if (!rest.length) return null;
  return (
    <div className="opt-col opt-details opt-kp-project-rest">
      <button type="button" className="opt-details-summary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        Ещё в проекте: {rest.length} поз. {open ? '⌄' : '›'}
      </button>
      {open && (
        <div className="opt-details-body opt-col">
          {rest.map((it, i) => (
            <div key={`${it.mark ?? it.raw}-${i}`} className="opt-row opt-kp-project-row">
              <span className="opt-grow">
                {it.name || it.raw}
                {it.width_mm || it.height_mm ? ` · ${it.width_mm ?? '—'} × ${it.height_mm ?? '—'} мм` : ''} · {it.qty.toLocaleString('ru-RU')} шт
                {it.sourceFiles?.length ? <span className="opt-kp-sub"> · {it.sourceFiles.join(', ')}</span> : null}
              </span>
              <button type="button" className="opt-btn opt-btn-small" disabled={locked} onClick={() => onAdd(i)}>
                добавить
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Состояние цены позиции: в очереди / идёт / ошибка задания / из прайса / цены интернета ждут выбора / нет цены; «Найти цену»
 * ищет заново (прайс → интернет по правилам). Источники интернета — в вопросе опросника.
 */
function PriceState({ line, pos, locked, onFind }: { line: KpDraftLine; pos: ResearchPosition | null; locked: boolean; onFind: () => void }) {
  const job = pos?.job ?? null;
  const busy = job?.state === 'queued' || job?.state === 'running';
  let status: string;
  if (busy) status = job?.state === 'queued' ? 'поиск цены в очереди…' : 'идёт поиск цены…';
  else if (job?.state === 'failed') status = `поиск не выполнен: ${job.error}`;
  else if (line.priceSource === 'research' || line.priceSource === 'analog') status = 'цена прежнего поиска — в КП не идёт';
  else if (line.price === null && line.web) status = `цены из интернета ${rub(line.web.min)} – ${rub(line.web.max)} — выберите в опроснике`;
  else if (line.priceOutcome === 'not_priced') status = `${line.priceLabel ?? 'в прайсе нет'} — уточнить у менеджера`;
  else status = '';
  const isError = job?.state === 'failed';
  return (
    <div className="opt-kp-price-state opt-row">
      {status && <span className={`opt-details-summary${isError ? ' opt-details-warn' : ''}`}>{status}</span>}
      {!busy && !locked && (
        <button type="button" className="opt-btn opt-btn-small" onClick={onFind} title="Найти цену позиции заново: прайс, затем интернет">
          Найти цену
        </button>
      )}
    </div>
  );
}

/** Примечание под кнопками узкой колонки: что дальше по состоянию черновика. */
function KpNote({ draft, why }: { draft: KpDraftInfo; why: string | null }) {
  if (draft.status === 'sent') return <>Отправлено{draft.sentAt ? ` ${date(draft.sentAt)}` : ''}. Повторная отправка — через «Отправить клиенту» с подтверждением.</>;
  if (draft.status === 'built') return <>Документ собран{draft.hasPdf ? ' (DOCX и PDF)' : ' (PDF не получился, есть DOCX)'} — файлы в карточке сделки. Проверьте документ и отправьте клиенту.</>;
  if (why) return <span className="opt-kp-why">Документ не собирается: {why}. Ответы и цены — в окне «Развернуть ⤢».</span>;
  return <>Документ можно собрать: проверьте цены, комплектацию и данные покупателя в окне «Развернуть ⤢».</>;
}
