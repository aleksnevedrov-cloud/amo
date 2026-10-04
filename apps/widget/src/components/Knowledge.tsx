import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { WidgetApi } from '../api.ts';
import { dateTime } from './StatusBadge.tsx';
import { s } from './styles.ts';
import { errorMessage, useLoad } from './useLoad.ts';

const KIND_LABEL = { faq: 'Вопрос-ответ', text: 'Текст', url: 'Статья', file: 'Файл' } as const;
const FILE_ACCEPT = '.pdf,.docx,.xlsx,.xlsm,.txt,.csv,.md';

function errText(err: unknown): string {
  const e = err as { status?: number; responseJSON?: { message?: string } } | null;
  return e?.status === 403 ? 'Только администратор.' : (e?.responseJSON?.message ?? errorMessage(err));
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Один способ добавления: свой заголовок, поля, кнопка и сообщение — без общего переключателя. */
function Block(props: {
  title: string;
  hint: string;
  children: ReactNode;
  canAdd: boolean;
  busy: boolean;
  msg: string | null;
  ok: string | null;
  onAdd: () => void;
  button?: string;
}) {
  return (
    <div style={s.card}>
      <div style={{ fontWeight: 600 }}>{props.title}</div>
      <div style={{ ...s.muted, ...s.small }}>{props.hint}</div>
      {props.children}
      <div style={s.row}>
        <button type="button" style={s.button} disabled={!props.canAdd || props.busy} onClick={props.onAdd}>
          {props.busy ? 'Добавляем…' : (props.button ?? 'Добавить')}
        </button>
        {props.msg && <span style={s.error}>{props.msg}</span>}
        {props.ok && <span style={s.badgeOk}>{props.ok}</span>}
      </div>
    </div>
  );
}

export function Knowledge({ api }: { api: WidgetApi }) {
  const load = useCallback(() => api.knowledge(), [api]);
  const [state, reload] = useLoad(load);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string | null>>({});
  const [ok, setOk] = useState<Record<string, string | null>>({});
  const [q, setQ] = useState('');
  const [ans, setAns] = useState('');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /** Общая обёртка: сообщение об ошибке или успехе привязано к своему блоку. */
  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setMsg((m) => ({ ...m, [key]: null }));
    setOk((m) => ({ ...m, [key]: null }));
    try {
      const done = await fn();
      setOk((m) => ({ ...m, [key]: done }));
      reload();
    } catch (err) {
      setMsg((m) => ({ ...m, [key]: errText(err) }));
    } finally {
      setBusy(null);
    }
  };

  const addFaq = () =>
    run('faq', async () => {
      await api.addKnowledge({ kind: 'faq', question: q.trim(), answer: ans.trim() });
      setQ(''); setAns('');
      return 'Добавлено';
    });
  const addText = () =>
    run('text', async () => {
      await api.addKnowledge({ kind: 'text', title: title.trim(), content: text.trim() });
      setTitle(''); setText('');
      return 'Добавлено';
    });
  const addUrl = () =>
    run('url', async () => {
      await api.addKnowledge({ kind: 'url', url: url.trim() });
      setUrl('');
      return 'Страница прочитана и проиндексирована';
    });
  const addFile = () =>
    run('file', async () => {
      if (!file) throw new Error('Файл не выбран');
      const r = await api.addKnowledgeFile(file.name, file.type || 'application/octet-stream', await toBase64(file));
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      return `Извлечено ${r.chars.toLocaleString('ru-RU')} знаков${r.pages > 1 ? `, страниц: ${r.pages}` : ''}`;
    });
  const refresh = (id: number) => run(`item-${id}`, async () => { await api.refreshKnowledge(id); return 'Обновлено'; });
  const remove = (id: number) => run(`item-${id}`, async () => { await api.removeKnowledge(id); return ''; });

  return (
    <div style={s.col}>
      <Block title="1. Вопрос-ответ" hint="Готовый ответ на частый вопрос клиента."
        canAdd={!!q.trim() && !!ans.trim()} busy={busy === 'faq'} msg={msg.faq ?? null} ok={ok.faq ?? null} onAdd={addFaq}>
        <input style={s.input} placeholder="Вопрос" value={q} onChange={(e) => setQ(e.target.value)} />
        <textarea style={s.textarea} placeholder="Ответ" value={ans} onChange={(e) => setAns(e.target.value)} />
      </Block>

      <Block title="2. Текст" hint="Любой текст: условия, регламент, описание услуги. Ссылки внутри текста агент не открывает — для страниц сайта есть блок 3."
        canAdd={!!title.trim() && !!text.trim()} busy={busy === 'text'} msg={msg.text ?? null} ok={ok.text ?? null} onAdd={addText}>
        <input style={s.input} placeholder="Заголовок" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea style={s.textarea} placeholder="Текст" value={text} onChange={(e) => setText(e.target.value)} />
      </Block>

      <Block title="3. Статья по ссылке" hint="Адрес страницы сайта. Сервер сам прочитает её и сохранит текст; когда страница изменится — кнопка «Обновить» в списке ниже."
        canAdd={/^https?:\/\/\S+$/i.test(url.trim())} busy={busy === 'url'} msg={msg.url ?? null} ok={ok.url ?? null} onAdd={addUrl} button="Прочитать и добавить">
        <input style={s.input} placeholder="https://www.rf-dveri.ru/…" value={url} onChange={(e) => setUrl(e.target.value)} />
      </Block>

      <Block title="4. Файл" hint="PDF, DOCX, XLSX, TXT до 20 МБ. Сканы без текстового слоя не подойдут."
        canAdd={!!file} busy={busy === 'file'} msg={msg.file ?? null} ok={ok.file ?? null} onAdd={addFile} button="Загрузить">
        <input ref={fileRef} type="file" accept={FILE_ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        {file && <div style={{ ...s.muted, ...s.small }}>{file.name} · {(file.size / 1024).toFixed(0)} КБ</div>}
      </Block>

      <div style={{ fontWeight: 600, marginTop: 8 }}>Что уже в базе</div>
      {state.status === 'loading' && <div style={s.muted}>Загрузка…</div>}
      {state.status === 'error' && <div style={s.error}>{state.message}</div>}
      {state.status === 'ready' && state.data.items.length === 0 && <div style={s.muted}>База знаний пуста</div>}
      {state.status === 'ready' &&
        state.data.items.map((it) => {
          const key = `item-${it.id}`;
          return (
            <div key={it.id} style={{ ...s.block, ...s.row, justifyContent: 'space-between' }}>
              <div>
                <b>{KIND_LABEL[it.kind]}</b> {it.title}
                <div style={{ ...s.muted, ...s.small }}>
                  {dateTime(it.createdAt)} · фрагментов: {it.chunks} · <span style={s.badgeOk}>проиндексировано</span>
                  {it.kind === 'url' && it.source && (
                    <>
                      {' '}·{' '}
                      <a href={it.source} target="_blank" rel="noreferrer">источник</a>
                    </>
                  )}
                  {msg[key] && <span style={s.error}> {msg[key]}</span>}
                  {ok[key] && <span style={s.badgeOk}> {ok[key]}</span>}
                </div>
              </div>
              <div style={s.row}>
                {it.kind === 'url' && (
                  <button type="button" style={s.buttonGhost} disabled={busy === key} onClick={() => refresh(it.id)}>
                    {busy === key ? 'Читаем…' : 'Обновить'}
                  </button>
                )}
                <button type="button" style={s.buttonGhost} disabled={busy === key} onClick={() => remove(it.id)}>
                  Удалить
                </button>
              </div>
            </div>
          );
        })}
    </div>
  );
}
