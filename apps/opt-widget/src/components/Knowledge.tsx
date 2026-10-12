import { useCallback, useState } from 'react';
import { errorMessage, s, useLoad } from '@core/widget-core';
import type { KpApi, KnowledgeKindInfo } from '../api.ts';

const dateTime = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * Вкладка «База знаний» (ТЗ раздел 9): пять справочников, у каждого — шаблон для заполнения, загрузка
 * с проверкой построчно и удаление. Содержимое готовит заказчик; пустой справочник ничего не меняет в КП.
 */
export function Knowledge({ api }: { api: KpApi }) {
  const load = useCallback(() => api.knowledge(), [api]);
  const [state, reload] = useLoad(load);
  if (state.status === 'loading') return <div style={{ ...s.block, ...s.muted }}>Загрузка…</div>;
  if (state.status === 'error') return <div style={{ ...s.block, ...s.error }}>{state.message}</div>;
  return (
    <div style={s.block}>
      <div style={{ ...s.muted, marginBottom: 12 }}>
        Справочники подмешиваются в черновик как исходные данные: менеджер видит подсказки у позиций. Цифры из них в КП автоматически не подставляются.
      </div>
      {state.data.items.map((it) => (
        <KindCard key={it.kind} api={api} info={it} onChange={reload} />
      ))}
    </div>
  );
}

function KindCard({ api, info, onChange }: { api: KpApi; info: KnowledgeKindInfo; onChange: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ line: number; message: string }[]>([]);
  const [busy, setBusy] = useState(false);

  const upload = async (file: File) => {
    setBusy(true);
    setMsg(null);
    setErrors([]);
    try {
      const r = await api.uploadKnowledge(info.kind, file.name, await readText(file));
      setMsg(`Загружено: ${file.name}, строк ${r.rows}`);
      onChange();
    } catch (e) {
      const body = (e as { responseJSON?: { error?: string; errors?: { line: number; message: string }[] } }).responseJSON;
      if (body?.error === 'invalid_file' && body.errors) {
        setErrors(body.errors);
        setMsg('Файл не принят: исправьте строки ниже и загрузите заново. Ничего не сохранено.');
      } else setMsg(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const download = async (fn: () => Promise<{ filename: string; content: string }>) => {
    try {
      const f = await fn();
      saveTextFile(f.filename, f.content);
    } catch (e) {
      setMsg(errorMessage(e));
    }
  };

  const remove = async () => {
    if (!window.confirm(`Удалить справочник «${info.title}»?`)) return;
    setBusy(true);
    try {
      await api.removeKnowledge(info.kind);
      setMsg('Удалено');
      onChange();
    } catch (e) {
      setMsg(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ ...s.card, marginBottom: 10 }}>
      <div style={{ fontWeight: 600 }}>{info.title}</div>
      <div style={{ ...s.muted, ...s.small }}>{info.purpose} · файл {info.template}</div>
      <div style={{ ...s.small, marginTop: 4 }}>
        {info.loaded ? `Загружен: ${info.loaded.filename}, строк ${info.loaded.rows}, ${dateTime(info.loaded.updatedAt)}` : 'Не загружен — КП собирается без этого справочника'}
      </div>
      <div style={{ ...s.row, marginTop: 8 }}>
        <button type="button" style={s.buttonGhost} disabled={busy} onClick={() => void download(() => api.knowledgeTemplate(info.kind))}>
          Скачать шаблон
        </button>
        {info.loaded && (
          <button type="button" style={s.buttonGhost} disabled={busy} onClick={() => void download(() => api.knowledgeFile(info.kind))}>
            Скачать загруженный
          </button>
        )}
        <label style={{ ...s.buttonGhost, display: 'inline-flex', alignItems: 'center', cursor: busy ? 'progress' : 'pointer' }}>
          {busy ? 'Проверяю…' : info.loaded ? 'Заменить файл' : 'Загрузить файл'}
          <input
            type="file"
            accept={info.format === 'csv' ? '.csv,.txt' : '.md,.txt'}
            disabled={busy}
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = '';
            }}
          />
        </label>
        {info.loaded && (
          <button type="button" style={s.buttonGhost} disabled={busy} onClick={() => void remove()}>
            Удалить
          </button>
        )}
      </div>
      {msg && <div style={{ ...s.muted, ...s.small, marginTop: 6 }}>{msg}</div>}
      {errors.length > 0 && (
        <ul style={{ ...s.small, ...s.error, margin: '4px 0 0 16px', padding: 0 }}>
          {errors.map((e, i) => (
            <li key={i}>{e.line ? `строка ${e.line}: ` : ''}{e.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Скачивание текста файлом через временную ссылку: ссылки на API без токена amo не работают. */
function saveTextFile(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Текст файла через FileReader: работает и в amo, и в jsdom тестов. */
function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(r.error ?? new Error('файл не прочитан'));
    r.readAsText(file, 'utf-8');
  });
}
