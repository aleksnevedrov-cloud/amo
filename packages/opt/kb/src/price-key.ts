/**
 * Ключ прайса (RFD-AI-AGENT-OPT-KB-MULTIPRICE): нормализованное имя файла без расширения и без хвоста из версий и дат,
 * чтобы «Прайс_межкомнатные_двери_ГОСТ — обновил 16102026.xlsx» и «Прайс_межкомнатные_двери_ГОСТ (2).xlsx» считались
 * одним прайсом: загрузка файла с тем же ключом заменяет только его цены.
 */
const JUNK_TOKEN = /^(v\d+|ver\d*|версия|вер|\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{6,8}|\d{4}|\(\d+\)|\d+|копия|copy|обновил[аи]?|обновлен[оа]?|обновление|новый|новая|new|final|итог|от|актуальный|актуальная|актуал)$/i;

export function priceListKeyOf(filename: string | null | undefined): string {
  let s = (filename ?? '').trim().replace(/\.(xlsx|xlsm|xls|csv|ods)$/i, '');
  // Тире между словами — разделитель хвоста («… — обновил»), дефис внутри слова («475-2016») остаётся.
  s = s.toLowerCase().replace(/ё/g, 'е').replace(/[_\s]+/g, ' ').replace(/\s+[—–-]+\s+|[—–]+/g, ' - ').replace(/\s+/g, ' ').trim();
  // Хвост: токены версий, дат, «обновил», «(2)», «копия» снимаются справа, разделители между ними тоже.
  const tokens = s.split(' ').filter(Boolean);
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1] as string;
    if (last === '-' || JUNK_TOKEN.test(last)) tokens.pop();
    else break;
  }
  return tokens.join(' ').replace(/\s*-\s*$/, '').trim();
}

const TITLE_STOP = new Set(['прайс', 'прайс-лист', 'прайслист', 'price', 'pricelist', 'лист', 'двери', 'дверей', 'дверь', 'door', 'doors', 'гост', 'gost', 'ооо', 'на', 'по', 'для']);

/** Короткое название прайса для сводки: «прайс межкомнатные двери гост» → «Межкомнатные»; ничего не осталось — ключ как есть. */
export function priceListTitleOf(key: string | null | undefined): string {
  const k = (key ?? '').trim();
  if (!k) return '';
  const words = k.split(/\s+/).filter((w) => w && w !== '-' && !TITLE_STOP.has(w.toLowerCase()));
  const out = (words.length ? words : k.split(/\s+/)).join(' ');
  return out.charAt(0).toUpperCase() + out.slice(1);
}
