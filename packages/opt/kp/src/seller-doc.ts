/**
 * RFD-AI-AGENT-OPT-DEAL-FILES-2, 2.2: документ продавца — наш счёт, КП, договор, УПД, накладная, где продавец / поставщик —
 * наша компания (ИНН / КПП из sellerRequisites или название из sellerName и варианты «РУС ДВЕРИ», «РУС-ДВЕРИ»). Позиции из него
 * в черновик не берутся. Признаки ищутся в сыром тексте файла (до чистки персональных данных — она убирает строки с ИНН и «счёт»).
 */
export interface SellerInfo {
  name?: string | null;
  requisites?: string | null;
}

const OUR_NAME_VARIANTS = ['РУС-ДВЕРИ', 'РУС ДВЕРИ', 'РУСДВЕРИ'];
const normName = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[«»"'“”„]/g, '').replace(/\b(ооо|ао|ип|зао|пао)\b/g, '').replace(/[\s\-–—_.]+/g, '');
/** Вид документа по названию: счёт, КП, договор, УПД, накладная. */
export const SELLER_DOC_RE = /сч[её]т|коммерческое предложение|\bкп\b|договор|упд|накладн|универсальн\w* передаточн/i;

export function sellerLabel(seller: SellerInfo | null | undefined): string {
  return seller?.name?.trim() || 'ООО «РУС-ДВЕРИ»';
}

/** Похож ли файл на документ продавца по виду (kind estimate) или названию — тогда стоит смотреть его текст. */
export function looksLikeSellerDoc(f: { kind: string; title?: string | null; filename: string }): boolean {
  return f.kind === 'estimate' || SELLER_DOC_RE.test(`${f.title ?? ''} ${f.filename}`);
}

/** Наш ли это документ: вид документа продавца и в тексте — наш ИНН / КПП или название. */
export function isOurDocument(f: { kind: string; title?: string | null; filename: string; text?: string | null }, seller: SellerInfo | null | undefined): boolean {
  if (!looksLikeSellerDoc(f)) return false;
  const text = f.text ?? '';
  if (!text.trim()) return false;
  const codes = [...(seller?.requisites ?? '').matchAll(/\b(\d{9,12})\b/g)].map((m) => m[1] as string).filter((c) => c.length === 9 || c.length === 10 || c.length === 12);
  const digits = ` ${text.replace(/[^\d]+/g, ' ')} `;
  if (codes.some((c) => digits.includes(` ${c} `))) return true;
  const names = [...OUR_NAME_VARIANTS, ...(seller?.name ? [seller.name] : [])].map(normName).filter((n) => n.length >= 5);
  const hay = normName(text);
  return names.some((n) => hay.includes(n));
}
