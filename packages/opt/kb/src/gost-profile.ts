import type { KbPrice } from './prices.ts';

/**
 * KP-AGENT-V2, п. 3: ГОСТ-профиль двери — ключ подбора. Позиция заявки и строка прайса разбираются в одни и те же поля;
 * строка прайса подходит, только если не расходятся обязательные поля (ГОСТ, вид, створки, Г/О, огнестойкость).
 * Чего в позиции нет — не угадывается: поле остаётся пустым и уходит вопросом в опросник (questions.ts в @opt/kp).
 *
 * Обозначения: ГОСТ 475-2016 «ДВ 1Рп 21-10 Г ПрБ М3» (ДН — наружная, ДВ — внутренняя входная, ДМ — межкомнатная,
 * ДС — специальная; 1/2 — створки, Рп/Рл — распашная правая/левая, Г/О, Прг/ПрБ — с порогом / без, М1…М3 / Мд1…Мд3 — прочность);
 * ГОСТ 31173-2016 «ДСН А Дп Пр Прг Н П2лс М1 О 2300×1430» (ДСН / ДСВ — стальная наружная / внутренняя, Дп — двупольная,
 * Пр / Л — правая / левая); ГОСТ Р 57327-2016 «ДПС 01 2060-780 EI60» (01 / 02 — одно- / двупольная); ГОСТ 23747-2015 — ДА;
 * старый ГОСТ 6629-88 «ДГ 21-9» / «ДО 21-9» (размер в дециметрах).
 */

export type GostCode = '475-2016' | '31173-2016' | 'Р 57327-2016' | '23747-2015' | '6629-88';
export type GostKind = 'Д' | 'ДН' | 'ДВ' | 'ДМ' | 'ДС' | 'ДСН' | 'ДСВ' | 'ДПС' | 'ДА';
export type SizeBasis = 'leaf' | 'frame' | 'opening';

export interface GostProfile {
  gost: GostCode | null;
  /** Вид изделия; у строки прайса может быть несколько («ДСН или ДСВ»). */
  kind: GostKind | null;
  kinds?: GostKind[];
  leaves: 1 | 2 | null;
  /** Двупольная неравнопольная («800+400», «90+30»): решение человека — вопрос в опросник. */
  unequal: boolean;
  /** Открывание: Рп / Рл (ГОСТ 475), Пр / Л (ГОСТ 31173) → сторона. */
  opening: 'left' | 'right' | null;
  fill: 'Г' | 'О' | null;
  threshold: 'Прг' | 'ПрБ' | null;
  strength: string | null;
  fire: string | null;
  heightMm: number | null;
  widthMm: number | null;
  basis: SizeBasis | null;
  material: 'wood' | 'mdf' | 'dpk' | 'steel' | 'aluminium' | 'plastic' | null;
  cover: string | null;
  /** Бренд клиента вне прайса (Аква, Ставерн, Pleskovdoor…) — вопрос «аналог по ГОСТ допустим?». */
  brand: string | null;
}

export const EMPTY_PROFILE: GostProfile = { gost: null, kind: null, leaves: null, unequal: false, opening: null, fill: null, threshold: null, strength: null, fire: null, heightMm: null, widthMm: null, basis: null, material: null, cover: null, brand: null };

/** Обязательные для совпадения со строкой прайса поля (п. 3.2). */
export const PROFILE_MANDATORY = ['gost', 'kind', 'leaves', 'fill', 'fire'] as const;
export type ProfileField = keyof GostProfile;

export const PROFILE_LABEL: Record<string, string> = {
  gost: 'ГОСТ', kind: 'вид изделия', leaves: 'число створок', opening: 'открывание', fill: 'глухая / остеклённая', threshold: 'порог', strength: 'класс прочности', fire: 'огнестойкость', size: 'размер', basis: 'база размера (полотно / коробка / проём)', material: 'материал', cover: 'покрытие',
};

const GOST_OF_KIND: Partial<Record<GostKind, GostCode>> = { ДН: '475-2016', ДВ: '475-2016', ДМ: '475-2016', ДСН: '31173-2016', ДСВ: '31173-2016', ДПС: 'Р 57327-2016', ДА: '23747-2015', Д: '6629-88' };
export const BRANDS: { rx: RegExp; title: string }[] = [
  { rx: /аква|aquadoor|aqua\s?door/i, title: 'Аква' },
  { rx: /ставерн|staver/i, title: 'Ставерн' },
  { rx: /pleskov|плесков/i, title: 'Pleskovdoor' },
];

