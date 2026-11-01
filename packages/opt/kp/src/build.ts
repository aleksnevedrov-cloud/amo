import { execFile } from 'node:child_process';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { promisify } from 'node:util';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import { formatKopecks, lineSumKopecks, splitVat, toRub } from './offer-price.ts';

/**
 * Сборка КП по файлу-шаблону (тема RFD-AI-AGENT-KP, этап 4 ТЗ).
 *
 * Вёрстка живёт в DOCX, код подставляет только значения: модель документ не пишет.
 * Собирается строго из подтверждённого менеджером черновика — цены и количества берутся
 * оттуда, а не из каталога, чтобы правки руками не потерялись.
 */

export interface KpBuildLine {
  name: string;
  size: string;
  qty: number;
  price: number | null;
  discount: number;
}

export interface KpBuildInput {
  kpNo: string;
  date: Date;
  /** Основание: «запрос от 09.10.2026». */
  basis: string;
  clientName: string;
  clientPhone: string;
  lines: KpBuildLine[];
  vatRate: number;
  /** Фраза о ценах; пустая строка — без фразы. */
  priceNote: string;
}

/**
 * Постоянная фраза в каждом КП (решение заказчика 12.10.2026 — вместо стоп-листа обещаний).
 * Редактируется в настройках КП (константа priceNote), в шаблоне — плейсхолдер {{price_note}} под итогом.
 */
export const DEFAULT_PRICE_NOTE = 'Цены носят ориентировочный характер и могут быть скорректированы после уточнения всех деталей заказа.';

export interface KpTemplateData {
  kp_number: string;
  kp_date: string;
  order_basis: string;
  client_name: string;
  client_phone: string;
  items: { n: number; name: string; size: string; qty: string; price: string; sum: string }[];
  total_in_words: string;
  vat_phrase: string;
  grand_total: string;
  total_qty: string;
  price_note: string;
}

const run = promisify(execFile);

const money = (v: number) => `${Math.round(v).toLocaleString('ru-RU')} ₽`;

/** Цена строки с учётом скидки менеджера, рубли; считается в целых копейках (offer-price.ts), округление один раз. */
export const lineSum = (l: KpBuildLine) => toRub(lineSumKopecks(l));

const ONES = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const ONES_F = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const TEENS = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];

/** Форма слова по числу: 1 рубль, 2 рубля, 5 рублей. */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

function group(n: number, female: boolean): string {
  const out: string[] = [];
  const h = Math.floor(n / 100);
  const t = Math.floor((n % 100) / 10);
  const o = n % 10;
  if (h) out.push(HUNDREDS[h] ?? '');
  if (t === 1) {
    out.push(TEENS[o] ?? '');
  } else {
    if (t) out.push(TENS[t] ?? '');
    if (o) out.push((female ? ONES_F[o] : ONES[o]) ?? '');
  }
  return out.join(' ');
}

