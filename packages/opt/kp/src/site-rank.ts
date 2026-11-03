import type { GostProfile, KbSource } from '@opt/kb';
import { hostMatches } from './market-research.ts';

/**
 * KP-AGENT-V2, п. 4а: выбор сайтов для поиска цены позиции по комментариям менеджера в «Базе знаний».
 * Порядок: фабрики (подходят по комментарию или без комментария) → сайты, подходящие по комментарию → сайты без комментария →
 * любые магазины (это уже веб-поиск без подсказки). Сайт, в комментарии которого этот вид дверей отмечен «нет» («Стальных нет»),
 * для такой позиции не используется.
 */
export interface SiteChoice {
  host: string;
  title: string;
  factory: boolean;
  comment: string | null;
  /** Почему выбран: «фабрика», «по комментарию: «…»», «без комментария». */
  why: string;
}

export interface SitePlan {
  prefer: SiteChoice[];
  excluded: SiteChoice[];
}

const hostOf = (url: string | null): string | null => {
  try {
    return url ? new URL(/^https?:/i.test(url) ? url : `https://${url}`).host.toLowerCase().replace(/^www\./, '') : null;
  } catch {
    return null;
  }
};
const norm = (s: string) => ` ${s.toLowerCase().replace(/ё/g, 'е').replace(/[«»"(),.;:!?]/g, ' ').replace(/\s+/g, ' ')} `;

/** Слова позиции, по которым сайт подходит или исключается: материал, вид, бренд, покрытие, назначение, ГОСТ. */
export function positionTerms(profile: GostProfile | null, text: string): string[] {
  const t = norm(text);
  const out = new Set<string>();
  const p = profile;
  if (p?.material === 'steel' || p?.kind === 'ДПС' || p?.kind === 'ДСН' || p?.kind === 'ДСВ' || /стальн|металл/.test(t)) ['стальн', 'металл', 'сталь'].forEach((w) => out.add(w));
  if (p?.kind === 'ДПС' || p?.fire || /противопожар/.test(t)) out.add('противопожар');
  if (p?.kind === 'ДСН' || /подъезд/.test(t)) ['подъезд', 'входн'].forEach((w) => out.add(w));
  if (p?.material === 'aluminium' || /алюмин/.test(t)) out.add('алюмин');
  if (p?.material === 'dpk' || /(?<![а-я])дпк(?![а-я])/.test(t)) ['дпк', 'влагост'].forEach((w) => out.add(w));
  if (p?.material === 'wood' || p?.material === 'mdf' || p?.gost === '475-2016' || /межкомнат|деревян|мдф/.test(t)) ['межкомнат', 'деревян', 'мдф'].forEach((w) => out.add(w));
  if (p?.brand) out.add(p.brand.toLowerCase());
  if (p?.cover) out.add(p.cover.toLowerCase());
  if (p?.gost) out.add(p.gost.replace(/-\d{4}$/, '').replace(/^р /i, '').toLowerCase());
  for (const w of ['коробк', 'наличник', 'добор', 'фурнитур', 'ручк', 'замк', 'замок', 'петл', 'порог']) if (t.includes(w)) out.add(w);
  return [...out];
}

/** Части комментария с отрицанием: «Стальных нет», «нет стальных», «не продаём алюминиевые». */
function negatedParts(comment: string): string[] {
  // Отрицание — в пределах своей фразы: слово-два перед «нет» («Стальных нет»), после «нет» («нет стальных»), после «не продаём».
  return comment
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[;.,\n]| но | кроме /)
    .flatMap((part) => {
      const t = ` ${part.replace(/\s+/g, ' ').trim()} `;
      const before = /((?:[^\s]+\s){0,1}[^\s]+)\sнет\s/.exec(t);
      const after = /\sнет\s([^\s]+(?:\s[^\s]+)?)/.exec(t);
      const notSold = /\sне\s(?:продаем|продают|делаем|делают|бывает)\s([^\s]+(?:\s[^\s]+)?)/.exec(t);
      return [before?.[1], after?.[1], notSold?.[1]].filter((x): x is string => Boolean(x));
    });
}

export function planSites(sites: Pick<KbSource, 'original' | 'title' | 'comment' | 'isFactory'>[], profile: GostProfile | null, text: string): SitePlan {
  const terms = positionTerms(profile, text);
  const has = (s: string, w: string) => s.includes(w);
  const factory: SiteChoice[] = [];
  const matched: (SiteChoice & { score: number })[] = [];
  const plain: SiteChoice[] = [];
  const excluded: SiteChoice[] = [];
  for (const s of sites) {
    const host = hostOf(s.original);
    if (!host) continue;
    const comment = s.comment?.trim() || null;
    const c = comment ? norm(comment) : '';
    const negated = comment ? negatedParts(comment) : [];
    if (negated.some((n) => terms.some((w) => has(n, w)))) {
      excluded.push({ host, title: s.title, factory: s.isFactory, comment, why: `по комментарию: «${comment}» — для этой позиции не используется` });
      continue;
    }
    const positive = negated.reduce((acc, n) => acc.replace(n.trim(), ' '), c);
    const score = terms.filter((w) => has(positive, w)).length;
    const short = comment ? (comment.length > 120 ? `${comment.slice(0, 117)}…` : comment) : '';
    if (s.isFactory && (score > 0 || !comment)) factory.push({ host, title: s.title, factory: true, comment, why: comment ? `фабрика; по комментарию: «${short}»` : 'фабрика' });
    else if (score > 0) matched.push({ host, title: s.title, factory: s.isFactory, comment, why: `по комментарию: «${short}»`, score });
    else if (!comment) plain.push({ host, title: s.title, factory: false, comment: null, why: 'сайт из базы знаний без комментария' });
  }
  matched.sort((a, b) => b.score - a.score);
  return { prefer: [...factory, ...matched.map(({ score: _s, ...x }) => x), ...plain], excluded };
}

/** По какому комментарию выбран сайт предложения (для показа у цены). */
export function siteWhy(url: string, plan: SitePlan | null): string | null {
  return plan?.prefer.find((s) => hostMatches(url, s.host))?.why ?? null;
}