// В JS \b не знает кириллицы — границы слов явно.
const W = '(?<![а-яёa-z0-9])';
const E = '(?![а-яёa-z0-9])';

const norm = (s: string) => ` ${s.toLowerCase().replace(/ё/g, 'е').replace(/[«»"()]/g, ' ').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ')} `;

/** Номер ГОСТ из текста: явный номер главнее вида изделия. */
export function gostOf(text: string): GostCode | null {
  const t = norm(text);
  if (/57327/.test(t)) return 'Р 57327-2016';
  if (/31173/.test(t)) return '31173-2016';
  if (/23747/.test(t)) return '23747-2015';
  if (/(?<!\d)475(?:-(?:2016|78))?(?!\d)/.test(t) && /гост/.test(t)) return '475-2016';
  if (/6629/.test(t)) return '6629-88';
  return null;
}

/** Размер: «2100×1000», «2300*1430», «2060-780», «2100-10» (ширина в дм), «21*9» / «21-9» (дм) → высота × ширина, мм. */
export function profileSize(text: string): { heightMm: number; widthMm: number } | null {
  // Номера стандартов («ГОСТ 475-2016», «ГОСТ Р 57327-2016», «ТУ 5361-001») — не размер.
  const t = text.replace(/\u00a0/g, ' ').replace(/(гост|ту|сп|снип|ral)\s*(р\s*)?[\d.]+(?:-\d{2,4})*/gi, ' ');
  const m = /(?<!\d|\d[.,])(\d{2,4})\s*[×xх*\-–]\s*(\d{1,4})(?!\d|[.,]\d)/i.exec(t);
  if (!m) return null;
  let a = Number(m[1]);
  let b = Number(m[2]);
  if (a <= 30) a *= 100;
  if (b <= 30) b *= 100;
  if (a < 300 || b < 300 || a > 3500 || b > 3500) return null;
  // Высота — большая сторона (ГОСТ пишет Н×Ш, заявки — как придётся).
  return { heightMm: Math.max(a, b), widthMm: Math.min(a, b) };
}