/** Сумма прописью: «сто двадцать три тысячи рублей 00 копеек». */
export function rublesInWords(value: number): string {
  const total = Math.round(Math.abs(value) * 100);
  const rub = Math.floor(total / 100);
  const kop = total % 100;
  if (rub === 0) return `ноль рублей ${String(kop).padStart(2, '0')} копеек`;
  const parts: string[] = [];
  const milliards = Math.floor(rub / 1_000_000_000);
  const millions = Math.floor((rub % 1_000_000_000) / 1_000_000);
  const thousands = Math.floor((rub % 1_000_000) / 1000);
  const rest = rub % 1000;
  if (milliards) parts.push(`${group(milliards, false)} ${plural(milliards, 'миллиард', 'миллиарда', 'миллиардов')}`);
  if (millions) parts.push(`${group(millions, false)} ${plural(millions, 'миллион', 'миллиона', 'миллионов')}`);
  if (thousands) parts.push(`${group(thousands, true)} ${plural(thousands, 'тысяча', 'тысячи', 'тысяч')}`);
  if (rest) parts.push(group(rest, false));
  const words = parts.join(' ').replace(/\s+/g, ' ').trim();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} ${plural(rub, 'рубль', 'рубля', 'рублей')} ${String(kop).padStart(2, '0')} ${plural(kop, 'копейка', 'копейки', 'копеек')}`;
}

/** Значения для плейсхолдеров шаблона — закрытый список из раздела 7 ТЗ. */
export function templateData(input: KpBuildInput): KpTemplateData {
  const items = input.lines.map((l, i) => ({
    n: i + 1,
    name: l.name || '—',
    size: l.size || '—',
    qty: `${l.qty.toLocaleString('ru-RU')} шт`,
    price: l.price === null ? '—' : money(l.price),
    sum: money(lineSum(l)),
  }));
  // Итог и НДС — в целых копейках: цены в КП конечные, НДС выделяется из них (этап 4 ТЗ RFD-AI-AGENT-OPT-PRICE), а не начисляется сверху.
  const totalKopecks = input.lines.reduce((s, l) => s + lineSumKopecks(l), 0);
  const total = toRub(totalKopecks);
  const vat = splitVat(totalKopecks, input.vatRate);
  const qty = input.lines.reduce((s, l) => s + l.qty, 0);
  return {
    kp_number: input.kpNo,
    kp_date: input.date.toLocaleDateString('ru-RU'),
    order_basis: input.basis,
    client_name: input.clientName,
    client_phone: input.clientPhone,
    items,
    total_in_words: rublesInWords(total),
    vat_phrase: input.vatRate > 0
      ? `в том числе НДС ${input.vatRate}% — ${formatKopecks(vat.vatKopecks)}`
      : 'НДС не облагается',
    grand_total: money(total),
    total_qty: `${qty} ${plural(qty, 'позиция', 'позиции', 'позиций')}`,
    price_note: input.priceNote.trim(),
  };
}

/**
 * Шаблон без {{price_note}}: фраза всё равно должна попасть в каждое КП — добавляется строкой
 * после фразы об НДС (она стоит под итогом). Возвращает те же данные, если тег в шаблоне есть.
 */
export function withPriceNoteFallback(hasTag: boolean, data: KpTemplateData): { data: KpTemplateData; fallback: boolean } {
  if (hasTag || !data.price_note) return { data, fallback: false };
  return { data: { ...data, vat_phrase: `${data.vat_phrase}\n${data.price_note}` }, fallback: true };
}

export interface KpBuildResult {
  docxPath: string;
  pdfPath: string | null;
  pdfError?: string;
  certificates: string[];
  /** В шаблоне нет {{price_note}} — фраза о ценах добавлена под строку НДС. */
  priceNoteFallback: boolean;
}

/**
 * DOCX по шаблону, следом PDF через LibreOffice. Если soffice недоступен, DOCX всё равно
 * собран и возвращается: менеджер не остаётся без документа из-за конвертера.
 */
export async function buildKp(
  templatePath: string,
  data: KpTemplateData,
  outDir: string,
  baseName: string,
): Promise<KpBuildResult> {
  const zip = new PizZip(await readFile(templatePath));
  const doc = new Docxtemplater(zip, {
    delimiters: { start: '{{', end: '}}' },
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => '',
  });
  const { data: rendered, fallback } = withPriceNoteFallback(doc.getFullText().includes('price_note'), data);
  doc.render(rendered);
  await mkdir(outDir, { recursive: true });
  const docxPath = join(outDir, `${baseName}.docx`);
  await writeFile(docxPath, doc.getZip().generate({ type: 'nodebuffer' }) as Buffer);

  const pdfPath = join(outDir, `${baseName}.pdf`);
  try {
    // Один профиль на процесс: параллельные вызовы soffice падают на общем профиле.
    await run(
      'soffice',
      ['--headless', `-env:UserInstallation=file:///tmp/lo-${process.pid}`, '--convert-to', 'pdf', '--outdir', outDir, docxPath],
      { timeout: 120_000 },
    );
    await access(pdfPath);
    return { docxPath, pdfPath, certificates: [], priceNoteFallback: fallback };
  } catch (err) {
    return { docxPath, pdfPath: null, pdfError: (err as Error).message, certificates: [], priceNoteFallback: fallback };
  }
}

/**
 * Сертификаты по фабрикам позиций: файл берётся, если его имя содержит название фабрики.
 * Не склеиваем с КП — прикладываются отдельными файлами (раздел 7 ТЗ).
 */
export async function findCertificates(dir: string | null, factories: string[]): Promise<string[]> {
  if (!dir || factories.length === 0) return [];
  const names = await readdir(dir).catch(() => [] as string[]);
  const wanted = factories.map((f) => f.toLowerCase().trim()).filter(Boolean);
  const out: string[] = [];
  for (const n of names) {
    if (extname(n).toLowerCase() !== '.pdf') continue;
    const low = basename(n, extname(n)).toLowerCase();
    if (wanted.some((w) => w.length > 2 && low.includes(w))) out.push(join(dir, n));
  }
  return out.slice(0, 10);
}
