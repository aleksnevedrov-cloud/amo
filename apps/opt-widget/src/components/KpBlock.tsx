import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '@core/widget-core';
import type { DraftJob, KpApi, KpDraftInfo, KpDraftLine, MailSourceInfo, ResearchPosition, ResearchState } from '../api.ts';
import { KbAnswer } from './KbAnswer.tsx';
import { SendPreview } from './SendPreview.tsx';

/**
 * Блок «Агента опт» в карточке сделки. Единственный вход — кнопка «Собрать КП» (ТЗ 6.4):
 * задание уходит воркеру, блок опрашивает состояние; затем менеджер правит цены, собирает
 * документ и отправляет письмо из окна предпросмотра. Автосборки и автоотправки нет.
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
/** Срок актуальности рыночной цены (веб-поиск), дни — после него в плитке «цена устарела» (RFD-AI-AGENT-OPT-KB). */
const MARKET_STALE_DAYS = 30;

/** Подпись источника цены в плитке: с сервера (база знаний, рынок, менеджер) либо по старому полю priceSource. */
/** Работы (монтаж, врезка, доставка): по категории или старому kind — в итог не входят, цена не требуется (KB-COMPONENTS). */
export const isServiceLine = (l: Pick<KpDraftLine, 'kind' | 'category'>): boolean => l.category === 'service' || l.kind === 'service';

function priceSourceLabel(l: KpDraftLine): string {
  if (l.priceLabel) return l.priceLabel;
  return l.priceSource === 'manager' ? 'изменено менеджером' : l.priceSource === 'analog' ? 'по аналогу' : l.priceSource === 'research' ? 'по рынку' : l.priceSource === 'kb' ? 'по базе' : '';
}
function priceIsStale(l: KpDraftLine, now = Date.now()): boolean {
  if (l.price === null) return false;
  if (l.priceStale) return true;
  if ((l.priceSource === 'research' || l.priceSource === 'analog') && l.market?.researchedAt) return now - new Date(l.market.researchedAt).getTime() > MARKET_STALE_DAYS * 86_400_000;
  return false;
}