/** ГОСТ-профиль позиции из её текста (наименование, обозначение, характеристики). */
export function profileOf(text: string | null | undefined): GostProfile {
  const p: GostProfile = { ...EMPTY_PROFILE };
  if (!text) return p;
  const raw = text.replace(/\u00a0/g, ' ');
  const t = norm(raw);
  p.gost = gostOf(raw);
  // Вид: ДПС / ДПМ (противопожарные стальные), ДСН / ДСВ, ДА, ДН / ДВ / ДМ / ДС по ГОСТ 475 — кодом в начале обозначения
  // («ДМ 1 Рл», «Дв Рп 1», «ДВ 1Рп»); «ДМ-1» с дефисом — название модели, не код.
  if (new RegExp(`${W}(дпс|дпм)${E}`).test(t) || /противопожарн\w* (сталь|металл)/.test(t)) p.kind = 'ДПС';
  else if (new RegExp(`${W}дсн${E}`).test(t)) p.kind = 'ДСН';
  else if (new RegExp(`${W}дсв${E}`).test(t)) p.kind = 'ДСВ';
  else if (new RegExp(`${W}да${E}[\\s-]*[12]`).test(t)) p.kind = 'ДА';
  else {
    const k = new RegExp(`${W}(дн|дв|дм|дс)\\s?(?=[12]\\s?р|р[пл]|[12]\\s|\\d{2}[-×x*]|г\\s|о\\s)`).exec(t);
    if (k) p.kind = (k[1] as string).toUpperCase() as GostKind;
    else if (new RegExp(`${W}д[го]\\s?\\d{2}\\s?[-×x*]\\s?\\d`).test(t)) p.kind = 'Д';
  }
  // Обозначение: от кода вида на 60 знаков — только в нём буквы Г / О / Пр / Л значат признаки («о поставке» — не «остеклённая»).
  const code = new RegExp(`${W}(дпс|дпм|дсн|дсв|да|дн|дв|дм|дс|дг|до)${E}`).exec(t);
  const seg = code ? t.slice(code.index, code.index + 60) : '';
  // Сталь с кодом межкомнатной двери по ГОСТ 475 («дверь стальная ДМ …») — код не подходит, вид из ГОСТ 31173 не угадываем.
  const steel = /стальн|\sсталь\s|металлическ|металл\s/.test(t);
  if (steel && (p.kind === 'ДМ' || p.kind === 'ДВ' || p.kind === 'ДН' || p.kind === 'Д')) p.kind = null;
  if (!p.gost && p.kind) p.gost = GOST_OF_KIND[p.kind] ?? null;

  // Створки: «Дп», «двупольная», «2 створки», «2Рп», ДПС 02; неравнопольная — «800+400», «90+30».
  const unequal = /(\d{2,4})\s*\+\s*(\d{2,4})/.exec(raw);
  if (unequal) {
    p.leaves = 2;
    p.unequal = Number(unequal[1]) !== Number(unequal[2]);
  } else if (new RegExp(`${W}дп${E}|двупольн|двухпольн|двустворч|двухстворч|${W}2\\s?(рп|рл|р)${E}|2 створ|${W}дпс\\s?0?2${E}|${W}да[\\s-]*2`).test(t)) p.leaves = 2;
  else if (new RegExp(`однопольн|одностворч|${W}1\\s?(рп|рл|р)${E}|${W}(дн|дв|дм|дс)\\s1${E}|${W}дпс\\s?0?1${E}|${W}да[\\s-]*1|1-польн|полотно(?![а-я])|${W}дп[го]${E}|${W}р[пл]\\s1${E}`).test(t)) p.leaves = 1;
  // Открывание.
  if (new RegExp(`${W}[12]?\\s?рл${E}|левая|левое|левого|левые`).test(t) || new RegExp(`${W}л${E}`).test(seg)) p.opening = 'left';
  else if (new RegExp(`${W}[12]?\\s?рп${E}|правая|правое|правого|правые`).test(t) || new RegExp(`${W}пр${E}|${W}п${E}`).test(seg)) p.opening = 'right';
  // Г / О: буквой в обозначении, словами, ДПГ / ДПО / ДГ / ДО.
  if (new RegExp(`глух|${W}дп?г${E}|${W}дг\\s?\\d|${W}пг${E}`).test(t) || new RegExp(`${W}г${E}`).test(seg)) p.fill = 'Г';
  else if (new RegExp(`остекл|со стекл|${W}дп?о${E}|${W}до\\s?\\d|${W}по${E}`).test(t) || new RegExp(`${W}о${E}`).test(seg)) p.fill = 'О';
  // Порог.
  if (new RegExp(`${W}прб${E}|без порог`).test(t)) p.threshold = 'ПрБ';
  else if (new RegExp(`${W}прг${E}|с порог`).test(t)) p.threshold = 'Прг';
  // Прочность: М1…М3, Мд1…Мд3.
  const st = new RegExp(`${W}(м[123]|мд[123])${E}`).exec(t);
  if (st) p.strength = (st[1] as string).replace(/^м/, 'М');
  // Огнестойкость: EI / EIW / Е-30.
  // EI30 / EIW60 / «EI 60»; «Е-30» (кириллица) — только с дефисом: «не менее 30» — не огнестойкость.
  const fire = /(?<![a-z])(eiw|ei)\s?-?\s?(15|30|45|60|90)(?!\d)|(?<![а-яёa-z])[еe]-\s?(15|30|45|60|90)(?!\d)/i.exec(raw);
  if (fire) p.fire = fire[1] ? `${fire[1].toUpperCase()}${fire[2]}` : `EI${fire[3]}`;
  else if (p.kind === 'ДПС' || /противопожарн|огнестойк/.test(t)) p.fire = 'EI?';
  // Размер и база.
  const size = profileSize(raw);
  if (size) Object.assign(p, size);
  if (/по прое|прое?м|по проему/.test(t)) p.basis = 'opening';
  else if (/по коробк|блок|коробк/.test(t)) p.basis = 'frame';
  else if (/полотн|по полотну/.test(t)) p.basis = 'leaf';
  // Материал и покрытие.
  if (new RegExp(`${W}дпк${E}`).test(t)) p.material = 'dpk';
  else if (/алюмин/.test(t) || p.kind === 'ДА') p.material = 'aluminium';
  else if (steel || p.kind === 'ДПС' || p.kind === 'ДСН' || p.kind === 'ДСВ') p.material = 'steel';
  else if (/пластик|пвх-профил/.test(t)) p.material = 'plastic';
  else if (new RegExp(`${W}мдф${E}`).test(t)) p.material = 'mdf';
  else if (/дерев|массив|шпон/.test(t)) p.material = 'wood';
  if (/cpl/.test(t)) p.cover = 'CPL';
  else if (new RegExp(`${W}пвх${E}`).test(t)) p.cover = 'ПВХ';
  else if (/экошпон/.test(t)) p.cover = 'экошпон';
  else if (/шпон/.test(t)) p.cover = 'шпон';
  else if (new RegExp(`${W}лкм${E}|эмал|окраск`).test(t)) p.cover = 'ЛКМ';
  else if (/порошк|полимерн/.test(t)) p.cover = 'порошок';
  p.brand = BRANDS.find((b) => b.rx.test(raw))?.title ?? null;
  return p;
}

