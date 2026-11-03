import { useState } from 'react';
import type { KpAnswerBody, KpQuestionInfo } from '../api.ts';

/**
 * Опросник менеджеру (KP-AGENT-V2, п. 5 и 6а): вопросы выводит сервер из черновика. Порядок — сначала открытые блокирующие
 * (красная полоса), затем открытые без блокировки (жёлтая), затем отвеченные. Ответ — вариант (радиокнопки), своя цена или
 * поля; «Спросить у клиента» показывает готовый текст уточнения — его менеджер отправляет сам, агент клиенту не пишет.
 */
const rub = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;

export const surveyOrder = (qs: KpQuestionInfo[]): KpQuestionInfo[] => {
  const rank = (q: KpQuestionInfo) => (q.answer ? 2 : q.blocking ? 0 : 1);
  return [...qs].sort((a, b) => rank(a) - rank(b));
};

/** Ответ строкой: вариант, цена, поля. */
function answerText(q: KpQuestionInfo): string {
  const a = q.answer;
  if (!a) return '';
  const opt = q.options.find((o) => o.id === a.option)?.label;
  const fields = Object.entries(a.fields ?? {}).filter(([, v]) => v).map(([k, v]) => `${q.fields?.find((f) => f.name === k)?.label ?? k}: ${v}`);
  return [opt ?? (a.option === 'custom' ? 'своя цена' : null), a.price ? rub(a.price) : null, ...fields].filter(Boolean).join(' · ');
}

export function Survey({ questions, locked, onAnswer }: { questions: KpQuestionInfo[]; locked: boolean; onAnswer: (body: KpAnswerBody) => void }) {
  if (!questions.length) return <div className="opt-kp-note">Вопросов нет</div>;
  return (
    <div className="opt-kp-survey">
      {surveyOrder(questions).map((q) => (
        <QuestionCard key={q.key} q={q} locked={locked} onAnswer={onAnswer} />
      ))}
    </div>
  );
}

function QuestionCard({ q, locked, onAnswer }: { q: KpQuestionInfo; locked: boolean; onAnswer: (body: KpAnswerBody) => void }) {
  const [edit, setEdit] = useState(!q.answer);
  const [option, setOption] = useState<string | null>(q.answer?.option ?? null);
  const [price, setPrice] = useState('');
  const [fields, setFields] = useState<Record<string, string>>(() => Object.fromEntries((q.fields ?? []).map((f) => [f.name, q.answer?.fields?.[f.name] ?? f.value ?? ''])));
  const [ask, setAsk] = useState(false);
  const state = q.answer ? 'done' : q.blocking ? 'block' : 'warn';
  const own = Number(price.replace(/\s/g, '').replace(',', '.'));
  const submit = () => {
    if (own > 0) return onAnswer({ key: q.key, price: own });
    const body: KpAnswerBody = { key: q.key, ...(option ? { option } : {}), ...(q.fields?.length ? { fields } : {}) };
    onAnswer(body);
  };
  // Доставка: «самовывоз» — без полей; «доставка» — адрес и сумма.
  const showFields = q.fields?.length && !(q.type === 'delivery' && option === 'pickup');
  const canSubmit = !locked && (own > 0 || Boolean(option) || (!q.options.length && Boolean(q.fields?.length)));
  return (
    <div className={`opt-kp-q opt-kp-q-${state}`} data-key={q.key}>
      <div className="opt-kp-q-head">
        <span className="opt-kp-q-title">{q.title}</span>
        {!q.answer && <span className={`opt-kp-q-flag${q.blocking ? ' opt-kp-q-flag-block' : ''}`}>{q.blocking ? 'блокирует КП' : 'не блокирует'}</span>}
      </div>
      <div className="opt-kp-q-text">{q.text}</div>
      {q.web && <WebSources web={q.web} />}
      {q.answer && !edit && (
        <div className="opt-kp-q-answer">
          Ответ: {answerText(q) || 'дан'}
          {!locked && (
            <button type="button" className="opt-link" onClick={() => setEdit(true)}>
              изменить
            </button>
          )}
        </div>
      )}
      {edit && (
        <div className="opt-kp-q-form">
          {q.options.length > 0 && (
            <div className="opt-kp-q-options" role="radiogroup">
              {q.options.map((o) => (
                <label key={o.id} className="opt-kp-q-option">
                  <input type="radio" name={`q-${q.key}`} value={o.id} checked={option === o.id} disabled={locked} onChange={() => setOption(o.id)} />
                  <span>{o.label}</span>
                </label>
              ))}
            </div>
          )}
          {showFields
            ? q.fields?.map((f) => (
                <label key={f.name} className="opt-kp-field">
                  <span className="opt-kp-label">{f.label}</span>
                  <input type="text" value={fields[f.name] ?? ''} disabled={locked} onChange={(e) => setFields((x) => ({ ...x, [f.name]: e.target.value }))} />
                </label>
              ))
            : null}
          {q.customPrice && (
            <label className="opt-kp-field opt-kp-q-own">
              <span className="opt-kp-label">Своя цена с НДС, ₽</span>
              <input type="number" min={0} value={price} disabled={locked} placeholder="Введите цену" onChange={(e) => setPrice(e.target.value)} />
            </label>
          )}
          <div className="opt-row">
            <button type="button" className="opt-btn opt-btn-small opt-btn-green" disabled={!canSubmit} onClick={submit}>
              Ответить
            </button>
            {q.answer && (
              <button type="button" className="opt-btn opt-btn-small" onClick={() => setEdit(false)}>
                Отмена
              </button>
            )}
          </div>
        </div>
      )}
      {q.askClient && (
        <div className="opt-kp-q-client">
          <button type="button" className="opt-link" onClick={() => setAsk((v) => !v)}>
            Спросить у клиента {ask ? '⌄' : '›'}
          </button>
          {ask && (
            <>
              <textarea className="opt-kp-q-client-text" readOnly value={q.askClient} />
              <div className="opt-kp-sub">Текст для письма клиенту — отправьте его сами; агент клиенту не пишет.</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Цены интернета: min / медиана / max, сколько источников и фабрик, источники со ссылкой и тем, почему выбран сайт. */
function WebSources({ web }: { web: NonNullable<KpQuestionInfo['web']> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="opt-kp-q-web">
      <div className="opt-kp-sub">
        {rub(web.min)} · медиана {rub(web.median)} · {rub(web.max)} — источников {web.count}
        {web.factorySources ? `, с фабрики ${web.factorySources}` : ''}
        {web.spreadPct > 30 ? ` · разброс ${web.spreadPct} %` : ''}
        {!web.enough ? ' · мало источников' : ''}
      </div>
      <button type="button" className="opt-link" onClick={() => setOpen((v) => !v)}>
        Источники {open ? '⌄' : '›'}
      </button>
      {open && (
        <ul className="opt-kp-q-sources">
          {web.sources.map((x) => (
            <li key={x.url}>
              <a href={x.url} target="_blank" rel="noreferrer">{x.seller || x.url}</a> — {rub(x.unitPrice ?? x.price)}
              {x.manufacturer ? ' · фабрика' : ''}
              {x.site ? ` · выбран: ${x.site}` : ''}
            </li>
          ))}
          {web.excludedSites.length > 0 && <li className="opt-muted">Не использовались (по комментарию «… нет»): {web.excludedSites.join(', ')}</li>}
        </ul>
      )}
    </div>
  );
}
