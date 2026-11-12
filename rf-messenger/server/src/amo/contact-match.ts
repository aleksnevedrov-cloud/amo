/**
 * Подбор контакта amoCRM по номеру собеседника. Чистые функции — проверяются тестами без сети.
 * query у amoCRM нечёткий, поэтому совпадение засчитывается только при точном равенстве последних 10 цифр.
 */

/** Последние 10 цифр номера; короче 10 цифр — null (искать не по чему). */
export function phoneTail(raw: string): string | null {
  const d = raw.replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}

/** Хвост номера для журнала: последние 4 цифры. */
export const phoneTail4 = (raw: string) => `…${raw.replace(/\D/g, '').slice(-4)}`;

export interface ContactCandidate {
  id: number;
  name: string;
  /** Значения поля «Телефон» контакта как есть. */
  phones: string[];
  updatedAt: number;
  /** Сделки контакта: открыта — статус не 142 (успешно) и не 143 (закрыто). */
  leads: { id: number; statusId: number; updatedAt: number }[];
}

export const LEAD_CLOSED_STATUSES: ReadonlySet<number> = new Set([142, 143]);

/** Контакты, у которых один из телефонов точно совпадает с номером по последним 10 цифрам. */
export function exactPhoneMatches(candidates: readonly ContactCandidate[], phone: string): ContactCandidate[] {
  const tail = phoneTail(phone);
  if (!tail) return [];
  return candidates.filter((c) => c.phones.some((p) => phoneTail(p) === tail));
}

/**
 * Выбор среди нескольких: сначала контакт с открытой сделкой (самая свежая по updated_at сделки),
 * иначе контакт с самым свежим updated_at. null — кандидатов нет.
 */
export function chooseContact(matches: readonly ContactCandidate[]): { contact: ContactCandidate; reason: string } | null {
  if (!matches.length) return null;
  const only = matches[0];
  if (matches.length === 1 && only) return { contact: only, reason: 'единственный контакт с этим номером' };
  let best: { contact: ContactCandidate; leadId: number; at: number } | null = null;
  for (const c of matches) {
    for (const l of c.leads) {
      if (LEAD_CLOSED_STATUSES.has(l.statusId)) continue;
      if (!best || l.updatedAt > best.at) best = { contact: c, leadId: l.id, at: l.updatedAt };
    }
  }
  if (best) return { contact: best.contact, reason: `из ${matches.length} контактов выбран с самой свежей открытой сделкой #${best.leadId}` };
  const freshest = [...matches].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!freshest) return null;
  return { contact: freshest, reason: `из ${matches.length} контактов без открытых сделок выбран самый свежий` };
}
