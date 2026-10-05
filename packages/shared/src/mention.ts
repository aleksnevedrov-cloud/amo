/**
 * Обращение к агенту в групповом чате (RFD-AI-AGENT-GRUPPOVYE-CHATY, пункт 8).
 * «@Амма», «Амма,», «амма» - регистр и собака не важны.
 */
function core(word: string): string {
  return word.replace(/^@+/, '').trim();
}

function build(word: string, flags: string): RegExp | null {
  const w = core(word);
  if (!w) return null;
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^\\p{L}\\p{N}])@?' + esc + '(?=[^\\p{L}\\p{N}]|$)', flags);
}

/** Есть ли в тексте обращение к агенту. */
export function hasMention(text: string | null | undefined, word: string): boolean {
  const re = build(word, 'iu');
  return re ? re.test(text ?? '') : false;
}

/** Вырезает обращение из текста: модели слово-вызов не нужно. */
export function stripMention(text: string | null | undefined, word: string): string {
  const re = build(word, 'giu');
  const src = text ?? '';
  if (!re) return src;
  return src
    .replace(re, '$1')
    .replace(/^[\s,:;\-–—]+/, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Групповое сообщение Salesbot приходит с подписью автора и строкой-разделителем:
 * "Дмитрий +79990000000\n>>>>>>>>>>\nтекст". В личном чате такой обвязки нет,
 * поэтому формат сам по себе — признак группы, даже если чат не опознан по базе Wazzup.
 */
const GROUP_PREFIX = /^[^\n]{1,80}\n[ \t]*>{5,}[ \t]*\n/;

export function looksLikeGroupMessage(text: string | null | undefined): boolean {
  return GROUP_PREFIX.test(text ?? '');
}

/** Текст без подписи автора: в нём ищем обращение к агенту. */
export function stripGroupPrefix(text: string | null | undefined): string {
  const s = text ?? '';
  const m = GROUP_PREFIX.exec(s);
  return m ? s.slice(m[0].length) : s;
}
