/** Режет текст на фрагменты по абзацам, не длиннее maxLen символов. */
export function chunkText(text: string, maxLen = 1200): string[] {
  const paras = text
    .split(/\n\s*\n|\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let cur = '';
  const push = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = '';
  };
  for (const p of paras) {
    if (p.length > maxLen) {
      push();
      // Длинный абзац — по предложениям.
      for (const s of p.split(/(?<=[.!?…])\s+/)) {
        if ((cur + ' ' + s).length > maxLen) push();
        cur = cur ? `${cur} ${s}` : s;
        while (cur.length > maxLen) {
          chunks.push(cur.slice(0, maxLen));
          cur = cur.slice(maxLen);
        }
      }
      push();
      continue;
    }
    if ((cur + '\n' + p).length > maxLen) push();
    cur = cur ? `${cur}\n${p}` : p;
  }
  push();
  return chunks;
}

/** Грубое извлечение основного текста статьи из HTML. */
export function htmlToText(html: string): { title: string | null; text: string } {
  const title = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? null;
  const main =
    /<article[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1] ??
    /<main[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ??
    /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ??
    html;
  const text = main
    .replace(/<(script|style|nav|header|footer|aside|form|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|div|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&mdash;/g, '—')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
  const clean = (s: string) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return { title: title ? clean(title) : null, text };
}
