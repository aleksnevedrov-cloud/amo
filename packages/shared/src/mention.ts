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
