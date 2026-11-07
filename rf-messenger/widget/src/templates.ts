/**
 * Шаблоны сообщений (как в Wazzup): переменные, поиск по списку, подстановка.
 * Чистые функции — проверяются тестами без DOM.
 */

export interface TemplateView {
  id: number;
  title: string;
  text: string;
  folder: string;
  attachments: { fileId: string; name: string; mime: string; size: number }[];
  shared: boolean;
  useCount: number;
}

/** Данные карточки для переменных: {имя_клиента}, {имя_менеджера}, {номер_сделки}, {бюджет}, {поле:Название}. */
export interface TemplateContext {
  client: string;
  manager: string;
  leadId: number | null;
  leadName?: string;
  budget: number | null;
  fields: Record<string, string>;
}

export const VARIABLES: { name: string; hint: string }[] = [
  { name: '{имя_клиента}', hint: 'Имя контакта' },
  { name: '{имя_менеджера}', hint: 'Ваше имя в amoCRM' },
  { name: '{номер_сделки}', hint: 'Номер сделки' },
  { name: '{бюджет}', hint: 'Бюджет сделки' },
  { name: '{поле:Название поля}', hint: 'Любое поле сделки' },
];

/** 25000 → «25 000 ₽» (обычный пробел — так текст одинаково выглядит в любом мессенджере). */
const money = (n: number) => `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ₽`;

/** Подстановка переменных. Пустые остаются в тексте как есть и возвращаются в missing — их подсвечиваем перед отправкой. */
export function renderTemplate(text: string, ctx: TemplateContext | null): { text: string; missing: string[] } {
  const missing: string[] = [];
  const out = text.replace(/\{(имя_клиента|имя_менеджера|номер_сделки|бюджет|поле:[^{}]+)\}/g, (whole, key: string) => {
    let value = '';
    if (ctx) {
      if (key === 'имя_клиента') value = ctx.client;
      else if (key === 'имя_менеджера') value = ctx.manager;
      else if (key === 'номер_сделки') value = ctx.leadId ? String(ctx.leadId) : '';
      else if (key === 'бюджет') value = ctx.budget ? money(ctx.budget) : '';
      else if (key.startsWith('поле:')) {
        const name = key.slice(5).trim().toLowerCase();
        const found = Object.entries(ctx.fields).find(([k]) => k.trim().toLowerCase() === name);
        value = found?.[1] ?? '';
      }
    }
    if (!value.trim()) {
      missing.push(whole);
      return whole;
    }
    return value;
  });
  return { text: out, missing: [...new Set(missing)] };
}

/** Переменные, оставшиеся в тексте незаполненными (для подсветки перед отправкой). */
export function unresolvedVariables(text: string): string[] {
  return [...new Set(text.match(/\{(?:имя_клиента|имя_менеджера|номер_сделки|бюджет|поле:[^{}]+)\}/g) ?? [])];
}

/** Поиск по шаблонам: по названию, папке и тексту; порядок — как пришёл с сервера (частые сверху). */
export function filterTemplates(list: readonly TemplateView[], query: string): TemplateView[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  const words = q.split(/\s+/);
  return list.filter((t) => {
    const hay = `${t.title} ${t.folder} ${t.text}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Группировка по папкам: папка «» — в конец под именем «Без папки». */
export function groupByFolder(list: readonly TemplateView[]): { folder: string; items: TemplateView[] }[] {
  const map = new Map<string, TemplateView[]>();
  for (const t of list) {
    const key = t.folder || '';
    const items = map.get(key) ?? [];
    items.push(t);
    map.set(key, items);
  }
  const groups = [...map.entries()].map(([folder, items]) => ({ folder: folder || 'Без папки', items }));
  return groups.sort((a, b) => (a.folder === 'Без папки' ? 1 : b.folder === 'Без папки' ? -1 : 0));
}

/** Введённое начинается с «/» — режим выбора шаблона; возвращает строку поиска. */
export function slashQuery(value: string): string | null {
  const m = /^\/([^\n]*)$/.exec(value);
  return m ? (m[1] ?? '') : null;
}
