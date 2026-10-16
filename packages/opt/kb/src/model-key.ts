/**
 * Ключ модели для сопоставления позиции заявки с ценами и синонимами базы: нижний регистр, ё→е, без размера,
 * количества, единиц и общих слов («дверь», «полотно», «межкомнатная»), пунктуация → пробел.
 * «Дверь ДПГ сота 800×2000 мм — 12 шт» → «дпг сота».
 */
const GENERIC = new Set(['дверь', 'двери', 'дверное', 'дверной', 'полотно', 'полотна', 'межкомнатная', 'межкомнатные', 'межкомнатное', 'межкомнатных', 'мм', 'см', 'м', 'шт', 'штук', 'штуки', 'компл', 'комплект', 'цена', 'купить', 'за', 'в', 'на', 'с', 'и', 'без', 'для', 'размер', 'размером']);

export const SIZE_RX = /(\d+(?:[.,]\d+)?)\s*[×x*хХX]\s*(\d+(?:[.,]\d+)?)(?:\s*[×x*хХX]\s*(\d+(?:[.,]\d+)?))?\s*(мм|м|mm|m)?(?![a-zа-я0-9])/gi;

export function modelKeyOf(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(SIZE_RX, ' ')
    .replace(/\d+(?:[.,]\d+)?\s*(шт\.?|штук[аи]?|компл\.?|комплект(а|ов)?)(?![a-zа-я])/g, ' ')
    .replace(/[«»"'`()[\]{}.,;:!?/\\|—–\-+=_#№%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned
    .split(' ')
    .filter((w) => w && !GENERIC.has(w))
    .join(' ');
}

export const tokensOf = (key: string): string[] => key.split(' ').filter(Boolean);

/** Размер из текста: «800×2000», «2000*800 мм», «0,8х2 м» — меньшее число ширина, большее высота; третье число (толщина) отбрасывается. */
export function sizeOf(text: string): { widthMm: number; heightMm: number } | null {
  for (const m of text.matchAll(new RegExp(SIZE_RX.source, 'gi'))) {
    const unit = (m[4] ?? '').toLowerCase();
    const nums = [m[1], m[2], m[3]].filter((x): x is string => x !== undefined).map((x) => Number(x.replace(',', '.')));
    const mm = nums.map((n) => (unit === 'м' || unit === 'm' || (!unit && n < 10) ? Math.round(n * 1000) : Math.round(n)));
    const big = mm.filter((n) => n >= 100);
    if (big.length < 2) continue;
    const [a, b] = [big[0] as number, big[1] as number];
    return { widthMm: Math.min(a, b), heightMm: Math.max(a, b) };
  }
  return null;
}

/**
 * Все размеры из текста (RFD-AI-AGENT-OPT-KB-PRICELIST, в): «Блок Ш×В: 1010×2100; 910×2100. Проход ≥800 мм — подтвердить
 * чертежом.» → [1010×2100, 910×2100]; пояснительный текст и одиночные числа не считаются; повторы убираются.
 */
export function sizesOf(text: string): { widthMm: number; heightMm: number }[] {
  const out: { widthMm: number; heightMm: number }[] = [];
  for (const m of text.matchAll(new RegExp(SIZE_RX.source, 'gi'))) {
    const unit = (m[4] ?? '').toLowerCase();
    const nums = [m[1], m[2], m[3]].filter((x): x is string => x !== undefined).map((x) => Number(x.replace(',', '.')));
    const mm = nums.map((n) => (unit === 'м' || unit === 'm' || (!unit && n < 10) ? Math.round(n * 1000) : Math.round(n)));
    const big = mm.filter((n) => n >= 100);
    if (big.length < 2) continue;
    const size = { widthMm: Math.min(big[0] as number, big[1] as number), heightMm: Math.max(big[0] as number, big[1] as number) };
    if (!out.some((x) => x.widthMm === size.widthMm && x.heightMm === size.heightMm)) out.push(size);
  }
  return out;
}

/** Слова для подбора по словам: ключ модели плюс сокращение и назначение, без повторов и коротких слов (кроме артикулов с цифрой). */
export function searchTokensOf(...texts: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const w of tokensOf(modelKeyOf(t))) if (w.length >= 3 || /\d/.test(w)) out.add(w);
  }
  return [...out];
}

/** Число створок: двупольная/двухпольная/двустворчатая — 2; однопольная — 1; не сказано — null. */
export function leavesOf(text: string): number | null {
  const t = text.toLowerCase();
  if (/дву[хс]?\s*(польн|створ)|двуств|2[\s-]*створ/.test(t)) return 2;
  if (/одно\s*(польн|створ)|1[\s-]*створ/.test(t)) return 1;
  return null;
}

/** «800×2000» из ширины и высоты; null — размера нет. */
export const sizeLabel = (w: number | null, h: number | null): string | null => (w && h ? `${w}×${h}` : null);