/** Профиль строки прайса: шаблон обозначения по ГОСТ, ГОСТы карточки, Г/О, створки, база размера; остальное — из текста строки. */
export function profileOfRow(row: Pick<KbPrice, 'model' | 'abbr' | 'description' | 'card' | 'family' | 'widthMm' | 'heightMm'>): GostProfile {
  const card = row.card;
  const designation = card?.designation ?? '';
  const p = profileOf([designation, row.abbr ?? '', row.model, row.description ?? ''].filter(Boolean).join(' | '));
  const gosts = (card?.gosts ?? []).map(gostOf).filter((g): g is GostCode => Boolean(g));
  // Основной ГОСТ изделия: огнестойкость по 53307 — дополнительный; из списка карточки первым — изделийный.
  const main = gosts.find((g) => g !== '6629-88') ?? gosts[0] ?? null;
  if (main) p.gost = main;
  if (/дсн или дсв|дсв или дсн/i.test(designation)) {
    p.kind = 'ДСН';
    p.kinds = ['ДСН', 'ДСВ'];
  } else if (!p.kind && p.gost === 'Р 57327-2016') p.kind = 'ДПС';
  else if (!p.kind && p.gost === '23747-2015') p.kind = 'ДА';
  else if (!p.kind && p.gost === '6629-88') p.kind = 'Д';
  if (card?.leafCount === 1 || card?.leafCount === 2) p.leaves = card.leafCount;
  if (card?.fill === 'solid') p.fill = 'Г';
  else if (card?.fill === 'glazed') p.fill = 'О';
  if (card?.sizeBasis) p.basis = card.sizeBasis === 'opening' ? 'opening' : card.sizeBasis === 'block' ? 'frame' : 'leaf';
  if (p.fire === 'EI?') p.fire = null;
  if (row.family === 'steel' && !p.material) p.material = 'steel';
  if (row.family === 'aluminium') p.material = 'aluminium';
  p.heightMm = row.heightMm ?? p.heightMm;
  p.widthMm = row.widthMm ?? p.widthMm;
  return p;
}

const kindsOf = (p: GostProfile): GostKind[] => (p.kinds?.length ? p.kinds : p.kind ? [p.kind] : []);

/** Расхождения обязательных полей (известных с обеих сторон): пусто — строка прайса подходит позиции. */
export function profileConflicts(q: GostProfile, r: GostProfile): ProfileField[] {
  const out: ProfileField[] = [];
  if (q.gost && r.gost && q.gost !== r.gost) out.push('gost');
  const qk = kindsOf(q);
  const rk = kindsOf(r);
  if (qk.length && rk.length && !qk.some((k) => rk.includes(k))) out.push('kind');
  if (q.leaves && r.leaves && q.leaves !== r.leaves) out.push('leaves');
  if (q.fill && r.fill && q.fill !== r.fill) out.push('fill');
  // Огнестойкость: противопожарная позиция без класса («EI?») подходит к любой противопожарной строке; обычная — только к обычной.
  const qf = q.fire;
  const rf = r.fire;
  if ((qf && !rf) || (!qf && rf) || (qf && rf && qf !== 'EI?' && qf !== rf)) out.push('fire');
  return out;
}

