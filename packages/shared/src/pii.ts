const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
// Телефоны: +7 / 8 и 10 цифр с любыми разделителями, а также длинные международные номера.
const PHONE = /(?<![\p{N}])(?:\+?\d[\s\-().]*){10,15}(?![\p{N}])/gu;

/** Маскирует e-mail и телефоны в строке (152-ФЗ: не отдаём ПДн в логи). */
export function maskPii(text: string): string {
  return text
    .replace(EMAIL, (m) => {
      const [user = '', domain = ''] = m.split('@');
      return `${user.slice(0, 1)}***@${domain}`;
    })
    .replace(PHONE, (m) => {
      const digits = m.replace(/\D/g, '');
      return `***${digits.slice(-2)}`;
    });
}
