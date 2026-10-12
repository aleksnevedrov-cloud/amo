/**
 * Служебная метка темы вопроса в конце ответа модели: [Q: razmery] или [Q: none].
 *
 * Метка вырезается до отправки, клиент её не видит. Если тема уже закрыта
 * памятью клиента, ответ не уходит, а переписывается без повторного вопроса.
 */

export const QUESTION_TOPICS = [
  'razmery',
  'kolichestvo',
  'pomeschenie',
  'byudzhet',
  'pokrytie',
  'cvet',
  'stil',
] as const;

export type QuestionTopic = (typeof QUESTION_TOPICS)[number];

/** Человеческое название темы — для сообщения модели и журнала. */
export const TOPIC_LABEL: Record<QuestionTopic, string> = {
  razmery: 'размеры проёма',
  kolichestvo: 'количество дверей',
  pomeschenie: 'помещение',
  byudzhet: 'бюджет',
  pokrytie: 'покрытие',
  cvet: 'цвет',
  stil: 'стиль',
};

const TAG = /\s*\[Q:\s*([a-z_]+)\s*\]\s*$/i;

/** Вырезает метку из ответа и возвращает тему вопроса к клиенту. */
export function parseQuestion(raw: string): { topic: QuestionTopic | null; text: string } {
  const m = TAG.exec(raw);
  if (!m || m.index === undefined) return { topic: null, text: raw };
  const text = raw.slice(0, m.index).trimEnd();
  const name = (m[1] ?? '').toLowerCase();
  const topic = (QUESTION_TOPICS as readonly string[]).includes(name) ? (name as QuestionTopic) : null;
  return { topic, text: text || raw };
}

/** Форма памяти клиента, которая нужна для сверки (раздел 9 ТЗ). */
export interface MemoryShape {
  openings?: { room?: string; width_mm?: number; height_mm?: number; qty?: number }[];
  budget_rub?: number | null;
  preferences?: { door_type?: string; coating?: string; color?: string; style?: string };
}

/** Темы, по которым клиент уже ответил — переспрашивать их нельзя. */
export function knownTopics(m: MemoryShape | null | undefined): QuestionTopic[] {
  if (!m) return [];
  const out: QuestionTopic[] = [];
  const op = m.openings ?? [];
  if (op.some((o) => o.width_mm && o.height_mm)) out.push('razmery');
  if (op.length > 0) out.push('kolichestvo');
  if (op.some((o) => o.room)) out.push('pomeschenie');
  if (m.budget_rub !== null && m.budget_rub !== undefined) out.push('byudzhet');
  const p = m.preferences ?? {};
  if (p.coating) out.push('pokrytie');
  if (p.color) out.push('cvet');
  if (p.style) out.push('stil');
  return out;
}