/** Обязательные поля, которых нет у двери (после дополнения из выбранной строки прайса) — вопрос в опросник. */
export function missingFields(p: GostProfile): string[] {
  const out: string[] = [];
  if (!p.gost) out.push('gost');
  if (!p.kind) out.push('kind');
  if (!p.leaves) out.push('leaves');
  if (!p.fill) out.push('fill');
  if (p.fire === 'EI?') out.push('fire');
  if (!p.heightMm || !p.widthMm) out.push('size');
  return out;
}

/** Профиль позиции, дополненный строкой прайса, к которой она отнесена (модель названа прямо или подобрана однозначно). */
export function completeProfile(q: GostProfile, r: GostProfile | null): GostProfile {
  if (!r) return q;
  const out = { ...q };
  for (const k of ['gost', 'kind', 'leaves', 'fill', 'threshold', 'strength', 'material', 'cover'] as const) {
    if (out[k] === null || out[k] === undefined) (out as Record<string, unknown>)[k] = r[k];
  }
  if (out.fire === 'EI?' && r.fire) out.fire = r.fire;
  if (!out.basis) out.basis = r.basis;
  return out;
}

const dm = (mm: number) => String(Math.round(mm / 100));

/**
 * Обозначение по ГОСТ для КП (п. 3.5): шаблон из прайса («ДМ 1Рп 21×9 Г ПрБ Мд_ ГОСТ 475-2016») с размером и стороной позиции;
 * неизвестное поле шаблона («Мд_», «З_») убирается. Шаблона нет — собирается из профиля.
 */
export function gostDesignation(template: string | null | undefined, p: GostProfile): string | null {
  const tpl = (template ?? '').replace(/\s*\((?:в карточке|марку|полную)[^)]*\)/gi, '').trim();
  if (tpl && /\d{2}\s?×\s?\d{1,2}|[12]р[пл]|гост/i.test(tpl)) {
    let s = tpl;
    if (p.heightMm && p.widthMm) s = s.replace(/(?<!\d)\d{2}\s?×\s?\d{1,2}(?!\d)/, `${dm(p.heightMm)}×${dm(p.widthMm)}`);
    if (p.opening === 'left') s = s.replace(/([12])Рп/, '$1Рл');
    if (p.opening === 'right') s = s.replace(/([12])Рл/, '$1Рп');
    s = s.replace(/Мд_|З_/g, p.strength && /^Мд/.test(p.strength) ? p.strength : '');
    return s.replace(/\s{2,}/g, ' ').replace(/\s+([;.,])/g, '$1').trim();
  }
  if (!p.kind) return null;
  const side = p.opening === 'left' ? 'Рл' : 'Рп';
  const size = p.heightMm && p.widthMm ? `${dm(p.heightMm)}×${dm(p.widthMm)}` : '';
  const parts = [p.kind, p.leaves ? `${p.leaves}${side}` : '', size, p.fill ?? '', p.threshold ?? '', p.strength ?? '', p.fire && p.fire !== 'EI?' ? p.fire : '', p.gost ? `ГОСТ ${p.gost}` : ''];
  return parts.filter(Boolean).join(' ');
}

/** Профиль одной строкой для плитки: «ГОСТ 475-2016 · ДМ · 1 створка · Рл · Г · ПрБ · Мд1 · 2100×900 (по проёму)». */
export function profileLine(p: GostProfile): string {
  const basis = p.basis === 'opening' ? 'по проёму' : p.basis === 'frame' ? 'по коробке' : p.basis === 'leaf' ? 'по полотну' : 'база ?';
  return [
    p.gost ? `ГОСТ ${p.gost}` : 'ГОСТ ?',
    p.kind ?? 'вид ?',
    p.leaves ? `${p.leaves === 2 ? (p.unequal ? '2 створки, неравнопольная' : '2 створки') : '1 створка'}` : 'створки ?',
    p.opening === 'left' ? 'левая' : p.opening === 'right' ? 'правая' : '',
    p.fill ?? 'Г/О ?',
    p.threshold ?? '',
    p.strength ?? '',
    p.fire ? (p.fire === 'EI?' ? 'EI ?' : p.fire) : '',
    p.heightMm && p.widthMm ? `${p.heightMm}×${p.widthMm} (${basis})` : 'размер ?',
  ].filter(Boolean).join(' · ');
}
