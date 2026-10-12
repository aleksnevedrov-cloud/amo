
/**
 * Чистка текста документа перед отправкой в LLM (152-ФЗ, согласие заказчика: в Claude
 * уходит только текст без контактов). Убираем телефоны, e-mail, ФИО, адреса, реквизиты
 * и паспортные данные; размеры, марки и цены остаются.
 */
export interface Cleaned {
  text: string;
  /** Сколько строк и фрагментов удалено/замаскировано. */
  removed: number;
}

// Фамилия Имя Отчество (отчество по суффиксу) или Фамилия И.О.
const FULL_NAME = /(?<!\p{L})[А-ЯЁ][а-яё-]+\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+(?:ович|евич|ич|овна|евна|ична|инична)(?!\p{L})/gu;
const SHORT_NAME = /(?<!\p{L})[А-ЯЁ][а-яё-]{2,}\s+[А-ЯЁ]\.\s?[А-ЯЁ]\.(?!\s*[а-яё])/gu;
const NAME_LINE = /^\s*(ФИО|Ф\.И\.О\.?|Контактное лицо|Заказчик|Покупатель|Клиент|Получатель|Плательщик|Директор|Руководитель|Менеджер|Замерщик|Исполнитель)\s*[:\-—]?\s*\S/iu;
const ADDRESS_LINE = /(^|\s)(адрес|г\.|город\s|ул\.|улица|просп\.|проспект|пер\.|переулок|д\.\s?\d|дом\s?\d|кв\.|квартира|мкр|корп\.|стр\.\s?\d)/iu;

const PASSPORT = /(?<!\p{L})(паспорт|паспортные данные|серия и номер)(?!\p{L})/iu;
// ИНН, ОГРН, БИК, счета, паспорта: 9–20 цифр подряд (размеры и артикулы короче).
const LONG_DIGITS = /(?<![\d-])\d{9,20}(?![\d-])/g;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
// Российские номера: +7/8 и 10 цифр с обычными разделителями, либо мобильный 9XXXXXXXXX; табуляция (граница ячейки) разделителем не считается.
const PHONE = /(?<![\d-])(?:(?:\+7|8|7)[ (-]*\d{3}[ )-]*\d{3}[ -]*\d{2}[ -]*\d{2}|9\d{9})(?![\d-])/g;

export function cleanPersonalData(text: string): Cleaned {
  let removed = 0;
  const lines = text.split('\n').map((line) => {
    // Строка целиком про человека/адрес/реквизиты — выкидываем (размеры там не живут).
    if (NAME_LINE.test(line) || PASSPORT.test(line) || (ADDRESS_LINE.test(line) && !/\d{3,4}\s*[xх×*]\s*\d{3,4}/u.test(line))) {
      removed += 1;
      return '[строка с персональными данными удалена]';
    }
    let out = line.replace(FULL_NAME, () => {
      removed += 1;
      return '[ФИО]';
    });
    out = out.replace(SHORT_NAME, () => {
      removed += 1;
      return '[ФИО]';
    });
    out = out.replace(LONG_DIGITS, () => {
      removed += 1;
      return '[номер]';
    });
    out = out.replace(PHONE, () => {
      removed += 1;
      return '[телефон]';
    });
    return out.replace(EMAIL, () => {
      removed += 1;
      return '[e-mail]';
    });
  });
  // Подряд идущие пометки — в одну.
  const collapsed = lines.filter((l, i, a) => !(l === a[i - 1] && l.startsWith('[строка')));
  return { text: collapsed.join('\n'), removed };
}
