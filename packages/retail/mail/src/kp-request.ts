/**
 * Фильтр писем с запросом коммерческого предложения (тема RFD-AI-AGENT-KP, этап 2).
 * Нужен, чтобы вложения рассылок скачивались, но не разбирались моделью:
 * разбор стоит денег, а рассылки его не окупают.
 */

/** Слова, по которым узнаём запрос предложения. */
const KP_WORDS = [
  'ткп',
  'коммерческое предложение',
  'комм. предложение',
  'коммерческого предложения',
  'запрос цены',
  'запрос цен',
  'запрос стоимости',
  'прайс',
  'тендер',
  'котировк',
  'смет',
  'закупк',
];

/** Отдельно «КП» как слово: внутри других слов не считается. */
const KP_SHORT = /(^|[^0-9a-zа-яё])кп([^0-9a-zа-яё]|$)/i;

const BULK_FROM =
  /no-?reply|noreply|do-?not-?reply|bounce|mailer-daemon|postmaster|newsletter|mailing|notifications?@/i;
const BULK_SUBJECT = /рассылк|отписаться|unsubscribe|дайджест|новости недели|вебинар/i;

export interface KpRequestInput {
  fromAddress: string;
  subject: string;
  text: string;
}

export interface KpRequestVerdict {
  /** Похоже на запрос предложения — можно тратить разбор и писать примечание. */
  isRequest: boolean;
  /** Рассылка или робот: вложения скачиваем, но не разбираем. */
  isBulk: boolean;
  matched: string[];
}

export function classifyKpRequest(i: KpRequestInput): KpRequestVerdict {
  const from = (i.fromAddress ?? '').toLowerCase();
  const subject = (i.subject ?? '').toLowerCase();
  // Длинные письма режем: признаки запроса стоят в начале, а не в подвале цитат.
  const body = (i.text ?? '').slice(0, 4000).toLowerCase();
  const haystack = `${subject}\n${body}`;

  if (BULK_FROM.test(from) || BULK_SUBJECT.test(subject)) {
    return { isRequest: false, isBulk: true, matched: [] };
  }

  const matched = KP_WORDS.filter((w) => haystack.includes(w));
  if (KP_SHORT.test(subject) || KP_SHORT.test(body)) matched.push('кп');
  return { isRequest: matched.length > 0, isBulk: false, matched };
}

export interface KpNoteInput {
  subject: string;
  fromName: string;
  fromAddress: string;
  text: string;
  matched: string[];
  files: { filename: string; text?: string; error?: string }[];
}

/** Примечание в сделку: что просят и что лежит во вложениях. */
export function buildKpNote(i: KpNoteInput): string {
  const lines: string[] = [];
  lines.push(`Запрос КП: ${i.subject || 'письмо без темы'}`);
  lines.push(`От: ${i.fromName ? `${i.fromName} <${i.fromAddress}>` : i.fromAddress}`);
  if (i.matched.length) lines.push(`Признаки: ${[...new Set(i.matched)].join(', ')}`);

  const body = cut(i.text.replace(/\s+\n/g, '\n').trim(), 900);
  if (body) {
    lines.push('');
    lines.push('Текст письма:');
    lines.push(body);
  }

  if (i.files.length) {
    lines.push('');
    lines.push('Вложения:');
    for (const f of i.files) {
      if (f.error) {
        lines.push(`• ${f.filename} — разобрать не удалось: ${cut(f.error, 120)}`);
        continue;
      }
      const t = cut((f.text ?? '').trim(), 400);
      lines.push(t ? `• ${f.filename}: ${t}` : `• ${f.filename} — текста нет`);
    }
  }

  lines.push('');
  lines.push('Подготовить КП — кнопкой в карточке сделки.');
  return cut(lines.join('\n'), 3000);
}

function cut(s: string, n: number): string {
  const t = (s ?? '').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}
