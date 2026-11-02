import { useCallback, useEffect, useState } from 'react';
import { errorMessage, Field, s } from '@core/widget-core';
import type { KbCandidateInfo, KbSourceInfo, KpApi } from '../api.ts';
import { downloadBase64 } from './KbPrices.tsx';

/**
 * Сайты и кандидаты в прайс (KP-AGENT-V2, п. 4а и 4.4). У сайта — комментарий до 2000 знаков (что на нём есть и чего нет:
 * «ДПК Аква», «Стальных нет») и отметка «фабрика»: агент ищет цены сначала на фабриках, затем на сайтах, подходящих по
 * комментарию, затем на любых; сайт с «… нет» для этого вида двери не используется. Список сайтов — выгрузка и загрузка xlsx.
 */
export const COMMENT_MAX = 2000;

/** Сайт верхнего уровня (не страница раздела) — у него есть комментарий и «фабрика». */
export const isSite = (src: KbSourceInfo) => src.kind === 'url' && !src.parentId;

/** Комментарий и «фабрика» у сайта в карточке источника: подписанные поля с сохранённым значением, правка — «Сохранить». */
export function SiteMeta({ api, src, onSaved }: { api: KpApi; src: KbSourceInfo; onSaved: (msg: string) => void }) {
  const [comment, setComment] = useState(src.comment ?? '');
  const [factory, setFactory] = useState(Boolean(src.isFactory));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Список перечитан (загрузка xlsx, сохранение) — поля показывают сохранённое значение.
  useEffect(() => {
    setComment(src.comment ?? '');
    setFactory(Boolean(src.isFactory));
  }, [src.comment, src.isFactory]);
  const changed = comment !== (src.comment ?? '') || factory !== Boolean(src.isFactory);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.kbSetSite(src.id, { comment: comment.trim() || null, isFactory: factory });
      onSaved(`Сайт «${src.title}»: комментарий${factory ? ' и отметка «фабрика»' : ''} сохранены`);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="opt-kb-site" style={{ marginTop: 6 }}>
      <label style={{ ...s.small, display: 'block', marginBottom: 2 }}>Комментарий</label>
      <textarea
        className="opt-kb-site-comment"
        style={{ ...s.input, width: '100%', minHeight: 48, boxSizing: 'border-box' }}
        maxLength={COMMENT_MAX}
        placeholder="Что на сайте есть и чего нет: «ДПК Аква, межкомнатные», «Стальных нет»"
        value={comment}
        disabled={busy}
        onChange={(e) => setComment(e.target.value)}
      />
      <div style={{ ...s.row, marginTop: 4 }}>
        <label style={{ ...s.small, display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" className="opt-kb-site-factory" checked={factory} disabled={busy} onChange={(e) => setFactory(e.target.checked)} />
          Фабрика
        </label>
        <span style={{ ...s.small, ...s.muted }}>{comment.length} / {COMMENT_MAX}</span>
        <button type="button" style={s.buttonGhost} disabled={busy || !changed} onClick={() => void save()}>
          Сохранить
        </button>
      </div>
      {err && <div style={s.error}>{err}</div>}
    </div>
  );
}

/** Выгрузка и загрузка списка сайтов xlsx: «Адрес», «Название», «Фабрика», «Комментарий». */
export function SitesSection({ api, busy, onDone }: { api: KpApi; busy: boolean; onDone: (msg: string) => void }) {
  const [working, setWorking] = useState(false);
  const run = async (fn: () => Promise<string>) => {
    setWorking(true);
    try {
      onDone(await fn());
    } catch (e) {
      onDone(errorMessage(e));
    } finally {
      setWorking(false);
    }
  };
  return (
    <Field label="Сайты для поиска цен" hint="Сначала — фабрики, затем сайты, подходящие по комментарию, затем любые магазины; сайт с «… нет» для этого вида двери не используется. Список — xlsx с колонками «Адрес», «Название», «Фабрика», «Комментарий»">
      <div style={s.row}>
        <button
          type="button"
          style={s.buttonGhost}
          disabled={busy || working}
          onClick={() =>
            void run(async () => {
              const f = await api.kbSitesExport();
              downloadBase64(f.contentBase64, f.filename);
              return `Выгружено сайтов: ${f.rows}`;
            })
          }
        >
          Выгрузить сайты (xlsx)
        </button>
        <label style={{ ...s.small, display: 'flex', alignItems: 'center', gap: 4 }}>
          Загрузить сайты (xlsx):
          <input
            type="file"
            className="opt-kb-sites-import"
            accept=".xlsx"
            disabled={busy || working}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              void run(async () => {
                const r = await api.kbSitesImport(await fileBase64(f));
                return `Сайты из «${f.name}»: добавлено ${r.added}, обновлено ${r.updated}`;
              });
            }}
          />
        </label>
      </div>
    </Field>
  );
}

const rub = (n: number) => `${n.toLocaleString('ru-RU')} ₽`;

/** «Кандидаты в прайс»: цены, подтверждённые менеджером в КП (интернет / ввод); в подбор не идут — для пополнения прайса. */
export function CandidatesSection({ api, version = 0 }: { api: KpApi; version?: number }) {
  const [items, setItems] = useState<KbCandidateInfo[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setItems((await api.kbCandidates()).items);
    } catch (e) {
      setMsg(errorMessage(e));
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load, version]);
  const exportXlsx = async () => {
    try {
      const f = await api.kbCandidatesExport();
      downloadBase64(f.contentBase64, f.filename);
      setMsg(`Выгружено кандидатов: ${f.rows}`);
    } catch (e) {
      setMsg(errorMessage(e));
    }
  };
  const remove = async (c: KbCandidateInfo) => {
    try {
      await api.kbRemoveCandidate(c.id);
      await load();
    } catch (e) {
      setMsg(errorMessage(e));
    }
  };
  return (
    <div className="opt-kb-candidates" style={{ marginTop: 16 }}>
      <div style={{ ...s.row, alignItems: 'center' }}>
        <div style={s.label}>Кандидаты в прайс{items ? ` (${items.length})` : ''}</div>
        <button type="button" style={s.buttonGhost} disabled={!items?.length} onClick={() => void exportXlsx()}>
          Выгрузить xlsx
        </button>
      </div>
      <div style={{ ...s.small, ...s.muted }}>Цены, которые менеджер выбрал в опроснике (из интернета) или ввёл сам. В подбор цен не идут — после проверки их можно внести в прайс.</div>
      {msg && <div style={{ ...s.muted, marginTop: 4 }}>{msg}</div>}
      {items?.length === 0 && <div style={{ ...s.muted, marginTop: 4 }}>Кандидатов пока нет</div>}
      {items?.map((c) => (
        <div key={c.id} className="opt-kb-candidate" style={{ ...s.card, marginTop: 6 }}>
          <div style={s.row}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{c.model}{c.size ? `, ${c.size}` : ''} — {rub(c.price)}</div>
              <div style={{ ...s.small, ...s.muted, wordBreak: 'break-all' }}>
                {c.source === 'web_confirmed' ? 'из интернета, выбрал менеджер' : 'введена менеджером'}
                {c.leadId ? ` · сделка ${c.leadId}` : ''} · {new Date(c.createdAt).toLocaleDateString('ru-RU')}
                {c.url ? ` · ${c.url}` : ''}
              </div>
            </div>
            <button type="button" style={s.buttonGhost} onClick={() => void remove(c)}>
              Удалить
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Файл → base64 для JSON-тела. */
async function fileBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}
