/**
 * Пост-фильтр ответа (раздел 4 ТЗ): цены (₽), сроки (дни, недели) и утверждения о наличии
 * должны опираться на данные инструментов этого хода. Числа из сообщений клиента тоже
 * допустимы — это его данные (бюджет, размеры), а не выдуманные агентом.
 */

export interface FactCheckInput {
  reply: string;
  /** JSON-результаты инструментов этого хода. */
  toolResults: string[];
  /** Тексты сообщений клиента (история и новые). */
  clientTexts: string[];
  /** В этом ходе был вызван инструмент каталога. */
  catalogConsulted: boolean;
  forbiddenTopics?: string[];
}

export interface FactViolation {
  kind: 'price' | 'term' | 'availability' | 'forbidden_topic';
  fragment: string;
  value?: number;
}

const NUM = String.raw`\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;
const RANGE = String.raw`(${NUM})(?:\s*(?:-|–|—|до)\s*(${NUM}))?`;

const PRICE_RE = new RegExp(String.raw`${RANGE}\s*(тыс\.?|тысяч[иа]?)?\s*(?:₽|руб(?:\.|л[а-я]*)?|р\.)`, 'giu');
const TERM_RE = new RegExp(
  String.raw`${RANGE}\s*(?:рабоч[а-я]*\s+|календарн[а-я]*\s+)?(день|дн(?:\.|я|ей)?|сут(?:ок|ки)?|недел[а-я]*|месяц[а-я]*|час(?:а|ов)?)(?![а-я])`,
  'giu',
);

/** Срок в нормализованных единицах: дни (недели ×7), месяцы и часы отдельно. */
function termKey(value: number, unit: string): string {
  const u = unit.toLowerCase();
  if (u.startsWith('недел')) return `d:${value * 7}`;
  if (u.startsWith('месяц')) return `m:${value}`;
  if (u.startsWith('час')) return `h:${value}`;
  return `d:${value}`;
}

export function termsIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(TERM_RE)) {
    for (const raw of [m[1], m[2]]) if (raw) out.add(termKey(parseNumber(raw), m[3] ?? ''));
  }
  return out;
}
const AVAILABILITY_RE = /(?:есть\s+)?в\s+наличии|нет\s+в\s+наличии|под\s+заказ|на\s+складе/giu;

export function parseNumber(raw: string): number {
  return Number(raw.replace(/[ \u00a0\u202f]/g, '').replace(',', '.'));
}

/** Все числа, встречающиеся в тексте (в т.ч. «1 500», «2-3», «14–21»). */
export function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(new RegExp(NUM, 'gu'))) out.add(parseNumber(m[0]));
  // Числа, склеенные без пробела в JSON («1500»), и с пробелами — оба варианта.
  for (const m of text.matchAll(/\d+(?:[.,]\d+)?/g)) out.add(parseNumber(m[0]));
  return out;
}

export function checkFacts(i: FactCheckInput): FactViolation[] {
  const allowed = new Set<number>();
  for (const t of [...i.toolResults, ...i.clientTexts]) for (const n of numbersIn(t)) allowed.add(n);
  const violations: FactViolation[] = [];

  for (const m of i.reply.matchAll(PRICE_RE)) {
    const mult = m[3] ? 1000 : 1;
    // «Турин 1 — 14 900 ₽»: номер модели перед тире — не нижняя граница диапазона цен.
    const isLabel = m[2] !== undefined && parseNumber(m[1] ?? '') < 100 && parseNumber(m[2]) * mult >= 1000;
    for (const raw of isLabel ? [m[2]] : [m[1], m[2]]) {
      if (!raw) continue;
      const v = parseNumber(raw) * mult;
      if (!allowed.has(v)) violations.push({ kind: 'price', fragment: m[0].trim(), value: v });
    }
  }
  const allowedTerms = new Set<string>();
  for (const t of [...i.toolResults, ...i.clientTexts]) for (const k of termsIn(t)) allowedTerms.add(k);
  for (const m of i.reply.matchAll(TERM_RE)) {
    for (const raw of [m[1], m[2]]) {
      if (!raw) continue;
      const v = parseNumber(raw);
      if (!allowedTerms.has(termKey(v, m[3] ?? ''))) violations.push({ kind: 'term', fragment: m[0].trim(), value: v });
    }
  }
  if (!i.catalogConsulted) {
    const m = i.reply.match(AVAILABILITY_RE);
    if (m) violations.push({ kind: 'availability', fragment: m[0] });
  }
  const lower = i.reply.toLowerCase();
  for (const topic of i.forbiddenTopics ?? []) {
    const t = topic.trim().toLowerCase();
    if (t && lower.includes(t)) violations.push({ kind: 'forbidden_topic', fragment: topic });
  }
  return violations;
}

export function describeViolations(v: FactViolation[]): string {
  return v
    .map((x) => {
      switch (x.kind) {
        case 'price':
          return `цена «${x.fragment}» не найдена в данных инструментов`;
        case 'term':
          return `срок «${x.fragment}» не найден в данных инструментов`;
        case 'availability':
          return `утверждение о наличии («${x.fragment}») без проверки по каталогу`;
        case 'forbidden_topic':
          return `затронута запрещённая тема «${x.fragment}»`;
      }
    })
    .join('; ');
}
