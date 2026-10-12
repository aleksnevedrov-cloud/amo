/**
 * Подбор аналога по правилу (решение заказчика 12.10.2026 — вместо справочника «Замены и аналоги фабрик»).
 *
 * Аналог — только предложение менеджеру в черновике с пометкой, по какому критерию подобран;
 * в строки КП он не подставляется, цену не задаёт. Три критерия, в порядке приоритета:
 *   1. соответствие ГОСТ или техническим требованиям из заявки;
 *   2. соответствие дизайну (общие признаки: коллекция, покрытие, цвет, остекление);
 *   3. близость цены (в пределах допуска к цене из заявки или заданной менеджером).
 * Откуда брать кандидатов — решает подключение каталога (см. docs/opt/kp-analogi-i-fraza-o-cenah.md):
 * у опта своего каталога нет, поэтому источник передаётся зависимостью и может отсутствовать.
 */

export interface AnalogCandidate {
  id: string;
  name: string;
  vendor: string | null;
  price: number | null;
  /** Признаки дизайна: коллекция, покрытие, цвет, остекление — из параметров каталога. */
  design: string[];
  /** Стандарты и техтребования, которым отвечает товар: ГОСТ, ТУ, класс. */
  standards: string[];
}

export interface AnalogRequest {
  name: string;
  raw: string;
  /** Цена, с которой сравниваем; null — критерий цены не применяется. */
  price: number | null;
  /** ГОСТ, ТУ и прочие требования из заявки (письмо и разобранные спецификации). */
  requirements: string[];
}

export type AnalogCriterion = 'standard' | 'design' | 'price';

export interface AnalogSuggestion {
  candidate: AnalogCandidate;
  criterion: AnalogCriterion;
  /** Чем именно совпало: номер ГОСТ, общие признаки, разница в цене. */
  detail: string;
  /** Готовая пометка для needs_manager. */
  reason: string;
}

export const CRITERION_TITLE: Record<AnalogCriterion, string> = {
  standard: 'по ГОСТ/техтребованиям',
  design: 'по дизайну',
  price: 'по цене',
};

/** Допуск по цене: ±15 % от цены заявки. */
export const PRICE_TOLERANCE = 0.15;

/** Слова, которые есть почти в каждой позиции и дизайн не описывают. */
const STOP_WORDS = new Set(['дверь', 'двери', 'дверей', 'дверное', 'полотно', 'полотна', 'блок', 'комплект', 'межкомнатная', 'межкомнатные', 'входная', 'входные', 'размер', 'штук']);

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

/** Признаки дизайна из текста: слова от 4 букв без чисел и общих слов. */
export function designTokens(text: string): string[] {
  const out = new Set<string>();
  for (const w of norm(text).split(/[^a-zа-я]+/)) {
    if (w.length >= 4 && !STOP_WORDS.has(w)) out.add(w);
  }
  return [...out];
}

/** Номер стандарта в сравнимом виде: «ГОСТ 475-2016», «ТУ 5361-001». */
const normStandard = (s: string) => norm(s).replace(/\s+/g, ' ').replace(/[–—]/g, '-').trim();

// \b перед кириллицей не работает (ASCII-граница слова): проверяем, что перед аббревиатурой нет буквы.
const STANDARD_RE = /(?<![a-zа-яё])(ГОСТ|ТУ|СТО|СНиП|СП)\s*Р?\s*\d+(?:[.\-–—]\d+)*/gi;

/** ГОСТ, ТУ и прочие стандарты, упомянутые в заявке. */
export function extractRequirements(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(STANDARD_RE)) out.add(m[0].toUpperCase().replace(/\s+/g, ' ').replace(/[–—]/g, '-').trim());
  return [...out];
}

interface Scored {
  candidate: AnalogCandidate;
  criterion: AnalogCriterion;
  score: number;
  detail: string;
}

const money = (v: number) => `${Math.round(v).toLocaleString('ru-RU')} ₽`;

function score(req: AnalogRequest, c: AnalogCandidate, reqTokens: string[]): Scored | null {
  // 1. Стандарт: требование заявки встречается среди стандартов товара или в его названии.
  const haystack = [...c.standards, c.name].map(normStandard);
  const std = req.requirements.map(normStandard).find((r) => r && haystack.some((h) => h.includes(r)));
  if (std) return { candidate: c, criterion: 'standard', score: 3, detail: std.toUpperCase() };
  // 2. Дизайн: общие признаки в описании товара и в позиции заявки.
  const cTokens = new Set(designTokens([...c.design, c.name].join(' ')));
  const shared = reqTokens.filter((t) => cTokens.has(t));
  if (shared.length) return { candidate: c, criterion: 'design', score: 2 + shared.length / 10, detail: `общие признаки «${shared.join(', ')}»` };
  // 3. Цена: в пределах допуска от цены заявки.
  if (req.price !== null && req.price > 0 && c.price !== null) {
    const ratio = Math.abs(c.price - req.price) / req.price;
    if (ratio <= PRICE_TOLERANCE) return { candidate: c, criterion: 'price', score: 1 + (PRICE_TOLERANCE - ratio), detail: `${money(c.price)} против ${money(req.price)} (±${Math.round(ratio * 100)} %)` };
  }
  return null;
}

/** Лучший аналог по трём критериям или null, если ни один кандидат не подходит. */
export function suggestAnalog(req: AnalogRequest, candidates: AnalogCandidate[]): AnalogSuggestion | null {
  const reqTokens = designTokens(`${req.name} ${req.raw}`);
  let best: Scored | null = null;
  for (const c of candidates) {
    const s = score(req, c, reqTokens);
    if (s && (!best || s.score > best.score)) best = s;
  }
  if (!best) return null;
  const c = best.candidate;
  const title = [c.vendor, c.name].filter(Boolean).join(' ');
  const price = c.price === null ? 'цена в каталоге не задана' : money(c.price);
  return {
    candidate: c,
    criterion: best.criterion,
    detail: best.detail,
    reason: `аналог ${CRITERION_TITLE[best.criterion]} (${best.detail}): ${title}, ${price} — предложение, в КП не подставлено`,
  };
}
