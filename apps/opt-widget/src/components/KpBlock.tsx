import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '@core/widget-core';
import type { DraftJob, KpApi, KpDraftInfo, KpDraftLine, MailSourceInfo, ResearchPosition, ResearchState } from '../api.ts';
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

const rub = (n: number | null) => (n === null ? '—' : `${n.toLocaleString('ru-RU')} ₽`);
const date = (iso: string) => new Date(iso).toLocaleDateString('ru-RU');
/** Дата и время по Москве: «13.10.2026 11:06». */
const dateTimeMsk = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' })} ${d.toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' })}`;
};
const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`);

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
  const draftId = draft?.id ?? null;
  const loadResearch = useCallback(async () => {
    if (!draftId) return;
    try {
      const r = await api.researchState(draftId);
      if (!alive.current) return;
      setResearch(r);
      // Поиск закончился — цены легли в черновик: перечитываем его, не трогая несохранённые правки менеджера.
      if (!r.pending && wasPending.current && !dirty) await refresh();
      wasPending.current = r.pending;
    } catch (err) {
      if (alive.current) setError(errorMessage(err));
    }
  }, [api, draftId, refresh, dirty]);
  useEffect(() => {
    setResearch(null);
    void loadResearch();
  }, [loadResearch]);
  const researching = research?.pending ?? false;
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
      await loadResearch();
    } catch (err) {
      if (alive.current) setError(errorMessage(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return { draft, job, lines, dirty, busy, error, pending, act, edit, take, research, researching, findPrices };
}

export function KpBlock({ api, leadId }: { api: KpApi; leadId: number }) {
  const { draft, job, lines, dirty, busy, error, pending, act, edit, take, research, researching, findPrices } = useKpDraft(api, leadId);
  const [preview, setPreview] = useState(false);
  const start = () => void act(() => api.makeDraft(leadId));

  const total = lines.reduce((sum, l) => sum + (l.price === null ? 0 : l.price * l.qty * (1 - l.discount / 100)), 0);
  const ready = lines.length > 0 && lines.every((l) => l.price !== null);

  const kpStatus = STATUS[draft?.status ?? 'draft'] ?? draft?.status ?? '';

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
                  {researching ? 'Ищу цены…' : 'Найти цены'}
                </button>
              </div>
            )}
            <KpLinesTiles lines={lines} needsManager={draft.needsManager} research={research} locked={draft.status !== 'draft' || busy || pending || dirty} onEdit={edit} onFind={(i, force) => void findPrices([i], force)} />
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
          onDraft={start}
          onSave={() => void act(() => api.saveDraftItems(draft.id, lines))}
          onBuild={() => void act(() => api.buildDoc(draft.id))}
          onSend={() => setPreview(true)}
        />
      </section>

      {/* 6. Примечание */}
      <section className="opt-kp-card opt-kp-note">
        <KpNote draft={draft} ready={ready} />
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
          {m?.status === 'not_found' && <SearchDiag m={m} />}
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
      <div>Искали от {m.searchedFrom}{d?.criteria.domain ? ` (и весь домен @${d.criteria.domain})` : ''}{d ? `, даты ${d.criteria.since} – ${d.criteria.before}` : ''}{d?.criteria.subject ? `, тема «${d.criteria.subject}»` : ''}. Черновик собран по карточке.</div>
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
function KpLinesTiles({ lines, needsManager, research, locked, onEdit, onFind }: { lines: KpDraftLine[]; needsManager: KpDraftInfo['needsManager']; research: ResearchState | null; locked: boolean; onEdit: (i: number, patch: Partial<KpDraftLine>) => void; onFind: (requestIndex: number, force: boolean) => void }) {
  // «Цена не задана» под размером не показываем: это состояние и так видно в поле «Цена» (DESIGN-FIX, п. 4).
  const reasons = (i: number) => needsManager.filter((n) => n.request_index === i && n.reason !== 'цена не задана').map((n) => n.reason);
  return (
    <div className="opt-kp-tiles">
      {lines.map((l, i) => {
        const why = reasons(l.request_index);
        const pos = research?.positions?.find((p) => p.requestIndex === l.request_index) ?? null;
        return (
          <div key={`${l.request_index}-${i}`} className="opt-kp-tile">
            <div className="opt-kp-tile-name">{l.name || '—'}</div>
            {l.size && <div className="opt-kp-sub">{sizeLabel(l.size)}</div>}
            {why.length > 0 && <div className="opt-kp-sub">{why.join('; ')}</div>}
            <PriceState line={l} pos={pos} locked={locked} onFind={(force) => onFind(l.request_index, force)} />
            <div className="opt-kp-fields">
              <label className="opt-kp-field">
                <span className="opt-kp-label">Количество</span>
                <input type="number" min={1} value={l.qty} onChange={(e) => onEdit(i, { qty: Math.max(1, Number(e.target.value) || 1) })} />
              </label>
              <label className="opt-kp-field opt-kp-field-price">
                <span className="opt-kp-label">Цена{l.priceSource === 'manager' ? ' · изменено менеджером' : l.priceSource === 'analog' ? ' · по аналогу' : l.priceSource === 'research' ? ' · по рынку' : ''}</span>
                <input type="number" min={0} value={l.price ?? ''} placeholder="Нет цены" onChange={(e) => onEdit(i, { price: e.target.value === '' ? null : Number(e.target.value) })} />
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
  if (busy) status = job?.state === 'queued' ? 'поиск цены в очереди…' : 'идёт поиск цены…';
  else if (job?.state === 'failed') status = `поиск не выполнен: ${job.error}`;
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
          <button type="button" className="opt-btn opt-btn-small" onClick={() => onFind(Boolean(r))} title={r ? 'Искать заново, не используя сохранённый результат' : 'Найти рыночную цену по этой позиции'}>
            {r ? 'Искать заново' : 'Найти цену'}
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
function KpActions({ draft, busy, dirty, ready, onDraft, onSave, onBuild, onSend }: { draft: KpDraftInfo; busy: boolean; dirty: boolean; ready: boolean; onDraft: () => void; onSave: () => void; onBuild: () => void; onSend: () => void }) {
  const canSend = (draft.status === 'built' || draft.status === 'sent') && !dirty;
  return (
    <div className="opt-actions">
      <button type="button" className="opt-btn" disabled={busy} onClick={onDraft} title="Прочитать карточку заново; правки в позициях будут потеряны">
        Собрать заново
      </button>
      <button type="button" className="opt-btn" disabled={busy || !dirty} onClick={onSave}>
        Сохранить правки
      </button>
      <button type="button" className="opt-btn opt-btn-green" disabled={busy || dirty || !ready} title={dirty ? 'Сначала сохраните правки' : !ready ? 'У каждой позиции должна быть цена' : 'Собрать DOCX и PDF по шаблону'} onClick={onBuild}>
        Собрать документ
      </button>
      <button type="button" className="opt-btn" disabled={busy || !canSend} title={canSend ? 'Открыть письмо перед отправкой' : 'Доступно после сборки документа'} onClick={onSend}>
        Отправить клиенту
      </button>
    </div>
  );
}

/** Примечание под действиями: что дальше по состоянию черновика. */
function KpNote({ draft, ready }: { draft: KpDraftInfo; ready: boolean }) {
  if (draft.status === 'sent') return <>Отправлено{draft.sentAt ? ` ${date(draft.sentAt)}` : ''}. Повторная отправка — через «Отправить клиенту» с подтверждением.</>;
  if (draft.status === 'built') return <>Документ собран{draft.hasPdf ? ' (DOCX и PDF)' : ' (PDF не получился, есть DOCX)'} — файлы в карточке сделки. Проверьте документ и отправьте клиенту.</>;
  if (!ready && draft.items.length > 0) return <>Документ можно отправить после сборки и проверки цены, состава комплекта и данных покупателя. Сборка документа включится, когда у каждой позиции будет цена.</>;
  return <>Документ можно отправить после сборки и проверки цены, состава комплекта и данных покупателя.</>;
}
