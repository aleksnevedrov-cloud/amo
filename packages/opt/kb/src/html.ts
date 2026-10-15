import type { ChildNode, Element } from 'domhandler';
import { parseDocument } from 'htmlparser2';

/**
 * Основной текст страницы сайта без меню, шапки и подвала (ТЗ раздел 3, «Ссылка»): берётся <main> / <article> /
 * блок содержимого, вырезаются nav/header/footer/aside/формы/скрипты и блоки с классами меню, корзины, cookie.
 * Заголовки → строки «# …» (их подхватывает разбиение на фрагменты), таблицы → строки с табуляцией.
 */
const DROP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'nav', 'header', 'footer', 'aside', 'form', 'button', 'select', 'input', 'textarea', 'object', 'embed', 'video', 'audio', 'canvas']);
const DROP_CLASS = /(^|[\s_-])(menu|nav|navbar|navigation|footer|header|cookie|cookies|breadcrumbs?|sidebar|popup|modal|banner|social|share|subscribe|basket|cart|callback|search|login|auth|promo-?slider|slider|carousel|copyright|widget-?chat)([\s_-]|$)/i;
const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'main', 'li', 'tr', 'table', 'thead', 'tbody', 'ul', 'ol', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figure', 'figcaption', 'address', 'hr', 'details', 'summary']);
const SKIP_ROOT_CLASS = /(^|[\s_-])(content|main|article|page|text|catalog|price)([\s_-]|$)/i;

const isElement = (n: ChildNode): n is Element => n.type === 'tag';
const attr = (el: Element, name: string) => el.attribs?.[name] ?? '';

function textOf(nodes: ChildNode[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') out += n.data;
    else if (isElement(n) && !DROP_TAGS.has(n.name)) out += textOf(n.children);
  }
  return out.replace(/\s+/g, ' ').trim();
}

function find(nodes: ChildNode[], pred: (el: Element) => boolean): Element | null {
  for (const n of nodes) {
    if (!isElement(n)) continue;
    if (pred(n)) return n;
    const inner = find(n.children, pred);
    if (inner) return inner;
  }
  return null;
}

function dropped(el: Element): boolean {
  if (DROP_TAGS.has(el.name)) return true;
  const role = attr(el, 'role');
  if (role === 'navigation' || role === 'banner' || role === 'contentinfo' || role === 'search' || role === 'dialog') return true;
  if (attr(el, 'hidden') !== '' && el.attribs && 'hidden' in el.attribs) return true;
  const cls = `${attr(el, 'class')} ${attr(el, 'id')}`;
  // Классы меню/подвала режем только у обёрток, не у блока содержимого («content-header» остаётся).
  return DROP_CLASS.test(cls) && !SKIP_ROOT_CLASS.test(cls);
}

function render(nodes: ChildNode[], out: string[], inCell = false): void {
  for (const n of nodes) {
    if (n.type === 'text') {
      const t = n.data.replace(/\s+/g, ' ');
      if (t.trim()) out.push(t);
      continue;
    }
    if (!isElement(n) || dropped(n)) continue;
    const tag = n.name;
    if (tag === 'br') {
      out.push('\n');
      continue;
    }
    if (tag === 'img') {
      const alt = attr(n, 'alt').trim();
      if (alt) out.push(` ${alt} `);
      continue;
    }
    if (/^h[1-6]$/.test(tag)) {
      const text = textOf(n.children);
      if (text) out.push(`\n\n${'#'.repeat(Number(tag[1]))} ${text}\n\n`);
      continue;
    }
    if (tag === 'td' || tag === 'th') {
      out.push(textOf(n.children));
      out.push('\t');
      continue;
    }
    if (tag === 'li') {
      out.push('\n- ');
      render(n.children, out, inCell);
      out.push('\n');
      continue;
    }
    if (tag === 'tr') {
      out.push('\n');
      render(n.children, out, true);
      out.push('\n');
      continue;
    }
    const block = BLOCK_TAGS.has(tag);
    if (block) out.push('\n');
    render(n.children, out, inCell);
    if (block) out.push('\n');
  }
}

export interface HtmlText {
  title: string | null;
  text: string;
}

export function htmlToKbText(html: string): HtmlText {
  const doc = parseDocument(html, { decodeEntities: true });
  const nodes = doc.children;
  const h1 = find(nodes, (el) => el.name === 'h1');
  const titleEl = find(nodes, (el) => el.name === 'title');
  const title = (h1 && textOf(h1.children)) || (titleEl && textOf(titleEl.children)) || null;
  const root =
    find(nodes, (el) => el.name === 'main' || attr(el, 'role') === 'main') ??
    find(nodes, (el) => el.name === 'article') ??
    find(nodes, (el) => /^(content|main|main-content|page-content)$/i.test(attr(el, 'id'))) ??
    find(nodes, (el) => el.name === 'body');
  const out: string[] = [];
  render(root ? root.children : nodes, out);
  const text = out
    .join('')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, '').replace(/^[ ]+/, '').replace(/\t{2,}/g, '\t').replace(/ {2,}/g, ' '))
    .filter((l, i, a) => l.trim() || (i > 0 && (a[i - 1] ?? '').trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title: title ? title.slice(0, 300) : null, text };
}

/** Пагинация раздела: ?p=N, ?page=N, ?PAGEN_1=N — такие ссылки считаются страницами раздела. */
const PAGINATION = /^(p|page|pagen_\d+)$/i;
const FILE_LIKE = /\.(jpe?g|png|gif|webp|svg|ico|css|js|woff2?|ttf|mp4|zip|rar)$/i;

/**
 * Ссылки раздела для обхода (ТЗ: до 50 страниц): тот же сайт, путь внутри раздела страницы, без якорей;
 * из параметров остаётся только пагинация; картинки и скрипты отбрасываются; pdf/xlsx/docx остаются — они индексируются как файлы.
 */
export function sectionLinks(html: string, pageUrl: string, max = 50): string[] {
  const base = new URL(pageUrl);
  const dir = base.pathname.endsWith('/') ? base.pathname : base.pathname.replace(/[^/]*$/, '');
  const self = base.origin + base.pathname.replace(/\/$/, '');
  const out = new Set<string>();
  const doc = parseDocument(html);
  const walk = (nodes: ChildNode[]) => {
    for (const n of nodes) {
      if (!isElement(n)) continue;
      if (n.name === 'a' && n.attribs?.href) {
        let u: URL;
        try {
          u = new URL(n.attribs.href, base);
        } catch {
          continue;
        }
        if (u.origin !== base.origin || !u.pathname.startsWith(dir) || FILE_LIKE.test(u.pathname)) continue;
        u.hash = '';
        for (const k of [...u.searchParams.keys()]) if (!PAGINATION.test(k)) u.searchParams.delete(k);
        const key = u.origin + u.pathname.replace(/\/$/, '') + (u.search ? u.search : '');
        if (key === self) continue;
        out.add(u.toString());
        if (out.size >= max) return;
      }
      walk(n.children);
      if (out.size >= max) return;
    }
  };
  walk(doc.children);
  return [...out];
}