const rub = (n: number | null) => (n === null ? '—' : `${n.toLocaleString('ru-RU')} ₽`);
const date = (iso: string) => new Date(iso).toLocaleDateString('ru-RU');
/** Дата и время по Москве: «13.10.2026 11:06». */
const dateTimeMsk = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' })} ${d.toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' })}`;
};
const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`);

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

  const take = useCallback((d: KpDraftInfo | null) => {
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
    setLines((xs) => xs.map((l, k) => (k === i ? { ...l, ...patch, ...('price' in patch && patch.price !== l.price && patch.price !== null ? { priceSource: 'manager' as const } : {}) } : l)));
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
  const findPrices = async (which: number[] | 'all', force = false) => {
    if (!draftId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.research(draftId, which, force);
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

export function KpBlock({ api, leadId }: { api: KpApi; leadId: number }) {
  const { draft, job, lines, dirty, busy, error, setError, pending, act, edit, take, research, researching, progress, findPrices } = useKpDraft(api, leadId);
  const [preview, setPreview] = useState(false);
  const start = () => void act(() => api.makeDraft(leadId));

  // Работы в итог не входят и цены для сборки не требуют (KB-COMPONENTS, п. 5).
  const goods = lines.filter((l) => !isServiceLine(l));
  const total = goods.reduce((sum, l) => sum + (l.price === null ? 0 : l.price * l.qty * (1 - l.discount / 100)), 0);
  // KB-COMPONENT-DOOR: вопросы «к какой двери» блокируют сборку; «в прайсе цены нет» и «входит в блок» — нет (в КП — «уточнить» / под дверью).
  // KB-COMPONENT-DOOR-GROUP: один вопрос на группу похожих комплектующих.
  const groups = questionGroups(goods);
  const questions = groups.length;
  const ready = goods.length > 0 && questions === 0 && goods.every((l) => l.price !== null || l.priceOutcome === 'not_priced' || l.priceOutcome === 'included');

  const kpStatus = STATUS[draft?.status ?? 'draft'] ?? draft?.status ?? '';
  // Скачивание файла КП (RFD-AI-AGENT-OPT-KP-DOWNLOAD): подписанная ссылка от API, по ней браузер получает файл как вложение.
  const download = async (kind: 'pdf' | 'docx') => {
    if (!draft) return;
    try {
      const { url, filename } = await api.fileLink(draft.id, kind);
      openDownload(url, filename);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  // Макет Figma «10 Агент опт — КП» (RFD-AI-AGENT-OPT-WIDGET-DESIGN): карточки с рамкой и радиусом 13 px на сером фоне,
  // блок в карточке сделки ~500 px. Шапку с логотипом рисует amoCRM (.opt-caption).
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

  return (
    <div className="opt-root opt-kp">
      {/* 2. Черновик КП: статус, номер, покупатель, письмо */}
      <section className="opt-kp-card">
        <div className="opt-kp-head">
          <h3 className="opt-kp-title">Черновик КП</h3>
          <span className={`opt-kp-badge${draft.status === 'draft' || draft.status === 'built' || draft.status === 'sent' ? ' opt-kp-badge-green' : ''}`}>{kpStatus}</span>
          {(draft.status === 'built' || draft.status === 'sent') && (draft.hasPdf || draft.hasDocx) && (
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
          )}
        </div>
        <div className="opt-kp-sub">{draft.kpNo ?? 'Номер появится после сборки документа'}</div>
        <div className="opt-kp-sep" />
        <Buyer client={draft.client} />
        <div className="opt-kp-sep" />
        <MailSection draft={draft} />
        {pending && <div className="opt-kp-sub">{job?.state === 'queued' ? 'Новый черновик в очереди…' : 'Собираю новый черновик…'}</div>}
        {job?.state === 'failed' && <div className="opt-error">Новый черновик не собран: {job.error}</div>}
        {error && <div className="opt-error">{error}</div>}
      </section>

      {/* 3. Позиции КП */}
      <section className="opt-kp-card">
        <div className="opt-kp-head">
          <h3 className="opt-kp-title">Позиции КП</h3>
          <span className="opt-kp-badge" title={plural(lines.length, 'позиция', 'позиции', 'позиций')}>{lines.length}</span>
        </div>
        {lines.length === 0 ? (
          <div className="opt-kp-note">Позиций не нашлось ни в файлах, ни в письме — добавьте их в карточку и соберите заново</div>
        ) : (
          <>
            {draft.status === 'draft' && (
              <div className="opt-actions">
                <button type="button" className="opt-btn opt-btn-green" disabled={busy || pending || researching || dirty} title={dirty ? 'Сначала сохраните правки' : 'Найти рыночные цены по позициям без цены; позиции с ценой не трогаются'} onClick={() => void findPrices('all')}>
                  {researching ? `Ищу цены…${progress ? ` ${progress}` : ''}` : 'Найти цены'}
                </button>
              </div>
            )}
            {groups.length > 0 && <ComponentQuestions groups={groups} locked={draft.status !== 'draft' || busy || pending || dirty} onAnswer={(key, door) => void act(() => api.componentDoorGroup(draft.id, key, door))} />}
            <KpLinesTiles lines={lines} needsManager={draft.needsManager} research={research} locked={draft.status !== 'draft' || busy || pending || dirty} onEdit={edit} onFind={(i, force) => void findPrices([i], force)} onDoor={(i, door) => void act(() => api.componentDoor(draft.id, i, door))} />
            <div className="opt-kp-sep" />
            <div className="opt-kp-total">
              <span>Итого</span>
              <b>{rub(Math.round(total))}</b>
            </div>
          </>
        )}
      </section>

      {/* 4. Уточнить у клиента */}
      {draft.questions.length > 0 && (
        <section className="opt-kp-card">
          <div className="opt-kp-head">
            <h3 className="opt-kp-title">Уточнить у клиента</h3>
          </div>
          <ul className="opt-kp-questions">
            {draft.questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </section>
      )}

      {/* 4a. Ответ из базы знаний на вопрос покупателя (RFD-AI-AGENT-OPT-KB, этап 4) */}
      <section className="opt-kp-card">
        <div className="opt-kp-head">
          <h3 className="opt-kp-title">Ответ из базы знаний</h3>
        </div>
        <KbAnswer api={api} leadId={leadId} compact />
      </section>

      {/* 5. Действия с КП */}
      <section className="opt-kp-card">
        <div className="opt-kp-head">
          <h3 className="opt-kp-title">Действия с КП</h3>
        </div>
        <KpActions
          draft={draft}
          busy={busy || pending}
          dirty={dirty}
          ready={ready}
          questions={questions}
          onDraft={start}
          onSave={() => void act(() => api.saveDraftItems(draft.id, lines))}
          onBuild={() => void act(() => api.buildDoc(draft.id))}
          onSend={() => setPreview(true)}
        />
      </section>

      {/* 6. Примечание */}
      <section className="opt-kp-card opt-kp-note">
        <KpNote draft={draft} ready={ready} questions={questions} />
      </section>

      {preview && (
        <SendPreview
          api={api}
          draft={draft}
          onClose={() => setPreview(false)}
          onSent={(d) => {
            setPreview(false);
            take(d);
          }}
        />
      )}
    </div>
  );
}

/** Покупатель по макету: метка капсом, название компании (и имя), e-mail; адрес не повторяется, если он уже стоит в названии или имени. */
function Buyer({ client }: { client: KpDraftInfo['client'] }) {
  const email = client.email.trim().toLowerCase();
  const parts = [client.org, client.fio].map((x) => x.trim()).filter((x) => x && x.toLowerCase() !== email);
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
  const parseErrors = src.skipped.filter((f) => attachmentNames.has(f.name));
  const cardErrors = src.skipped.filter((f) => !attachmentNames.has(f.name));
  const summary =
    m?.status === 'found'
      ? `Письмо: ${m.date ? dateTimeMsk(m.date) : 'дата неизвестна'} · ${m.attachments ? plural(m.attachments, 'вложение', 'вложения', 'вложений') : 'без вложений'}`
      : m?.status === 'not_found'
        ? 'Письмо: не найдено'
        : m?.status === 'partial'
          ? 'Письмо: не найдено, ящик просмотрен не полностью'
          : m?.status === 'error'
            ? 'Письмо: ящик не прочитан'
          : src.letterAt
            ? `Письмо: ${date(src.letterAt)} (из карточки, ящик не настроен)`
            : 'Письмо: в карточке нет';
  const warn = m?.status !== 'found' || (m.files ?? []).some((f) => f.status === 'not_uploaded' && f.reason) || parseErrors.length > 0 || cardErrors.length > 0;
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
            <div className="opt-error">
              Ящик не прочитан: {m.error}
              {m.retryAt ? ` — следующая попытка после ${dateTimeMsk(m.retryAt)}` : ''}
            </div>
          )}
          {!m && <div className="opt-muted">Ящик во вкладке «Письмо» не настроен — черновик по письму и файлам из карточки сделки.</div>}
          <div className="opt-muted">
            {src.documents.length ? `Разобрано файлов: ${src.documents.length}` : src.attachments.length ? 'Файлы не разобраны' : 'Файлов для разбора нет'}
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

/** Позиции плитками по макету: название, размер серым, состояние поиска цены с раскрытием «Источники», поля «Количество», «Цена», «Скидка». */
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

const lineWord = (n: number) => plural(n, 'строка', 'строки', 'строк');

/** Блок над позициями: по одному вопросу на группу, кнопки — двери заявки; ответ — ко всем строкам группы. */
function ComponentQuestions({ groups, locked, onAnswer }: { groups: QuestionGroup[]; locked: boolean; onAnswer: (key: string, doorRequestIndex: number) => void }) {
  return (
    <div className="opt-kp-questions-block">
      <div className="opt-kp-questions-title">Вопросы по комплектующим ({groups.length})</div>
      {groups.map((g) => (
        <div key={g.key} className="opt-kp-question">
          <div className="opt-kp-question-text">
            К какой двери считать «{g.title}» ({lineWord(g.lines.length)}, {g.qty.toLocaleString('ru-RU')} шт)?
          </div>
          <div className="opt-kp-sub">{g.reason === 'many' ? 'Подходит несколько дверей заявки — цена всех строк группы возьмётся из строки прайса выбранной двери:' : 'Ни одна дверь заявки не подходит однозначно — выберите дверь:'}</div>
          <div className="opt-kp-question-options">
            {g.options.map((o) => (
              <button key={o.requestIndex} type="button" className="opt-btn opt-btn-small opt-kp-door-option" disabled={locked} onClick={() => onAnswer(g.key, o.requestIndex)}>
                {o.productId ? `${o.productId} · ` : ''}{o.model}{o.size ? ` · ${sizeLabel(o.size)}` : ''} · {o.qty.toLocaleString('ru-RU')} шт
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
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

function KpLinesTiles({ lines, needsManager, research, locked, onEdit, onFind, onDoor }: { lines: KpDraftLine[]; needsManager: KpDraftInfo['needsManager']; research: ResearchState | null; locked: boolean; onEdit: (i: number, patch: Partial<KpDraftLine>) => void; onFind: (requestIndex: number, force: boolean) => void; onDoor?: (requestIndex: number, doorRequestIndex: number) => void }) {
  // «Цена не задана» под размером не показываем: это состояние и так видно в поле «Цена» (DESIGN-FIX, п. 4).
  const reasons = (i: number) => needsManager.filter((n) => n.request_index === i && n.reason !== 'цена не задана').map((n) => n.reason);
  return (
    <div className="opt-kp-tiles">
      {lines.map((l, i) => {
        const why = reasons(l.request_index);
        const pos = research?.positions?.find((p) => p.requestIndex === l.request_index) ?? null;
        const service = isServiceLine(l);
        // Работы и услуги идут после товаров: заголовок перед первой из них (XLSX-2, п. 3).
        const firstService = service && !lines.slice(0, i).some((x) => x.kind === 'service');
        return (
          <div key={`${l.request_index}-${i}`} className={`opt-kp-tile${service ? ' opt-kp-tile-service' : ''}`}>
            {firstService && <div className="opt-kp-group">Работы и услуги</div>}
            <div className="opt-kp-tile-name">{l.name || '—'}</div>
            {l.equipment && <div className="opt-kp-sub opt-kp-tile-equipment">Комплектация: {l.equipment}</div>}
            {l.priceModel && <div className="opt-kp-sub opt-kp-tile-model">Обозначение по прайсу: {l.priceModel}{l.priceAbbr && !l.priceModel.toLowerCase().includes(l.priceAbbr.toLowerCase()) ? ` (${l.priceAbbr})` : ''}</div>}
            {l.size && <div className="opt-kp-sub">{sizeLabel(l.size)}</div>}
            {service && <div className="opt-kp-sub opt-kp-service-note">работы — по замеру: в таблицу и итог КП не входят, под таблицей фраза о расчёте после замера</div>}
            {l.priceOutcome === 'included' && <div className="opt-kp-sub opt-kp-outcome">входит в цену блока{l.includedIn ? ` (${l.includedIn})` : ''}: отдельной строкой в таблицу и итог КП не идёт, пишется под дверью</div>}
            {l.priceOutcome === 'not_priced' && <div className="opt-kp-sub opt-kp-outcome opt-kp-stale">в прайсе цены нет — уточнить у менеджера (в КП строка без цены, в итог не входит)</div>}
            {l.priceOutcome === 'estimate' && <div className="opt-kp-sub opt-kp-outcome">сметная цена — для сметы, уточнить у менеджера</div>}
            {l.priceOutcome === 'question' && l.question && <div className="opt-kp-sub opt-kp-outcome opt-kp-stale opt-kp-question-ref">вопрос «к какой двери» — в блоке «Вопросы по комплектующим» (группа «{l.question.groupTitle ?? l.name}»)</div>}
            {!service && lineCategoryOf(l) === 'component' && <DoorChoice line={l} doors={doorsOf(lines)} locked={locked || !onDoor} onDoor={(door) => onDoor?.(l.request_index, door)} />}
            {l.quoteNotes && l.quoteNotes.length > 0 && <div className="opt-kp-sub opt-kp-quote-notes">Примечание в КП: {l.quoteNotes.join(' ')}</div>}
            {why.length > 0 && <div className="opt-kp-sub">{why.filter((w) => !(service && w === 'цена не задана')).join('; ')}</div>}
            {!service && <PriceState line={l} pos={pos} locked={locked} onFind={(force) => onFind(l.request_index, force)} />}
            <div className="opt-kp-fields">
              <label className="opt-kp-field">
                <span className="opt-kp-label">Количество</span>
                <input type="number" min={0.5} step="any" value={l.qty} onChange={(e) => onEdit(i, { qty: Math.max(0.5, Number(e.target.value) || 1) })} />
              </label>
              <label className="opt-kp-field opt-kp-field-price">
                <span className="opt-kp-label">
                  Цена{priceSourceLabel(l) ? ` · ${priceSourceLabel(l)}` : ''}
                  {priceIsStale(l) && <span className="opt-kp-stale"> · цена устарела</span>}
                </span>
                <input type="number" min={0} value={l.price ?? ''} placeholder={service ? 'по замеру' : 'Нет цены'} onChange={(e) => onEdit(i, { price: e.target.value === '' ? null : Number(e.target.value) })} />
              </label>
              <label className="opt-kp-field opt-kp-field-discount">
                <span className="opt-kp-label">Скидка</span>
                <span className="opt-kp-suffix">
                  <input type="number" min={0} max={100} value={l.discount} onChange={(e) => onEdit(i, { discount: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} />
                  <span>%</span>
                </span>
              </label>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const VAT_TITLE: Record<string, string> = { included: 'с НДС', no_vat: 'без НДС', pre_net: 'до НДС', unknown: 'НДС не указан' };
const UNIT_TITLE: Record<string, string> = { piece: 'шт', set: 'компл.', m2: 'м²' };

/**
 * Состояние поиска цены по позиции: идёт поиск / найдено N источников / цены не найдены / ошибка; кнопка
 * «Найти цену» или «Искать заново» (мимо кэша); раскрытие «Источники» — все предложения, принятые первыми
 * (продавец, цена на сайте, размер, пересчитанная цена, ссылка), отклонённые серым с причиной.
 */
function PriceState({ line, pos, locked, onFind }: { line: KpDraftLine; pos: ResearchPosition | null; locked: boolean; onFind: (force: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const job = pos?.job ?? null;
  const r = pos?.research ?? null;
  const busy = job?.state === 'queued' || job?.state === 'running';
  let status: string;
  const fromKb = line.priceSource === 'kb' && line.price !== null;
  if (busy) status = job?.state === 'queued' ? 'поиск цены в очереди…' : 'идёт поиск цены…';
  else if (job?.state === 'failed') status = `поиск не выполнен: ${job.error}`;
  else if (fromKb && !r) status = `из базы знаний: ${line.priceLabel ?? 'по базе'}`;
  else if (!r) status = line.market ? `источников ${line.market.count}` : '';
  else if (r.status === 'failed') status = `ошибка поиска: ${r.error ?? 'без текста'}`;
  else if (r.status === 'none') status = 'цены не найдены';
  else status = `найдено ${plural(r.stats?.count ?? 0, 'источник', 'источника', 'источников')} · ${dateTimeMsk(r.createdAt)}`;
  const isError = job?.state === 'failed' || r?.status === 'failed';
  const canOpen = Boolean(r && r.offers.length);
  return (
    <div className="opt-kp-price-state opt-col">
      <div className="opt-row opt-kp-price-row">
        {status && (
          <button type="button" className={`opt-details-summary${isError ? ' opt-details-warn' : ''}`} disabled={!canOpen} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {status}
            {canOpen ? ` · Источники ${open ? '⌄' : '›'}` : ''}
          </button>
        )}
        {!busy && !locked && (
          <button type="button" className="opt-btn opt-btn-small" onClick={() => onFind(Boolean(r) || fromKb)} title={fromKb && !r ? 'Веб-поиск мимо базы знаний и кэша' : r ? 'Искать заново, не используя сохранённый результат' : 'Сначала база знаний, затем веб-поиск'}>
            {fromKb && !r ? 'Искать в интернете' : r ? 'Искать заново' : 'Найти цену'}
          </button>
        )}
      </div>
      {open && r && (
        <div className="opt-details-body opt-col">
          {r.stats && (
            <div>
              Диапазон {rub(r.stats.min)} – {rub(r.stats.max)}, медиана <b>{rub(r.stats.median)}</b> за шт
              {line.coefficient && line.coefficient !== 1 ? ` × ${line.coefficient}` : ''}
            </div>
          )}
          {r.analog && <div>Аналог: {r.analog.reason}</div>}
          {r.offers.map((o) => (
            <div key={o.url} className={o.accepted ? 'opt-kp-offer' : 'opt-kp-offer opt-muted'}>
              <div>
                {o.manufacturer ? '★ ' : ''}
                {o.seller || 'продавец не указан'} — {o.price.toLocaleString('ru-RU')} {o.currency}/{UNIT_TITLE[o.unit] ?? o.unit}
                {o.sourceSize ? `, ${o.sourceSize}` : ''}
                {o.accepted && o.unitPrice !== null && o.unitPrice !== o.price ? ` → ${rub(o.unitPrice)} за шт` : ''}
                {!o.accepted ? ` — ${o.reason ?? 'отклонено'}` : ''}
              </div>
              <div className="opt-muted">
                {VAT_TITLE[o.vatStated] ?? o.vatStated}
                {o.notes.length ? `; ${o.notes.join('; ')}` : ''}
                {o.formula ? `; ${o.formula}` : ''} ·{' '}
                <a href={o.url} target="_blank" rel="noreferrer" className="opt-link">
                  {safeHost(o.url)}
                </a>
              </div>
            </div>
          ))}
          <div className="opt-muted">
            Запрос: {r.query}; вызовов поиска {r.webSearchCalls}, ${r.costUsd.toFixed(3)}
          </div>
        </div>
      )}
    </div>
  );
}

const safeHost = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** Кнопки шагов во всю ширину одна под другой: собрать заново → сохранить правки → собрать документ → отправить (окно предпросмотра). */
function KpActions({ draft, busy, dirty, ready, questions = 0, onDraft, onSave, onBuild, onSend }: { draft: KpDraftInfo; busy: boolean; dirty: boolean; ready: boolean; questions?: number; onDraft: () => void; onSave: () => void; onBuild: () => void; onSend: () => void }) {
  const canSend = (draft.status === 'built' || draft.status === 'sent') && !dirty;
  return (
    <div className="opt-actions">
      <button type="button" className="opt-btn" disabled={busy} onClick={onDraft} title="Прочитать карточку заново; правки в позициях будут потеряны">
        Собрать заново
      </button>
      <button type="button" className="opt-btn" disabled={busy || !dirty} onClick={onSave}>
        Сохранить правки
      </button>
      <button type="button" className="opt-btn opt-btn-green" disabled={busy || dirty || !ready} title={dirty ? 'Сначала сохраните правки' : questions ? 'Ответьте на вопросы по комплектующим' : !ready ? 'У каждой позиции должна быть цена' : 'Собрать DOCX и PDF по шаблону'} onClick={onBuild}>
        Собрать документ
      </button>
      <button type="button" className="opt-btn" disabled={busy || !canSend} title={canSend ? 'Открыть письмо перед отправкой' : 'Доступно после сборки документа'} onClick={onSend}>
        Отправить клиенту
      </button>
    </div>
  );
}

/** Примечание под действиями: что дальше по состоянию черновика. */
function KpNote({ draft, ready, questions = 0 }: { draft: KpDraftInfo; ready: boolean; questions?: number }) {
  if (draft.status === 'sent') return <>Отправлено{draft.sentAt ? ` ${date(draft.sentAt)}` : ''}. Повторная отправка — через «Отправить клиенту» с подтверждением.</>;
  if (draft.status === 'built') return <>Документ собран{draft.hasPdf ? ' (DOCX и PDF)' : ' (PDF не получился, есть DOCX)'} — файлы в карточке сделки. Проверьте документ и отправьте клиенту.</>;
  if (questions > 0 && draft.status === 'draft') return <span className="opt-kp-questions-hint">Ответьте на вопросы по комплектующим ({questions}): в блоке над позициями выберите дверь для каждой группы — цена всех её строк возьмётся из строки прайса этой двери. До ответа документ не собирается.</span>;
  if (!ready && draft.items.length > 0) return <>Документ можно отправить после сборки и проверки цены, состава комплекта и данных покупателя. Сборка документа включится, когда у каждой позиции (кроме работ) будет цена.</>;
  return <>Документ можно отправить после сборки и проверки цены, состава комплекта и данных покупателя.</>;
}
