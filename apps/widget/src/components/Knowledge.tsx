import { useCallback, useState } from 'react';
import type { KnowledgeInput, WidgetApi } from '../api.ts';
import { dateTime } from './StatusBadge.tsx';
import { s } from './styles.ts';
import { errorMessage, useLoad } from './useLoad.ts';

const KIND_LABEL = { faq: 'FAQ', text: 'Текст', url: 'Статья', file: 'Файл' } as const;

export function Knowledge({ api }: { api: WidgetApi }) {
  const load = useCallback(() => api.knowledge(), [api]);
  const [state, reload] = useLoad(load);
  const [kind, setKind] = useState<KnowledgeInput['kind']>('faq');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const add = async () => {
    setMsg(null);
    const item: KnowledgeInput =
      kind === 'faq' ? { kind, question: a, answer: b } : kind === 'text' ? { kind, title: a, content: b } : { kind, url: a };
    try {
      await api.addKnowledge(item);
      setA('');
      setB('');
      reload();
    } catch (err) {
      const e = err as { status?: number; responseJSON?: { message?: string } } | null;
      setMsg(e?.status === 403 ? 'Только администратор.' : (e?.responseJSON?.message ?? errorMessage(err)));
    }
  };

  const remove = async (id: number) => {
    try {
      await api.removeKnowledge(id);
      reload();
    } catch (err) {
      setMsg(errorMessage(err));
    }
  };

  return (
    <div style={s.col}>
      <div style={s.card}>
        <div style={s.row}>
          {(['faq', 'text', 'url'] as const).map((k) => (
            <label key={k} style={s.row}>
              <input type="radio" checked={kind === k} onChange={() => setKind(k)} /> {KIND_LABEL[k]}
            </label>
          ))}
        </div>
        <div style={{ ...s.col, marginTop: 8 }}>
          <input
            style={s.input}
            placeholder={kind === 'faq' ? 'Вопрос' : kind === 'text' ? 'Заголовок' : 'Адрес статьи, например раздел «Полезные советы про двери»'}
            value={a}
            onChange={(e) => setA(e.target.value)}
          />
          {kind !== 'url' && (
            <textarea style={s.textarea} placeholder={kind === 'faq' ? 'Ответ' : 'Текст'} value={b} onChange={(e) => setB(e.target.value)} />
          )}
          <div style={s.row}>
            <button type="button" style={s.button} disabled={!a.trim() || (kind !== 'url' && !b.trim())} onClick={add}>
              Добавить
            </button>
            {msg && <span style={s.error}>{msg}</span>}
          </div>
        </div>
      </div>
      {state.status === 'loading' && <div style={s.muted}>Загрузка…</div>}
      {state.status === 'error' && <div style={s.error}>{state.message}</div>}
      {state.status === 'ready' && state.data.items.length === 0 && <div style={s.muted}>База знаний пуста</div>}
      {state.status === 'ready' &&
        state.data.items.map((it) => (
          <div key={it.id} style={{ ...s.block, ...s.row, justifyContent: 'space-between' }}>
            <div>
              <b>{KIND_LABEL[it.kind]}</b> {it.title}
              <div style={{ ...s.muted, ...s.small }}>
                {dateTime(it.createdAt)} · фрагментов: {it.chunks} · <span style={s.badgeOk}>проиндексировано</span>
                {it.source && (
                  <>
                    {' '}
                    ·{' '}
                    <a href={it.source} target="_blank" rel="noreferrer">
                      источник
                    </a>
                  </>
                )}
              </div>
            </div>
            <button type="button" style={s.buttonGhost} onClick={() => remove(it.id)}>
              Удалить
            </button>
          </div>
        ))}
    </div>
  );
}
